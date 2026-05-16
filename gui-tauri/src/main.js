const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog || {};
const { readText } = (window.__TAURI__.clipboardManager || {});

const state = {
  domain: "",
  shareId: "",
  files: [],
  outputDir: "",
  defaultConnections: 16,
  progressByPath: new Map(),
  sparkData: new Map(),
  downloading: false,
  activeDownloads: new Map(), // downloadId -> { file, li }
  cancelled: false,
};

let i18nStrings = null; // null = not loaded yet
let i18nLang = "zh-CN";

function t(key, ...args) {
  // If i18n hasn't loaded, return the key so callers can still show something
  const s = i18nStrings?.[key] ?? key;
  if (!args.length) return s;
  return args.reduce((acc, a, i) => acc.replaceAll(`{${i}}`, a), s);
}

function fmtSize(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + " " + u[i];
}
function fmtSpeed(bps) { return fmtSize(bps) + "/s"; }

function $(id) { return document.getElementById(id); }

function setStatus(key, kind, ...args) {
  const el = $("status");
  el.textContent = t(key, ...args);
  el.className = "status" + (kind ? " " + kind : "");
  el.dataset.statusKey = key;
  if (args.length) el.dataset.statusArgs = JSON.stringify(args);
  else delete el.dataset.statusArgs;
}

function setStatusRaw(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
  delete el.dataset.statusKey;
  delete el.dataset.statusArgs;
}

async function loadI18n() {
  try {
    let cfg = await invoke("get_config");
    let lang = cfg?.language;
    if (!lang || lang === "auto") {
      const detected = await invoke("get_lang_strings", { lang: "auto" });
      lang = detected.lang;
      const toSave = Object.assign({}, cfg, { language: lang });
      if (toSave.logEnabled === undefined) toSave.logEnabled = true;
      await invoke("save_config", { cfg: toSave });
    }
    const result = await invoke("get_lang_strings", { lang });
    i18nLang = result.lang;
    i18nStrings = result.strings || {};
    return true;
  } catch (e) {
    console.error("i18n load failed", e);
    return false;
  }
}

function updateLangBtn() {
  const btn = $("lang-btn");
  if (btn) btn.textContent = i18nLang === "zh-CN" ? "中" : "EN";
}

async function switchLanguage(targetLang) {
  try {
    console.log("[switchLanguage] fetching strings for", targetLang);
    const result = await invoke("get_lang_strings", { lang: targetLang });
    console.log("[switchLanguage] got strings, lang=", result.lang);
    i18nLang = result.lang;
    i18nStrings = result.strings || {};
    applyI18n();
    updateLangBtn();
    console.log("[switchLanguage] fetching config...");
    const cfg = await invoke("get_config");
    console.log("[switchLanguage] got config", cfg);
    const toSave = Object.assign({}, cfg, { language: targetLang });
    if (toSave.logEnabled === undefined) toSave.logEnabled = true;
    console.log("[switchLanguage] saving config...");
    await invoke("save_config", { cfg: toSave });
    console.log("[switchLanguage] done");
    return true;
  } catch (e) {
    console.error("[switchLanguage] FAILED", e);
    const msg = typeof e === "string" ? e : (e?.message || String(e));
    setStatusRaw("Lang error: " + msg, "error");
    return false;
  }
}

function cycleLang() {
  const next = i18nLang === "zh-CN" ? "en-US" : "zh-CN";
  switchLanguage(next);
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  // Refresh status bar if it holds a translatable key.
  const statusEl = $("status");
  const statusKey = statusEl?.dataset.statusKey;
  if (statusKey && i18nStrings) {
    const args = statusEl.dataset.statusArgs ? JSON.parse(statusEl.dataset.statusArgs) : [];
    if (statusKey === "theme_changed") {
      const themeKey = args[0];
      const label = t(`theme_${themeKey}`) || themeKey;
      statusEl.textContent = t(statusKey, label);
    } else {
      statusEl.textContent = t(statusKey, ...args);
    }
  }
}

async function init() {
  const savedTheme = localStorage.getItem("nekodown.theme");
  if (savedTheme) document.body.dataset.theme = savedTheme;

  const i18nOk = await loadI18n();
  if (i18nOk) applyI18n();
  updateLangBtn();

  try {
    state.outputDir = await invoke("get_default_output_dir");
    $("output-dir").textContent = state.outputDir;
  } catch (e) {
    console.error("get_default_output_dir failed", e);
    $("output-dir").textContent = t("not_configured");
  }

  try {
    const ver = await invoke("get_version");
    const tag = $("brand-version");
    if (tag) tag.textContent = "v" + ver;
  } catch (e) {
    console.error("get_version failed", e);
  }

  $("parse-btn").addEventListener("click", onParse);
  $("link-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onParse();
  });

  $("select-all-btn").addEventListener("click", () => setAllChecked(true));
  $("deselect-btn").addEventListener("click", () => setAllChecked(false));
  $("download-btn").addEventListener("click", onDownload);
  $("cancel-btn").addEventListener("click", onCancel);
  $("open-folder-btn").addEventListener("click", () => {
    if (state.outputDir) invoke("open_folder", { path: state.outputDir });
  });
  $("choose-dir-btn").addEventListener("click", chooseDir);
  $("theme-btn").addEventListener("click", cycleTheme);

  $("settings-btn").addEventListener("click", openSettings);
  $("settings-close").addEventListener("click", closeSettings);
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target.id === "settings-overlay") closeSettings();
  });
  $("settings-save").addEventListener("click", applySettings);
  $("lang-btn").addEventListener("click", cycleLang);

  await listen("download-event", (e) => onDownloadEvent(e.payload));
  await listen("download-log", (e) => console.log("[ps]", e.payload?.line));

  window.addEventListener("focus", tryAutoPaste);
  await tryAutoPaste();

  // Delayed update check (don't block init, don't nag immediately).
  setTimeout(() => checkForUpdate(), 8000);

  setStatus("ready");
}

/* ===== Auto-updater ===== */
async function checkForUpdate() {
  try {
    const latest = await invoke("check_update");
    if (latest) {
      const banner = $("update-banner");
      const versionSpan = $("update-version");
      versionSpan.textContent = latest;
      banner.classList.remove("hidden");

      $("update-now-btn").onclick = async () => {
        setStatus("updating", null);
        try {
          await invoke("install_update");
        } catch (e) {
          console.error("install_update failed", e);
          setStatus("update_failed", "error");
        }
      };
      $("update-later-btn").onclick = () => {
        $("update-banner").classList.add("hidden");
      };
    }
  } catch (e) {
    console.error("check_update failed", e);
  }
}

const THEMES = ["neko", "moonlight", "sakura", "forest"];
function cycleTheme() {
  const cur = document.body.dataset.theme || "neko";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.body.dataset.theme = next;
  localStorage.setItem("nekodown.theme", next);
  setStatus("theme_changed", null, next);
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
  if (!link) { setStatus("parse_error", "error"); return; }
  $("parse-btn").disabled = true;
  $("download-btn").disabled = true;
  setStatus("parsing");
  try {
    const result = await invoke("parse_share", { link });
    if (!result.ok) {
      setStatusRaw(t("parse_failed") + (result.error || t("unknown")), "error");
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
    setStatus("parse_success", "success", state.files.length);
    $("download-btn").disabled = state.files.length === 0;
  } catch (e) {
    setStatusRaw(t("parse_failed") + (e?.message || e), "error");
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

async function startSingleDownload(file) {
  const li = state.progressByPath.get(file.path);
  if (!li) return { success: false, error: "no UI row" };
  const ps = li.querySelector(".progress-status");
  ps.textContent = t("downloading");
  ps.dataset.i18n = "downloading";

  try {
    const downloadId = await invoke("start_download", {
      file,
      domain: state.domain,
      outputDir: state.outputDir,
      connections: state.defaultConnections,
    });

    state.activeDownloads.set(downloadId, { file, li });

    // Wait for the backend to emit download-finished for this id.
    const result = await new Promise((resolve) => {
      let unlistenFn = null;

      const setup = async () => {
        unlistenFn = await listen("download-finished", (e) => {
          const payload = e.payload;
          if (payload && payload.downloadId === downloadId) {
            if (unlistenFn) unlistenFn();
            resolve(payload);
          }
        });
      };
      setup();
    });

    state.activeDownloads.delete(downloadId);

    if (state.cancelled) {
      const status = li.querySelector(".progress-status");
      status.className = "progress-status failed";
      status.textContent = t("cancelled_status");
      status.dataset.i18n = "cancelled_status";
      return { success: false, cancelled: true };
    }

    if (result.success) {
      const status = li.querySelector(".progress-status");
      status.className = "progress-status done";
      status.textContent = t("completed_status");
      status.dataset.i18n = "completed_status";
      li.querySelector(".progress-bar-fill").style.width = "100%";
      return { success: true };
    } else {
      const status = li.querySelector(".progress-status");
      status.className = "progress-status failed";
      status.textContent = t("failed_status");
      status.dataset.i18n = "failed_status";
      console.error("download failed", file.path, result);
      return { success: false, error: result.error || `exit code ${result.code}` };
    }
  } catch (e) {
    const status = li.querySelector(".progress-status");
    status.className = "progress-status failed";
    status.textContent = t("failed_status");
    status.dataset.i18n = "failed_status";
    console.error("download failed", file.path, e);
    return { success: false, error: e };
  }
}

async function onCancel() {
  if (!state.downloading) return;
  state.cancelled = true;
  $("cancel-btn").disabled = true;
  const ids = Array.from(state.activeDownloads.keys());
  await Promise.all(ids.map((id) => invoke("cancel_download", { id }).catch(() => {})));
  $("cancel-btn").disabled = false;
}

async function onDownload() {
  const selected = getSelectedFiles();
  if (selected.length === 0) { setStatus("no_selected", "error"); return; }
  state.downloading = true;
  state.cancelled = false;
  $("download-btn").classList.add("hidden");
  $("cancel-btn").classList.remove("hidden");
  $("cancel-btn").disabled = false;
  $("parse-btn").disabled = true;
  setStatus("downloading_count", null, selected.length);

  const progressList = $("progress-list");
  progressList.innerHTML = "";
  state.progressByPath.clear();
  state.sparkData.clear();
  state.activeDownloads.clear();
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
        <span class="progress-status running" data-i18n="queued">${t("queued")}</span>
        <canvas class="spark" width="64" height="18"></canvas>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
    `;
    progressList.appendChild(li);
    state.progressByPath.set(id, li);
    state.sparkData.set(id, []);
  });
  $("progress-empty").classList.add("hidden");

  const results = await Promise.allSettled(selected.map((f) => startSingleDownload(f)));
  let success = 0, failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.success) {
      success++;
    } else {
      failed++;
    }
  }

  state.downloading = false;
  $("download-btn").classList.remove("hidden");
  $("cancel-btn").classList.add("hidden");
  $("parse-btn").disabled = false;
  setStatus("completed", failed ? "error" : "success", success, failed);
}

function onDownloadEvent(payload) {
  if (!payload || !payload.event) return;
  if (payload.event === "progress") {
    const row = state.progressByPath.get(payload.filePath);
    if (!row) return;
    const total = Number(payload.total) || 0;
    const cur   = Number(payload.current) || 0;
    const speed = Number(payload.speed) || 0;
    const pct   = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
    row.querySelector(".progress-bar-fill").style.width = pct.toFixed(1) + "%";
    const meta = `${fmtSize(cur)} / ${fmtSize(total)} • ${fmtSpeed(speed)}`;
    row.querySelector(".progress-meta").textContent = meta;

    const id = row.dataset.id;
    const arr = state.sparkData.get(id);
    if (arr) {
      arr.push(speed);
      if (arr.length > 60) arr.shift();
      const canvas = row.querySelector(".spark");
      if (canvas) drawSparkline(canvas, arr);
    }
  }
}

function drawSparkline(canvas, data) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 64;
  const cssH = canvas.clientHeight || 18;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!data || data.length < 2) return;
  const max = Math.max(...data, 1);
  const step = cssW / (data.length - 1);

  ctx.beginPath();
  const firstY = cssH - (data[0] / max) * cssH;
  ctx.moveTo(0, firstY);
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(i * step, cssH - (data[i] / max) * cssH);
  }
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff7eb6";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo((data.length - 1) * step, cssH);
  ctx.lineTo(0, cssH);
  ctx.closePath();
  ctx.fillStyle = accent + "20";
  ctx.fill();
}

/* ===== Clipboard auto-fill ===== */
let lastPasteAttempt = 0;
function looksLikeLink(text) {
  return /https?:\/\//.test(text) &&
    (text.includes("nekogal.top") || /\/s\/\w+/.test(text) || text.includes("home?path=cloudreve%3A"));
}
async function tryAutoPaste() {
  if (!readText) return;
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now - lastPasteAttempt < 3000) return;
  lastPasteAttempt = now;
  const input = $("link-input");
  if (input.value.trim()) return;
  try {
    const text = await readText();
    if (!text || !looksLikeLink(text)) return;
    input.value = text.trim();
    setStatus("auto_paste_ok", "success");
  } catch (e) { /* ignore */ }
}

/* ===== Settings modal ===== */
async function openSettings() {
  let cfg = {};
  try { cfg = await invoke("get_config"); } catch (e) { console.error(e); }
  $("cfg-language").value      = cfg.language || i18nLang;
  $("cfg-connections").value   = cfg.defaultConnections ?? 16;
  $("cfg-autoRetry").checked   = cfg.autoRetry ?? true;
  $("cfg-maxRetries").value    = cfg.maxRetries ?? 3;
  $("cfg-checkDiskSpace").checked = cfg.checkDiskSpace ?? true;
  $("cfg-minFreeSpace").value  = cfg.minFreeSpaceGB ?? 2;
  $("cfg-proxy").value         = cfg.proxy || "";
  $("settings-msg").textContent = "";
  $("settings-overlay").classList.add("active");
}
function closeSettings() {
  $("settings-overlay").classList.remove("active");
}
async function applySettings() {
  const cfg = {
    language: $("cfg-language").value,
    defaultOutputDir: state.outputDir,
    defaultConnections: Number($("cfg-connections").value) || 16,
    autoRetry: $("cfg-autoRetry").checked,
    maxRetries: Number($("cfg-maxRetries").value) || 3,
    checkDiskSpace: $("cfg-checkDiskSpace").checked,
    minFreeSpaceGB: Number($("cfg-minFreeSpace").value) || 2,
    proxy: $("cfg-proxy").value.trim(),
    logEnabled: true,
  };
  try {
    await invoke("save_config", { cfg });
    state.defaultConnections = cfg.defaultConnections;
    const chosenLang = cfg.language;
    if (chosenLang !== i18nLang) {
      await switchLanguage(chosenLang);
    }
    $("settings-msg").textContent = t("save_settings");
    $("settings-msg").style.color = ""; // reset from previous error red
  } catch (e) {
    $("settings-msg").textContent = "Error: " + (e?.message || e);
    $("settings-msg").style.color = "var(--danger)";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

window.addEventListener("DOMContentLoaded", init);
