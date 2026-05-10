use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

fn find_project_root() -> anyhow::Result<PathBuf> {
    // Walk upward from the running exe and the current working directory
    // looking for `lib/core.ps1`. Works in both `cargo tauri dev` (cwd is
    // src-tauri/) and the bundled exe (next to lib/ once shipped).
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::current_exe() {
        if let Some(d) = p.parent() { starts.push(d.to_path_buf()); }
    }
    if let Ok(p) = std::env::current_dir() { starts.push(p); }
    for start in starts {
        let mut cur = start.clone();
        for _ in 0..8 {
            if cur.join("lib").join("core.ps1").exists() {
                return Ok(cur);
            }
            if !cur.pop() { break; }
        }
    }
    Err(anyhow::anyhow!("could not locate NekoDown project root (looking for lib/core.ps1)"))
}

fn bridge_path() -> Result<PathBuf, String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    Ok(root.join("lib").join("tauri-bridge.ps1"))
}

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
) -> Result<(), String> {
    let bridge = bridge_path()?;
    let path = file.get("path").and_then(|v| v.as_str()).ok_or("missing file.path")?.to_string();
    let size = file.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    let rel  = file.get("relativePath").and_then(|v| v.as_str()).unwrap_or("").to_string();

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

    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("powershell exit code {:?}", status.code()))
    }
}

#[tauri::command]
fn get_default_output_dir() -> Result<String, String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    Ok(root.join("downloads").to_string_lossy().to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
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
    if !cfg_path.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw = std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?;
    serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_config(cfg: Value) -> Result<(), String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    let cfg_path = root.join("config.json");
    let pretty = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&cfg_path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

fn resolve_language(lang: &str) -> String {
    if lang == "auto" || lang.is_empty() {
        // Look at the OS locale; default to en-US if anything looks off.
        let locale = std::env::var("LANG")
            .ok()
            .or_else(|| std::env::var("LANGUAGE").ok())
            .unwrap_or_default();
        if locale.starts_with("zh") {
            return "zh-CN".to_string();
        }
        // On Windows, fall back to GetUserDefaultLocaleName via PowerShell-free probe:
        // the system locale env vars above may be empty. Use the legacy registry-derived
        // default — for now just return en-US as fallback.
        return "en-US".to_string();
    }
    lang.to_string()
}

#[tauri::command]
fn get_lang_strings(lang: String) -> Result<Value, String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    let lang_path = root.join("lang.json");
    let raw = std::fs::read_to_string(&lang_path).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            parse_share,
            start_download,
            get_default_output_dir,
            open_folder,
            get_config,
            save_config,
            get_lang_strings,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
