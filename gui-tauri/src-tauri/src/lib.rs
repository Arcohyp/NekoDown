use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn find_project_root() -> anyhow::Result<PathBuf> {
    // Walk upward from the running exe and the current working directory
    // looking for `lib/core.ps1`.
    // Covers three layouts:
    //   1. Dev / portable / NSIS side-by-side:  exe 旁边直接有 lib/
    //   2. Tauri bundled resources/:             exe 旁边有 resources/lib/
    //   3. Source checkout:                      exe 在 gui-tauri/src-tauri/target/
    //                                             向上走到项目根目录
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::current_exe() {
        if let Some(d) = p.parent() { starts.push(d.to_path_buf()); }
    }
    if let Ok(p) = std::env::current_dir() { starts.push(p); }
    for start in starts {
        let mut cur = start.clone();
        for _ in 0..8 {
            // Layout 1: direct
            if cur.join("lib").join("core.ps1").exists() {
                return Ok(cur);
            }
            // Layout 2: Tauri resources/ subdir (NSIS installer default)
            if cur.join("resources").join("lib").join("core.ps1").exists() {
                return Ok(cur.join("resources"));
            }
            if !cur.pop() { break; }
        }
    }
    Err(anyhow::anyhow!(
        "找不到 NekoDown 核心文件 lib/core.ps1。\\n\\n\
        可能原因：\\n\
        1. 你移动了 nekodown-gui.exe 但没有把 lib/ 文件夹一起移动\\n\
        2. 使用的是便携版 zip，但没有完整解压\\n\
        3. 使用的是安装包，但安装目录被手动修改过\\n\\n\
        解决方案：\\n\
        • 确保 nekodown-gui.exe 旁边有 lib/ 文件夹\\n\
        • 或重新下载完整安装包 / 便携 zip 并完整解压"
    ))
}

fn bridge_path() -> Result<PathBuf, String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    Ok(root.join("lib").join("tauri-bridge.ps1"))
}

// ==================== Download Manager ====================

#[derive(Debug)]
struct DownloadManager {
    next_id: AtomicU32,
    processes: Mutex<HashMap<u32, std::process::Child>>,
}

impl DownloadManager {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            next_id: AtomicU32::new(1),
            processes: Mutex::new(HashMap::new()),
        })
    }

    fn register(&self, child: std::process::Child) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.processes.lock().unwrap().insert(id, child);
        id
    }

    fn unregister(&self, id: u32) -> Option<std::process::Child> {
        self.processes.lock().unwrap().remove(&id)
    }

    fn cancel(&self, id: u32) {
        let Some(mut child) = self.processes.lock().unwrap().remove(&id) else {
            // Already finished or never existed — nothing to do.
            return;
        };
        let pid = child.id();
        // Spawn a thread to do the heavy lifting so we don't block the async runtime.
        std::thread::spawn(move || {
            // Kill the entire process tree (PowerShell + aria2c) via taskkill.
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output();
            // Reap the zombie process.
            let _ = child.wait();
        });
    }

    fn cancel_all(&self) {
        let ids: Vec<u32> = self.processes.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.cancel(id);
        }
    }
}

static MANAGER: OnceLock<Arc<DownloadManager>> = OnceLock::new();

#[tauri::command]
fn parse_share(link: String) -> Result<Value, String> {
    let bridge = bridge_path()?;
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", bridge.to_str().ok_or("bad bridge path")?,
            "-Action", "parse",
            "-ShareLink", &link,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to spawn powershell: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    // The bridge prints exactly one JSON line on stdout. Take the last
    // non-empty line so any unexpected chatter doesn't trip the parser.
    let payload = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .ok_or_else(|| format!("empty stdout. stderr=\n{}", stderr))?;
    serde_json::from_str::<Value>(payload)
        .map_err(|e| format!("invalid JSON from bridge: {}\npayload={}\nstderr={}", e, payload, stderr))
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    file: Value,
    domain: String,
    output_dir: String,
    connections: Option<u32>,
) -> Result<u32, String> {
    let manager = MANAGER.get().ok_or("download manager not initialized")?;
    let bridge = bridge_path()?;
    let path = file.get("path").and_then(|v| v.as_str()).ok_or("missing file.path")?.to_string();
    let size = file.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    let rel = file.get("relativePath").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let conn = connections.unwrap_or(0).to_string();

    let mut child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
            "-File", bridge.to_str().ok_or("bad bridge path")?,
            "-Action", "download",
            "-FilePath", &path,
            "-FileSize", &size.to_string(),
            "-RelativePath", &rel,
            "-Domain", &domain,
            "-OutputDir", &output_dir,
            "-Connections", &conn,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn: {}", e))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let app_out = app.clone();
    let app_err = app.clone();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() { continue; }
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                let _ = app_out.emit("download-event", json);
            }
        }
    });
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = app_err.emit("download-log", serde_json::json!({"line": line}));
            }
        }
    });

    let id = manager.register(child);
    let download_id = id;

    // Wait for the child in a background thread so the command returns immediately.
    let manager_clone = manager.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        if let Some(mut child) = manager_clone.unregister(download_id) {
            let payload = match child.wait() {
                Ok(status) if status.success() => {
                    serde_json::json!({ "downloadId": download_id, "success": true })
                }
                Ok(status) => {
                    serde_json::json!({ "downloadId": download_id, "success": false, "code": status.code() })
                }
                Err(e) => {
                    serde_json::json!({ "downloadId": download_id, "success": false, "error": e.to_string() })
                }
            };
            let _ = app_clone.emit("download-finished", payload);
        }
    });

    Ok(id)
}

#[tauri::command]
async fn cancel_download(app: AppHandle, id: u32) -> Result<(), String> {
    let manager = MANAGER.get().ok_or("download manager not initialized")?;
    manager.cancel(id);
    // Emit a finished event so the frontend always resolves its wait-loop,
    // even if the background wait-thread already unregistered the child.
    let _ = app.emit(
        "download-finished",
        serde_json::json!({ "downloadId": id, "success": false, "cancelled": true }),
    );
    Ok(())
}

#[tauri::command]
fn get_default_output_dir() -> Result<String, String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    Ok(root.join("downloads").to_string_lossy().to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("无法访问路径: {}", e))?;
    if !meta.is_dir() {
        return Err("路径不是目录".to_string());
    }
    Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_config() -> Result<Value, String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    let cfg_path = root.join("config.json");
    eprintln!("[get_config] path={:?}", cfg_path);
    if !cfg_path.exists() {
        eprintln!("[get_config] file not found, returning empty object");
        return Ok(serde_json::json!({}));
    }
    let mut raw = std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?;
    // Strip UTF-8 BOM if present so serde_json doesn't choke.
    if raw.starts_with('\u{feff}') {
        raw = raw[3..].to_string();
    }
    eprintln!("[get_config] read {} bytes", raw.len());
    if raw.trim().is_empty() {
        eprintln!("[get_config] file empty, returning empty object");
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str::<Value>(&raw).map_err(|e| {
        eprintln!("[get_config] JSON parse error: {}", e);
        e.to_string()
    })
}

#[tauri::command]
fn save_config(cfg: Value) -> Result<(), String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    let cfg_path = root.join("config.json");
    let pretty = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&cfg_path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

static AUTO_LANG: OnceLock<String> = OnceLock::new();

fn detect_auto_language() -> String {
    // 1. Linux / macOS: LANG / LANGUAGE env vars
    if let Ok(l) = std::env::var("LANG") {
        if l.to_lowercase().starts_with("zh") {
            return "zh-CN".to_string();
        }
    }
    if let Ok(l) = std::env::var("LANGUAGE") {
        if l.to_lowercase().starts_with("zh") {
            return "zh-CN".to_string();
        }
    }
    // 2. Windows: PowerShell Get-UICulture is reliable where env vars are empty
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "(Get-UICulture).Name"])
            .output()
        {
            let locale = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_lowercase();
            if locale.starts_with("zh") {
                return "zh-CN".to_string();
            }
        }
    }
    "en-US".to_string()
}

fn resolve_language(lang: &str) -> String {
    if lang == "auto" || lang.is_empty() {
        AUTO_LANG.get_or_init(detect_auto_language).clone()
    } else {
        lang.to_string()
    }
}

#[tauri::command]
fn get_lang_strings(lang: String) -> Result<Value, String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    let lang_path = root.join("lang.json");
    let mut raw = std::fs::read_to_string(&lang_path).map_err(|e| e.to_string())?;
    // Strip UTF-8 BOM if present.
    if raw.starts_with('\u{feff}') {
        raw = raw[3..].to_string();
    }
    eprintln!("[get_lang_strings] read {} bytes", raw.len());
    if raw.trim().is_empty() {
        eprintln!("[get_lang_strings] file empty");
        return Err("lang.json is empty".to_string());
    }
    let json: Value = serde_json::from_str(&raw).map_err(|e| {
        eprintln!("[get_lang_strings] JSON parse error: {}", e);
        e.to_string()
    })?;
    let resolved = resolve_language(&lang);
    let strings = json.get(&resolved)
        .or_else(|| json.get("en-US"))
        .cloned()
        .ok_or_else(|| format!("language '{}' not found in lang.json", resolved))?;
    Ok(serde_json::json!({
        "lang": resolved,
        "strings": strings,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager = DownloadManager::new();
    MANAGER.set(manager.clone()).expect("failed to initialize download manager");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            parse_share,
            start_download,
            cancel_download,
            get_default_output_dir,
            open_folder,
            get_config,
            save_config,
            get_lang_strings,
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let m = manager.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        m.cancel_all();
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
