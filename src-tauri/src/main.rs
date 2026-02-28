#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::Client;
use scraper::{ElementRef, Html, Node, Selector};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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
        .invoke_handler(tauri::generate_handler![run_code, cf_fetch_problem, cf_list_problems])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
