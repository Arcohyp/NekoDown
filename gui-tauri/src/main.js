const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog || {};

const state = {
  domain: "",
  shareId: "",
  files: [],
  outputDir: "",
  defaultConnections: 16,
  progressByPath: new Map(),
  downloading: false,
};

function fmtSize(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + " " + u[i];
}
function fmtSpeed(bps) { return fmtSize(bps) + "/s"; }

function $(id) { return document.getElementById(id); }

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

async function init() {
  // Restore theme preference
  const savedTheme = localStorage.getItem("nekodown.theme");
  if (savedTheme) document.body.dataset.theme = savedTheme;

  try {
    state.outputDir = await invoke("get_default_output_dir");
    $("output-dir").textContent = state.outputDir;
  } catch (e) {
    console.error("get_default_output_dir failed", e);
    $("output-dir").textContent = "(未配置)";
  }

  $("parse-btn").addEventListener("click", onParse);
  $("link-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onParse();
  });

  $("select-all-btn").addEventListener("click", () => setAllChecked(true));
  $("deselect-btn").addEventListener("click", () => setAllChecked(false));
  $("download-btn").addEventListener("click", onDownload);
  $("open-folder-btn").addEventListener("click", () => {
    if (state.outputDir) invoke("open_folder", { path: state.outputDir });
  });
  $("choose-dir-btn").addEventListener("click", chooseDir);
  $("theme-btn").addEventListener("click", cycleTheme);

  await listen("download-event", (e) => onDownloadEvent(e.payload));
  await listen("download-log", (e) => console.log("[ps]", e.payload?.line));

  setStatus("就绪");
}

const THEMES = ["neko", "moonlight", "sakura", "forest"];
const THEME_LABELS = { neko: "🐾 粉桃", moonlight: "🌙 月夜", sakura: "🌸 樱花", forest: "🍃 森林" };
function cycleTheme() {
  const cur = document.body.dataset.theme || "neko";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.body.dataset.theme = next;
  localStorage.setItem("nekodown.theme", next);
  setStatus(`主题：${THEME_LABELS[next]}`);
}

async function chooseDir() {
  if (!open) return;
  try {
    const picked = await open({ directory: true, defaultPath: state.outputDir });
    if (picked) {
      state.outputDir = picked;
      $("output-dir").textContent = picked;
    }
  } catch (e) { console.error(e); }
}

async function onParse() {
  const link = $("link-input").value.trim();
  if (!link) { setStatus("请先粘贴链接", "error"); return; }
  $("parse-btn").disabled = true;
  $("download-btn").disabled = true;
  setStatus("正在解析…");
  try {
    const result = await invoke("parse_share", { link });
    if (!result.ok) {
      setStatus("解析失败：" + (result.error || "未知错误"), "error");
      return;
    }
    state.shareId = result.shareId;
    state.domain  = result.domain;
    state.files   = result.files || [];
    if (result.defaultOutputDir && !state.outputDir) {
      state.outputDir = result.defaultOutputDir;
      $("output-dir").textContent = state.outputDir;
    }
    if (result.defaultConnections) state.defaultConnections = result.defaultConnections;

    if (result.info) {
      $("info-name").textContent      = result.info.name      || "—";
      $("info-owner").textContent     = result.info.owner     || "—";
      $("info-views").textContent     = result.info.views     ?? "—";
      $("info-downloads").textContent = result.info.downloads ?? "—";
    } else {
      $("info-name").textContent      = "—";
      $("info-owner").textContent     = "—";
      $("info-views").textContent     = "—";
      $("info-downloads").textContent = "—";
    }

    renderFiles();
    setStatus(`解析成功，共 ${state.files.length} 个文件`, "success");
    $("download-btn").disabled = state.files.length === 0;
  } catch (e) {
    setStatus("解析异常：" + (e?.message || e), "error");
    console.error(e);
  } finally {
    $("parse-btn").disabled = false;
  }
}

function renderFiles() {
  const ul = $("files-list");
  ul.innerHTML = "";
  $("files-empty").classList.toggle("hidden", state.files.length > 0);
  state.files.forEach((f, idx) => {
    const li = document.createElement("li");
    li.className = "file-row";
    const display = f.relativePath ? `${f.relativePath}/${f.name}` : f.name;
    li.innerHTML = `
      <input type="checkbox" data-idx="${idx}" checked />
      <span class="file-name" title="${escapeHtml(display)}">${escapeHtml(display)}</span>
      <span class="file-size">${fmtSize(f.size)}</span>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") {
        const cb = li.querySelector("input");
        cb.checked = !cb.checked;
      }
    });
    ul.appendChild(li);
  });
}

function setAllChecked(checked) {
  document.querySelectorAll("#files-list input[type=checkbox]").forEach((cb) => (cb.checked = checked));
}

function getSelectedFiles() {
  const out = [];
  document.querySelectorAll("#files-list input[type=checkbox]").forEach((cb) => {
    if (cb.checked) out.push(state.files[Number(cb.dataset.idx)]);
  });
  return out;
}

async function onDownload() {
  const selected = getSelectedFiles();
  if (selected.length === 0) { setStatus("没有选中的文件", "error"); return; }
  state.downloading = true;
  $("download-btn").disabled = true;
  $("parse-btn").disabled = true;
  setStatus(`正在下载 (${selected.length})…`);

  const progressList = $("progress-list");
  progressList.innerHTML = "";
  state.progressByPath.clear();
  selected.forEach((f) => {
    const id = f.path;
    const li = document.createElement("li");
    li.className = "progress-row";
    li.dataset.id = id;
    const name = f.relativePath ? `${f.relativePath}/${f.name}` : f.name;
    li.innerHTML = `
      <div class="row-top">
        <span class="progress-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="progress-meta">${fmtSize(f.size)}</span>
        <span class="progress-status running">排队中</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
    `;
    progressList.appendChild(li);
    state.progressByPath.set(id, li);
  });
  $("progress-empty").classList.add("hidden");

  let success = 0, failed = 0;
  for (const f of selected) {
    const li = state.progressByPath.get(f.path);
    li.querySelector(".progress-status").textContent = "下载中";
    try {
      await invoke("start_download", {
        file: f,
        domain: state.domain,
        outputDir: state.outputDir,
        connections: state.defaultConnections,
      });
      const status = li.querySelector(".progress-status");
      status.className = "progress-status done";
      status.textContent = "完成";
      li.querySelector(".progress-bar-fill").style.width = "100%";
      success++;
    } catch (e) {
      const status = li.querySelector(".progress-status");
      status.className = "progress-status failed";
      status.textContent = "失败";
      console.error("download failed", f.path, e);
      failed++;
    }
  }
  state.downloading = false;
  $("download-btn").disabled = false;
  $("parse-btn").disabled = false;
  setStatus(`完成 ${success} / 共 ${selected.length}` + (failed ? `（失败 ${failed}）` : ""), failed ? "error" : "success");
}

function onDownloadEvent(payload) {
  if (!payload || !payload.event) return;
  if (payload.event === "progress") {
    const file = payload.file || "";
    // Find the row whose name ends with this file
    let row;
    state.progressByPath.forEach((li) => {
      const nameEl = li.querySelector(".progress-name");
      if (nameEl && nameEl.textContent.endsWith(file)) row = li;
    });
    if (!row) return;
    const total = Number(payload.total) || 0;
    const cur   = Number(payload.current) || 0;
    const speed = Number(payload.speed) || 0;
    const pct   = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
    row.querySelector(".progress-bar-fill").style.width = pct.toFixed(1) + "%";
    const meta = `${fmtSize(cur)} / ${fmtSize(total)} • ${fmtSpeed(speed)}`;
    row.querySelector(".progress-meta").textContent = meta;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

window.addEventListener("DOMContentLoaded", init);
