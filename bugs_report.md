那三个还没修的 bug 涉及的内容如下：

---

## 1. 关闭 GUI 后 aria2 子进程残留

**问题：** 用户在 GUI 里开始下载，中途关掉窗口，aria2c 进程还在后台继续跑。如果用户重新打开 GUI，它完全不知道之前那个 aria2 还在跑。

**涉及改动：**
- Rust 侧 `lib.rs`：`start_download` 需要维护一个全局的子进程列表（`Arc<Mutex<Vec<Child>>>` 或 `Arc<AtomicU32>` + 进程 ID 集合）。窗口关闭事件（Tauri 的 `on_window_event CloseRequested`）时遍历并 kill 所有子进程。
- Rust 侧 `main.rs`：需要添加 `tauri::Manager` 来监听窗口事件，注册一个 `on_window_event` 回调。

脚本跑完才返回。这意味着即使前端知道窗口要关了，Rust 命令可能还在 `child.wait()` 里阻塞，无法响应。

**复杂度：** 中等偏高。需要改变 Rust 的子进程管理模型——从"spawn 然后 wait"变成"spawn 后立刻返回，然后后端通过事件通道推状态"。或者至少加一个全局进程池 + 关闭钩子。

---

## 2. 缺少取消下载按钮

**问题：** 用户点了"开始下载"后，如果选错了文件或者想中途停止，没有办法。只能等全部下完或者去任务管理器杀进程。

**涉及改动：**
- 前端 `index.html`：下载按钮旁边需要加一个"取消"按钮，或者每个进度行上加上一个 ✕。
- 前端 `main.js`：`onDownload` 的 `for` 循环里需要有中断机制。每次循环开始检查一个 `state.cancelled` flag。
- Rust 侧 `lib.rs`：需要一个新命令 `cancel_download`，往子进程的 `stdin` 写信号，或者调用 `child.kill()`。
- Rust 侧 `lib.rs`：当前的 `start_download` 的 `stdin` 写信号，但 GUI 从来没传过。需要打通：Rust 收到 `cancel` 后，向 PowerShell 子进程发信号，PowerShell 检查 `token` 后 Kill() aria2 进程。
- PowerShell 侧 `tauri-bridge.ps1`：当前的 `Start-FileDownload` 接受一个 `$CancelToken` hashtable，但 GUI 从来没传过。需要打通：Rust 收到 `cancel` 后，向 PowerShell 子进程发信号，PowerShell 检查 `token` 后 Kill() aria2 进程。

**复杂度：** 中高。涉及三层通信：前端 → Rust → PowerShell → aria2。需要重构 `start_download` 的运行模型。

---

## 3. 顺序下载而非并行

**问题：** 现在 `onDownload` 用 `for (const f of selected) { await invoke("start_download", ...) }`，一次只能下一个文件。选 10 个小文件也是串行，体验极差。

**涉及改动：**
- 前端 `main.js`：需要用 `Promise.all()` 或 `Promise.allSettled()` 并行发起多个下载，每个下载独立跟踪进度。
- Rust 侧 `lib.rs`：`start_download` 不能阻塞前端了。需要改成"spawn 后立刻返回一个 `downloadId`"，然后后端通过事件通道持续推送进度。前端根据 `downloadId` 更新对应的进度行。
- 进度状态管理：`state.progressByPath` 的 key 要从 `f.path` 变成 `downloadId`，因为并行时多个下载同时推进，Map 的读写要有并发安全（虽然 JS 是单线程的，但事件回调是异步的）。

**复杂度：** 高。几乎要重写 `start_download` 的 Rust 前端合约 + JS 下载状态机。

---

## 总结：

| Bug | 文件改动 | 复杂度 | 估算时间 |
|-----|----------|--------|----------|
| 子进程残留 | Rust lib.rs + main.rs | 中高 | 1-2 小时 |
| 取消下载 | Rust + PS + JS + HTML | 高 | 2-3 小时 |
| 并行下载 | Rust + JS（大重构） | 高 | 3-4 小时 |

---

这三个本质上是相互关联的：并行下载需要一个能同时管理多个子进程的 Rust 后端，取消下载需要同样的子进程管理能力，窗口关闭 kill 子进程也需要。它们共享同一个基础设施——一个全局的子进程管理器。

如果你打算修，我的建议是把这三个一起做（因为它们共享同一次大重构），而不是一个一个修。可以先从"并行下载 + 子进程跟踪"开始，然后"取消"和"关闭 kill"就水到渠成了。
