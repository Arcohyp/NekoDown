const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog || {};
const { readText } = (window.__TAURI__.clipboardManager || {});
const { sendNotification } = (window.__TAURI__.notification || {});

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
  cancelling: new Set(), // file paths pending cancellation
  lastProgressTime: new Map(), // filePath -> timestamp
  stalledCheckInterval: null,
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

/* ===== Sound Effects ===== */
let soundEnabled = true;
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playTone(freq, duration, type = "sine", volume = 0.15) {
  if (!soundEnabled || !audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) { console.error("Audio error:", e); }
}
function playSuccessSound() {
  if (!soundEnabled) return;
  playTone(523, 0.15, "sine", 0.12);      // C5
  setTimeout(() => playTone(784, 0.25, "sine", 0.15), 100); // G5
  setTimeout(() => playTone(1047, 0.35, "sine", 0.12), 200); // C6
}
function playFailSound() {
  if (!soundEnabled) return;
  playTone(200, 0.3, "triangle", 0.15);   // low A3
  setTimeout(() => playTone(150, 0.4, "triangle", 0.12), 150); // lower E3
}

/* ===== Confetti Celebration ===== */
function fireConfetti(x, y) {
  const canvas = document.createElement("canvas");
  canvas.style.position = "fixed";
  canvas.style.top = "0";
  canvas.style.left = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "9999";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const colors = ["#39C5BB", "#E85298", "#ff7eb6", "#67e8f9", "#a3e635", "#fbbf24"];
  const particles = [];
  const originX = x ?? w / 2;
  const originY = y ?? h / 2;
  for (let i = 0; i < 60; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 6 + 2;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 4,
      size: Math.random() * 4 + 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI,
      rotSpeed: (Math.random() - 0.5) * 0.2,
      life: 1.0,
      decay: Math.random() * 0.02 + 0.015,
    });
  }

  let startTime = null;
  function animate(ts) {
    if (!startTime) startTime = ts;
    ctx.clearRect(0, 0, w, h);
    let alive = false;
    for (const p of particles) {
      if (p.life <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15; // gravity
      p.rotation += p.rotSpeed;
      p.life -= p.decay;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }
    if (alive) {
      requestAnimationFrame(animate);
    } else {
      canvas.remove();
    }
  }
  requestAnimationFrame(animate);
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
    // Restore last-used output dir: localStorage > config.json > hardcoded default
    const savedDir = localStorage.getItem("nekodown.outputDir");
    if (savedDir) {
      state.outputDir = savedDir;
    } else {
      const cfg = await invoke("get_config");
      state.outputDir = cfg.defaultOutputDir || await invoke("get_default_output_dir");
    }
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
  $("clear-link-btn").addEventListener("click", () => {
    $("link-input").value = "";
    $("link-input").focus();
  });
  $("link-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onParse();
  });

  $("select-all-btn").addEventListener("click", () => setAllChecked(true));
  $("deselect-btn").addEventListener("click", () => {
    state.files = [];
    renderFiles();
    $("download-btn").disabled = true;
    $("info-name").textContent = "—";
    $("info-owner").textContent = "—";
    $("info-views").textContent = "—";
    $("info-downloads").textContent = "—";
    setStatus("ready");
  });
  $("download-btn").addEventListener("click", onDownload);
  $("cancel-btn").addEventListener("click", onCancel);
  $("open-folder-btn").addEventListener("click", () => {
    if (state.outputDir) invoke("open_folder", { path: state.outputDir });
  });
  $("clear-progress-btn").addEventListener("click", clearCompletedProgress);
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

  /* ===== Title Bar Buttons ===== */
  $("tb-min").addEventListener("click", () => invoke("minimize_window"));
  $("tb-max").addEventListener("click", () => invoke("maximize_window"));
  $("tb-tray").addEventListener("click", () => invoke("hide_window"));
  $("tb-close").addEventListener("click", async () => {
    const cfg = await invoke("get_config");
    if (cfg.rememberCloseAction && cfg.closeAction && cfg.closeAction !== "ask") {
      if (cfg.closeAction === "exit") {
        invoke("exit_app");
      } else {
        invoke("hide_window");
      }
      return;
    }
    showExitConfirm();
  });

  /* ===== Exit Confirm Dialog ===== */
  $("exit-action-tray").addEventListener("click", async () => {
    const remember = $("remember-exit-choice").checked;
    if (remember) {
      try {
        const cfg = await invoke("get_config");
        cfg.closeAction = "tray";
        cfg.rememberCloseAction = true;
        await invoke("save_config", { cfg });
      } catch (e) {
        console.error("save close action failed", e);
      }
    }
    hideExitConfirm();
    invoke("hide_window");
  });
  $("exit-action-exit").addEventListener("click", async () => {
    const remember = $("remember-exit-choice").checked;
    if (remember) {
      try {
        const cfg = await invoke("get_config");
        cfg.closeAction = "exit";
        cfg.rememberCloseAction = true;
        await invoke("save_config", { cfg });
      } catch (e) {
        console.error("save close action failed", e);
      }
    }
    hideExitConfirm();
    invoke("exit_app");
  });
  $("exit-confirm-overlay").addEventListener("click", (e) => {
    if (e.target.id === "exit-confirm-overlay") hideExitConfirm();
  });

  // Listen for Alt+F4 / system close
  await listen("show-exit-confirm", () => showExitConfirm());

  window.addEventListener("focus", tryAutoPaste);
  await tryAutoPaste();

  // Delayed update check (don't block init, don't nag immediately).
  setTimeout(() => checkForUpdate(), 8000);

  setStatus("ready");
}

function showExitConfirm() {
  const hint = $("exit-hint");
  if (hint) {
    if (state.downloading && state.activeDownloads.size > 0) {
      hint.classList.remove("hidden");
      hint.textContent = t("exit_will_cancel_downloads");
    } else {
      hint.classList.add("hidden");
    }
  }
  $("exit-confirm-overlay").classList.add("active");
}
function hideExitConfirm() {
  $("exit-confirm-overlay").classList.remove("active");
}

/* ===== Update Notifier ===== */
async function checkForUpdate() {
  try {
    const latest = await invoke("check_update");
    if (latest) {
      const banner = $("update-banner");
      const versionSpan = $("update-version");
      versionSpan.textContent = latest;
      banner.classList.remove("hidden");

      $("update-now-btn").onclick = () => {
        const url = "https://github.com/Arcohyp/NekoDown/releases/latest";
        const opener = window.__TAURI__?.opener;
        if (opener?.openUrl) {
          opener.openUrl(url);
        } else {
          window.open(url, "_blank");
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

const THEMES = ["neko", "sakura"];
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
      // Persist to localStorage for next session
      localStorage.setItem("nekodown.outputDir", picked);
      // Also save to config.json so CLI shares the same last-used directory
      try {
        const cfg = await invoke("get_config");
        cfg.defaultOutputDir = picked;
        await invoke("save_config", { cfg });
      } catch (e) {
        console.error("failed to save output dir to config", e);
      }
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

    // Append new files with per-file domain tag (multi-share accumulate).
    const existingPaths = new Set(state.files.map(f => f.path));
    const newFiles = (result.files || [])
      .filter(f => !existingPaths.has(f.path))
      .map(f => ({ ...f, domain: result.domain }));
    state.files.push(...newFiles);

    // Update share info with latest parsed share.
    state.shareId = result.shareId;
    state.domain  = result.domain;
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

    // Clear input and auto-paste the next link from clipboard.
    $("link-input").value = "";
    await tryAutoPaste();
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

// Build the expected output path for a file (matches PowerShell's Sanitize-FileName logic).
function buildOutputPath(file, outputDir) {
  const sanitize = (s) => s.replace(/[<>:"/\\|?*]/g, '_').replace(/\.{2,}/g, '_').replace(/[ .]+$/, '');
  const parts = [outputDir];
  if (file.relativePath) {
    parts.push(...file.relativePath.split('/').map(sanitize));
  }
  parts.push(sanitize(file.name));
  return parts.join('\\');
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
      domain: file.domain || state.domain,
      outputDir: state.outputDir,
      connections: state.defaultConnections,
    });

    state.activeDownloads.set(downloadId, { file, li });

    // Wire up per-file cancel button.
    li.dataset.downloadId = downloadId;
    const cancelBtn = li.querySelector(".btn-cancel-file");
    if (cancelBtn) {
      cancelBtn.classList.remove("hidden");
      cancelBtn._handler = async () => {
        cancelBtn.disabled = true;
        // Mark as cancelling so progress events are ignored.
        state.cancelling.add(file.path);
        // Immediately freeze all visual progress — zero bar, speed, sparkline.
        const progressFill = li.querySelector(".progress-bar-fill");
        if (progressFill) progressFill.style.width = "0%";
        const meta = li.querySelector(".progress-meta");
        if (meta) meta.textContent = "";
        const sparkCanvas = li.querySelector(".spark");
        if (sparkCanvas) {
          const ctx = sparkCanvas.getContext("2d");
          ctx.clearRect(0, 0, sparkCanvas.width, sparkCanvas.height);
        }
        state.sparkData.set(file.path, []);
        // Show cancelling status.
        const ps = li.querySelector(".progress-status");
        ps.textContent = t("cancelling_status");
        ps.className = "progress-status failed";
        try { await invoke("cancel_download", { id: downloadId }); }
        catch (e) { console.error("cancel file failed", e); }
      };
      cancelBtn.addEventListener("click", cancelBtn._handler);
    }

    // Wait for the centralized listener (in onDownload) to resolve via activeDownloads.
    const result = await new Promise((resolve) => {
      const entry = state.activeDownloads.get(downloadId);
      if (entry) entry._resolve = resolve;
    });

    state.activeDownloads.delete(downloadId);
    state.cancelling.delete(file.path);

    // Switch ✕ from "cancel" to "remove row" mode.
    if (cancelBtn) {
      if (cancelBtn._handler) cancelBtn.removeEventListener("click", cancelBtn._handler);
      cancelBtn.disabled = false;
      cancelBtn.title = t("remove_row");
      cancelBtn._handler = () => {
        const row = cancelBtn.closest(".progress-row");
        if (!row) return;
        const id = row.dataset.id;
        if (id) { state.progressByPath.delete(id); state.sparkData.delete(id); }
        row.remove();
        if ($("progress-list").children.length === 0) $("progress-empty").classList.remove("hidden");
      };
      cancelBtn.addEventListener("click", cancelBtn._handler);
    }

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
      playSuccessSound();
      const rect = li.getBoundingClientRect();
      fireConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (sendNotification) {
        sendNotification({ title: t("download_complete_title"), body: t("download_complete_body", file.name) });
      }
      return { success: true };
    } else {
      const status = li.querySelector(".progress-status");
      status.className = "progress-status failed";
      status.textContent = t("failed_status");
      status.dataset.i18n = "failed_status";
      console.error("download failed", file.path, result);
      playFailSound();
      if (sendNotification) {
        const errMsg = result.error || (result.code ? `exit code ${result.code}` : t("unknown"));
        sendNotification({ title: t("download_failed_title"), body: t("download_failed_body", file.name, errMsg) });
      }
      return { success: false, error: result.error || `exit code ${result.code}` };
    }
  } catch (e) {
    const status = li.querySelector(".progress-status");
    status.className = "progress-status failed";
    status.textContent = t("failed_status");
    status.dataset.i18n = "failed_status";
    console.error("download failed", file.path, e);
    playFailSound();
    if (sendNotification) {
      const errMsg = e?.message || String(e);
      sendNotification({ title: t("download_failed_title"), body: t("download_failed_body", file.name, errMsg) });
    }
    return { success: false, error: e };
  }
}

async function onCancel() {
  if (!state.downloading) return;
  state.cancelled = true;
  $("cancel-btn").disabled = true;

  // Freeze every active download UI immediately and mark them so progress
  // events are ignored (both in-flight buffered ones and any stragglers).
  state.activeDownloads.forEach((entry) => {
    if (entry.file && entry.file.path) {
      state.cancelling.add(entry.file.path);
    }
    const li = entry.li;
    if (li) {
      const fill = li.querySelector(".progress-bar-fill");
      if (fill) fill.style.width = "0%";
      const meta = li.querySelector(".progress-meta");
      if (meta) meta.textContent = "";
      const spark = li.querySelector(".spark");
      if (spark) {
        const ctx = spark.getContext("2d");
        ctx.clearRect(0, 0, spark.width, spark.height);
      }
      const id = li.dataset.id;
      if (id) state.sparkData.set(id, []);
    }
  });

  const ids = Array.from(state.activeDownloads.keys());
  await Promise.all(ids.map((id) => invoke("cancel_download", { id }).catch((e) => console.warn("cancel_download failed:", e))));
  stopStallDetection();
  $("cancel-btn").disabled = false;
}

async function onDownload() {
  let selected = getSelectedFiles();
  if (selected.length === 0) { setStatus("no_selected", "error"); return; }

  // --- Duplicate file detection (medium precision) ---
  // Check which selected files already exist at the expected output path.
  const paths = selected.map(f => buildOutputPath(f, state.outputDir));
  let exists;
  try {
    exists = await invoke("paths_exist", { paths });
  } catch (e) {
    console.error("paths_exist failed, skipping duplicate check", e);
    exists = selected.map(() => false);
  }
  const existingFiles = selected.filter((_, i) => exists[i]);
  const newFiles = selected.filter((_, i) => !exists[i]);

  if (existingFiles.length > 0 && newFiles.length === 0) {
    // All selected files already exist — nothing to do.
    setStatus("all_exist_skip", null, existingFiles.length);
    return;
  }
  if (existingFiles.length > 0) {
    setStatus("file_exists_skip", null, existingFiles.length, newFiles.length);
  }
  selected = newFiles;

  state.downloading = true;
  state.cancelled = false;
  // Keep download button visible so users can append more files while downloading.
  $("download-btn").disabled = false;
  $("cancel-btn").classList.remove("hidden");
  $("cancel-btn").disabled = false;
  // Allow parsing while downloading — new files can be added to the queue.
  $("parse-btn").disabled = false;
  setStatus("downloading_count", null, selected.length);

  // Centralized download-finished listener for this batch.
  // Prevents per-download listener leaks that would hang the UI forever.
  let batchUnlisten = null;
  const setupBatchListener = async () => {
    batchUnlisten = await listen("download-finished", (e) => {
      const p = e.payload;
      if (p && p.downloadId) {
        const entry = state.activeDownloads.get(p.downloadId);
        if (entry && entry._resolve) {
          entry._resolve(p);
        }
      }
    });
  };
  await setupBatchListener();

  const progressList = $("progress-list");
  // Append new tasks instead of clearing — supports adding files while downloading.
  // Skip files that are already in the progress list (by path).
  const newSelected = selected.filter((f) => !state.progressByPath.has(f.path));
  if (newSelected.length === 0) {
    setStatus("already_in_queue", null, selected.length);
    return;
  }
  newSelected.forEach((f) => {
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
        <button class="btn-cancel-file hidden" title="${t('cancel_file')}">✕</button>
      </div>
      <div class="progress-bar">
        <div class="progress-bar-fill"></div>
      </div>
    `;
    progressList.appendChild(li);
    state.progressByPath.set(id, li);
    state.sparkData.set(id, []);
    state.lastProgressTime.set(id, Date.now());
  });
  $("progress-empty").classList.add("hidden");

  // Start stall detection timer.
  startStallDetection();

  const results = await Promise.allSettled(selected.map((f) => startSingleDownload(f)));
  let success = 0, failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.success) {
      success++;
    } else {
      failed++;
    }
  }

  // Clean up the batch-level listener so it never leaks into future downloads.
  if (batchUnlisten) batchUnlisten();

  stopStallDetection();
  state.downloading = false;
  state.cancelled = false;
  state.cancelling.clear();
  $("cancel-btn").classList.add("hidden");
  $("download-btn").disabled = getSelectedFiles().length === 0;
  $("parse-btn").disabled = false;
  setStatus("completed", failed ? "error" : "success", success, failed);
}

function onDownloadEvent(payload) {
  if (!payload || !payload.event) return;
  if (payload.event === "progress") {
    // Ignore progress for files that have been cancelled (per-file or global).
    if (state.cancelling.has(payload.filePath)) return;
    if (state.cancelled) return;
    const row = state.progressByPath.get(payload.filePath);
    if (!row) return;
    const total = Number(payload.total) || 0;
    const cur   = Number(payload.current) || 0;
    const speed = Number(payload.speed) || 0;
    const pct   = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
    row.querySelector(".progress-bar-fill").style.width = pct.toFixed(1) + "%";
    const meta = `${fmtSize(cur)} / ${fmtSize(total)} • ${fmtSpeed(speed)}`;
    row.querySelector(".progress-meta").textContent = meta;

    // Reset stall timer for this file.
    state.lastProgressTime.set(payload.filePath, Date.now());
    // Clear any previous stalled warning if it exists.
    const ps = row.querySelector(".progress-status");
    if (ps && ps.dataset.i18n === "stalled_status") {
      ps.textContent = t("downloading");
      ps.dataset.i18n = "downloading";
      ps.className = "progress-status running";
    }

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

// Stall detection: mark files as "stalled" if no progress event for 30s.
function startStallDetection() {
  if (state.stalledCheckInterval) return;
  state.stalledCheckInterval = setInterval(() => {
    const now = Date.now();
    state.lastProgressTime.forEach((ts, path) => {
      const row = state.progressByPath.get(path);
      if (!row) return;
      const ps = row.querySelector(".progress-status");
      if (!ps) return;
      // Skip already terminal states.
      if (ps.classList.contains("done") || ps.classList.contains("failed")) return;
      // Skip cancelled.
      if (state.cancelling.has(path) || state.cancelled) return;
      const elapsed = now - ts;
      if (elapsed > 30000 && ps.dataset.i18n !== "stalled_status") {
        ps.textContent = t("stalled_status");
        ps.dataset.i18n = "stalled_status";
        ps.className = "progress-status running";
        ps.style.color = "var(--warn)";
      }
    });
  }, 5000);
}

function stopStallDetection() {
  if (state.stalledCheckInterval) {
    clearInterval(state.stalledCheckInterval);
    state.stalledCheckInterval = null;
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
    (text.includes("nekogal.top") || /\/s\/[a-zA-Z0-9]{4,8}(\/|$|[?#])/.test(text) || text.includes("home?path=cloudreve%3A"));
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
    // Visual feedback: flash the input, then remove animation class.
    input.classList.add("flash");
    setTimeout(() => input.classList.remove("flash"), 1500);
    setStatus("auto_paste_ok", "success");
  } catch (e) { console.warn("Auto-paste failed:", e); }
}

/* ===== Clear completed progress ===== */
function clearCompletedProgress() {
  const list = $("progress-list");
  const items = list.querySelectorAll(".progress-row");
  let cleared = 0;
  items.forEach(li => {
    const statusEl = li.querySelector(".progress-status");
    if (!statusEl) return;
    const isTerminal = statusEl.classList.contains("done") || statusEl.classList.contains("failed");
    if (!isTerminal) return;
    const id = li.dataset.id;
    if (id) {
      state.progressByPath.delete(id);
      state.sparkData.delete(id);
      // Tidy stale entry from activeDownloads if any.
      if (state.activeDownloads.size > 0) {
        const stale = [...state.activeDownloads].find(([, e]) => e.file && e.file.path === id);
        if (stale) state.activeDownloads.delete(stale[0]);
      }
    }
    li.remove();
    cleared++;
  });
  // Show empty placeholder if nothing left.
  if (list.children.length === 0) {
    $("progress-empty").classList.remove("hidden");
  }
  if (cleared > 0) {
    setStatus("progress_cleared", "success", cleared);
  }
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
  $("cfg-closeAction").value   = cfg.closeAction || "ask";
  $("cfg-sound").checked       = cfg.soundEnabled ?? true;
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
    closeAction: $("cfg-closeAction").value || "ask",
    rememberCloseAction: $("cfg-closeAction").value !== "ask",
    soundEnabled: $("cfg-sound").checked,
    logEnabled: true,
  };
  try {
    await invoke("save_config", { cfg });
    state.defaultConnections = cfg.defaultConnections;
    soundEnabled = cfg.soundEnabled ?? true;
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
