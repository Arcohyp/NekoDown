# NekoDown 发版指南

## 两种发版模式

本项目采用**代码先行、按需发布**的 workflow：

| 场景 | 命令 | 效果 |
|---|---|---|
| **日常开发**（改版本号，不发布） | `.\scripts\bump-version.ps1 x.y.z -Dev` | 改版本号 → commit |
| **正式发布**（测试稳定后） | `.\scripts\bump-version.ps1 x.y.z` | 改版本号 → commit → tag → push → **触发 GitHub Actions 构建 NSIS 安装包** |

---

## 日常开发：改版本号

当你合并了新功能，想更新代码里的版本号但不发 Release：

```powershell
# 把代码版本升到 3.5.0，只 commit，不打 tag，不触发 workflow
.\scripts\bump-version.ps1 3.5.0 -Dev
```

这会做三件事：
1. 改 `Cargo.toml`、`tauri.conf.json`、`neko-down.ps1` 里的版本号
2. 在 `README.md` 插入 changelog 模板
3. `git add` + `git commit`

**不会打 tag**，GitHub Actions 不会触发，你可以继续本地测试。

---

## 正式发布：推送到 Release

等你测试稳定，确认要发版时：

```powershell
# 补打 tag 并推送，触发 workflow
# （注意：前面的 -Dev 已经 commit 了，这里只要补 tag）
$VERSION = "3.5.0"
git tag -a "v${VERSION}" -m "v${VERSION}"
git push origin v${VERSION}
```

或者直接让脚本一次性完成（如果你之前没打 -Dev）：

```powershell
.\scripts\bump-version.ps1 3.5.0
```

这会：
1. 改版本号 + commit + tag
2. `git push` commit 到 main
3. `git push origin v3.5.0` 触发 **Release workflow**
4. GitHub Actions 自动构建 NSIS 安装包并发布到 Releases 页面

---

## Workflow 产物

Release workflow 会生成三个文件：

| 文件名 | 说明 |
|---|---|
| `NekoDown_x.y.z_x64-setup.exe` | NSIS 安装包（推荐） |
| `nekodown-gui.exe` | 单文件便携版 |
| `NekoDown_x.y.z_x64-portable.zip` | 完整便携包（含 CLI 脚本） |

---

## 手动本地构建

如果你不想等 workflow，想本地快速构建 NSIS 安装包：

```powershell
cd gui-tauri
cargo tauri build
# 产物在 src-tauri/target/release/bundle/nsis/
```

> 本地构建不需要签名密钥，但生成的安装包不能用于自动更新功能。

---

## 注意事项

- **不要直接 push tag**：确认代码已推送到 main，且版本号已在代码中更新
- **tag 必须与代码版本一致**：`tauri.conf.json` 的 `version` 要与 tag 名称对应（如 tag `v3.5.0` 对应代码 `3.5.0`）
- **Workflow 需要签名密钥**：`TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 需在仓库 Secrets 中配置
