use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, OnceLock,
};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

// ==================== Embedded Resources ====================
// PowerShell scripts and language pack are compiled into the binary so that
// the GUI can run from a single exe without any side-car files.
//
// Green-first strategy: try to extract next to the exe (portable / USB mode).
// If the exe directory is read-only (e.g. Program Files), fall back to
// %LOCALAPPDATA%\NekoDown.

const CORE_PS1:      &str = include_str!("../../../lib/core.ps1");
const I18N_PS1:      &str = include_str!("../../../lib/i18n.ps1");
const LOG_PS1:       &str = include_str!("../../../lib/log.ps1");
const BRIDGE_PS1:    &str = include_str!("../../../lib/tauri-bridge.ps1");
const LANG_JSON:     &str = include_str!("../../../lang.json");

fn get_local_app_data_dir() -> anyhow::Result<PathBuf> {
    let local = std::env::var("LOCALAPPDATA")
        .map_err(|_| anyhow::anyhow!("无法获取 LOCALAPPDATA 环境变量"))?;
    Ok(PathBuf::from(local).join("NekoDown"))
}

/// Write all embedded resources into `root`.
fn extract_resources_to(root: &std::path::Path) -> anyhow::Result<()> {
    let lib_dir = root.join("lib");

    let scripts = [
        ("core.ps1", CORE_PS1),
        ("i18n.ps1", I18N_PS1),
        ("log.ps1", LOG_PS1),
        ("tauri-bridge.ps1", BRIDGE_PS1),
    ];

    for (name, content) in scripts {
        let path = lib_dir.join(name);
        let needs_write = if path.exists() {
            let existing = std::fs::read_to_string(&path).unwrap_or_default();
            existing != content
        } else {
            true
        };
        if needs_write {
            std::fs::create_dir_all(&lib_dir)?;
            std::fs::write(&path, content)?;
        }
    }

    // lang.json
    let lang_path = root.join("lang.json");
    let needs_write = if lang_path.exists() {
        let existing = std::fs::read_to_string(&lang_path).unwrap_or_default();
        let existing_clean = if existing.starts_with('\u{feff}') {
            existing[3..].to_string()
        } else {
            existing
        };
        existing_clean != LANG_JSON
    } else {
        true
    };
    if needs_write {
        std::fs::write(&lang_path, LANG_JSON)?;
    }

    Ok(())
}

/// Try to write a test file next to the exe to see if the directory is writable.
fn is_dir_writable(path: &std::path::Path) -> bool {
    let probe = path.join("._nekodown_writable_test");
    match std::fs::write(&probe, b"1") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Extract embedded scripts/lang.json so the app can run standalone.
///
/// Priority:
///   1. Next to the exe if the directory is writable (green / portable mode).
///   2. %LOCALAPPDATA%\NekoDown (fallback for read-only installs).
fn ensure_resources_extracted() -> anyhow::Result<PathBuf> {
    // Try green mode first.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            if is_dir_writable(exe_dir) {
                extract_resources_to(exe_dir)?;
                return Ok(exe_dir.to_path_buf());
            }
        }
    }

    // Fallback to LOCALAPPDATA.
    let app_dir = get_local_app_data_dir()?;
    extract_resources_to(&app_dir)?;
    Ok(app_dir)
}

fn find_project_root() -> anyhow::Result<PathBuf> {
    // Walk upward from the running exe and the current working directory
    // looking for `lib/core.ps1`.
    // Covers four layouts:
    //   1. Dev / portable / NSIS side-by-side:  exe 旁边直接有 lib/
    //   2. Tauri bundled resources/:             exe 旁边有 resources/lib/
    //   3. Source checkout:                      exe 在 gui-tauri/src-tauri/target/
    //                                             向上走到项目根目录
    //   4. Single-exe fallback:                  resources extracted to %LOCALAPPDATA%\NekoDown
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
    // Layout 4: fallback to extracted resources in LOCALAPPDATA
    if let Ok(app_dir) = get_local_app_data_dir() {
        if app_dir.join("lib").join("core.ps1").exists() {
            return Ok(app_dir);
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
    finished_ids: Mutex<HashSet<u32>>,
}

impl DownloadManager {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            next_id: AtomicU32::new(1),
            processes: Mutex::new(HashMap::new()),
            finished_ids: Mutex::new(HashSet::new()),
        })
    }

    fn register(&self, child: std::process::Child) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.processes.lock().insert(id, child);
        id
    }

    fn unregister(&self, id: u32) -> Option<std::process::Child> {
        self.processes.lock().remove(&id)
    }

    fn cancel(&self, id: u32) {
        let Some(mut child) = self.processes.lock().remove(&id) else {
            // Already finished or never existed — nothing to do.
            return;
        };
        let pid = child.id();
        // Spawn a thread to do the heavy lifting so we don't block the async runtime.
        std::thread::spawn(move || {
            // Kill the entire process tree (PowerShell + aria2c) via taskkill.
            let mut cmd = Command::new("taskkill");
            cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
            set_no_window(&mut cmd);
            let _ = cmd.output();
            // Reap the zombie process.
            let _ = child.wait();
        });
    }

    fn cancel_all(&self) {
        let ids: Vec<u32> = self.processes.lock().keys().cloned().collect();
        for id in ids {
            self.cancel(id);
        }
    }

    fn try_emit_finished(&self, id: u32, app: &AppHandle, payload: Value) {
        let mut finished = self.finished_ids.lock();
        if finished.insert(id) {
            let _ = app.emit("download-finished", payload);
        }
    }
}

static MANAGER: OnceLock<Arc<DownloadManager>> = OnceLock::new();

/// Prevent console window popup on Windows (CREATE_NO_WINDOW).
#[cfg(target_os = "windows")]
fn set_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn set_no_window(_cmd: &mut Command) {}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(default = "default_output_dir")]
    default_output_dir: String,
    #[serde(default = "default_connections")]
    default_connections: u32,
    #[serde(default = "default_auto_retry")]
    auto_retry: bool,
    #[serde(default = "default_max_retries")]
    max_retries: u32,
    #[serde(default = "default_log_enabled")]
    log_enabled: bool,
    #[serde(default = "default_check_disk_space")]
    check_disk_space: bool,
    #[serde(default = "default_min_free_space_gb")]
    min_free_space_gb: u32,
    #[serde(default)]
    proxy: String,
    #[serde(default = "default_language")]
    language: String,
    #[serde(default = "default_sound_enabled")]
    sound_enabled: bool,
    #[serde(default = "default_close_action")]
    close_action: String,
    #[serde(default = "default_remember_close_action")]
    remember_close_action: bool,
}

impl AppConfig {
    fn with_root(root: &std::path::Path) -> Self {
        Self {
            default_output_dir: root.join("downloads").to_string_lossy().to_string(),
            default_connections: 16,
            auto_retry: true,
            max_retries: 3,
            log_enabled: true,
            check_disk_space: true,
            min_free_space_gb: 2,
            proxy: String::new(),
            language: "auto".to_string(),
            sound_enabled: true,
            close_action: "ask".to_string(),
            remember_close_action: false,
        }
    }
}

fn default_output_dir() -> String {
    find_project_root()
        .map(|r| r.join("downloads").to_string_lossy().to_string())
        .unwrap_or_else(|_| "downloads".to_string())
}

fn default_connections() -> u32 { 16 }
fn default_auto_retry() -> bool { true }
fn default_max_retries() -> u32 { 3 }
fn default_log_enabled() -> bool { true }
fn default_check_disk_space() -> bool { true }
fn default_min_free_space_gb() -> u32 { 2 }
fn default_language() -> String { "auto".to_string() }
fn default_sound_enabled() -> bool { true }
fn default_close_action() -> String { "ask".to_string() }
fn default_remember_close_action() -> bool { false }

#[tauri::command]
fn parse_share(link: String) -> Result<Value, String> {
    let bridge = bridge_path()?;
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", bridge.to_str().ok_or("bad bridge path")?,
        "-Action", "parse",
        "-ShareLink", &link,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    set_no_window(&mut cmd);
    let output = cmd.output()
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

    let mut cmd = Command::new("powershell");
    cmd.args([
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
    .stderr(Stdio::piped());
    set_no_window(&mut cmd);
    let mut child = cmd.spawn()
        .map_err(|e| format!("failed to spawn: {}", e))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let app_out = app.clone();
    let app_err = app.clone();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if !line.trim().is_empty() {
                        if let Ok(json) = serde_json::from_str::<Value>(&line) {
                            let _ = app_out.emit("download-event", json);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[stdout] reader error (progress events may stall): {}", e);
                    break;
                }
            }
        }
    });
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if !line.trim().is_empty() {
                        let _ = app_err.emit("download-log", serde_json::json!({"line": line}));
                    }
                }
                Err(e) => {
                    eprintln!("[stderr] reader error: {}", e);
                    break;
                }
            }
        }
    });

    let id = manager.register(child);
    let download_id = id;

    // Wait for the child in a background thread so the command returns immediately.
    let manager_clone = manager.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let payload = if let Some(mut child) = manager_clone.unregister(download_id) {
            match child.wait() {
                Ok(status) if status.success() => {
                    serde_json::json!({ "downloadId": download_id, "success": true })
                }
                Ok(status) => {
                    serde_json::json!({ "downloadId": download_id, "success": false, "code": status.code() })
                }
                Err(e) => {
                    serde_json::json!({ "downloadId": download_id, "success": false, "error": e.to_string() })
                }
            }
        } else {
            serde_json::json!({ "downloadId": download_id, "success": false, "cancelled": true })
        };
        manager_clone.try_emit_finished(download_id, &app_clone, payload);
    });

    Ok(id)
}

#[tauri::command]
async fn cancel_download(app: AppHandle, id: u32) -> Result<(), String> {
    let manager = MANAGER.get().ok_or("download manager not initialized")?;
    manager.cancel(id);
    // Emit a finished event so the frontend always resolves its wait-loop,
    // even if the background wait-thread already unregistered the child.
    manager.try_emit_finished(
        id,
        &app,
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
fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).exists()).collect()
}

#[tauri::command]
fn get_config() -> Result<Value, String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    let cfg_path = root.join("config.json");
    eprintln!("[get_config] path={:?}", cfg_path);
    if !cfg_path.exists() {
        eprintln!("[get_config] file not found, returning default config");
        let cfg = AppConfig::with_root(&root);
        return serde_json::to_value(&cfg).map_err(|e| e.to_string());
    }
    let mut raw = std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?;
    // Strip UTF-8 BOM if present so serde_json doesn't choke.
    if raw.starts_with('\u{feff}') {
        raw = raw[3..].to_string();
    }
    eprintln!("[get_config] read {} bytes", raw.len());
    if raw.trim().is_empty() {
        eprintln!("[get_config] file empty, returning default config");
        let cfg = AppConfig::with_root(&root);
        return serde_json::to_value(&cfg).map_err(|e| e.to_string());
    }
    let cfg: AppConfig = serde_json::from_str(&raw).map_err(|e| {
        eprintln!("[get_config] JSON parse error: {}", e);
        format!("配置格式无效: {}", e)
    })?;
    serde_json::to_value(&cfg).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_config(cfg: Value) -> Result<(), String> {
    let root = find_project_root().map_err(|e| e.to_string())?;
    let cfg_path = root.join("config.json");
    // Validate against schema before writing.
    let _validated: AppConfig = serde_json::from_value(cfg.clone())
        .map_err(|e| format!("配置格式无效: {}", e))?;
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
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(update.version.clone())),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Err("no_update_available".to_string()),
        Err(e) => return Err(e.to_string()),
    };

    let download_url = update.download_url.clone();
    let version = update.version.clone();

    // Manually download the installer, bypassing the plugin's broken
    // verify_signature (which crashes when pubkey is "").
    let _ = app.emit("update-state", serde_json::json!({ "state": "downloading" }));

    let client = reqwest::Client::builder()
        .user_agent(&format!("NekoDown-Updater/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(download_url.as_str())
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with HTTP {}",
            response.status()
        ));
    }

    let total_size: Option<u64> = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Download error: {e}"))?;
    let _ = app.emit(
        "update-state",
        serde_json::json!({
            "state": "downloading",
            "downloaded": bytes.len(),
            "total": total_size
        }),
    );

    let _ = app.emit("update-state", serde_json::json!({ "state": "installing" }));

    // Write downloaded bytes to temp file
    let temp_dir = std::env::temp_dir().join(format!("nekodown-update-{}", version));
    let installer_path =
        temp_dir.join(format!("NekoDown_{}_x64-setup.exe", version));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {e}"))?;
    std::fs::write(&installer_path, &bytes)
        .map_err(|e| format!("Failed to write installer: {e}"))?;

    // Run the NSIS installer
    // The v3.4.0+ NSIS installer supports /UPDATE (built with createUpdaterArtifacts).
    // /S ensures silent (non-interactive) installation.
    let status = std::process::Command::new(&installer_path)
        .args(["/S", "/UPDATE"])
        .status()
        .map_err(|e| format!("Failed to launch installer: {e}"))?;

    if !status.success() {
        return Err(format!("Installer exited with: {:?}", status.code()));
    }

    // Clean up downloaded installer before spawning new instance.
    let _ = std::fs::remove_dir_all(&temp_dir);

    // Spawn a fresh instance (so the user lands on the updated app)
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).spawn();
    }
    std::process::exit(0);
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
    // Ensure embedded scripts are available on disk (single-exe mode).
    if let Err(e) = ensure_resources_extracted() {
        eprintln!("[warn] 无法释放内置资源到 APPDATA: {}", e);
    }

    let manager = DownloadManager::new();
    if MANAGER.set(manager.clone()).is_err() {
        eprintln!("[warn] download manager already initialized");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            parse_share,
            start_download,
            cancel_download,
            get_default_output_dir,
            open_folder,
            get_config,
            save_config,
            get_lang_strings,
            get_version,
            check_update,
            install_update,
            paths_exist,
            minimize_window,
            maximize_window,
            hide_window,
            show_window,
            exit_app,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let main_window = app.get_webview_window("main")
                .ok_or_else(|| anyhow::anyhow!("主窗口未找到"))?;

            // --- Tray Icon: left-click shows window ---
            if let Some(tray) = app.tray_by_id("main-tray") {
                let win = main_window.clone();
                tray.on_tray_icon_event(move |_tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                });
            }

            // --- Close confirmation ---
            {
                let _win = main_window.clone();
                let ah = app_handle.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // Always prevent default close; let frontend decide.
                        api.prevent_close();
                        let _ = ah.emit("show-exit-confirm", ());
                    }
                });
            }

            // --- Cancel active downloads on explicit exit ---
            {
                let m = manager.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        m.cancel_all();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ==================== Window Control Commands ====================

#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn maximize_window(window: tauri::WebviewWindow) {
    if let Ok(true) = window.is_maximized() {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn show_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}
