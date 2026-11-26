import {
  saveLiveDirectoryHandle,
  getLiveDirectoryHandle,
  clearLiveDirectoryHandle,
  verifyPermission,
  writeManifestToDirectory,
  findLiveCompanionTheme,
  hotReloadLiveTheme,
  getRealtimeStateFromDB,
  getCustomThemesFromDB,
  getCachedUserSettings,
  updateCachedUserSettings,
  syncAllThemesToPairedDir,
  subscribeRealtimeDB,
  LIVE_THEME_NAME
} from "../liveThemeStore.js";
import { applyNativeTabBarTheme } from "../themeController.js";
import { createThemeManifestJSON } from "../themeGenerator.js";
import { THEMES } from "../themesData.js";
import { escapeHtml, normalizeStr } from "../sharedUtils.js";

// DOM Elements
const btnPickFolder = document.getElementById("btnPickFolder");
const btnPickFolderText = document.getElementById("btnPickFolderText");
const btnChangeFolder = document.getElementById("btnChangeFolder");
const pairedFolderBanner = document.getElementById("pairedFolderBanner");
const pairedFolderName = document.getElementById("pairedFolderName");
const targetFolderHint = document.getElementById("targetFolderHint");
const btnOpenExtensions = document.getElementById("btnOpenExtensions");
const btnCopyExtUrl = document.getElementById("btnCopyExtUrl");
const btnCopyText = document.getElementById("btnCopyText");
const btnRescan = document.getElementById("btnRescan");
const btnBackToGallery = document.getElementById("btnBackToGallery");

const stepCard1 = document.getElementById("stepCard1");
const stepCard2 = document.getElementById("stepCard2");
const circle1 = document.getElementById("circle1");
const circle2 = document.getElementById("circle2");
const livePulse = document.getElementById("livePulse");
const liveStatusMsg = document.getElementById("liveStatusMsg");
const liveToast = document.getElementById("liveToast");

// Browser Environment Detection
const isEdge = typeof navigator !== "undefined" && navigator.userAgent.includes("Edg");
const targetExtUrl = isEdge ? "edge://extensions" : "chrome://extensions";

// Initialize UI text with detected browser URL
const targetExtUrlCode = document.getElementById("targetExtUrl");
if (targetExtUrlCode) {
  targetExtUrlCode.textContent = targetExtUrl;
}

/**
 * Visual Toast notification
 */
function showToast(message, duration = 2500) {
  if (!liveToast) return;
  liveToast.textContent = message;
  liveToast.classList.add("show");
  clearTimeout(liveToast._timeout);
  liveToast._timeout = setTimeout(() => {
    liveToast.classList.remove("show");
  }, duration);
}

/**
 * 4-Layer Extensions Page Opener
 * Bypasses Chromium sandbox restrictions via extension messaging or OS-level launcher
 */
async function openExtensionsManager() {
  let opened = false;

  // Layer 1: Background Service Worker Message
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "OPEN_EXTENSIONS_PAGE" });
      if (resp && resp.success) {
        showToast(`Opened ${targetExtUrl}`);
        return true;
      }
    } catch (_) { }
  }

  // Layer 2: Direct chrome.tabs API
  if (typeof chrome !== "undefined" && chrome.tabs?.create) {
    try {
      await chrome.tabs.create({ url: targetExtUrl });
      showToast(`Opened ${targetExtUrl}`);
      return true;
    } catch (_) { }
  }

  // Layer 3: Universal Fallback (Clipboard + User prompt)
  try {
    await navigator.clipboard.writeText(targetExtUrl);
    showToast(`✓ Copied "${targetExtUrl}" to clipboard! Paste in a new tab.`);
    opened = true;
  } catch (_) {
    window.prompt(`Copy and paste this URL into your browser address bar:`, targetExtUrl);
    opened = true;
  }

  return opened;
}

/**
 * Handle Folder Pairing
 */
async function handleSelectFolder(forcePicker = false) {
  try {
    if (typeof window.showDirectoryPicker !== "function") {
      alert("The File System Access API is not supported in this browser tab. Use pre-built theme packages instead.");
      return;
    }

    const existing = await getLiveDirectoryHandle();
    let dirHandle = null;
    if (!forcePicker && existing && !(await verifyPermission(existing, true, false))) {
      if (await verifyPermission(existing, true, true)) dirHandle = existing;
    }
    if (!dirHandle) {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    }
    if (!dirHandle) return;

    const dbState = await getRealtimeStateFromDB();
    const initialTheme = dbState?.colors || dbState?.activeThemeId || "aurora";
    const themeLabel = dbState?.activeThemeName || "Aurora";
    const initialManifest = createThemeManifestJSON(initialTheme, `${LIVE_THEME_NAME} (${themeLabel})`);
    await writeManifestToDirectory(dirHandle, initialManifest, true);
    await saveLiveDirectoryHandle(dirHandle);

    showToast(`✓ Connected folder: ${dirHandle.name}`);
    updatePairedFolderUI(dirHandle.name);

    const companion = await findLiveCompanionTheme();
    if (!companion) {
      await openExtensionsManager();
    }
    await checkStatus();
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error("[Live Companion Setup] Folder picker error:", err);
      showToast(`Folder selection failed: ${err.message}`, 3500);
    }
  }
}

/**
 * Update UI for Paired Folder state
 */
function updatePairedFolderUI(folderName) {
  if (pairedFolderBanner && pairedFolderName) {
    pairedFolderName.textContent = folderName;
    pairedFolderBanner.style.display = "flex";
  }
  if (targetFolderHint) {
    targetFolderHint.textContent = folderName;
  }
  if (btnPickFolderText) {
    btnPickFolderText.textContent = "Change Paired Folder";
  }
}

/**
 * Check overall sync & installation status
 */
async function checkStatus() {
  try {
    const dirHandle = await getLiveDirectoryHandle();
    const hasPerm = dirHandle ? await verifyPermission(dirHandle, true, false) : false;
    const companion = await findLiveCompanionTheme();

    // Step 1 evaluation
    if (dirHandle && hasPerm) {
      stepCard1.classList.add("completed");
      circle1.textContent = "✓";
      updatePairedFolderUI(dirHandle.name || "LiveTheme");
      stepCard2.classList.add("active");
    } else if (dirHandle && !hasPerm) {
      stepCard1.classList.remove("completed");
      stepCard1.classList.add("active");
      circle1.textContent = "!";
      updatePairedFolderUI(dirHandle.name || "LiveTheme");
      if (btnPickFolderText) btnPickFolderText.textContent = "Re-authorize Folder Write Access";
    } else {
      stepCard1.classList.remove("completed");
      circle1.textContent = "1";
      stepCard2.classList.remove("active");
      if (pairedFolderBanner) pairedFolderBanner.style.display = "none";
      if (btnPickFolderText) btnPickFolderText.textContent = "Select / Create Live Folder";
    }

    // Step 2 & Live Status evaluation
    if (dirHandle && !hasPerm) {
      livePulse.className = "status-pulse-dot active";
      liveStatusMsg.innerHTML = `Browser restarted and paused folder write access. Click <strong>Re-authorize Folder Write Access</strong> above.`;
      if (btnBackToGallery) btnBackToGallery.style.display = "none";
    } else if (companion && dirHandle && hasPerm) {
      stepCard2.classList.remove("active");
      stepCard2.classList.add("completed");
      circle2.textContent = "✓";
      livePulse.className = "status-pulse-dot success";
      liveStatusMsg.innerHTML = `<strong>✓ Paired &amp; Connected!</strong> New Tab themes update instantly &amp; <code>manifest.json</code> writes on every click. Note: Chromium caches unpacked top-bar colors until <strong>↻ Reload</strong> on <em>"${companion.name}"</em> in <code>${targetExtUrl}</code>.`;
      if (btnBackToGallery) btnBackToGallery.style.display = "inline-flex";
    } else if (dirHandle) {
      stepCard2.classList.remove("completed");
      stepCard2.classList.add("active");
      circle2.textContent = "2";
      livePulse.className = "status-pulse-dot active";
      liveStatusMsg.innerHTML = `Folder connected! In <code>${targetExtUrl}</code>, turn on Developer mode & click <strong>Load unpacked</strong>.`;
      if (btnBackToGallery) btnBackToGallery.style.display = "none";
    } else {
      stepCard2.classList.remove("completed", "active");
      circle2.textContent = "2";
      livePulse.className = "status-pulse-dot";
      liveStatusMsg.textContent = "Waiting for folder selection in Step 1...";
      if (btnBackToGallery) btnBackToGallery.style.display = "none";
    }
  } catch (err) {
    console.debug("[Live Companion Setup] checkStatus error:", err);
  }
}

// Event Listeners
if (btnPickFolder) {
  btnPickFolder.addEventListener("click", () => handleSelectFolder(false));
}

if (btnChangeFolder) {
  btnChangeFolder.addEventListener("click", () => handleSelectFolder(true));
}

if (btnOpenExtensions) {
  btnOpenExtensions.addEventListener("click", async () => {
    await openExtensionsManager();
  });
}

if (btnCopyExtUrl) {
  btnCopyExtUrl.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(targetExtUrl);
      if (btnCopyText) btnCopyText.textContent = "✓ Copied!";
      showToast(`Copied "${targetExtUrl}" to clipboard!`);
      setTimeout(() => {
        if (btnCopyText) btnCopyText.textContent = "Copy URL";
      }, 2000);
    } catch (_) {
      window.prompt("Copy URL:", targetExtUrl);
    }
  });
}

if (btnRescan) {
  btnRescan.addEventListener("click", async () => {
    showToast("Scanning developer extensions & manifests...");
    await refreshCompanionPanel();
    const companion = await findLiveCompanionTheme();
    if (companion) {
      showToast(`✓ Found companion theme: "${companion.name}"!`);
    } else {
      showToast(`Rescanned manifests & extensions! Click "Load unpacked" in ${targetExtUrl} to add new themes.`, 3500);
    }
  });
}

if (btnBackToGallery) {
  btnBackToGallery.addEventListener("click", () => {
    const popupUrl = (typeof chrome !== "undefined" && chrome.runtime?.getURL)
      ? chrome.runtime.getURL("popup/popup.html")
      : "popup.html";
    window.location.href = popupUrl;
  });
}

const manifestGrid = document.getElementById("themesManifestGrid");
const themeSearchInput = document.getElementById("themeSearchInput");
const installedCountBadge = document.getElementById("installedCountBadge");
const totalThemesBadge = document.getElementById("totalThemesBadge");

let isRefreshingPanel = false;
async function refreshCompanionPanel() {
  if (isRefreshingPanel) return;
  isRefreshingPanel = true;
  try {
    await checkStatus();
    await renderManifestGrid(themeSearchInput?.value || "");
  } finally {
    isRefreshingPanel = false;
  }
}

// Browser Management Event Listeners (Instant reactive update when unpacked is loaded/enabled/removed)
if (typeof chrome !== "undefined" && chrome.management) {
  chrome.management.onInstalled.addListener(() => refreshCompanionPanel());
  chrome.management.onEnabled.addListener(() => refreshCompanionPanel());
  chrome.management.onDisabled.addListener(() => refreshCompanionPanel());
  chrome.management.onUninstalled.addListener(() => refreshCompanionPanel());
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (
      msg.type === "THEME_INSTALLED" ||
      msg.type === "THEME_ENABLED" ||
      msg.type === "THEME_DISABLED" ||
      msg.type === "THEME_UNINSTALLED" ||
      msg.type === "QUEUE_ROTATED"
    ) {
      refreshCompanionPanel();
    }
  });
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.colorMode?.newValue) {
      applyCompanionColorMode(changes.colorMode.newValue);
    }
    if (changes.customThemes || changes.activeThemeId || changes.activeExtensionId) {
      refreshCompanionPanel();
    }
  });
}

window.addEventListener("focus", () => refreshCompanionPanel());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshCompanionPanel();
});

// Real-time color mode sync from local cache + ThemeStudioDB
function applyCompanionColorMode(mode) {
  if (!mode) return;
  const normalized = mode === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", normalized);
  document.body.setAttribute("data-theme", normalized);
  updateCachedUserSettings({ colorMode: normalized });
}

const initialCache = getCachedUserSettings();
if (initialCache.colorMode) {
  applyCompanionColorMode(initialCache.colorMode);
}

getRealtimeStateFromDB().then((st) => {
  if (st?.colorMode) applyCompanionColorMode(st.colorMode);
});
if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get(["colorMode"]).then((data) => {
    if (data?.colorMode) applyCompanionColorMode(data.colorMode);
  }).catch(() => {});
}

subscribeRealtimeDB((ev) => {
  if (ev.type === "COLOR_MODE_CHANGED" || ev.state?.colorMode) {
    applyCompanionColorMode(ev.colorMode || ev.state.colorMode);
  }
  if (ev.type === "CUSTOM_THEMES_CHANGED" || ev.type === "DB_STATE_CHANGED" || ev.type === "FULL_DATA_RESET") {
    refreshCompanionPanel();
  }
});

// ============================================================================
// INCLUDED THEME MANIFESTS + LIVE DEVELOPER THEMES EXPLORER
// ============================================================================

function findMatchingInstalledTheme(item, installedThemes) {
  const normManifest = item.manifestName ? item.manifestName.toLowerCase() : "";
  const normName = item.normalized || normalizeStr(item.name || "");
  return installedThemes.find((ext) => {
    if (item.installedExtensionId && ext.id === item.installedExtensionId) return true;
    if (ext.id === item.id) return true;
    if (normManifest && ext.name.toLowerCase() === normManifest) return true;
    return normalizeStr(ext.name) === normName;
  }) || null;
}

async function renderManifestGrid(query = "") {
  if (!manifestGrid) return;

  let installedThemes = [];
  if (typeof chrome !== "undefined" && chrome.management?.getAll) {
    try {
      installedThemes = (await chrome.management.getAll()).filter(
        (x) => x.type === "theme" && !x.name.includes("Live Companion")
      );
    } catch (_) {}
  }

  let customThemes = await getCustomThemesFromDB();
  if ((!customThemes || customThemes.length === 0) && Array.isArray(getCachedUserSettings().customThemes)) {
    customThemes = getCachedUserSettings().customThemes;
  }

  const dbState = await getRealtimeStateFromDB();
  const cachedState = getCachedUserSettings();
  const activeThemeId = dbState?.activeThemeId || cachedState?.activeThemeId || "DEFAULT_BROWSER";

  const presetItems = THEMES.filter((t) => !t.isDefault).map((t) => ({
    ...t,
    sourceLabel: `themes/${t.folder}/manifest.json`,
    isCustomEntry: false
  }));

  const unifiedCustom = (customThemes || []).map((ct) => ({
    ...ct,
    manifestName: ct.manifestName || ct.name,
    normalized: normalizeStr(ct.manifestName || ct.name),
    folder: ct.folder || "custom-theme",
    category: ct.category || "custom",
    colors: ct.colors || { frame: "#1c1c1e", toolbar: "#2c2c2e" },
    sourceLabel: ct.installedExtensionId ? "Developer / Loaded Theme" : `themes/${ct.folder || "custom"}/manifest.json`,
    isCustomEntry: true
  }));

  // Also include any developer-loaded unpacked themes in browser not yet in DB/presets
  const knownIds = new Set([
    ...presetItems.map((p) => p.normalized),
    ...unifiedCustom.map((c) => c.normalized)
  ]);
  const extraInstalled = installedThemes
    .filter((ext) => {
      const n = normalizeStr(ext.name);
      return !knownIds.has(n) && !unifiedCustom.some((c) => c.installedExtensionId === ext.id || c.id === ext.id);
    })
    .map((ext) => ({
      id: ext.id,
      installedExtensionId: ext.id,
      name: ext.name,
      manifestName: ext.name,
      normalized: normalizeStr(ext.name),
      folder: "developer-unpacked",
      category: "custom",
      colors: { frame: "#1f2430", toolbar: "#2d3343" },
      sourceLabel: `Developer Loaded (${ext.id.slice(0, 8)}...)`,
      isCustomEntry: true
    }));

  const allItems = [...extraInstalled, ...unifiedCustom, ...presetItems];

  const installedCount = allItems.filter((item) => Boolean(findMatchingInstalledTheme(item, installedThemes))).length;
  const customCount = extraInstalled.length + unifiedCustom.length;

  if (installedCountBadge) {
    installedCountBadge.textContent = installedCount > 0
      ? `${installedCount}/${allItems.length} In Browser`
      : `${allItems.length} Theme Manifests`;
  }
  if (totalThemesBadge) {
    totalThemesBadge.textContent = customCount > 0
      ? `${presetItems.length} Built-in + ${customCount} Custom`
      : `extension/themes/`;
  }
  if (themeSearchInput) {
    themeSearchInput.placeholder = `Search ${allItems.length} theme manifests & loaded themes...`;
  }

  const q = query.trim().toLowerCase();
  const filtered = allItems.filter(
    (t) =>
      !q ||
      (t.name || "").toLowerCase().includes(q) ||
      (t.folder || "").toLowerCase().includes(q) ||
      (t.category || "").toLowerCase().includes(q) ||
      (t.sourceLabel || "").toLowerCase().includes(q)
  );

  manifestGrid.innerHTML = filtered.map((t) => {
    const matchedExt = findMatchingInstalledTheme(t, installedThemes);
    const isInstalled = Boolean(matchedExt);
    const isActive = Boolean(matchedExt?.enabled) || activeThemeId === t.id || (matchedExt && activeThemeId === matchedExt.id);
    const frameCol = t.colors?.frame || "#1c1c1e";
    const barCol = t.colors?.toolbar || "#2c2c2e";

    return `
      <div class="manifest-item${isInstalled ? " installed" : ""}${isActive ? " active-theme" : ""}" data-theme-id="${escapeHtml(t.id)}">
        <div class="manifest-left" data-apply-id="${escapeHtml(t.id)}" title="Click to apply ${escapeHtml(t.name)} to Tab Bar & New Tab">
          <span class="manifest-swatch" style="background: linear-gradient(135deg, ${escapeHtml(frameCol)}, ${escapeHtml(barCol)});"></span>
          <div class="manifest-meta">
            <div class="manifest-title">${escapeHtml(t.name)}</div>
            <div class="manifest-path">${escapeHtml(t.sourceLabel)}</div>
          </div>
        </div>
        <div class="manifest-actions">
          ${isInstalled
            ? `<button type="button" class="manifest-apply-btn ${isActive ? "is-active" : "in-browser"}" data-apply-id="${escapeHtml(t.id)}" title="Switch browser Tab Bar to ${escapeHtml(t.name)}">${isActive ? "✓ Active" : "Apply"}</button>`
            : `${t.isCustomEntry
                ? `<button type="button" class="manifest-apply-btn ${isActive ? "is-active" : ""}" data-apply-id="${escapeHtml(t.id)}" title="Apply ${escapeHtml(t.name)} to Tab Bar &amp; New Tab">${isActive ? "✓ Active" : "Apply"}</button>`
                : ""
              }${t.folder !== "developer-unpacked"
                ? `<button type="button" class="manifest-dl-btn${t.isCustomEntry ? " compact" : ""}" data-folder="${escapeHtml(t.folder)}" data-id="${escapeHtml(t.id)}" title="Download manifest.json">${t.isCustomEntry ? "↓" : "Save .json"}</button>`
                : ""
              }`
          }
        </div>
      </div>
    `;
  }).join("");

  manifestGrid.querySelectorAll("[data-apply-id]").forEach((el) => {
    el.addEventListener("click", async () => {
      const target = allItems.find((x) => x.id === el.dataset.applyId);
      if (!target) return;
      const res = await applyNativeTabBarTheme(target, target.name);
      await refreshCompanionPanel();
      if (res?.status === "applied_instantly" || res?.status === "applied_live_dynamic") {
        showToast(`✓ Tab Bar & New Tab switched to ${target.name}!`);
      } else {
        showToast(`✓ Updated theme cache & New Tab to ${target.name}!`);
      }
    });
  });

  manifestGrid.querySelectorAll(".manifest-dl-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = allItems.find((x) => x.id === btn.dataset.id || x.folder === btn.dataset.folder);
      if (!t) return;
      const jsonStr = t.manifestJson || createThemeManifestJSON(t.folder, t.manifestName || t.name);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: "manifest.json" });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`Saved ${t.name} manifest.json`);
    });
  });
}

themeSearchInput?.addEventListener("input", (e) => {
  renderManifestGrid(e.target.value);
});

const btnSyncAllThemes = document.getElementById("btnSyncAllThemes");
if (btnSyncAllThemes) {
  btnSyncAllThemes.addEventListener("click", async () => {
    const customList = await getCustomThemesFromDB();
    const combined = [...(customList || []), ...THEMES.filter((t) => !t.isDefault)];
    const res = await syncAllThemesToPairedDir(combined, createThemeManifestJSON);
    if (res.ok) {
      showToast(`✓ Synced ${res.count} pre-loaded & custom theme folders into "${res.folderName}"!`);
      await refreshCompanionPanel();
    } else if (res.reason === "no_dir") {
      showToast("Pick your themes folder in Step 1 first so all 53+ themes can sync at once.", 3500);
    } else {
      showToast("Please grant folder write permission to sync all theme folders.", 3500);
    }
  });
}

// Continuous check loop (keeps panel in sync with extension/developer state)
setInterval(() => {
  refreshCompanionPanel();
}, 1500);
refreshCompanionPanel();
