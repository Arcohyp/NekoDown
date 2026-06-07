# NekoDown

**A Cloudreve share link downloader optimised for the NekoGAL community**

[中文](../README.md) | English | [NekoGAL](https://www.nekogal.com/) | [Download](https://github.com/Arcohyp/NekoDown/releases) | [Issues](https://github.com/Arcohyp/NekoDown/issues)

NekoDown provides both a native GUI and a command-line interface for downloading Cloudreve share links. It auto-invokes aria2 for multi-threaded downloads, supports CJK filenames, resume interrupted downloads, disk-space checks, and automatic retries.

> 🐾 **Deeply optimised for [NekoGAL](https://www.nekogal.com/)** — fully supports its Cloudflare R2 storage backend, large-file downloads, and Chinese/Japanese filename handling.

---

## ✨ Features

- 🪟 **Native GUI** (Tauri + WebView2): dark / light dual-theme switching, single-file `.exe` ~5 MB
- 📦 **Single-file executable**: `nekodown-gui.exe` bundles all scripts and language packs; extracts automatically on first launch — no need to carry a `lib/` folder
- 🌿 **Portable-first**: extracts next to the executable (desktop, USB, etc.); falls back to `%LOCALAPPDATA%` if the directory is read-only
- ⌨️ **Command-line version** (PowerShell): pure `.ps1` scripts, zero dependencies
- 🚀 **Multi-threaded acceleration**: aria2 multi-connection downloads, configurable 1–64 connections
- 📦 **Auto-install aria2**: downloads to `tools/aria2/` automatically on first run — no manual setup
- 🌍 **Bilingual UI**: auto-detects system language; supports `zh-CN` / `en-US`
- 🔄 **Resume interrupted downloads**: detects `.aria2` control files and resumes automatically
- 🛡️ **Safe filenames**: sanitises Windows reserved names and invalid characters (CON/PRN/…)
- 💾 **Disk-space check**: verifies available space before downloading

### 🎨 Theme Preview

| Neko Dark | Neko Light |
|:---------:|:----------:|
| ![Neko Dark](ui_theme_neko.png) | ![Neko Light](ui_theme_sakura.png) |

---

## 📥 Download

Grab the latest release from [GitHub Releases](https://github.com/Arcohyp/NekoDown/releases):

| File | Purpose |
|------|---------|
| `NekoDown_x.y.z_x64-setup.exe` | **NSIS installer** (recommended) — creates Start Menu shortcuts and an uninstall entry |
| `nekodown-gui.exe` | **Single-file GUI** — drop it anywhere and double-click; required files auto-extract on first launch |
| `NekoDown_x.y.z_x64-portable.zip` | **Full portable package** — includes CLI tools (`neko-down.ps1` + `lib/`), no installation |

---

## 🚀 Quick Start

### GUI Users

1. Double-click `NekoDown_x.y.z_x64-setup.exe` to install, or just drop `nekodown-gui.exe` anywhere you like
2. Launch NekoDown, paste a Cloudreve share link into the top input box
3. Click **Parse**, wait for the file list to load, then click **Start Download**
4. Click the 🎨 button in the top-right to switch themes

> Even if you only copied the single `nekodown-gui.exe`, it will auto-extract the required `lib/` scripts and `lang.json` on first launch (preferably next to the executable, or falls back to `%LOCALAPPDATA%\NekoDown` if the directory is read-only).

Supported link formats:

```
https://pan.nekogal.top/s/xxxxx
https://pan.nekogal.top/home?path=cloudreve%3A%2F%2Fxxxxx%40share
https://share.nekogal.top/home?path=cloudreve%3A%2F%2Fxxxxx%40share
https://pan.xxx.com/s/xxxxx        (any Cloudreve v4 instance)
```

### CLI Users

```powershell
# Interactive mode
.\neko-down.ps1

# Direct link
.\neko-down.ps1 -ShareLink "https://pan.nekogal.top/s/yE4u7"

# Custom directory & connections
.\neko-down.ps1 -ShareLink "..." -OutputDir "D:\Downloads" -Aria2Connections 32
```

Or double-click the `双击运行.cmd` launcher in the project root.

---

## ⚙️ Configuration

Edit `config.json` (shared by GUI and CLI):

```json
{
  "defaultOutputDir": "C:\\NekoDown\\downloads",
  "defaultConnections": 16,
  "autoRetry": true,
  "maxRetries": 3,
  "logEnabled": true,
  "checkDiskSpace": true,
  "minFreeSpaceGB": 2,
  "proxy": "",
  "language": "auto"
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `defaultOutputDir` | Default download directory | `<install dir>/downloads` |
| `defaultConnections` | aria2 connection count (1–64) | `16` |
| `maxRetries` | Number of retry attempts | `3` |
| `proxy` | HTTP proxy | `""` |
| `language` | `auto` / `zh-CN` / `en-US` | `auto` |

The GUI settings panel mirrors this configuration in a graphical form.

---

## 🏗️ Architecture

```
NekoDown/
├── neko-down.ps1            CLI entry (thin 225-line wrapper, dot-sources lib/*)
├── config.json              Shared configuration
├── lang.json                Bilingual dictionary (125 keys)
├── lib/
│   ├── core.ps1             Download core (API, aria2, Start-FileDownload)
│   ├── i18n.ps1             Localisation (L function + lang.json loader)
│   ├── log.ps1              Logger class + console output helpers
│   └── tauri-bridge.ps1     JSON-lines bridge for Rust invocation
├── gui-tauri/               Tauri 2 GUI project
│   ├── src/                 Frontend (HTML + CSS + JS)
│   └── src-tauri/           Backend (Rust)
└── 双击运行.cmd              CLI launcher
```

The GUI uses a Tauri architecture: the Rust backend handles the window shell, process orchestration, and resource extraction; the actual download logic is shared with the CLI via `lib/`. At compile time, `lib/*.ps1` and `lang.json` are embedded into the binary via `include_str!`, so the single `nekodown-gui.exe` can run standalone. On first launch, embedded resources are extracted to disk (portable-first, with a fallback to `%LOCALAPPDATA%`). The frontend communicates with Rust via `invoke()`, and progress events stream back to the UI through Tauri events.

---

## 🔧 Building from Source

### CLI

No build required — just run `.\neko-down.ps1`.

### GUI

Prerequisites:

- [Rust](https://rustup.rs/) (install via rustup)
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (include "Desktop development with C++" workload)
- WebView2 runtime (included in Windows 10/11)

```powershell
cd gui-tauri
cargo install tauri-cli --locked
cargo tauri dev          # Development mode (hot reload)
cargo tauri build        # Build release .exe + NSIS installer
```

Build artifacts are in `gui-tauri/src-tauri/target/release/`:

- `nekodown-gui.exe` — portable executable
- `bundle/nsis/NekoDown_*_x64-setup.exe` — NSIS installer

---

## ❓ FAQ

### Double-clicking `.cmd` flashes and closes

In CLI mode: check the `logs/` directory. Usually this means aria2 auto-installation failed (internet required on first run). Manual install: `winget install aria2.aria2`.

### Download returns 403 Forbidden

NekoGAL's R2 storage occasionally rate-limits single IPs; the script already sets browser-level request headers. Try using a proxy or downloading at a different time.

### GUI is blank / unresponsive

Check if WebView2 is installed: `Get-AppxPackage Microsoft.WebView2`. Older Windows 10 builds may need a separate install: https://developer.microsoft.com/microsoft-edge/webview2/

### CJK filenames are garbled

`v3.0+` enforces UTF-8. If older Windows still shows garbled text, go to *Region Settings → Administrative → Change system locale* and check "Use Unicode UTF-8 for worldwide language support".

### Can I download from Cloudreve instances other than NekoGAL?

Yes. `Parse-ShareLink` auto-detects `https://pan.xxx.com/s/xxxxx` for any Cloudreve v4 instance.

---

## 📝 Changelog

See [GitHub Releases](https://github.com/Arcohyp/NekoDown/releases).

### v3.4.2 (2026-06-07)

- 🔒 **Removed auto-install updater**: replaced automatic download/install with a link to GitHub Releases, eliminating the RCE risk of executing unsigned EXEs
- 🛡️ **Security hardening**: `Sanitize-FileName` now filters Unicode full-width slashes; Windows reserved-name checks now include `CLOCK$`/`COM0`/`LPT0`

> Earlier versions: [GitHub Releases](https://github.com/Arcohyp/NekoDown/releases).

---

## ⚠️ Disclaimer

- Cloudreve temporary download links expire in about 1 hour; the script auto-refreshes them
- Some antivirus software may flag PowerShell scripts; please add an exclusion if needed
- Respect copyright — this tool is intended only for content you have permission to access

---

**Made with 🐾 for the [NekoGAL](https://www.nekogal.com/) community.**
