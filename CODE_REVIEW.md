# NekoDown 代码审查报告

> 基于 `fuck-u-code` 原始报告修正，排除第三方库/编译产物，仅分析项目自有代码

---

## 总体评估

| 维度 | 评级 | 说明 |
|------|------|------|
| **架构设计** | B+ | Tauri+PowerShell 混合架构合理，但跨语言通信存在脆弱点 |
| **代码质量** | B | Rust 端基本规范，JS 端状态管理较混乱，PS 端健壮性不足 |
| **安全性** | C+ | 存在命令注入风险、路径遍历隐患、未验证的下载文件执行 |
| **可维护性** | B- | 函数过长、职责混杂、错误处理不统一 |
| **可靠性** | C+ | 竞态条件、资源泄漏、悬空 Promise、空 catch 块 |

**综合评分: 72/100** — 能跑，但有明显隐患

---

## 🔴 高风险问题

### 1. 自动更新执行未验证的下载器（RCE 风险）

**位置**: `gui-tauri/src-tauri/src/lib.rs:638`

```rust
let status = std::process::Command::new(&installer_path)
    .args(["/S", "/UPDATE"])
    .status()
```

**问题**: 
- 从网络下载的 `.exe` 未做签名验证直接执行（注释说绕过了签名验证）
- `installer_path` 位于用户可写的 `%TEMP%` 目录，恶意软件可提前占位
- 中间人攻击可替换下载内容

**建议**: 
- 恢复签名验证（修复 pubkey 配置而非绕过）
- 下载后校验 SHA256 checksum
- 避免从 `%TEMP%` 执行，先复制到程序目录再运行

---

### 2. PowerShell 命令注入

**位置**: `gui-tauri/src-tauri/src/lib.rs:350-362`

```rust
let mut cmd = Command::new("powershell");
cmd.args([
    "-File", bridge.to_str().ok_or("bad bridge path")?,
    "-FilePath", &path,   // <- 用户可控的文件路径直接传入
    "-OutputDir", &output_dir, // <- 用户可控的目录
]);
```

**问题**: `FilePath`、`OutputDir`、`Domain` 等参数来自前端输入，虽然 bridge 脚本用了 `param()` 声明，但如果路径包含特殊字符（如 `"`; `; rm -rf /`），仍可能被 PowerShell 解析器误解释。

**建议**: 
- 对路径参数做白名单校验（只允许合法路径字符）
- 使用 `std::process::Command` 的参数列表特性（已做，但要确保 PowerShell 脚本内部不使用字符串拼接）
- 在 PS 端用 `[System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent()` 二次保护

---

### 3. 竞态条件：下载完成事件可能丢失

**位置**: `gui-tauri/src-tauri/src/lib.rs:416-433`

```rust
std::thread::spawn(move || {
    let payload = if let Some(mut child) = manager_clone.unregister(download_id) {
        match child.wait() {
```

**问题**: 
- `unregister` 和 `wait` 之间，如果 `cancel_download` 被调用，进程已被 kill，这里可能 panic 或返回错误状态
- `try_emit_finished` 依赖 `finished_ids` 去重，但如果前端 listener 还没注册，事件丢失

**建议**: 
- 使用 Tokio 的 `tokio::process` + `tokio::select!` 替代裸线程
- 为每个 download 维护一个 `oneshot::channel`，cancel 时发送取消信号

---

## 🟡 中风险问题

### 4. main.js 状态管理混乱

**位置**: `gui-tauri/src/main.js`

```javascript
const state = {
  progressByPath: new Map(),
  sparkData: new Map(),
  activeDownloads: new Map(),
  cancelling: new Set(),
  cancelled: false,
};
```

**问题**:
- `cancelled` 是全局标志，影响所有下载，但按钮事件是并发的
- `activeDownloads` 同时在前端和 Rust 端维护，状态不同步
- `progressByPath` 用 `file.path` 做 key，如果同一文件下载两次会冲突
- `batchUnlisten` 在 `onDownload` 末尾清理，但如果异常提前退出，listener 泄漏

**建议**:
- 引入状态机（idle → parsing → downloading → completed）
- 用 downloadId（Rust 分配的 u32）作为唯一标识，而非 file.path

---

### 5. 空 catch 块 + 静默吞异常

**位置**: `gui-tauri/src/main.js:929`

```javascript
try {
  const text = await readText();
  // ...
} catch (e) { /* ignore */ }
```

**位置**: `gui-tauri/src/main.js:739`

```javascript
await Promise.all(ids.map((id) => invoke("cancel_download", { id }).catch(() => {})));
```

**问题**: 异常被静默丢弃，用户不知道发生了什么，调试困难。

**建议**: 至少写 `console.warn`，或者使用 `console.error(e)`。

---

### 6. PowerShell 脚本缺乏严格模式

**位置**: `lib/core.ps1`, `lib/tauri-bridge.ps1`

```powershell
# 只在 bridge 设置了 $ErrorActionPreference = "Stop"
# core.ps1 中很多函数没有 [CmdletBinding()] 和 param 类型声明
```

**问题**:
- `core.ps1` 的函数没有 `[CmdletBinding()]`，传错参数不会报错
- 没有 `#Requires -Version` 统一声明
- 大量 `try { ... } catch { Write-Warn "..." }` 吞掉异常后继续执行，可能导致后续逻辑基于无效数据运行

**建议**:
- 所有文件顶部统一 `#Requires -Version 5.1`
- 所有函数加 `[CmdletBinding()]` 和 `[OutputType()]`
- `catch` 块至少写 `throw $_` 让调用者决定

---

### 7. 路径遍历：sanitize 不够严格

**位置**: `lib/core.ps1:377`

```powershell
function Sanitize-FileName {
    $name = $name -replace '[\/]', '_'
    $name = $name -replace '\.{2,}', '_'
```

**问题**:
- 只替换了 `/` 和 `\`，但 Unicode 变体（如 `／`、`＼`）可以绕过
- `../` 在 `-replace` 之前可能被拆分成 `.` 和 `/` 分别处理，存在绕过的可能
- Windows 保留名检查不全面（缺少 `CLOCK$`、`COM0`、`LPT0`）

**建议**:
- 使用 .NET 的 `[System.IO.Path]::GetInvalidFileNameChars()` 遍历所有非法字符
- 对最终路径用 `Resolve-Path` 校验是否在目标目录内

---

### 8. 资源泄漏：Confetti canvas 未清理兜底

**位置**: `gui-tauri/src/main.js:90-157`

```javascript
function fireConfetti(x, y) {
  const canvas = document.createElement("canvas");
  // ...
  if (alive && ts - startTime < 2500) {
    requestAnimationFrame(animate);
  } else {
    canvas.remove();
  }
}
```

**问题**: 如果 `ts - startTime >= 2500` 但还有粒子存活，canvas 不会被移除。

**建议**: 条件改为 `if (alive) { requestAnimationFrame(animate); } else { canvas.remove(); }`，把 2500ms 作为 `startTime` 的判断前置。

---

### 9. 音频上下文未恢复

**位置**: `gui-tauri/src/main.js:61-75`

```javascript
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
```

**问题**:
- 没有处理 `audioCtx.state === 'suspended'` 的情况（浏览器策略限制）
- 多次调用 `playTone` 创建新 oscillator 但没有重用节点

**建议**: 在 `init()` 中加 `audioCtx.resume()` 的用户交互触发。

---

### 10. CSS 全局污染

**位置**: `gui-tauri/src/styles.css`

```css
* { box-sizing: border-box; }
```

**问题**: 虽然这个项目是独立 WebView，但全局 `*` 选择器可能影响 WebView 内部的其他组件（如 Tauri 的对话框）。

**建议**: 限定在 `.app` 或 `#app` 内。

---

## 🟢 低风险 / 代码异味

### 11. 重复代码：配置加载逻辑

**位置**: `lib.rs:477-501` 和 `lib.rs:657-684`

`get_config()` 和 `get_lang_strings()` 都重复了 BOM 剥离逻辑：

```rust
if raw.starts_with('\u{feff}') {
    raw = raw[3..].to_string();
}
```

**建议**: 抽一个 `read_utf8_file(path) -> Result<String, String>` 工具函数。

---

### 12. 硬编码魔法数字

**位置**: `main.js:911`

```javascript
(text.includes("nekogal.top") || /\/s\/[a-zA-Z0-9]{4,8}(\/|$|[?#])/.test(text))
```

- `4,8` 的 shareId 长度限制是硬编码的
- `3000` 毫秒（自动粘贴间隔）没有命名常量
- `60` 个 sparkline 数据点没有说明

---

### 13. 注释比例虚高

原始报告显示注释比例 85.98%，但这是把 `target/` 里的生成代码也算进去了。实际自有代码中：

- `lib.rs` 注释率适中，但部分注释是中文，不利于国际化协作
- `main.js` 关键复杂逻辑（如 `startSingleDownload`）缺少 JSDoc
- PowerShell 脚本缺少 `.SYNOPSIS` 和 `.PARAMETER` 文档

---

## 优先修复清单

| 优先级 | 问题 | 文件 | 预估工时 |
|--------|------|------|----------|
| P0 | 下载器签名验证绕过 | `lib.rs` | 4h |
| P0 | PowerShell 参数注入防护 | `lib.rs` + PS | 2h |
| P1 | 竞态条件重构 | `lib.rs` | 6h |
| P1 | main.js 状态机重构 | `main.js` | 4h |
| P1 | Sanitize-FileName 强化 | `core.ps1` | 1h |
| P2 | 空 catch 块清理 | `main.js` + PS | 2h |
| P2 | Confetti 资源泄漏 | `main.js` | 0.5h |
| P3 | 提取公共函数 | `lib.rs` | 1h |

---

## 总结

NekoDown 的代码在功能层面是完整的，下载核心逻辑（aria2 调用、断点续传、文件名清洗）经过多轮迭代已经比较健壮。但**三个层面的问题比较突出**：

1. **安全层**：自动更新的 RCE 风险和命令注入是硬伤，必须修
2. **并发层**：Rust 端的多线程下载管理和 JS 端的 Promise 状态机都需要重构
3. **健壮性层**：PowerShell 的错误处理太松散，空 catch 块太多

如果只做一件事：**先把自动更新的签名验证补上**，这是唯一可能导致用户机器被完全控制的风险点。
