#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use flate2::read::GzDecoder;
use reqwest::blocking::Client as BlockingClient;
use reqwest::Client;
use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;
use std::{
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{LazyLock, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tar::Archive;

static TRANSLATION_INSTALL_STATE: LazyLock<Mutex<TranslationInstallState>> =
    LazyLock::new(|| Mutex::new(TranslationInstallState::idle()));

#[derive(Clone, Serialize)]
struct TranslationInstallState {
    active: bool,
    finished: bool,
    ready: bool,
    step: u8,
    total_steps: u8,
    phase: String,
    error: String,
    logs: Vec<String>,
}

impl TranslationInstallState {
    fn idle() -> Self {
        Self {
            active: false,
            finished: false,
            ready: false,
            step: 0,
            total_steps: 4,
            phase: "Idle".to_string(),
            error: String::new(),
            logs: Vec::new(),
        }
    }
}

#[derive(serde::Deserialize)]
struct LatestReleaseMetadata {
    tag: String,
}

#[derive(serde::Deserialize)]
struct GitHubRelease {
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Clone, serde::Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
}

fn with_install_state<R>(f: impl FnOnce(&mut TranslationInstallState) -> R) -> R {
    let mut state = TRANSLATION_INSTALL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut state)
}

fn set_install_phase(step: u8, total_steps: u8, phase: impl Into<String>) {
    with_install_state(|state| {
        state.active = true;
        state.finished = false;
        state.step = step;
        state.total_steps = total_steps;
        state.phase = phase.into();
        state.error.clear();
    });
}

fn push_install_log(message: impl Into<String>) {
    with_install_state(|state| {
        state.logs.push(message.into());
        if state.logs.len() > 200 {
            let drop_count = state.logs.len() - 200;
            state.logs.drain(0..drop_count);
        }
    });
}

fn finish_install_success() {
    with_install_state(|state| {
        state.active = false;
        state.finished = true;
        state.ready = true;
        state.step = state.total_steps;
        state.phase = "Ready".to_string();
        state.error.clear();
        state.logs.push("Chinese statement support is ready.".to_string());
        if state.logs.len() > 200 {
            let drop_count = state.logs.len() - 200;
            state.logs.drain(0..drop_count);
        }
    });
}

fn finish_install_error(message: String) {
    with_install_state(|state| {
        state.active = false;
        state.finished = true;
        state.ready = false;
        state.error = message.clone();
        state.phase = "Install failed".to_string();
        state.logs.push(format!("Error: {message}"));
        if state.logs.len() > 200 {
            let drop_count = state.logs.len() - 200;
            state.logs.drain(0..drop_count);
        }
    });
}

#[tauri::command]
async fn run_code(lang: String, code: String, stdin: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match lang.as_str() {
            "py" => run_python(&code, &stdin),
            "cpp" => run_cpp(&code, &stdin),
            "js" => run_js(&code, &stdin),
            _ => Err(format!("unsupported language: {lang}")),
        }
    })
    .await
    .map_err(|e| format!("run_code task failed: {e}"))?
}

#[tauri::command]
async fn cf_fetch_problem(contest_id: u32, index: String) -> Result<serde_json::Value, String> {
    let url = format!(
        "https://codeforces.com/problemset/problem/{}/{}",
        contest_id, index
    );

    let client = Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 BingoOJ/0.1")
        .http1_only()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let html = fetch_codeforces_html(&client, &url).await?;

    let doc = Html::parse_document(&html);

    let sel_stmt = Selector::parse(".problem-statement").map_err(|e| e.to_string())?;
    let stmt = doc
        .select(&sel_stmt)
        .next()
        .ok_or("problem statement not found")?;
    let statement_html = stmt.html();

    let sel_sample = Selector::parse(".sample-test").map_err(|e| e.to_string())?;
    let sel_in = Selector::parse(".input pre").map_err(|e| e.to_string())?;
    let sel_out = Selector::parse(".output pre").map_err(|e| e.to_string())?;

    let mut samples = Vec::<serde_json::Value>::new();
    if let Some(sample_node) = doc.select(&sel_sample).next() {
        let inputs: Vec<String> = sample_node
            .select(&sel_in)
            .map(extract_sample_text)
            .collect();
        let outputs: Vec<String> = sample_node
            .select(&sel_out)
            .map(extract_sample_text)
            .collect();

        for i in 0..inputs.len().min(outputs.len()) {
            samples.push(serde_json::json!({
                "input": inputs[i],
                "output": outputs[i],
            }));
        }
    }

    Ok(serde_json::json!({
        "url": url,
        "statement_html": statement_html,
        "samples": samples,
    }))
}

#[tauri::command]
async fn cf_list_problems() -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 BingoOJ/0.1")
        .http1_only()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let data = fetch_codeforces_api_json(&client, "https://codeforces.com/api/problemset.problems")
        .await?;

    let problems = data["result"]["problems"]
        .as_array()
        .ok_or("Codeforces API returned an unexpected payload")?
        .iter()
        .map(|problem| {
            let contest_id = problem.get("contestId").and_then(|v| v.as_u64());
            let index = problem
                .get("index")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let url = contest_id
                .map(|id| format!("https://codeforces.com/problemset/problem/{id}/{index}"))
                .unwrap_or_default();

            serde_json::json!({
                "id": contest_id
                    .map(|id| format!("CF-{id}-{index}"))
                    .unwrap_or_else(|| format!("CF-{index}")),
                "title": problem.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown Problem"),
                "source": "Codeforces",
                "url": url,
                "tags": problem.get("tags").cloned().unwrap_or_else(|| serde_json::json!([])),
                "rating": problem.get("rating").cloned().unwrap_or(serde_json::Value::Null),
                "samples": [],
                "statementMd": format!("题面暂不抓取，打开链接：{url}"),
                "contestId": contest_id,
                "index": index,
            })
        })
        .collect::<Vec<_>>();

    Ok(serde_json::Value::Array(problems))
}

#[tauri::command]
async fn translate_problem_html(
    html: String,
    from_lang: Option<String>,
    to_lang: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let python_path = managed_translation_python_path();
        if !python_path.exists() {
            return Err("Chinese statement support is not installed yet.".to_string());
        }
        let version = python_version(&python_path)?;
        if !is_supported_translation_python(version) {
            return Err(format!(
                "The local translation runtime uses {}, which is not compatible with Argos Translate yet.",
                format_python_version(version)
            ));
        }

        run_translation_support_command(
            &python_path,
            &[
                "translate",
                "--from-lang",
                from_lang.as_deref().unwrap_or("en"),
                "--to-lang",
                to_lang.as_deref().unwrap_or("zh"),
            ],
            Some(&html),
        )
        .and_then(|output| {
            String::from_utf8(output.stdout)
                .map_err(|err| format!("local translation returned non-utf8 html: {err}"))
        })
    })
    .await
    .map_err(|err| format!("local translation task failed: {err}"))?
}

#[tauri::command]
async fn get_translation_support_status(
    from_lang: Option<String>,
    to_lang: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let python_path = managed_translation_python_path();
        if !python_path.exists() {
            return Ok(serde_json::json!({
                "ready": false,
                "installing": false,
                "message": "Chinese statement support is not installed yet."
            }));
        }

        let version = python_version(&python_path)?;
        if !is_supported_translation_python(version) {
            return Ok(serde_json::json!({
                "ready": false,
                "installing": false,
                "message": format!(
                    "The local translation runtime uses {}, which is not compatible with Argos Translate yet. This machine needs Python 3.8-3.13, or the app should bundle a compatible runtime.",
                    format_python_version(version)
                )
            }));
        }

        let output = run_translation_support_command(
            &python_path,
            &[
                "status",
                "--from-lang",
                from_lang.as_deref().unwrap_or("en"),
                "--to-lang",
                to_lang.as_deref().unwrap_or("zh"),
            ],
            None,
        )?;

        serde_json::from_slice::<serde_json::Value>(&output.stdout)
            .map_err(|err| format!("translation status returned invalid json: {err}"))
    })
    .await
    .map_err(|err| format!("translation status task failed: {err}"))?
}

#[tauri::command]
async fn install_translation_support(
    from_lang: Option<String>,
    to_lang: Option<String>,
) -> Result<serde_json::Value, String> {
    let already_active = with_install_state(|state| state.active);
    if already_active {
        return get_translation_install_state().await;
    }

    let from_lang = from_lang.unwrap_or_else(|| "en".to_string());
    let to_lang = to_lang.unwrap_or_else(|| "zh".to_string());

    with_install_state(|state| {
        *state = TranslationInstallState {
            active: true,
            finished: false,
            ready: false,
            step: 0,
            total_steps: 4,
            phase: "Preparing install".to_string(),
            error: String::new(),
            logs: vec!["Starting Chinese statement support setup...".to_string()],
        };
    });

    thread::spawn(move || {
        if let Err(err) = run_translation_install(&from_lang, &to_lang) {
            finish_install_error(err);
        } else {
            finish_install_success();
        }
    });

    get_translation_install_state().await
}

#[tauri::command]
async fn get_translation_install_state() -> Result<serde_json::Value, String> {
    let state = with_install_state(|state| state.clone());
    serde_json::to_value(state).map_err(|err| format!("serialize install state failed: {err}"))
}

async fn fetch_codeforces_html(client: &Client, url: &str) -> Result<String, String> {
    let mut last_error = String::new();

    for attempt in 1..=3 {
        let response = client
            .get(url)
            .header(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .header(reqwest::header::PRAGMA, "no-cache")
            .header(reqwest::header::REFERER, "https://codeforces.com/problemset")
            .send()
            .await;

        match response {
            Ok(resp) => match resp.error_for_status() {
                Ok(ok_resp) => match ok_resp.text().await {
                    Ok(html) => return Ok(html),
                    Err(err) => {
                        last_error = format!("attempt {attempt}: failed to read response body: {err}");
                    }
                },
                Err(err) => {
                    last_error = format!("attempt {attempt}: http error: {err}");
                }
            },
            Err(err) => {
                last_error = format!("attempt {attempt}: request failed: {err}");
            }
        }

        thread::sleep(Duration::from_millis(300 * attempt as u64));
    }

    curl_fetch_text(
        url.to_string(),
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8".to_string(),
        "https://codeforces.com/problemset".to_string(),
        format!("failed to fetch Codeforces problem page after 3 reqwest attempts: {last_error}"),
    )
    .await
}

async fn fetch_codeforces_api_json(client: &Client, url: &str) -> Result<serde_json::Value, String> {
    let mut last_error = String::new();

    for attempt in 1..=3 {
        let response = client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json,text/plain,*/*")
            .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .header(reqwest::header::PRAGMA, "no-cache")
            .header(reqwest::header::REFERER, "https://codeforces.com/problemset")
            .send()
            .await;

        match response {
            Ok(resp) => match resp.error_for_status() {
                Ok(ok_resp) => match ok_resp.text().await {
                    Ok(body) => match serde_json::from_str::<serde_json::Value>(&body) {
                        Ok(json) => {
                            if json["status"].as_str() == Some("OK") {
                                return Ok(json);
                            }
                            last_error = format!("attempt {attempt}: Codeforces API status was not OK");
                        }
                        Err(err) => {
                            last_error = format!("attempt {attempt}: failed to parse json: {err}");
                        }
                    },
                    Err(err) => {
                        last_error = format!("attempt {attempt}: failed to read response body: {err}");
                    }
                },
                Err(err) => {
                    last_error = format!("attempt {attempt}: http error: {err}");
                }
            },
            Err(err) => {
                last_error = format!("attempt {attempt}: request failed: {err}");
            }
        }

        thread::sleep(Duration::from_millis(300 * attempt as u64));
    }

    let body = curl_fetch_text(
        url.to_string(),
        "application/json,text/plain,*/*".to_string(),
        "https://codeforces.com/problemset".to_string(),
        format!("failed to fetch Codeforces API after 3 reqwest attempts: {last_error}"),
    )
    .await?;

    serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|err| format!("curl fallback returned invalid json: {err}"))
}

async fn curl_fetch_text(
    url: String,
    accept: String,
    referer: String,
    prior_error: String,
) -> Result<String, String> {
    let task_error = prior_error.clone();
    let closure_error = prior_error.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new("curl")
            .arg("-L")
            .arg("--fail")
            .arg("--silent")
            .arg("--show-error")
            .arg("--max-time")
            .arg("15")
            .arg("--http1.1")
            .arg("-A")
            .arg("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 BingoOJ/0.1")
            .arg("-H")
            .arg(format!("Accept: {accept}"))
            .arg("-H")
            .arg("Accept-Language: en-US,en;q=0.9")
            .arg("-H")
            .arg("Cache-Control: no-cache")
            .arg("-H")
            .arg("Pragma: no-cache")
            .arg("-e")
            .arg(referer)
            .arg(url)
            .output()
            .map_err(|err| format!("{task_error}; curl spawn failed: {err}"))?;

        if output.status.success() {
            return String::from_utf8(output.stdout)
                .map_err(|err| format!("{task_error}; curl returned non-utf8 body: {err}"));
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "{closure_error}; curl fallback failed with status {:?}: {}",
            output.status.code(),
            stderr.trim()
        ))
    })
    .await
    .map_err(|err| format!("{prior_error}; curl task failed: {err}"))?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            run_code,
            cf_fetch_problem,
            cf_list_problems,
            translate_problem_html,
            get_translation_support_status,
            install_translation_support,
            get_translation_install_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn run_translation_install(from_lang: &str, to_lang: &str) -> Result<(), String> {
    let script_path = translation_support_script_path();
    if !script_path.exists() {
        return Err(format!(
            "translation support script not found: {}",
            script_path.display()
        ));
    }

    let root = translation_support_root_dir()?;
    fs::create_dir_all(&root)
        .map_err(|err| format!("create translation support directory failed: {err}"))?;

    let venv_dir = translation_support_venv_dir();
    let python_path = managed_translation_python_path();
    if python_path.exists() {
        match python_version(&python_path) {
            Ok(version) if !is_supported_translation_python(version) => {
                push_install_log(format!(
                    "Removing incompatible translation runtime ({})...",
                    format_python_version(version)
                ));
                fs::remove_dir_all(&venv_dir).map_err(|err| {
                    format!("remove incompatible translation runtime failed: {err}")
                })?;
            }
            Ok(version) => {
                set_install_phase(2, 4, "Local translation runtime");
                push_install_log(format!(
                    "Local translation runtime already exists ({})",
                    format_python_version(version)
                ));
            }
            Err(err) => {
                push_install_log(format!(
                    "Existing translation runtime could not be verified: {err}"
                ));
                fs::remove_dir_all(&venv_dir).map_err(|remove_err| {
                    format!("remove broken translation runtime failed: {remove_err}")
                })?;
            }
        }
    }

    let python_path = managed_translation_python_path();
    if !python_path.exists() {
        set_install_phase(1, 4, "Checking Python runtime");
        push_install_log("Looking for a compatible Python runtime...");
        let system_python = resolve_translation_host_python()?;
        set_install_phase(2, 4, "Creating local translation runtime");
        push_install_log(format!(
            "Creating an isolated Python runtime with {}...",
            system_python.display()
        ));
        let mut command = Command::new(&system_python);
        command.arg("-m").arg("venv").arg(&venv_dir);
        run_command_with_live_logs(command, "create local translation runtime")?;
        push_install_log("Local translation runtime created.");
    }

    set_install_phase(3, 4, "Installing translation packages");
    push_install_log("Installing Argos Translate runtime packages...");
    let mut command = Command::new(&python_path);
    command
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--disable-pip-version-check")
        .arg("argostranslate")
        .arg("beautifulsoup4");
    run_command_with_live_logs(command, "install translation packages")?;
    push_install_log("Runtime packages installed.");

    set_install_phase(4, 4, "Downloading translation package");
    push_install_log("Downloading English -> Chinese language package...");
    run_translation_support_command_with_logs(
        &python_path,
        &[
            "install",
            "--from-lang",
            from_lang,
            "--to-lang",
            to_lang,
        ],
        None,
    )?;
    push_install_log("Language package installed.");

    Ok(())
}

fn translation_support_root_dir() -> Result<PathBuf, String> {
    if let Some(xdg_data_home) = env::var_os("XDG_DATA_HOME") {
        return Ok(PathBuf::from(xdg_data_home).join("bingooj").join("translation"));
    }

    let home = env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("bingooj")
        .join("translation"))
}

fn translation_support_runtime_dir() -> PathBuf {
    translation_support_root_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("bingooj-translation"))
        .join("runtime")
}

fn translation_support_venv_dir() -> PathBuf {
    translation_support_root_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("bingooj-translation"))
        .join("venv")
}

fn managed_translation_python_path() -> PathBuf {
    let python_name = if cfg!(windows) { "python.exe" } else { "python3" };
    let bin_dir = if cfg!(windows) { "Scripts" } else { "bin" };
    translation_support_venv_dir().join(bin_dir).join(python_name)
}

fn translation_runtime_stage_dir() -> PathBuf {
    translation_support_root_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("bingooj-translation"))
        .join("runtime-stage")
}

fn env_translation_python_path() -> Option<PathBuf> {
    env::var_os("BINGOOJ_TRANSLATION_PYTHON")
        .map(PathBuf::from)
        .filter(|path| path.exists())
}

fn bundled_translation_python_candidates() -> Vec<PathBuf> {
    let python_name = if cfg!(windows) { "python.exe" } else { "python3" };
    let bin_dir = if cfg!(windows) { "Scripts" } else { "bin" };
    let runtime_dir = translation_support_runtime_dir();

    vec![
        runtime_dir.join(bin_dir).join(python_name),
        runtime_dir.join("python").join(bin_dir).join(python_name),
    ]
}

fn managed_bundled_translation_python_path() -> Option<PathBuf> {
    bundled_translation_python_candidates()
        .into_iter()
        .find(|path| path.exists())
}

fn python_version(python_path: &PathBuf) -> Result<(u8, u8), String> {
    let output = Command::new(python_path)
        .arg("--version")
        .output()
        .map_err(|err| format!("read python version failed: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("python --version failed: {}", stderr.trim()));
    }

    let stdout = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).to_string()
    } else {
        String::from_utf8_lossy(&output.stdout).to_string()
    };

    parse_python_version(&stdout)
        .ok_or_else(|| format!("could not parse python version from `{}`", stdout.trim()))
}

fn parse_python_version(text: &str) -> Option<(u8, u8)> {
    let version = text.trim().strip_prefix("Python ")?;
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn is_supported_translation_python(version: (u8, u8)) -> bool {
    version.0 == 3 && (8..=13).contains(&version.1)
}

fn format_python_version(version: (u8, u8)) -> String {
    format!("Python {}.{}", version.0, version.1)
}

fn translation_runtime_download_client() -> Result<BlockingClient, String> {
    BlockingClient::builder()
        .user_agent("BingoOJ/0.1 (+https://github.com/chikee/bingooj)")
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|err| format!("build translation download client failed: {err}"))
}

fn preferred_python_build_versions() -> &'static [&'static str] {
    &["3.12.", "3.11.", "3.10.", "3.13.", "3.9.", "3.8."]
}

fn supported_python_build_suffixes() -> Result<&'static [&'static str], String> {
    match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => Ok(&[
            "x86_64_v3-unknown-linux-gnu-install_only_stripped.tar.gz",
            "x86_64_v2-unknown-linux-gnu-install_only_stripped.tar.gz",
            "x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
        ]),
        ("linux", "aarch64") => Ok(&["aarch64-unknown-linux-gnu-install_only_stripped.tar.gz"]),
        ("macos", "aarch64") => Ok(&["aarch64-apple-darwin-install_only_stripped.tar.gz"]),
        ("macos", "x86_64") => Ok(&["x86_64-apple-darwin-install_only_stripped.tar.gz"]),
        ("windows", "x86_64") => Ok(&["x86_64-pc-windows-msvc-install_only_stripped.tar.gz"]),
        _ => Err(format!(
            "BingoOJ does not have a bundled translation runtime for {} {} yet.",
            env::consts::OS,
            env::consts::ARCH
        )),
    }
}

fn fetch_latest_python_release_metadata(client: &BlockingClient) -> Result<LatestReleaseMetadata, String> {
    let body = client
        .get("https://raw.githubusercontent.com/astral-sh/python-build-standalone/latest-release/latest-release.json")
        .send()
        .map_err(|err| format!("fetch latest python runtime metadata failed: {err}"))?
        .error_for_status()
        .map_err(|err| format!("latest python runtime metadata request failed: {err}"))?
        .text()
        .map_err(|err| format!("read latest python runtime metadata failed: {err}"))?;

    serde_json::from_str::<LatestReleaseMetadata>(&body)
        .map_err(|err| format!("parse latest python runtime metadata failed: {err}"))
}

fn fetch_python_release(client: &BlockingClient, tag: &str) -> Result<GitHubRelease, String> {
    let body = client
        .get(format!(
            "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/{tag}"
        ))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .map_err(|err| format!("fetch python runtime release metadata failed: {err}"))?
        .error_for_status()
        .map_err(|err| format!("python runtime release metadata request failed: {err}"))?
        .text()
        .map_err(|err| format!("read python runtime release metadata failed: {err}"))?;

    serde_json::from_str::<GitHubRelease>(&body)
        .map_err(|err| format!("parse python runtime release metadata failed: {err}"))
}

fn select_python_release_asset(release: &GitHubRelease) -> Result<GitHubReleaseAsset, String> {
    let suffixes = supported_python_build_suffixes()?;

    for version in preferred_python_build_versions() {
        for suffix in suffixes {
            if let Some(asset) = release.assets.iter().find(|asset| {
                asset.name.starts_with(&format!("cpython-{version}"))
                    && asset.name.ends_with(suffix)
                    && !asset.name.contains("freethreaded")
            }) {
                return Ok(asset.clone());
            }
        }
    }

    Err(format!(
        "No compatible bundled Python runtime was found for {} {}.",
        env::consts::OS,
        env::consts::ARCH
    ))
}

fn download_file_with_logs(
    client: &BlockingClient,
    url: &str,
    destination: &Path,
) -> Result<(), String> {
    let mut response = client
        .get(url)
        .send()
        .map_err(|err| format!("download request failed: {err}"))?
        .error_for_status()
        .map_err(|err| format!("download request failed: {err}"))?;

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create runtime download directory failed: {err}"))?;
    }

    let mut file =
        File::create(destination).map_err(|err| format!("create download file failed: {err}"))?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut downloaded = 0_u64;
    let mut last_logged_mb = 0_u64;
    let total_bytes = response.content_length();

    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|err| format!("read download response failed: {err}"))?;
        if read == 0 {
            break;
        }

        file.write_all(&buffer[..read])
            .map_err(|err| format!("write download file failed: {err}"))?;
        downloaded += read as u64;
        let downloaded_mb = downloaded / (1024 * 1024);
        if downloaded_mb >= last_logged_mb + 25 {
            last_logged_mb = downloaded_mb;
            if let Some(total) = total_bytes {
                push_install_log(format!(
                    "Downloaded {} MB / {} MB...",
                    downloaded_mb,
                    total / (1024 * 1024)
                ));
            } else {
                push_install_log(format!("Downloaded {} MB...", downloaded_mb));
            }
        }
    }

    if let Some(total) = total_bytes {
        push_install_log(format!(
            "Runtime archive downloaded ({} MB).",
            total / (1024 * 1024)
        ));
    } else {
        push_install_log("Runtime archive downloaded.".to_string());
    }

    Ok(())
}

fn extract_tar_gz_archive(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let archive_file =
        File::open(archive_path).map_err(|err| format!("open runtime archive failed: {err}"))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    archive
        .unpack(destination)
        .map_err(|err| format!("extract runtime archive failed: {err}"))
}

fn runtime_root_from_python_path(python_path: &Path) -> Option<&Path> {
    python_path.parent()?.parent()
}

fn find_python_root_in_dir(root: &Path) -> Option<PathBuf> {
    let python_name = if cfg!(windows) { "python.exe" } else { "python3" };
    let bin_dir = if cfg!(windows) { "Scripts" } else { "bin" };

    let direct = root.join(bin_dir).join(python_name);
    if direct.exists() {
        return runtime_root_from_python_path(&direct).map(Path::to_path_buf);
    }

    let nested = root.join("python").join(bin_dir).join(python_name);
    if nested.exists() {
        return runtime_root_from_python_path(&nested).map(Path::to_path_buf);
    }

    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }

        let child = entry.path();
        let direct = child.join(bin_dir).join(python_name);
        if direct.exists() {
            return runtime_root_from_python_path(&direct).map(Path::to_path_buf);
        }

        let nested = child.join("python").join(bin_dir).join(python_name);
        if nested.exists() {
            return runtime_root_from_python_path(&nested).map(Path::to_path_buf);
        }
    }

    None
}

fn install_bundled_translation_python_runtime() -> Result<PathBuf, String> {
    let client = translation_runtime_download_client()?;
    let release_metadata = fetch_latest_python_release_metadata(&client)?;
    push_install_log(format!(
        "Using bundled Python runtime release {}.",
        release_metadata.tag
    ));
    let release = fetch_python_release(&client, &release_metadata.tag)?;
    let asset = select_python_release_asset(&release)?;
    push_install_log(format!("Selected runtime asset: {}", asset.name));

    let runtime_dir = translation_support_runtime_dir();
    let stage_dir = translation_runtime_stage_dir();
    let archive_path = stage_dir.join(&asset.name);
    let extract_dir = stage_dir.join("extract");

    if stage_dir.exists() {
        fs::remove_dir_all(&stage_dir)
            .map_err(|err| format!("clear runtime staging directory failed: {err}"))?;
    }
    fs::create_dir_all(&stage_dir)
        .map_err(|err| format!("create runtime staging directory failed: {err}"))?;

    push_install_log("Downloading bundled Python runtime...");
    download_file_with_logs(&client, &asset.browser_download_url, &archive_path)?;

    fs::create_dir_all(&extract_dir)
        .map_err(|err| format!("create runtime extraction directory failed: {err}"))?;
    push_install_log("Extracting bundled Python runtime...");
    extract_tar_gz_archive(&archive_path, &extract_dir)?;

    let extracted_root = find_python_root_in_dir(&extract_dir)
        .ok_or("The bundled Python archive did not contain a usable Python runtime.")?;

    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir)
            .map_err(|err| format!("remove previous bundled runtime failed: {err}"))?;
    }
    if let Some(parent) = runtime_dir.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create bundled runtime directory failed: {err}"))?;
    }

    fs::rename(&extracted_root, &runtime_dir)
        .map_err(|err| format!("install bundled runtime failed: {err}"))?;

    let final_python = managed_bundled_translation_python_path().ok_or(
        "The bundled Python runtime was installed, but python3 could not be found.",
    )?;
    let version = python_version(&final_python)?;
    if !is_supported_translation_python(version) {
        return Err(format!(
            "The bundled Python runtime uses {}, but Argos Translate currently needs Python 3.8-3.13.",
            format_python_version(version)
        ));
    }

    push_install_log(format!(
        "Bundled Python runtime is ready ({}).",
        format_python_version(version)
    ));

    let _ = fs::remove_dir_all(&stage_dir);
    Ok(final_python)
}

fn translation_python_candidates() -> Vec<PathBuf> {
    [
        "python3.13",
        "python3.12",
        "python3.11",
        "python3.10",
        "python3.9",
        "python3.8",
        "python3",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

fn resolve_translation_host_python() -> Result<PathBuf, String> {
    if let Some(env_python) = env_translation_python_path() {
        let version = python_version(&env_python)?;
        if is_supported_translation_python(version) {
            push_install_log(format!(
                "Using translation runtime from BINGOOJ_TRANSLATION_PYTHON ({})",
                format_python_version(version)
            ));
            return Ok(env_python);
        }

        return Err(format!(
            "BINGOOJ_TRANSLATION_PYTHON points to {}, but Argos Translate currently needs Python 3.8-3.13.",
            format_python_version(version)
        ));
    }

    if let Some(bundled_python) = managed_bundled_translation_python_path() {
        match python_version(&bundled_python) {
            Ok(version) if is_supported_translation_python(version) => {
                push_install_log(format!(
                    "Using bundled Python runtime ({})",
                    format_python_version(version)
                ));
                return Ok(bundled_python);
            }
            Ok(version) => {
                push_install_log(format!(
                    "Removing incompatible bundled Python runtime ({})...",
                    format_python_version(version)
                ));
            }
            Err(err) => {
                push_install_log(format!(
                    "Existing bundled Python runtime could not be verified: {err}. Removing it..."
                ));
            }
        }

        let runtime_dir = translation_support_runtime_dir();
        if runtime_dir.exists() {
            fs::remove_dir_all(&runtime_dir)
                .map_err(|err| format!("remove incompatible bundled runtime failed: {err}"))?;
        }
    }

    match find_compatible_system_python() {
        Ok(system_python) => {
            let version = python_version(&system_python)?;
            push_install_log(format!(
                "Using system Python runtime: {} ({})",
                system_python.display(),
                format_python_version(version)
            ));
            Ok(system_python)
        }
        Err(err) => {
            push_install_log(err);
            set_install_phase(1, 4, "Downloading bundled Python runtime");
            push_install_log("No compatible system Python was found. Downloading a bundled Python runtime...");
            install_bundled_translation_python_runtime()
        }
    }
}

fn find_compatible_system_python() -> Result<PathBuf, String> {
    let mut detected = Vec::new();

    for candidate in translation_python_candidates() {
        let output = Command::new(&candidate).arg("--version").output();
        let output = match output {
            Ok(output) => output,
            Err(_) => continue,
        };
        if !output.status.success() {
            continue;
        }

        let text = if output.stdout.is_empty() {
            String::from_utf8_lossy(&output.stderr).to_string()
        } else {
            String::from_utf8_lossy(&output.stdout).to_string()
        };

        if let Some(version) = parse_python_version(&text) {
            detected.push(format!("{} ({})", candidate.display(), format_python_version(version)));
            if is_supported_translation_python(version) {
                return Ok(candidate);
            }
        }
    }

    let detected_text = if detected.is_empty() {
        "none detected".to_string()
    } else {
        detected.join(", ")
    };

    Err(format!(
        "Chinese statement support currently requires Python 3.8-3.13, but this machine only has: {detected_text}. Install a compatible system Python or let BingoOJ provide a bundled translation runtime."
    ))
}

fn translation_support_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("translation_support.py")
}

fn run_translation_support_command(
    python_path: &PathBuf,
    args: &[&str],
    stdin_text: Option<&str>,
) -> Result<Output, String> {
    let script_path = translation_support_script_path();
    if !script_path.exists() {
        return Err(format!(
            "translation support script not found: {}",
            script_path.display()
        ));
    }

    let mut command = Command::new(python_path);
    command
        .arg(&script_path)
        .args(args)
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| format!("spawn translation support command failed: {err}"))?;

    if let Some(text) = stdin_text {
        if let Some(mut input) = child.stdin.take() {
            use std::io::Write;
            input
                .write_all(text.as_bytes())
                .map_err(|err| format!("write translation support stdin failed: {err}"))?;
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|err| format!("read translation support output failed: {err}"))?;

    if output.status.success() {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(stderr.trim().to_string())
}

fn run_translation_support_command_with_logs(
    python_path: &PathBuf,
    args: &[&str],
    stdin_text: Option<&str>,
) -> Result<(), String> {
    let script_path = translation_support_script_path();
    if !script_path.exists() {
        return Err(format!(
            "translation support script not found: {}",
            script_path.display()
        ));
    }

    let mut command = Command::new(python_path);
    command.arg(&script_path).args(args);
    run_command_with_live_logs_input(command, "run translation support command", stdin_text)
}

fn run_command_with_live_logs(
    command: Command,
    label: &str,
) -> Result<(), String> {
    run_command_with_live_logs_input(command, label, None)
}

fn run_command_with_live_logs_input(
    mut command: Command,
    label: &str,
    stdin_text: Option<&str>,
) -> Result<(), String> {
    command
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| format!("spawn {label} failed: {err}"))?;

    if let Some(text) = stdin_text {
        if let Some(mut input) = child.stdin.take() {
            input
                .write_all(text.as_bytes())
                .map_err(|err| format!("write stdin for {label} failed: {err}"))?;
        }
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{label} stdout was not captured"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{label} stderr was not captured"))?;

    let stdout_thread = thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        push_install_log(trimmed.to_string());
                    }
                }
                Err(err) => {
                    push_install_log(format!("stdout read error: {err}"));
                    break;
                }
            }
        }
    });

    let stderr_thread = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        push_install_log(trimmed.to_string());
                    }
                }
                Err(err) => {
                    push_install_log(format!("stderr read error: {err}"));
                    break;
                }
            }
        }
    });

    let status = child
        .wait()
        .map_err(|err| format!("wait for {label} failed: {err}"))?;

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    if status.success() {
        return Ok(());
    }

    Err(format!(
        "{label} failed with status {}",
        status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated".to_string())
    ))
}

fn run_python(code: &str, stdin: &str) -> Result<String, String> {
    run_process_with_input(
        Command::new("python3").arg("-c").arg(code),
        stdin,
        Duration::from_secs(2),
        "python3",
    )
}

fn run_js(code: &str, stdin: &str) -> Result<String, String> {
    let dir = make_temp_dir()?;
    let script_path = dir.join("main.js");
    fs::write(&script_path, code).map_err(|e| format!("write js file failed: {e}"))?;

    let result = run_process_with_input(
        Command::new("node").arg(&script_path),
        stdin,
        Duration::from_secs(2),
        "node",
    );

    let _ = fs::remove_dir_all(&dir);
    result
}

fn run_cpp(code: &str, stdin: &str) -> Result<String, String> {
    let dir = make_temp_dir()?;
    let source_path = dir.join("main.cpp");
    let binary_path = dir.join("main");
    fs::write(&source_path, code).map_err(|e| format!("write cpp file failed: {e}"))?;

    let compile_output = Command::new("g++")
        .arg("-std=c++17")
        .arg("-O2")
        .arg("-pipe")
        .arg(&source_path)
        .arg("-o")
        .arg(&binary_path)
        .output()
        .map_err(|e| format!("spawn g++ failed: {e}"))?;

    if !compile_output.status.success() {
        let message = render_output(compile_output);
        let _ = fs::remove_dir_all(&dir);
        return Ok(if message.trim().is_empty() {
            "Compilation failed.\n".into()
        } else {
            message
        });
    }

    let mut command = Command::new(&binary_path);
    let result = run_process_with_input(
        &mut command,
        stdin,
        Duration::from_secs(2),
        "compiled binary",
    );

    let _ = fs::remove_dir_all(&dir);
    result
}

fn run_process_with_input(
    command: &mut Command,
    stdin: &str,
    timeout: Duration,
    label: &str,
) -> Result<String, String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {label} failed: {e}"))?;

    if let Some(mut input) = child.stdin.take() {
        use std::io::Write;
        input
            .write_all(stdin.as_bytes())
            .map_err(|e| format!("write stdin failed: {e}"))?;
    }

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("read output failed: {e}"))?;
                let mut text = render_output(output);
                if text.trim().is_empty() {
                    text = if status.success() {
                        "OK\n".into()
                    } else {
                        "Error\n".into()
                    };
                }
                return Ok(text);
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(format!("Time limit exceeded ({}s)", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("try_wait failed: {e}")),
        }
    }
}

fn render_output(output: Output) -> String {
    let mut text = String::new();
    if !output.stdout.is_empty() {
        text.push_str(&String::from_utf8_lossy(&output.stdout));
    }
    if !output.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    text
}

fn make_temp_dir() -> Result<PathBuf, String> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock error: {e}"))?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("bingooj-{}-{unique}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| format!("create temp dir failed: {e}"))?;
    Ok(dir)
}

fn extract_sample_text(node: ElementRef<'_>) -> String {
    let mut text = String::new();
    collect_sample_text(*node, &mut text);
    text.replace('\u{a0}', " ").trim_end_matches('\n').to_string()
}

fn collect_sample_text(node: ego_tree::NodeRef<'_, Node>, out: &mut String) {
    match node.value() {
        Node::Text(text) => out.push_str(&text),
        Node::Element(element) if element.name() == "br" => {
            if !out.ends_with('\n') {
                out.push('\n');
            }
            return;
        }
        _ => {}
    }

    for child in node.children() {
        collect_sample_text(child, out);

        if let Some(element) = child.value().as_element() {
            let tag = element.name();
            if (tag == "div" || tag == "p" || tag == "li") && !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
}
