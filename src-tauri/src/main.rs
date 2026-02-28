#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{process::Command, time::Duration};

#[tauri::command]
fn run_python(code: String, stdin: String) -> Result<String, String> {
    // 用 python3 执行传入代码，通过 stdin 喂输入，抓 stdout/stderr
    // 先不做沙箱，只做最小闭环
    let mut child = Command::new("python3")
        .arg("-c")
        .arg(code)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn python3 failed: {e}"))?;

    // 写入 stdin
    if let Some(mut s) = child.stdin.take() {
        use std::io::Write;
        s.write_all(stdin.as_bytes())
            .map_err(|e| format!("write stdin failed: {e}"))?;
    }

    // 粗糙超时：用 wait_timeout（避免引第三方库就先不搞精致）
    // 这里用轮询方式实现一个简易 timeout
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = child
                    .wait_with_output()
                    .map_err(|e| format!("read output failed: {e}"))?;

                let mut text = String::new();
                if !out.stdout.is_empty() {
                    text.push_str(&String::from_utf8_lossy(&out.stdout));
                }
                if !out.stderr.is_empty() {
                    if !text.is_empty() {
                        text.push_str("\n");
                    }
                    text.push_str(&String::from_utf8_lossy(&out.stderr));
                }
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
                if start.elapsed() > Duration::from_secs(2) {
                    let _ = child.kill();
                    return Err("Time limit exceeded (2s)".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("try_wait failed: {e}")),
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_python])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

