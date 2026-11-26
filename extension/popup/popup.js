import {
  applyNativeTabBarTheme,
  checkCompanionStatus
} from "../themeController.js";
import {
  saveLiveDirectoryHandle,
  getLiveDirectoryHandle,
  writeManifestToDirectory,
  initThemeDatabase,
  setRealtimeColorModeInDB,
  getRealtimeStateFromDB,
  getCachedUserSettings,
  updateCachedUserSettings,
  subscribeRealtimeDB,
  getCustomThemesFromDB,
  saveCustomThemeInDB,
  deleteCustomThemeFromDB,
  getAllWallpapersFromDB,
  saveWallpaperInDB,
  deleteWallpaperFromDB,
  getWallpaperSettingsFromDB,
  saveWallpaperSettingsInDB,
  getLocalDeviceSpaceStatus,
  requestLocalDeviceSpacePermission,
  syncDatabaseToLocalDevice,
  writeSingleCustomThemeToPairedDirs,
  resetAllStudioData,
  ensureFreshDataMigration,
  DEFAULT_ROTATION_QUEUE,
  DEFAULT_COLORS,
  LIVE_THEME_NAME
} from "../liveThemeStore.js";
import { THEME_PRESETS, createThemeManifestJSON } from "../themeGenerator.js";
import { THEMES, findThemeMeta } from "../themesData.js";
import {
  normalizeStr,
  validateHexColor,
  secureParseAndCompile,
  extractManifestFromZipBuffer,
  isColorDark,
  escapeHtml,
  CookieStore,
  setupHorizontalScroll
} from "../sharedUtils.js";

const GALLERY_PRESETS = THEMES.map((t) => ({ ...t, colors: { ...t.colors } }));

let currentCategory = "all";
let currentSearchQuery = "";

// App State
let appState = {
  activeThemeId: "DEFAULT_BROWSER",
  installedThemes: [],
  scheduleEnabled: false,
  intervalHours: 2,
  intervalMinutes: 120,
  currentIndex: 0,
  lastRotationTime: Date.now(),
  targetRotationTime: Date.now() + 7200000,
  themeQueue: ["DEFAULT_BROWSER", "preset-aurora", "preset-midsummer", "preset-nebula"],
  customThemes: [],
  devMode: false,
  hasLoadedInitialState: false
};

// Universal Extension/Localhost Communication Layer
async function sendExtensionMessage(message) {
  if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      console.info("[Extension API] Not connected to service worker, using local simulator:", e.message);
    }
  }

  switch (message.type) {
    case "GET_STATE":
      return {
        success: true,
        activeThemeId: appState.activeThemeId,
        installedThemes: [
          { id: "installed-dracula", name: "Dracula Official", enabled: false },
          { id: "installed-nord", name: "Nord Deep Frost", enabled: false }
        ],
        scheduleEnabled: appState.scheduleEnabled,
        intervalHours: appState.intervalHours,
        intervalMinutes: appState.intervalMinutes || (appState.intervalHours * 60),
        themeQueue: appState.themeQueue,
        currentIndex: appState.currentIndex || 0,
        lastRotationTime: appState.lastRotationTime,
        targetRotationTime: appState.targetRotationTime
      };

    case "OPEN_EXTENSIONS_PAGE": {
      const extUrl = navigator.userAgent.includes("Edg") ? "edge://extensions" : "chrome://extensions";
      navigator.clipboard?.writeText(extUrl).catch(() => {});
      showToast(`Paste ${extUrl} in a new tab to manage unpacked themes.`);
      return { success: true };
    }

    case "RESET_TO_DEFAULT":
      appState.activeThemeId = "DEFAULT_BROWSER";
      return { success: true, activeThemeId: "DEFAULT_BROWSER" };

    case "APPLY_THEME":
      appState.activeThemeId = message.themeId;
      return { success: true, activeThemeId: message.themeId };

    case "UPDATE_INTERVAL": {
      const mins = Number(message.intervalMinutes) || (Number(message.intervalHours) * 60) || 120;
      appState.intervalMinutes = mins;
      appState.intervalHours = mins / 60;
      appState.lastRotationTime = Date.now();
      appState.targetRotationTime = Date.now() + (mins * 60 * 1000);
      return { success: true, intervalMinutes: mins, intervalHours: mins / 60, targetRotationTime: appState.targetRotationTime };
    }

    case "UPDATE_QUEUE":
      if (Array.isArray(message.themeQueue)) appState.themeQueue = message.themeQueue;
      if (Number.isInteger(message.currentIndex)) appState.currentIndex = message.currentIndex;
      return { success: true };

    case "SET_TIMER":
      appState.scheduleEnabled = Boolean(message.enabled);
      if (message.intervalMinutes) {
        appState.intervalMinutes = Number(message.intervalMinutes);
        appState.intervalHours = appState.intervalMinutes / 60;
      } else if (message.intervalHours) {
        appState.intervalHours = Number(message.intervalHours);
        appState.intervalMinutes = appState.intervalHours * 60;
      }
      return { success: true, scheduleEnabled: appState.scheduleEnabled };

    default:
      return { success: true };
  }
}

async function loadCustomThemesIntoApp() {
  const customList = await getCustomThemesFromDB();
  appState.customThemes = Array.isArray(customList) ? customList : [];

  const customPill = document.getElementById("customCategoryPill");
  if (customPill) {
    customPill.classList.toggle("hidden", appState.customThemes.length === 0);
  }
  const allPillSpan = document.querySelector('.cat-pill[data-category="all"] span');
  if (allPillSpan) {
    allPillSpan.textContent = `All (${THEMES.length + appState.customThemes.length})`;
  }
}

function resolvePopupTheme(identifier) {
  if (!identifier || identifier === "DEFAULT_BROWSER") {
    return GALLERY_PRESETS[0];
  }
  return (
    GALLERY_PRESETS.find((p) => p.id === identifier || p.installedExtensionId === identifier) ||
    (appState.customThemes || []).find((c) => c.id === identifier || c.installedExtensionId === identifier) ||
    findThemeMeta(identifier) ||
    null
  );
}

async function performFreshReset(clearWallpapers = false) {
  await resetAllStudioData({ themesList: THEMES, clearWallpapers });
  appState.customThemes = [];
  appState.activeThemeId = "DEFAULT_BROWSER";
  appState.scheduleEnabled = false;
  appState.intervalMinutes = 120;
  appState.intervalHours = 2;
  appState.currentIndex = 0;
  appState.themeQueue = [...DEFAULT_ROTATION_QUEUE];
  currentCategory = "all";
  document.querySelectorAll(".cat-pill").forEach((b) => b.classList.toggle("active", b.dataset.category === "all"));
  await loadCustomThemesIntoApp();
  await refreshState();
  syncTabBarAndColorMode(null, "dark", true);
  updateActiveBadge("Default Browser");
  updateDesignerInputs(DEFAULT_COLORS, "Custom Theme");
  renderGallery();
  renderScheduler();
  if (clearWallpapers) renderWallpaperStudio();
  updateCountdownDisplay();
  updateLiveSyncStatus();
}

// Initialize Popup
async function start() {
  // 0. Ensure fresh data schema (clears stale custom themes once cleanly when resetting)
  await ensureFreshDataMigration(THEMES);

  // Synchronously apply cached user mode, scheduler target & colors to eliminate flash/reset
  const cached = getCachedUserSettings();
  if (cached.activeThemeId) appState.activeThemeId = cached.activeThemeId;
  if (Number(cached.targetRotationTime) > 0) appState.targetRotationTime = Number(cached.targetRotationTime);
  if (Number(cached.lastRotationTime) > 0) appState.lastRotationTime = Number(cached.lastRotationTime);
  if (Number.isInteger(cached.currentIndex)) appState.currentIndex = cached.currentIndex;
  if (cached.colorMode || CookieStore.get("app_ui_theme_mode")) {
    const bootMode = cached.colorMode || CookieStore.get("app_ui_theme_mode");
    syncTabBarAndColorMode(cached.colors || CookieStore.getJSON("active_theme_colors"), bootMode, appState.activeThemeId === "DEFAULT_BROWSER");
  }

  // 1. Initialize ThemeStudioDB & fetch runtime state
  await initThemeDatabase(THEMES);
  await loadCustomThemesIntoApp();
  const dbState = await getRealtimeStateFromDB();
  if (dbState?.activeThemeId) {
    appState.activeThemeId = dbState.activeThemeId;
  }
  if (dbState?.colorMode) {
    appState.colorMode = dbState.colorMode;
    CookieStore.set("app_ui_theme_mode", dbState.colorMode);
  }
  await refreshState();

  // Restore synced Tab Bar color & mode for the active theme
  const allLookup = [...GALLERY_PRESETS, ...(appState.customThemes || [])];
  const activePreset = allLookup.find((p) => p.id === appState.activeThemeId);
  const initialColors = activePreset?.colors || dbState?.colors || cached.colors || CookieStore.getJSON("active_theme_colors");
  syncTabBarAndColorMode(
    initialColors,
    dbState?.colorMode || cached.colorMode || null,
    appState.activeThemeId === "DEFAULT_BROWSER"
  );

  // 3. Setup UI event bindings
  setupActionModal();
  setupTabNavigation();
  setupGalleryActions();
  setupWallpaperStudio();
  setupSchedulerControls();
  setupCustomizer();
  setupLocalDeviceSpaceUI();
  setupLivePreview();
  setupThemeListeners();
  setupEdgeInstaller();
  setupLiveSyncUI();
  updateLiveSyncStatus();
  setupDashboardSidebar();
  setupCountdownTimer();

  // Subscribe to real-time IndexedDB updates (color mode + tab bar sync)
  subscribeRealtimeDB((ev) => {
    if (ev.type === "COLOR_MODE_CHANGED" && ev.colorMode) {
      syncTabBarAndColorMode(
        CookieStore.getJSON("active_theme_colors"),
        ev.colorMode,
        appState.activeThemeId === "DEFAULT_BROWSER"
      );
    }
    if (ev.type === "DB_STATE_CHANGED" && ev.state?.activeThemeId) {
      appState.activeThemeId = ev.state.activeThemeId;
      syncTabBarAndColorMode(
        ev.state.colors,
        ev.state.colorMode || null,
        ev.state.activeThemeId === "DEFAULT_BROWSER"
      );
      renderGallery();
    }
    if (ev.type === "WALLPAPER_CHANGED") {
      renderWallpaperStudio();
    }
    if (ev.type === "CUSTOM_THEMES_CHANGED") {
      loadCustomThemesIntoApp().then(() => renderGallery());
    }
    if (ev.type === "FULL_DATA_RESET") {
      loadCustomThemesIntoApp().then(() => refreshState()).then(() => {
        renderGallery();
        renderScheduler();
        renderWallpaperStudio();
        updateCountdownDisplay();
      });
    }
  });

  // Listen for live Chromium / Edge theme management & rotation events
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(async (msg) => {
      if (!msg) return;
      if (msg.type === "THEME_INSTALLED" || msg.type === "THEME_ENABLED" || msg.type === "THEME_DISABLED" || msg.type === "THEME_UNINSTALLED") {
        await loadCustomThemesIntoApp();
        await refreshState();
        renderGallery();
        renderScheduler();
        checkInstallerAutoClose(msg);
      } else if (msg.type === "QUEUE_ROTATED") {
        appState.currentIndex = msg.currentIndex ?? appState.currentIndex;
        appState.targetRotationTime = msg.targetRotationTime ?? appState.targetRotationTime;
        const cardData = GALLERY_PRESETS.find((p) => p.id === msg.themeId) ||
          (appState.customThemes || []).find((t) => t.id === msg.themeId);
        appState.activeThemeId = cardData ? cardData.id : msg.themeId;
        const resolvedName = cardData?.name || msg.themeName || msg.themeId;
        const resolvedColors = cardData?.colors || msg.colors || null;
        CookieStore.set("active_theme_id", appState.activeThemeId);
        CookieStore.set("active_theme_name", resolvedName);
        if (resolvedColors) CookieStore.setJSON("active_theme_colors", resolvedColors);
        updateCachedUserSettings({
          activeThemeId: appState.activeThemeId,
          activeThemeName: resolvedName,
          colors: resolvedColors
        });
        updateActiveBadge(resolvedName);
        syncTabBarAndColorMode(resolvedColors, null, appState.activeThemeId === "DEFAULT_BROWSER");
        await refreshState();
        renderGallery();
        renderScheduler();
        updateCountdownDisplay();
      }
    });
  }

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let schedDirty = false;
      if (changes.intervalMinutes?.newValue) {
        appState.intervalMinutes = Number(changes.intervalMinutes.newValue);
        appState.intervalHours = appState.intervalMinutes / 60;
        CookieStore.set("schedule_interval_minutes", appState.intervalMinutes);
        CookieStore.set("schedule_interval_hours", appState.intervalHours);
        schedDirty = true;
      }
      if (typeof changes.scheduleEnabled?.newValue === "boolean") {
        appState.scheduleEnabled = changes.scheduleEnabled.newValue;
        CookieStore.set("schedule_enabled", appState.scheduleEnabled ? "true" : "false");
        schedDirty = true;
      }
      if (Array.isArray(changes.themeQueue?.newValue)) {
        appState.themeQueue = changes.themeQueue.newValue;
        CookieStore.setJSON("theme_rotation_queue", appState.themeQueue);
        schedDirty = true;
      }
      if (changes.targetRotationTime?.newValue) {
        appState.targetRotationTime = changes.targetRotationTime.newValue;
        CookieStore.set("schedule_target_time", String(appState.targetRotationTime));
        updateCachedUserSettings({ targetRotationTime: appState.targetRotationTime });
        schedDirty = true;
      }
      if (Number.isInteger(changes.currentIndex?.newValue)) {
        appState.currentIndex = changes.currentIndex.newValue;
        CookieStore.set("schedule_current_index", String(appState.currentIndex));
        updateCachedUserSettings({ currentIndex: appState.currentIndex });
        schedDirty = true;
      }
      if (schedDirty) {
        renderScheduler();
        updateCountdownDisplay();
      }
      if (changes.activeThemeId?.newValue) {
        refreshState().then(() => {
          renderGallery();
          renderScheduler();
        });
      }
    });
  }

  // 4. Initial Render
  renderGallery();
  renderScheduler();
}

// Fetch state & restore choices from cookies
async function refreshState() {
  const cookieThemeId = CookieStore.get("active_theme_id");
  const cookieThemeName = CookieStore.get("active_theme_name");
  if (cookieThemeId) {
    appState.activeThemeId = cookieThemeId;
    updateActiveBadge(cookieThemeName || cookieThemeId);
  }

  const cookieQueue = CookieStore.getJSON("theme_rotation_queue");
  if (Array.isArray(cookieQueue) && cookieQueue.length > 0) {
    appState.themeQueue = cookieQueue;
  }

  const cookieIntervalMins = CookieStore.get("schedule_interval_minutes");
  const cookieInterval = CookieStore.get("schedule_interval_hours");
  if (cookieIntervalMins && Number(cookieIntervalMins) >= 1) {
    appState.intervalMinutes = Number(cookieIntervalMins);
    appState.intervalHours = appState.intervalMinutes / 60;
  } else if (cookieInterval && Number(cookieInterval) > 0) {
    appState.intervalHours = Number(cookieInterval);
    appState.intervalMinutes = Math.round(appState.intervalHours * 60);
  }

  const cookieScheduleEnabled = CookieStore.get("schedule_enabled");
  if (cookieScheduleEnabled !== null) {
    appState.scheduleEnabled = cookieScheduleEnabled === "true";
  }

  const cookieTargetTime = Number(CookieStore.get("schedule_target_time") || getCachedUserSettings().targetRotationTime || 0);
  if (cookieTargetTime > 0) {
    appState.targetRotationTime = cookieTargetTime;
  }
  const cookieIdx = CookieStore.get("schedule_current_index");
  if (cookieIdx !== null && Number.isInteger(Number(cookieIdx))) {
    appState.currentIndex = Number(cookieIdx);
  }

  try {
    const response = await sendExtensionMessage({ type: "GET_STATE" });
    if (response && response.success) {
      const hasChromeRuntime = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
      const existingCustomMap = new Map();
      for (const ct of [...(response.customThemes || []), ...(appState.customThemes || [])]) {
        if (ct?.id) existingCustomMap.set(ct.id, ct);
      }

      // Authoritative interval: in extension mode use chrome.storage.local (response), else cookie/local state
      const resolvedMinutes = hasChromeRuntime
        ? (Number(response.intervalMinutes) || (cookieIntervalMins ? Number(cookieIntervalMins) : appState.intervalMinutes))
        : (cookieIntervalMins ? Number(cookieIntervalMins) : (Number(response.intervalMinutes) || appState.intervalMinutes));

      const resolvedEnabled = hasChromeRuntime
        ? Boolean(response.scheduleEnabled)
        : (cookieScheduleEnabled !== null ? cookieScheduleEnabled === "true" : Boolean(response.scheduleEnabled));

      let resolvedQueue = hasChromeRuntime && Array.isArray(response.themeQueue) && response.themeQueue.length > 0
        ? [...response.themeQueue]
        : (cookieQueue || response.themeQueue || appState.themeQueue);

      const installedSet = new Set((response.installedThemes || []).map((t) => t.id));
      const customSet = new Set(Array.from(existingCustomMap.keys()));
      // Remove orphaned 32-char extension IDs no longer installed/known
      resolvedQueue = resolvedQueue.filter((qId) => {
        if (!/^[a-p]{32}$/.test(String(qId))) return true;
        return installedSet.has(qId) || customSet.has(qId);
      });
      if (resolvedQueue.length === 0) resolvedQueue = [...DEFAULT_ROTATION_QUEUE];

      const preservedTarget = hasChromeRuntime
        ? (Number(response.targetRotationTime) || cookieTargetTime || (Date.now() + resolvedMinutes * 60000))
        : (cookieTargetTime > 0 ? cookieTargetTime : (Number(response.targetRotationTime) || (Date.now() + resolvedMinutes * 60000)));

      appState = {
        ...appState,
        ...response,
        customThemes: Array.from(existingCustomMap.values()),
        activeThemeId: hasChromeRuntime
          ? (response.activeThemeId || cookieThemeId || appState.activeThemeId)
          : (cookieThemeId || response.activeThemeId || appState.activeThemeId),
        themeQueue: resolvedQueue,
        intervalMinutes: resolvedMinutes,
        intervalHours: resolvedMinutes / 60,
        scheduleEnabled: resolvedEnabled,
        currentIndex: hasChromeRuntime ? (response.currentIndex ?? appState.currentIndex) : (appState.currentIndex ?? response.currentIndex ?? 0),
        lastRotationTime: response.lastRotationTime || appState.lastRotationTime || Date.now(),
        targetRotationTime: preservedTarget,
        devMode: CookieStore.get("dev_mode_enabled") === "true" || false,
        hasLoadedInitialState: true
      };

      // Match installed Chromium/Edge themes to GALLERY_PRESETS & appState.customThemes
      GALLERY_PRESETS.forEach(p => {
        if (p.id === "DEFAULT_BROWSER") return;
        p.isInstalled = false;
        p.installedExtensionId = null;
        p.isEnabled = false;
      });
      (appState.customThemes || []).forEach(ct => {
        ct.isInstalled = false;
        ct.isEnabled = false;
      });

      let enabledThemeEntry = null;
      if (Array.isArray(appState.installedThemes)) {
        appState.installedThemes.forEach(t => {
          const isRealEnabled = Boolean(t.enabled && !t.isLiveCompanion && !t.name.includes("Live Companion"));
          let matchedPreset = GALLERY_PRESETS.find(p => p.id === t.presetId);
          if (!matchedPreset && !t.isLiveCompanion && !t.name.includes("Live Companion")) {
            matchedPreset = GALLERY_PRESETS.find(p => {
              if (p.id === "DEFAULT_BROWSER") return false;
              if (p.manifestName.toLowerCase() === t.name.toLowerCase()) return true;
              if (p.normalized === normalizeStr(t.name)) return true;
              return normalizeStr(p.name) === normalizeStr(t.name);
            });
          }

          if (matchedPreset) {
            matchedPreset.isInstalled = true;
            matchedPreset.installedExtensionId = t.id;
            matchedPreset.isEnabled = Boolean(t.enabled);
            if (isRealEnabled) enabledThemeEntry = matchedPreset;
          } else if (!t.isLiveCompanion && !t.name.includes("Live Companion")) {
            const matchedCustom = (appState.customThemes || []).find(
              c => c.id === t.presetId || c.installedExtensionId === t.id || normalizeStr(c.manifestName || c.name) === normalizeStr(t.name)
            );
            if (matchedCustom) {
              matchedCustom.isInstalled = true;
              matchedCustom.installedExtensionId = t.id;
              matchedCustom.isEnabled = Boolean(t.enabled);
              if (isRealEnabled) enabledThemeEntry = matchedCustom;
            } else if (isRealEnabled) {
              enabledThemeEntry = { id: t.id, name: t.name, colors: null };
            }
          }
        });
      }

      if (hasChromeRuntime && (!appState.activeThemeId || appState.activeThemeId === "DEFAULT_BROWSER") && enabledThemeEntry?.id && !response.activeThemeId) {
        appState.activeThemeId = enabledThemeEntry.id;
      }

      // Sync active theme badge, cookies, and local cache to match authoritative state
      const currentActive = resolvePopupTheme(appState.activeThemeId) ||
        (appState.installedThemes || []).find(t => t.id === appState.activeThemeId || t.presetId === appState.activeThemeId);

      const activeDisplayName = appState.activeThemeId === "DEFAULT_BROWSER"
        ? "Default Browser"
        : (currentActive?.name || appState.activeThemeId);
      const activeColors = currentActive?.colors || null;

      CookieStore.set("active_theme_id", appState.activeThemeId);
      CookieStore.set("active_theme_name", activeDisplayName);
      if (activeColors) CookieStore.setJSON("active_theme_colors", activeColors);
      CookieStore.set("schedule_interval_minutes", appState.intervalMinutes);
      CookieStore.set("schedule_interval_hours", appState.intervalHours);
      CookieStore.set("schedule_enabled", appState.scheduleEnabled ? "true" : "false");
      CookieStore.set("schedule_target_time", String(appState.targetRotationTime));
      CookieStore.set("schedule_current_index", String(appState.currentIndex || 0));
      updateCachedUserSettings({
        activeThemeId: appState.activeThemeId,
        activeThemeName: activeDisplayName,
        colors: activeColors,
        scheduleEnabled: appState.scheduleEnabled,
        intervalMinutes: appState.intervalMinutes,
        intervalHours: appState.intervalHours,
        targetRotationTime: appState.targetRotationTime,
        lastRotationTime: appState.lastRotationTime,
        currentIndex: appState.currentIndex || 0,
        themeQueue: appState.themeQueue,
        devMode: appState.devMode
      });

      updateActiveBadge(activeDisplayName);
      syncTabBarAndColorMode(
        activeColors,
        hasChromeRuntime ? (response.colorMode || appState.colorMode || null) : (appState.colorMode || null),
        appState.activeThemeId === "DEFAULT_BROWSER"
      );
    }
  } catch (err) {
    appState.hasLoadedInitialState = true;
    console.error("Failed to query extension state:", err);
  }
}

// Tab Navigation
function setupTabNavigation() {
  const tabs = document.querySelectorAll(".segment-btn");
  const panels = document.querySelectorAll(".tab-panel");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const targetId = tab.dataset.tab;

      tabs.forEach(t => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      panels.forEach(p => p.classList.remove("active"));

      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      const activePanel = document.getElementById(`tab-${targetId}`);
      if (activePanel) activePanel.classList.add("active");

      CookieStore.set("active_nav_tab", targetId);
    });
  });

  // Restore saved active tab from URL ?tab=... first, else cookie
  const urlTab = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
  const savedTab = urlTab || CookieStore.get("active_nav_tab");
  if (savedTab) {
    const activeTabBtn = document.querySelector(`.segment-btn[data-tab="${savedTab}"]`);
    if (activeTabBtn) {
      tabs.forEach(t => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      panels.forEach(p => p.classList.remove("active"));
      activeTabBtn.classList.add("active");
      activeTabBtn.setAttribute("aria-selected", "true");
      const activePanel = document.getElementById(`tab-${savedTab}`);
      if (activePanel) activePanel.classList.add("active");
    }
  }
}

async function handleDeleteCustomTheme(cardData) {
  if (!cardData?.id) return;

  await deleteCustomThemeFromDB(cardData.id);
  appState.customThemes = (appState.customThemes || []).filter((t) => t.id !== cardData.id);

  // Disable installed extension variant if enabled so browser doesn't stay stuck on deleted theme
  if (cardData.installedExtensionId && typeof chrome !== "undefined" && chrome.management) {
    try {
      const extInfo = await chrome.management.get(cardData.installedExtensionId);
      if (extInfo?.enabled) {
        await chrome.management.setEnabled(cardData.installedExtensionId, false);
      }
    } catch (_) {}
  }

  // Remove deleted theme (both studio id and extension id) from scheduler queue if present
  const idsToRemove = new Set([cardData.id, cardData.installedExtensionId].filter(Boolean));
  if (Array.isArray(appState.themeQueue) && appState.themeQueue.some((id) => idsToRemove.has(id))) {
    appState.themeQueue = appState.themeQueue.filter((id) => !idsToRemove.has(id));
    if (appState.currentIndex >= appState.themeQueue.length) {
      appState.currentIndex = 0;
    }
    CookieStore.setJSON("theme_rotation_queue", appState.themeQueue);
    updateCachedUserSettings({ themeQueue: appState.themeQueue });
    await sendExtensionMessage({
      type: "UPDATE_QUEUE",
      themeQueue: appState.themeQueue,
      currentIndex: appState.currentIndex
    });
  }

  // Revert to browser default if deleted theme was currently active or enabled in Edge
  if (appState.activeThemeId === cardData.id || cardData.isEnabled) {
    appState.activeThemeId = "DEFAULT_BROWSER";
    CookieStore.set("active_theme_id", "DEFAULT_BROWSER");
    CookieStore.set("active_theme_name", "Default Browser");
    updateCachedUserSettings({ activeThemeId: "DEFAULT_BROWSER", activeThemeName: "Default Browser", colors: null });
    updateActiveBadge("Default Browser");
    syncTabBarAndColorMode(null, null, true);
    await applyNativeTabBarTheme("default", "Default Browser");
  }

  await loadCustomThemesIntoApp();
  if (currentCategory === "custom" && appState.customThemes.length === 0) {
    currentCategory = "all";
    document.querySelectorAll(".cat-pill").forEach((b) => {
      b.classList.toggle("active", b.dataset.category === "all");
    });
    CookieStore.set("active_gallery_category", "all");
  }

  renderGallery();
  renderScheduler();
  updateLiveSyncStatus();
  showToast(`Removed "${cardData.name}" from My Studio`);
}

// Render Gallery Cards with Category & Search Filtering (or Wallpapers Studio View)
function renderGallery() {
  const carouselWrapper = document.getElementById("cardsCarouselWrapper");
  const wpSection = document.getElementById("wallpaperStudioSection");
  const searchWrap = document.querySelector(".gallery-search-wrap");
  const isWallpapersMode = currentCategory === "wallpapers";

  if (carouselWrapper) carouselWrapper.classList.toggle("hidden", isWallpapersMode);
  if (searchWrap) searchWrap.classList.toggle("hidden", isWallpapersMode);
  if (wpSection) wpSection.classList.toggle("hidden", !isWallpapersMode);

  if (isWallpapersMode) {
    renderWallpaperStudio();
    return;
  }

  const grid = document.getElementById("themeCardsGrid");
  if (!grid) return;

  grid.innerHTML = "";

  // Combine Presets + Custom Studio Themes + Installed Themes
  const customCards = (appState.customThemes || []).map(ct => ({
    ...ct,
    category: "custom",
    cssClass: ct.cssClass || "theme-card-custom",
    iconType: ct.iconType || "palette",
    isCustom: true
  }));
  const allCards = [...GALLERY_PRESETS, ...customCards];

  // Add only 3rd-party Chromium themes that do NOT match any of our presets or custom themes
  if (Array.isArray(appState.installedThemes)) {
    appState.installedThemes.forEach(theme => {
      const alreadyKnown = allCards.some(p => p.installedExtensionId === theme.id || p.id === theme.presetId);
      if (!alreadyKnown) {
        allCards.push({
          id: theme.id,
          name: theme.name,
          category: "custom",
          cssClass: "theme-card-custom",
          iconType: "palette",
          isInstalled: true,
          installedExtensionId: theme.id,
          isEnabled: Boolean(theme.enabled),
          colors: {
            frame: "#2c2c2e",
            toolbar: "#3a3a3c",
            text: "#ffffff",
            ntp: "#1c1c1e"
          }
        });
      }
    });
  }

  // Filter cards by category & search query
  const filteredCards = allCards.filter(card => {
    let catMatch = (currentCategory === "all");
    if (!catMatch) {
      if (currentCategory === "apple") {
        catMatch = card.category === "apple" || card.id?.startsWith("preset-") || card.id === "DEFAULT_BROWSER";
      } else {
        catMatch = (card.category === currentCategory);
      }
    }
    const q = currentSearchQuery.toLowerCase().trim();
    const searchMatch = !q || card.name.toLowerCase().includes(q) || (card.category || "").toLowerCase().includes(q);
    return catMatch && searchMatch;
  });

  if (filteredCards.length === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "empty-search-msg";
    emptyEl.style.cssText = "padding: 24px 12px; text-align: center; color: var(--text-secondary); font-size: 12px; width: 100%;";
    emptyEl.textContent = `No aesthetic themes match "${currentSearchQuery}". Try "pastel", "cafe", "cyber", or "ghibli".`;
    grid.appendChild(emptyEl);
    return;
  }

  filteredCards.forEach(cardData => {
    const cardEl = document.createElement("div");
    cardEl.className = `theme-card ${cardData.cssClass || ""}`;
    if (cardData.isCustom && cardData.colors?.frame) {
      cardEl.style.background = `linear-gradient(145deg, ${cardData.colors.frame} 0%, ${cardData.colors.toolbar || cardData.colors.frame} 100%)`;
    }
    if (appState.activeThemeId === cardData.id || (!appState.activeThemeId && cardData.isEnabled)) {
      cardEl.classList.add("active");
    }

    // Top icon pill
    const isDarkText = cardData.colors?.text
      ? !isColorDark(cardData.colors.frame || "#1c1c1e")
      : (cardData.isDefault || cardData.id === "preset-classic");
    const iconPill = document.createElement("div");
    iconPill.className = `card-icon-pill ${isDarkText ? "dark-icon" : ""}`;
    iconPill.innerHTML = getIconSvg(cardData.iconType);

    // If installed in Edge, show subtle verified badge
    if (cardData.isInstalled) {
      const installedBadge = document.createElement("div");
      installedBadge.className = "card-installed-badge";
      installedBadge.title = "Installed in Microsoft Edge";
      installedBadge.innerHTML = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> In Edge`;
      cardEl.appendChild(installedBadge);
    }

    // Delete option for uploaded / saved My Studio themes
    if (cardData.isCustom) {
      cardEl.classList.add("has-delete");
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "card-delete-btn";
      delBtn.title = `Delete "${cardData.name}" from My Studio`;
      delBtn.setAttribute("aria-label", `Delete ${cardData.name} from My Studio`);
      delBtn.innerHTML = "&times;";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await handleDeleteCustomTheme(cardData);
      });
      cardEl.appendChild(delBtn);
    }

    // Bottom label pill
    const labelPill = document.createElement("div");
    labelPill.className = "card-label-pill";
    labelPill.textContent = cardData.name;

    cardEl.appendChild(iconPill);
    cardEl.appendChild(labelPill);

    // Click handler to activate theme
    cardEl.addEventListener("click", async () => {
      await handleThemeSelect(cardData);
    });

    grid.appendChild(cardEl);
  });

  // Dedicated interactive "Custom Theme" card
  const customCard = document.createElement("div");
  customCard.className = "theme-card create-custom-card";
  customCard.title = "Build or Import a Custom Theme in Customizer";
  customCard.innerHTML = `
    <div class="card-icon-pill">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </div>
    <div class="card-label-pill">Create Custom</div>
  `;
  customCard.addEventListener("click", () => {
    const customTab = document.querySelector('.segment-btn[data-tab="customizer"]');
    if (customTab) customTab.click();
  });
  grid.appendChild(customCard);

  // Update carousel pagination dots and active state whenever cards are re-rendered
  setTimeout(() => {
    updateCardsPagination();
    syncActiveDot();
  }, 40);
}

function applyPopupThemeAccent(colors) {
  const pill = document.querySelector(".active-theme-pill");
  const dot = document.querySelector(".status-indicator-dot");
  if (!pill) return;
  if (!colors) {
    pill.style.removeProperty("border-color");
    if (dot) dot.style.removeProperty("background");
    return;
  }
  pill.style.borderColor = colors.toolbar || "";
  if (dot) dot.style.background = colors.toolbar || colors.frame || "";
}

function syncTabBarAndColorMode(colors, explicitMode = null, isDefault = false) {
  const root = document.documentElement;
  const osMode = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const resolvedMode = explicitMode || (isDefault || !colors?.frame ? osMode : (isColorDark(colors.frame) ? "dark" : "light"));

  root.setAttribute("data-theme", resolvedMode);
  document.body.setAttribute("data-theme", resolvedMode);
  appState.colorMode = resolvedMode;
  CookieStore.set("app_ui_theme_mode", resolvedMode);
  updateCachedUserSettings({
    colorMode: resolvedMode,
    colors: isDefault ? null : (colors || null)
  });

  const toggleBtn = document.getElementById("themeModeToggleBtn");
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-checked", resolvedMode === "dark" ? "true" : "false");
    toggleBtn.title = resolvedMode === "dark" ? "Switch to Light mode" : "Switch to Dark mode";
  }

  if (isDefault || !colors) {
    root.removeAttribute("data-theme-synced");
    ["--theme-frame", "--theme-toolbar", "--theme-text", "--theme-ntp"].forEach((v) => root.style.removeProperty(v));
    applyPopupThemeAccent(null);
  } else {
    root.setAttribute("data-theme-synced", "true");
    root.style.setProperty("--theme-frame", colors.frame || "#1c1c1e");
    root.style.setProperty("--theme-toolbar", colors.toolbar || "#2c2c2e");
    root.style.setProperty("--theme-text", colors.text || "#ffffff");
    root.style.setProperty("--theme-ntp", colors.ntp || "#121212");
    applyPopupThemeAccent(colors);
  }
  return resolvedMode;
}

// Theme Selection Handler (Live Companion Bypass + New Tab + Tab Bar Sync + ThemeStudioDB)
async function handleThemeSelect(cardData) {
  const isDefault = cardData.id === "DEFAULT_BROWSER";
  CookieStore.set("active_theme_id", cardData.id);
  CookieStore.set("active_theme_name", cardData.name);
  if (cardData.colors) {
    CookieStore.setJSON("active_theme_colors", cardData.colors);
  }

  // Immediately sync extension Tab Bar color & Light/Dark mode to match chosen theme
  const syncedMode = syncTabBarAndColorMode(cardData.colors, null, isDefault);

  try {
    const res = await applyNativeTabBarTheme(
      isDefault ? "default" : cardData,
      cardData.name,
      syncedMode
    );

    if (res && res.status === "applied_live_dynamic") {
      appState.activeThemeId = cardData.id;
      updateActiveBadge(cardData.name);
      renderGallery();
      showToast(`✓ Tab bar & New Tab updated to ${cardData.name}!`);
      updateLiveSyncStatus();
      return;
    } else if (res && res.status === "applied_instantly") {
      appState.activeThemeId = cardData.id;
      updateActiveBadge(cardData.name);
      renderGallery();
      showToast(`✓ Switched browser & New Tab to ${cardData.name}!`);
      updateLiveSyncStatus();
      return;
    } else if (res && res.status === "manifest_written_needs_reload") {
      appState.activeThemeId = cardData.id;
      updateActiveBadge(cardData.name);
      renderGallery();
      showToast(`✓ New Tab updated & saved! Click ↻ Reload in extensions to repaint top tab bar.`, 5000);
      updateLiveSyncStatus();
      return;
    } else if (res && res.status === "needs_folder_permission") {
      appState.activeThemeId = cardData.id;
      updateActiveBadge(cardData.name);
      renderGallery();
      showToast(`✓ New Tab updated! Click "Load in Edge" to authorize folder.`, 4500);
      updateLiveSyncStatus();
      return;
    } else if (res && res.status === "folder_updated_needs_load") {
      appState.activeThemeId = cardData.id;
      updateActiveBadge(cardData.name);
      renderGallery();
      showToast(`✓ Saved! Click "Load in Edge" to sync tab bar.`);
      updateLiveSyncStatus();
      return;
    } else if (res && res.status === "restored_default") {
      appState.activeThemeId = "DEFAULT_BROWSER";
      updateActiveBadge("Default Browser");
      syncTabBarAndColorMode(null, null, true);
      renderGallery();
      showToast("✓ Default Browser appearance restored");
      updateLiveSyncStatus();
      return;
    } else if (res && res.status === "requires_unpacked_load") {
      appState.activeThemeId = cardData.id;
      updateActiveBadge(cardData.name);
      renderGallery();
      if (cardData.colors) updateDesignerInputs(cardData.colors, cardData.name);
      updateLiveSyncStatus();
      showToast(`✓ ${cardData.name} applied to Studio & New Tab!`);
      return;
    }
  } catch (err) {
    console.warn("[Theme Controller] Controller error:", err);
  }
}

// Icon SVG Helper (Full aesthetic icon set)
function getIconSvg(type) {
  switch (type) {
    case "globe":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
    case "sun":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    case "moon":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
    case "sparkle":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`;
    case "cosmos":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="1"/><circle cx="5" cy="19" r="1"/></svg>`;
    case "heart":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`;
    case "cloud":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;
    case "smile":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`;
    case "flower":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="5" r="2.5"/><circle cx="12" cy="19" r="2.5"/><circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/></svg>`;
    case "leaf":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>`;
    case "coffee":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/></svg>`;
    case "feather":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>`;
    case "droplet":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>`;
    case "zap":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    case "terminal":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
    case "lantern":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 2h6"/><path d="M12 2v3"/><rect x="6" y="5" width="12" height="14" rx="3"/><line x1="6" y1="12" x2="18" y2="12"/><path d="M12 19v3"/></svg>`;
    case "book":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 2v20"/></svg>`;
    case "waves":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/></svg>`;
    case "palette":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.5 17.5 2 12 2Z"/></svg>`;
    case "mountain":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/></svg>`;
    case "tree":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2 7 9h3l-4 7h6v5h2v-5h6l-4-7h3l-5-7z"/></svg>`;
    case "chrome":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" y1="8" x2="12" y2="8"/><line x1="3.95" y1="6.06" x2="8.54" y2="14"/><line x1="10.88" y1="21.94" x2="15.46" y2="14"/></svg>`;
    default:
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/></svg>`;
  }
}

// Carousel Pagination & 2-Second Auto-Scroll Engine
let cardsAutoScrollTimer = null;
let isCardsAutoScrollPaused = false;

function setupCardsCarousel() {
  const container = document.getElementById("galleryScrollContainer");
  const dotsWrap = document.getElementById("cardsPaginationDots");
  if (!container) return;

  // 1. Mouse wheel translation: convert deltaY to horizontal scroll
  container.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > 0) {
      e.preventDefault();
      container.scrollLeft += e.deltaY * 1.15;
      syncActiveDot();
    }
  }, { passive: false });

  // 2. Mouse click & drag to scroll
  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;

  container.addEventListener("mousedown", (e) => {
    isDown = true;
    isCardsAutoScrollPaused = true;
    startX = e.pageX - container.offsetLeft;
    scrollLeft = container.scrollLeft;
  });

  const stopDrag = () => {
    if (isDown) {
      isDown = false;
      container.classList.remove("is-dragging");
      setTimeout(() => {
        isCardsAutoScrollPaused = false;
      }, 2000);
    }
  };

  window.addEventListener("mouseup", stopDrag);

  container.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    const x = e.pageX - container.offsetLeft;
    const walk = x - startX;
    if (Math.abs(walk) > 4) {
      container.classList.add("is-dragging");
      e.preventDefault();
      container.scrollLeft = scrollLeft - walk * 1.35;
      syncActiveDot();
    }
  });

  // 3. Pause auto-scroll on hover
  container.addEventListener("mouseenter", () => {
    isCardsAutoScrollPaused = true;
  });
  container.addEventListener("mouseleave", () => {
    isCardsAutoScrollPaused = false;
  });

  if (dotsWrap) {
    dotsWrap.addEventListener("mouseenter", () => {
      isCardsAutoScrollPaused = true;
    });
    dotsWrap.addEventListener("mouseleave", () => {
      isCardsAutoScrollPaused = false;
    });
  }

  // 4. Touch support for trackpads/touchscreens
  container.addEventListener("touchstart", () => {
    isCardsAutoScrollPaused = true;
  }, { passive: true });
  container.addEventListener("touchend", () => {
    setTimeout(() => {
      isCardsAutoScrollPaused = false;
    }, 2000);
  }, { passive: true });

  // 5. Scroll listener to keep active dot synchronized
  container.addEventListener("scroll", syncActiveDot, { passive: true });

  // 6. Pause auto-scroll when tab/window is hidden
  document.addEventListener("visibilitychange", () => {
    isCardsAutoScrollPaused = document.hidden;
  });

  // Initial build & start 2-second auto-scroll
  updateCardsPagination();
  startCardsAutoScroll();
}

function updateCardsPagination() {
  const container = document.getElementById("galleryScrollContainer");
  const dotsWrap = document.getElementById("cardsPaginationDots");
  if (!container || !dotsWrap) return;

  dotsWrap.innerHTML = "";
  const maxScroll = container.scrollWidth - container.clientWidth;
  if (maxScroll <= 12) {
    dotsWrap.style.display = "none";
    return;
  }
  dotsWrap.style.display = "flex";

  const totalCards = container.querySelectorAll(".theme-card").length;
  const cardStep = 96; // 88px card + 8px gap
  const visibleCards = Math.max(1, Math.floor(container.clientWidth / cardStep));
  const numPages = Math.min(8, Math.max(2, Math.ceil((totalCards - visibleCards + 1) / 2)));

  for (let i = 0; i < numPages; i++) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "carousel-dot" + (i === 0 ? " active" : "");
    dot.setAttribute("aria-label", `Theme page ${i + 1}`);
    dot.dataset.page = i;

    dot.addEventListener("click", () => {
      isCardsAutoScrollPaused = true;
      const targetScroll = (maxScroll / (numPages - 1)) * i;
      container.scrollTo({ left: targetScroll, behavior: "smooth" });
      setActiveDot(i);
      setTimeout(() => {
        isCardsAutoScrollPaused = false;
      }, 2500);
    });

    dotsWrap.appendChild(dot);
  }
}

function setActiveDot(index) {
  const dots = document.querySelectorAll("#cardsPaginationDots .carousel-dot");
  dots.forEach((dot, idx) => {
    dot.classList.toggle("active", idx === index);
  });
}

function syncActiveDot() {
  const container = document.getElementById("galleryScrollContainer");
  const dots = document.querySelectorAll("#cardsPaginationDots .carousel-dot");
  if (!container || dots.length === 0) return;

  const maxScroll = container.scrollWidth - container.clientWidth;
  if (maxScroll <= 0) return;

  const progress = container.scrollLeft / maxScroll;
  const activeIdx = Math.min(dots.length - 1, Math.max(0, Math.round(progress * (dots.length - 1))));
  setActiveDot(activeIdx);
}

function startCardsAutoScroll() {
  if (cardsAutoScrollTimer) clearInterval(cardsAutoScrollTimer);

  cardsAutoScrollTimer = setInterval(() => {
    if (isCardsAutoScrollPaused) return;

    // Only auto-scroll when Gallery tab is active
    const galleryTab = document.getElementById("tab-gallery");
    if (galleryTab && !galleryTab.classList.contains("active")) return;

    const container = document.getElementById("galleryScrollContainer");
    if (!container) return;

    const maxScroll = container.scrollWidth - container.clientWidth;
    if (maxScroll <= 12) return;

    const cardStep = 96;
    const nextScroll = container.scrollLeft + cardStep;

    if (nextScroll >= maxScroll + 15) {
      container.scrollTo({ left: 0, behavior: "smooth" });
    } else {
      container.scrollTo({ left: nextScroll, behavior: "smooth" });
    }
  }, 2000); // Exactly 02 seconds
}

// Gallery Actions & Reset Button
function setupGalleryActions() {
  const revertBtn = document.getElementById("revertDefaultBtn");
  const quickDefaultBtn = document.getElementById("quickDefaultBtn");
  const themeToggleBtn = document.getElementById("themeModeToggleBtn");

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", async () => {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      const next = current === "dark" ? "light" : "dark";
      await setRealtimeColorModeInDB(next);
      syncTabBarAndColorMode(
        CookieStore.getJSON("active_theme_colors"),
        next,
        appState.activeThemeId === "DEFAULT_BROWSER"
      );
      if (appState.activeThemeId === "preset-classic" || appState.activeThemeId === "preset-aurora") {
        const target = GALLERY_PRESETS.find((p) => p.id === (next === "dark" ? "preset-aurora" : "preset-classic"));
        if (target) await handleThemeSelect(target);
      } else {
        showToast(`✓ Tab Bar color mode set to ${next === "dark" ? "Dark" : "Light"}`);
      }
    });
  }

  // Wire Category Bar Horizontal Scroll
  const catBar = document.getElementById("galleryCategoryBar");
  const catNavLeft = document.getElementById("catNavLeft");
  const catNavRight = document.getElementById("catNavRight");
  setupHorizontalScroll(catBar, catNavLeft, catNavRight);

  // Initialize Theme Cards Carousel with Navigation Dots & 2-Second Auto-Scroll
  setupCardsCarousel();

  // Category filter buttons & cookie persistence
  const catPills = document.querySelectorAll(".cat-pill");
  catPills.forEach(pill => {
    pill.addEventListener("click", () => {
      catPills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      currentCategory = pill.dataset.category || "all";
      CookieStore.set("active_gallery_category", currentCategory);
      renderGallery();
    });
  });

  // Restore saved category from URL ?cat=... first, else cookie
  const urlCat = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("cat") : null;
  const savedCategory = urlCat || CookieStore.get("active_gallery_category");
  if (savedCategory) {
    const matchingPill = Array.from(catPills).find(p => p.dataset.category === savedCategory);
    if (matchingPill) {
      catPills.forEach(p => p.classList.remove("active"));
      matchingPill.classList.add("active");
      currentCategory = savedCategory;
      try {
        matchingPill.scrollIntoView({ behavior: "smooth", inline: "nearest" });
      } catch (_) {}
    }
  }

  // Search input filter & Clear button
  const searchInput = document.getElementById("gallerySearchInput");
  const searchClear = document.getElementById("gallerySearchClear");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      currentSearchQuery = e.target.value;
      if (searchClear) {
        searchClear.classList.toggle("hidden", !currentSearchQuery);
      }
      renderGallery();
    });
  }
  if (searchClear) {
    searchClear.addEventListener("click", () => {
      if (searchInput) {
        searchInput.value = "";
        searchInput.focus();
      }
      currentSearchQuery = "";
      searchClear.classList.add("hidden");
      renderGallery();
    });
  }

  const handleReset = async (e) => {
    if (e?.currentTarget) triggerSpinAnimation(e.currentTarget);
    await handleThemeSelect({
      id: "DEFAULT_BROWSER",
      name: "Default Browser",
      colors: { frame: "#e5e5ea", toolbar: "#ffffff", text: "#1d1d1f", ntp: "#f5f5f7" }
    });
  };

  if (revertBtn) revertBtn.addEventListener("click", handleReset);
  if (quickDefaultBtn) quickDefaultBtn.addEventListener("click", handleReset);

  // Quick shortcut from Gallery footer to Tab Wallpapers studio view
  const openWallpapersQuick = document.getElementById("btnOpenWallpapersQuick");
  if (openWallpapersQuick) {
    openWallpapersQuick.addEventListener("click", () => {
      const wpPill = document.getElementById("wallpapersCategoryPill");
      if (wpPill) {
        wpPill.click();
        try {
          wpPill.scrollIntoView({ behavior: "smooth", inline: "nearest" });
        } catch (_) {}
      }
    });
  }
}

// ============================================================================
// TAB WALLPAPERS STUDIO & AUTO-ROTATION CONTROLLER
// ============================================================================

function compressImageToDataUrl(file, maxWidth = 1920, maxHeight = 1080) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => {
      if (file.size <= 700 * 1024) {
        resolve(reader.result);
        return;
      }
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        const scale = Math.min(1, maxWidth / w, maxHeight / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => resolve(reader.result);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function renderWallpaperStudio() {
  const grid = document.getElementById("wallpaperCardsGrid");
  const autoToggle = document.getElementById("wallpaperAutoRotateToggle");
  const intervalSelect = document.getElementById("wallpaperIntervalSelect");
  if (!grid) return;

  const [wallpapers, settings] = await Promise.all([
    getAllWallpapersFromDB(),
    getWallpaperSettingsFromDB()
  ]);

  if (autoToggle) autoToggle.checked = Boolean(settings.autoRotate);
  if (intervalSelect) {
    intervalSelect.value = String(settings.intervalMinutes || 15);
  }

  grid.innerHTML = "";
  if (wallpapers.length === 0) {
    grid.innerHTML = `
      <div class="wallpaper-empty-state">
        <strong>No Tab Wallpapers Uploaded Yet</strong>
        <span>Click "Upload Wallpaper" above to add PNG/JPG/WebP backgrounds with auto-rotation across tabs.</span>
      </div>
    `;
    return;
  }

  wallpapers.forEach((wp) => {
    const card = document.createElement("div");
    const isActive = wp.id === settings.activeWallpaperId;
    card.className = `wallpaper-thumb-card${isActive ? " active" : ""}`;
    card.style.backgroundImage = `url("${wp.dataUrl}")`;
    card.title = `Click to apply "${wp.name}" to New Tab`;

    const label = document.createElement("div");
    label.className = "wallpaper-thumb-name";
    label.textContent = isActive ? `✓ ${wp.name}` : wp.name;

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "wallpaper-delete-btn";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Remove wallpaper";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteWallpaperFromDB(wp.id);
      await renderWallpaperStudio();
      showToast(`Removed wallpaper "${wp.name}"`);
    });

    card.addEventListener("click", async () => {
      await saveWallpaperSettingsInDB({ activeWallpaperId: wp.id });
      await renderWallpaperStudio();
      showToast(`✓ Tab wallpaper set to "${wp.name}"`);
    });

    card.append(label, delBtn);
    grid.appendChild(card);
  });
}

function setupWallpaperStudio() {
  const uploadInput = document.getElementById("wallpaperUploadInput");
  const uploadBtnLabel = document.querySelector(".wallpaper-upload-btn");
  const autoToggle = document.getElementById("wallpaperAutoRotateToggle");
  const intervalSelect = document.getElementById("wallpaperIntervalSelect");
  const btnNext = document.getElementById("btnWallpaperRotateNow");
  const btnClear = document.getElementById("btnWallpaperClear");

  if (uploadBtnLabel) {
    uploadBtnLabel.addEventListener("click", (e) => {
      if (isExtensionPopupWindow()) {
        e.preventDefault();
        openPersistentStudioTab("gallery", "wallpapers");
      }
    });
  }

  if (uploadInput) {
    uploadInput.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      let uploadedCount = 0;
      let lastId = null;
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        if (file.size > 15 * 1024 * 1024) {
          showToast(`Skipped "${file.name}" (> 15 MB)`);
          continue;
        }
        const dataUrl = await compressImageToDataUrl(file);
        const saved = await saveWallpaperInDB({
          name: file.name.replace(/\.[^.]+$/, ""),
          dataUrl,
          mimeType: file.type
        });
        lastId = saved.id;
        uploadedCount++;
      }

      if (uploadedCount > 0) {
        const settings = await getWallpaperSettingsFromDB();
        if (!settings.activeWallpaperId && lastId) {
          await saveWallpaperSettingsInDB({ activeWallpaperId: lastId });
        }
        await renderWallpaperStudio();
        showToast(`✓ Uploaded ${uploadedCount} wallpaper${uploadedCount > 1 ? "s" : ""} for your tabs!`);
      }
      uploadInput.value = "";
    });
  }

  if (autoToggle) {
    autoToggle.addEventListener("change", async () => {
      const enabled = autoToggle.checked;
      const mins = Number(intervalSelect?.value || 15);
      await saveWallpaperSettingsInDB({
        autoRotate: enabled,
        intervalMinutes: mins,
        lastRotatedAt: Date.now(),
        targetRotateAt: Date.now() + mins * 60 * 1000
      });
      await sendExtensionMessage({ type: "SET_WALLPAPER_TIMER", enabled, intervalMinutes: mins });
      showToast(enabled ? `✓ Wallpaper auto-rotation enabled (${mins}m)` : "Wallpaper auto-rotation paused");
    });
  }

  if (intervalSelect) {
    intervalSelect.addEventListener("change", async () => {
      const mins = Number(intervalSelect.value || 15);
      const enabled = Boolean(autoToggle?.checked);
      await saveWallpaperSettingsInDB({
        intervalMinutes: mins,
        lastRotatedAt: Date.now(),
        targetRotateAt: Date.now() + mins * 60 * 1000
      });
      if (enabled) {
        await sendExtensionMessage({ type: "SET_WALLPAPER_TIMER", enabled: true, intervalMinutes: mins });
      }
      showToast(`Wallpaper interval set to ${intervalSelect.options[intervalSelect.selectedIndex].text}`);
    });
  }

  if (btnNext) {
    btnNext.addEventListener("click", async () => {
      const wallpapers = await getAllWallpapersFromDB();
      if (wallpapers.length === 0) {
        showToast("Upload at least 1 wallpaper first");
        return;
      }
      const settings = await getWallpaperSettingsFromDB();
      const idx = wallpapers.findIndex((w) => w.id === settings.activeWallpaperId);
      const nextWp = wallpapers[idx >= 0 ? (idx + 1) % wallpapers.length : 0];
      const mins = Number(intervalSelect?.value || 15);
      await saveWallpaperSettingsInDB({
        activeWallpaperId: nextWp.id,
        lastRotatedAt: Date.now(),
        targetRotateAt: Date.now() + mins * 60 * 1000
      });
      await sendExtensionMessage({ type: "ROTATE_WALLPAPER_NOW" });
      await renderWallpaperStudio();
      showToast(`✓ Tab wallpaper switched to "${nextWp.name}"`);
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", async () => {
      await saveWallpaperSettingsInDB({ activeWallpaperId: null });
      await renderWallpaperStudio();
      showToast("Cleared active tab wallpaper");
    });
  }
}

function normalizeAllowedIntervalMinutes(mins) {
  const allowed = [15, 30, 45, 60, 120, 240, 1440];
  const n = Math.round(Number(mins) || 120);
  if (allowed.includes(n)) return n;
  return n < 15 ? 15 : 120;
}

function syncSchedulerControlStates() {
  const toggle = document.getElementById("scheduleToggle");
  if (toggle) toggle.checked = Boolean(appState.scheduleEnabled);

  const currentMin = normalizeAllowedIntervalMinutes(appState.intervalMinutes || (Number(appState.intervalHours) * 60));
  appState.intervalMinutes = currentMin;
  appState.intervalHours = currentMin / 60;
  const chips = document.querySelectorAll("#intervalChips .chip-btn");
  chips.forEach(c => {
    const chipMin = c.dataset.minutes ? Number(c.dataset.minutes) : (Number(c.dataset.hours) * 60);
    c.classList.toggle("active", chipMin === currentMin);
  });
}

// Scheduler Setup
function setupSchedulerControls() {
  const toggle = document.getElementById("scheduleToggle");
  const chips = document.querySelectorAll("#intervalChips .chip-btn");

  syncSchedulerControlStates();

  if (toggle) {
    toggle.addEventListener("change", async () => {
      const isEnabled = toggle.checked;
      const mins = appState.intervalMinutes || (appState.intervalHours * 60) || 120;
      appState.intervalMinutes = mins;
      appState.intervalHours = mins / 60;
      appState.scheduleEnabled = isEnabled;
      if (isEnabled) {
        appState.lastRotationTime = Date.now();
        appState.targetRotationTime = Date.now() + (mins * 60 * 1000);
      }
      CookieStore.set("schedule_enabled", isEnabled ? "true" : "false");
      CookieStore.set("schedule_interval_minutes", mins);
      CookieStore.set("schedule_interval_hours", appState.intervalHours);
      updateCachedUserSettings({
        scheduleEnabled: isEnabled,
        intervalMinutes: mins,
        intervalHours: appState.intervalHours
      });
      const resp = await sendExtensionMessage({
        type: "SET_TIMER",
        enabled: isEnabled,
        intervalHours: appState.intervalHours,
        intervalMinutes: mins
      });
      if (resp?.targetRotationTime) appState.targetRotationTime = resp.targetRotationTime;
      if (appState.targetRotationTime) {
        CookieStore.set("schedule_target_time", String(appState.targetRotationTime));
        updateCachedUserSettings({ targetRotationTime: appState.targetRotationTime, lastRotationTime: appState.lastRotationTime });
      }
      updateCountdownDisplay();
      const label = mins >= 60 ? `${mins / 60}h` : `${mins}m`;
      showToast(isEnabled ? `✓ Auto-cycle timer started (${label})` : "Auto-cycle timer paused");
    });
  }

  chips.forEach(chip => {
    chip.addEventListener("click", async () => {
      chips.forEach(c => c.classList.remove("active"));
      chip.classList.add("active");

      const minutes = chip.dataset.minutes ? Number(chip.dataset.minutes) : (Number(chip.dataset.hours) * 60);
      const hours = minutes / 60;

      appState.intervalMinutes = minutes;
      appState.intervalHours = hours;
      appState.lastRotationTime = Date.now();
      appState.targetRotationTime = Date.now() + (minutes * 60 * 1000);

      CookieStore.set("schedule_interval_hours", hours);
      CookieStore.set("schedule_interval_minutes", minutes);
      updateCachedUserSettings({
        intervalMinutes: minutes,
        intervalHours: hours
      });

      // Always persist chosen interval in chrome.storage.local whether paused or active
      const resp = await sendExtensionMessage({
        type: "UPDATE_INTERVAL",
        intervalHours: hours,
        intervalMinutes: minutes
      });
      if (resp?.targetRotationTime) appState.targetRotationTime = resp.targetRotationTime;
      CookieStore.set("schedule_target_time", String(appState.targetRotationTime));
      updateCachedUserSettings({ targetRotationTime: appState.targetRotationTime, lastRotationTime: appState.lastRotationTime });

      showToast(`Interval set to ${chip.textContent.trim()}! Countdown reset.`);
      updateCountdownDisplay();
    });
  });

  // Setup Add Screen Drawer Controls
  setupAddScreenControls();
}

function setupAddScreenControls() {
  const btnAdd = document.getElementById("btnAddScreen");
  const panel = document.getElementById("addScreenPanel");
  const select = document.getElementById("selectThemeToAdd");
  const btnConfirm = document.getElementById("btnConfirmAddScreen");
  const btnCancel = document.getElementById("btnCancelAddScreen");

  if (!panel || !select || !btnConfirm) return;

  // Populate options dynamically from presets & aesthetic categories
  const populateOptions = () => {
    select.innerHTML = "";

    const defOpt = document.createElement("option");
    defOpt.value = "";
    defOpt.disabled = true;
    defOpt.selected = true;
    defOpt.textContent = "Select a theme / screen to add...";
    select.appendChild(defOpt);

    // Group 1: Native & Apple Presets
    const grpApple = document.createElement("optgroup");
    grpApple.label = "Apple Originals";
    GALLERY_PRESETS.filter(p => p.category === "apple" || p.id.startsWith("preset-")).forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.isDefault ? "Default Browser" : t.name;
      grpApple.appendChild(opt);
    });
    select.appendChild(grpApple);

    // Group 2: Aesthetic Curated Categories
    const categories = [
      { key: "chrome", label: "Chrome Colors" },
      { key: "dark", label: "Dark & Black" },
      { key: "wild", label: "Window to Wild" },
      { key: "kawaii", label: "Kawaii" },
      { key: "pastel", label: "Pastel" },
      { key: "cafe", label: "Cafe & Minimal" },
      { key: "cyber", label: "Cyber & Retro" },
      { key: "celestial", label: "Space & Night" },
      { key: "anime", label: "Anime & Ghibli" }
    ];

    categories.forEach(cat => {
      const themes = GALLERY_PRESETS.filter(p => p.category === cat.key);
      if (themes.length > 0) {
        const grp = document.createElement("optgroup");
        grp.label = cat.label;
        themes.forEach(t => {
          const opt = document.createElement("option");
          opt.value = t.id;
          opt.textContent = t.name;
          grp.appendChild(opt);
        });
        select.appendChild(grp);
      }
    });

    // Group 3: Custom & Imported Studio Themes
    if (appState.customThemes && appState.customThemes.length > 0) {
      const grpCustom = document.createElement("optgroup");
      grpCustom.label = "My Studio Themes";
      appState.customThemes.forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.name;
        grpCustom.appendChild(opt);
      });
      select.appendChild(grpCustom);
    }

    // Group 4: Installed Themes (exclude Live Companion)
    const standaloneInstalled = (appState.installedThemes || []).filter((t) => !t.isLiveCompanion && !t.name?.includes("Live Companion"));
    if (standaloneInstalled.length > 0) {
      const grpInstalled = document.createElement("optgroup");
      grpInstalled.label = "Installed Chromium Themes";
      standaloneInstalled.forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.presetId || t.id;
        opt.textContent = t.name;
        grpInstalled.appendChild(opt);
      });
      select.appendChild(grpInstalled);
    }
  };

  populateOptions();

  // Toggle drawer
  if (btnAdd) {
    btnAdd.addEventListener("click", () => {
      panel.classList.toggle("hidden");
      if (!panel.classList.contains("hidden")) {
        populateOptions();
        select.focus();
      }
    });
  }

  if (btnCancel) {
    btnCancel.addEventListener("click", () => {
      panel.classList.add("hidden");
    });
  }

  // Confirm addition
  btnConfirm.addEventListener("click", async () => {
    const selectedId = select.value;
    if (!selectedId) {
      showToast("Please choose a theme from the dropdown");
      return;
    }

    const queue = Array.isArray(appState.themeQueue) ? [...appState.themeQueue] : [];
    queue.push(selectedId);
    appState.themeQueue = queue;
    CookieStore.setJSON("theme_rotation_queue", queue);

    await sendExtensionMessage({ type: "UPDATE_QUEUE", themeQueue: queue });
    renderScheduler();
    panel.classList.add("hidden");

    const themeName = select.options[select.selectedIndex]?.text || "Theme";
    showToast(`Added "${themeName}" to rotation sequence!`);
  });
}

function getQueueThemeMeta(id) {
  if (id === "DEFAULT_BROWSER") {
    return { name: "Default Browser", frame: "#d1d1d6", toolbar: "#f5f5f7" };
  }
  const found = GALLERY_PRESETS.find(p => p.id === id) || (appState.customThemes || []).find(t => t.id === id);
  if (found) {
    return {
      name: found.name,
      frame: found.colors?.frame || found.colors?.primary || "#0a84ff",
      toolbar: found.colors?.toolbar || found.colors?.accent || "#5e5ce6"
    };
  }
  const installed = appState.installedThemes?.find(t => t.id === id);
  if (installed) {
    return { name: installed.name, frame: "#0a84ff", toolbar: "#30d158" };
  }
  return {
    name: id.replace("preset-", "").replace("theme-", "").replace(/^\w/, c => c.toUpperCase()),
    frame: "#0a84ff",
    toolbar: "#64d2ff"
  };
}

function renderScheduler() {
  syncSchedulerControlStates();
  const queueList = document.getElementById("queueList");
  const queueCount = document.getElementById("queueCount");
  if (!queueList) return;

  const queue = Array.isArray(appState.themeQueue) && appState.themeQueue.length > 0
    ? appState.themeQueue
    : [...DEFAULT_ROTATION_QUEUE];

  if (queueCount) queueCount.textContent = `${queue.length} ${queue.length === 1 ? "Theme" : "Themes"}`;

  // Sync LIVE indicator strictly to the actual activeThemeId when present in queue
  const matchedLiveIdx = queue.findIndex((tid) => {
    if (tid === appState.activeThemeId) return true;
    const resolved = resolvePopupTheme(tid);
    return Boolean(resolved && resolved.id === appState.activeThemeId);
  });
  if (matchedLiveIdx >= 0) {
    appState.currentIndex = matchedLiveIdx;
  }

  const pillsHtml = queue.map((themeId, i) => {
    const isCurrentActive = i === matchedLiveIdx;
    const meta = getQueueThemeMeta(themeId);
    const swatchStyle = `background: linear-gradient(135deg, ${meta.frame} 0%, ${meta.toolbar} 100%);`;
    return `
      <div class="queue-pill ${isCurrentActive ? "active-rotation-pill" : ""}" data-index="${i}" title="Click to activate ${escapeHtml(meta.name)}">
        <span class="queue-swatch-dot" style="${swatchStyle}"></span>
        <span class="queue-order-num">${i + 1}</span>
        <span class="queue-theme-name">${escapeHtml(meta.name)}</span>
        ${isCurrentActive ? '<span class="queue-active-tag">LIVE</span>' : ''}
        <button type="button" class="queue-remove-btn" data-index="${i}" title="Remove from queue">&times;</button>
      </div>
    `;
  }).join("");

  queueList.innerHTML = pillsHtml;

  // Click pill to activate that theme immediately (persists queue index BEFORE applying so storage listeners never revert it)
  queueList.querySelectorAll(".queue-pill").forEach(pill => {
    pill.addEventListener("click", async () => {
      const idx = Number(pill.dataset.index);
      const targetId = queue[idx];
      if (!targetId) return;
      appState.currentIndex = idx;
      CookieStore.set("schedule_current_index", String(idx));
      updateCachedUserSettings({ currentIndex: idx });
      await sendExtensionMessage({
        type: "UPDATE_QUEUE",
        themeQueue: queue,
        currentIndex: idx
      });
      const cardData = resolvePopupTheme(targetId) || {
        id: targetId,
        name: getQueueThemeMeta(targetId).name
      };
      await handleThemeSelect(cardData);
      renderScheduler();
      updateCountdownDisplay();
    });
  });

  // Remove theme handler
  queueList.querySelectorAll(".queue-remove-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.index);
      if (queue.length <= 1) {
        showToast("Queue must retain at least 1 theme");
        return;
      }
      queue.splice(idx, 1);
      appState.themeQueue = queue;
      if (appState.currentIndex >= queue.length) {
        appState.currentIndex = 0;
      }
      CookieStore.setJSON("theme_rotation_queue", queue);
      await sendExtensionMessage({ type: "UPDATE_QUEUE", themeQueue: queue, currentIndex: appState.currentIndex });
      renderScheduler();
      updateCountdownDisplay();
      showToast("Updated rotation queue");
    });
  });
}

function buildDesignerThemePayload() {
  const name = (document.getElementById("themeNameInput")?.value || "Custom Theme").trim();
  const frame = document.getElementById("hexFrame")?.value || "#1c1c1e";
  const toolbar = document.getElementById("hexToolbar")?.value || "#2c2c2e";
  const text = document.getElementById("hexText")?.value || "#ffffff";
  const ntp = document.getElementById("hexNtp")?.value || "#121212";

  for (const [label, hex] of [["Frame", frame], ["Toolbar", toolbar], ["Tab Text", text], ["NTP", ntp]]) {
    if (!validateHexColor(hex)) throw new Error(`Invalid ${label} hex color: ${hex}`);
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "custom-theme";
  const manifestJson = createThemeManifestJSON({ name, frame, toolbar, text, ntp }, name);
  return { name, slug, frame, toolbar, text, ntp, manifestJson };
}

async function addDesignerThemeToStudio(applyToBrowser = true) {
  const payload = buildDesignerThemePayload();
  const existing = (appState.customThemes || []).find(t => normalizeStr(t.name) === normalizeStr(payload.name));
  const saved = await saveCustomThemeInDB({
    id: existing?.id || `custom-${payload.slug}-${Date.now()}`,
    name: payload.name,
    folder: existing?.folder || payload.slug,
    manifestName: existing?.manifestName || payload.name,
    installedExtensionId: existing?.installedExtensionId || null,
    isInstalled: Boolean(existing?.isInstalled),
    colors: {
      frame: payload.frame,
      toolbar: payload.toolbar,
      text: payload.text,
      ntp: payload.ntp
    },
    manifestJson: payload.manifestJson
  });

  // Ensure imported/created Studio themes are included in the automated rotation queue
  const queue = Array.isArray(appState.themeQueue) ? [...appState.themeQueue] : [];
  if (!queue.includes(saved.id)) {
    queue.push(saved.id);
    appState.themeQueue = queue;
    CookieStore.setJSON("theme_rotation_queue", queue);
    await sendExtensionMessage({ type: "UPDATE_QUEUE", themeQueue: queue });
  }

  // Single-upload sync: automatically write manifest.json to any authorized paired folder
  await writeSingleCustomThemeToPairedDirs(saved).catch(() => {});

  await loadCustomThemesIntoApp();
  renderGallery();
  renderScheduler();

  if (applyToBrowser) {
    await handleThemeSelect(saved);
  }
  return saved;
}

function isExtensionPopupWindow() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) return false;
    if (typeof chrome.extension?.getViews === "function") {
      return chrome.extension.getViews({ type: "popup" }).includes(window);
    }
    return window.innerHeight <= 520;
  } catch (_) {
    return false;
  }
}

function openPersistentStudioTab(tabName = "customizer", categoryName = null) {
  const params = new URLSearchParams();
  if (tabName) params.set("tab", tabName);
  if (categoryName) params.set("cat", categoryName);
  const rel = `popup/popup.html?${params.toString()}`;
  if (typeof chrome !== "undefined" && chrome.tabs?.create && chrome.runtime?.getURL) {
    chrome.tabs.create({ url: chrome.runtime.getURL(rel) });
    return true;
  }
  return false;
}

// Customizer & Manifest Importer Engine
function setupCustomizer() {
  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("themeFileInput");
  const compileBtn = document.getElementById("validateCompileBtn");
  const applyCustomBtn = document.getElementById("applyCustomThemeBtn");
  const scanFolderBtn = document.getElementById("btnScanThemeFolder");
  const openTabBtn = document.getElementById("btnOpenImporterWindow");

  // Prevent browser navigation if a user drops slightly outside #dropZone
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  if (openTabBtn) {
    openTabBtn.addEventListener("click", () => {
      if (openPersistentStudioTab("customizer")) {
        showToast("Opened Customizer in a persistent browser tab.");
      } else {
        window.open("popup.html?tab=customizer", "_blank");
      }
    });
  }

  // Folder Picker Scan (reads manifest.json directly from selected folder)
  if (scanFolderBtn) {
    scanFolderBtn.addEventListener("click", async () => {
      if (isExtensionPopupWindow()) {
        openPersistentStudioTab("customizer");
        return;
      }
      if (typeof window.showDirectoryPicker !== "function") {
        showToast("Folder picker not supported — drop folder onto box above.");
        return;
      }
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: "read" });
        const found = await findManifestInDirHandle(dirHandle);
        if (!found) {
          showToast(`No manifest.json found inside "${dirHandle.name}".`);
          return;
        }
        await handleThemeFileUpload(found.file, found.dirName || dirHandle.name);
      } catch (err) {
        if (err?.name !== "AbortError") {
          showToast(`Folder scan failed: ${err.message || err}`);
        }
      }
    });
  }

  // Drag and Drop (.json, manifest.json, .zip, or unpacked theme folder)
  if (dropZone && fileInput) {
    dropZone.addEventListener("click", (e) => {
      // In extension popups on Windows, opening the OS file picker closes the popup!
      // Automatically switch to a persistent tab so the selected file is never lost.
      if (isExtensionPopupWindow()) {
        e.preventDefault();
        openPersistentStudioTab("customizer");
      }
    });

    dropZone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });

    dropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("dragover");

      const items = Array.from(e.dataTransfer?.items || []);

      // 1. Modern File System Access handle (folders or files)
      for (const item of items) {
        if (typeof item.getAsFileSystemHandle === "function") {
          try {
            const handle = await item.getAsFileSystemHandle();
            if (handle?.kind === "directory") {
              const found = await findManifestInDirHandle(handle);
              if (found) {
                await handleThemeFileUpload(found.file, found.dirName || handle.name);
                return;
              }
              showToast(`No manifest.json found inside folder "${handle.name}"`);
              return;
            }
          } catch (_) {}
        }
      }

      // 2. Classic WebKit directory entry scan (recursive up to 4 levels)
      for (const item of items) {
        if (typeof item.webkitGetAsEntry === "function") {
          const entry = item.webkitGetAsEntry();
          if (entry && entry.isDirectory) {
            await handleDroppedDirectory(entry);
            return;
          }
        }
      }

      // 3. Direct dropped file (.json, manifest.json, .zip)
      const files = Array.from(e.dataTransfer?.files || []);
      const candidate = files.find((f) => /\.(json|zip)$/i.test(f.name)) || files[0];
      if (candidate) {
        await handleThemeFileUpload(candidate);
      } else {
        showToast("Drop a manifest.json, .json, .zip, or theme folder.");
      }
    });

    fileInput.addEventListener("change", async (e) => {
      if (e.target.files && e.target.files[0]) {
        await handleThemeFileUpload(e.target.files[0]);
      }
      fileInput.value = "";
    });
  }

  // Export Validated JSON
  if (compileBtn) {
    compileBtn.addEventListener("click", () => {
      try {
        const payload = buildDesignerThemePayload();
        showToast("Manifest validated & exported safely!");
        downloadThemePackage(payload.name, payload.manifestJson);
      } catch (err) {
        showToast(`Validation error: ${err.message || err}`);
      }
    });
  }

  // Add to Studio Gallery + Apply Immediately to Browser
  if (applyCustomBtn) {
    applyCustomBtn.addEventListener("click", async () => {
      try {
        const saved = await addDesignerThemeToStudio(true);
        showToast(`✓ "${saved.name}" added to Studio & applied!`);
      } catch (err) {
        showToast(`Cannot apply theme: ${err.message || err}`);
      }
    });
  }

}

async function findManifestInDirHandle(dirHandle, depth = 0) {
  if (!dirHandle || depth > 4) return null;
  let jsonFallback = null;
  const subDirs = [];

  for await (const [name, handle] of dirHandle.entries()) {
    const lower = name.toLowerCase();
    if (handle.kind === "file") {
      if (lower === "manifest.json") {
        return { file: await handle.getFile(), dirName: dirHandle.name };
      }
      if (!jsonFallback && lower.endsWith(".json")) {
        jsonFallback = { file: await handle.getFile(), dirName: dirHandle.name };
      }
    } else if (handle.kind === "directory" && !lower.startsWith(".")) {
      subDirs.push(handle);
    }
  }
  if (jsonFallback) return jsonFallback;

  for (const sub of subDirs) {
    const nested = await findManifestInDirHandle(sub, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function readEntryFile(fileEntry) {
  return new Promise((resolve, reject) => fileEntry.file(resolve, reject));
}

function readDirectoryEntries(dirEntry) {
  return new Promise((resolve, reject) => {
    const reader = dirEntry.createReader();
    const all = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else {
          all.push(...batch);
          readBatch();
        }
      }, reject);
    };
    readBatch();
  });
}

async function findManifestEntryRecursive(dirEntry, depth = 0) {
  if (!dirEntry || depth > 4) return null;
  const entries = await readDirectoryEntries(dirEntry);
  const manifest = entries.find((e) => e.isFile && e.name.toLowerCase() === "manifest.json");
  if (manifest) return { entry: manifest, dirName: dirEntry.name };

  const jsonFallback = entries.find((e) => e.isFile && e.name.toLowerCase().endsWith(".json"));
  if (jsonFallback) return { entry: jsonFallback, dirName: dirEntry.name };

  for (const sub of entries.filter((e) => e.isDirectory && !e.name.startsWith("."))) {
    const nested = await findManifestEntryRecursive(sub, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function handleDroppedDirectory(dirEntry) {
  try {
    const found = await findManifestEntryRecursive(dirEntry);
    if (!found) {
      showToast(`Dropped folder "${dirEntry.name}" does not contain a manifest.json file`);
      return;
    }
    const file = await readEntryFile(found.entry);
    await handleThemeFileUpload(file, found.dirName || dirEntry.name);
  } catch (err) {
    showToast(`Folder read failed: ${err.message || err}`);
  }
}

// File Upload Handler (.json / manifest.json / .zip) -> Scans, Populates Designer, Adds to Studio & Applies
async function handleThemeFileUpload(file, fallbackDirName = null) {
  if (!file) return;
  const lowerName = (file.name || "").toLowerCase();
  const isZip = lowerName.endsWith(".zip") || file.type === "application/zip" || file.type === "application/x-zip-compressed";

  if (!isZip && file.size > 2 * 1024 * 1024) {
    showToast("File rejected: JSON exceeds 2 MB limit");
    return;
  }
  if (isZip && file.size > 25 * 1024 * 1024) {
    showToast("File rejected: ZIP archive exceeds 25 MB limit");
    return;
  }

  try {
    let rawJsonText = "";
    if (isZip) {
      const buf = await file.arrayBuffer();
      rawJsonText = await extractManifestFromZipBuffer(buf);
    } else {
      rawJsonText = await file.text();
    }

    const baseFallback = fallbackDirName ||
      (lowerName !== "manifest.json" ? file.name.replace(/\.(json|zip)$/i, "") : "Imported Theme");

    const cleanManifest = secureParseAndCompile(rawJsonText, baseFallback);
    const parsed = JSON.parse(cleanManifest);

    if (parsed.theme && parsed.theme.colors) {
      const c = parsed.theme.colors;
      const rgbToHex = ([r, g, b]) => "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
      const hexColors = {
        frame: rgbToHex(c.frame),
        toolbar: rgbToHex(c.toolbar),
        text: rgbToHex(c.tab_text),
        ntp: rgbToHex(c.ntp_background)
      };
      updateDesignerInputs(hexColors, parsed.name);

      CookieStore.setJSON("custom_theme_draft", {
        ...hexColors,
        name: parsed.name
      });
    }

    // Automatically implement the scanned manifest: save to Studio & apply to browser!
    const saved = await addDesignerThemeToStudio(true);

    const badge = document.getElementById("importedManifestBadge");
    if (badge) {
      badge.textContent = `Applied: ${saved.name}`;
      badge.classList.remove("hidden");
      badge.classList.add("active");
    }

    showToast(`✓ Scanned & applied "${saved.name}" to Studio & Browser!`);
  } catch (err) {
    showToast(`Import failed: ${err.message || err}`);
  }
}

// Live Preview Bindings
function setupLivePreview() {
  const bindings = [
    { picker: "colorFrame", hex: "hexFrame", target: "prevFrame", prop: "backgroundColor" },
    { picker: "colorToolbar", hex: "hexToolbar", target: "prevToolbar", prop: "backgroundColor" },
    { picker: "colorText", hex: "hexText", target: "prevTabText", prop: "color" },
    { picker: "colorNtp", hex: "hexNtp", target: "prevNtp", prop: "backgroundColor" }
  ];

  const saveDraft = () => {
    CookieStore.setJSON("custom_theme_draft", {
      frame: document.getElementById("hexFrame")?.value || "#1c1c1e",
      toolbar: document.getElementById("hexToolbar")?.value || "#2c2c2e",
      text: document.getElementById("hexText")?.value || "#ffffff",
      ntp: document.getElementById("hexNtp")?.value || "#121212",
      name: document.getElementById("themeNameInput")?.value || "Custom Theme"
    });
  };

  const nameInput = document.getElementById("themeNameInput");
  if (nameInput) {
    nameInput.addEventListener("input", saveDraft);
  }

  bindings.forEach(({ picker, hex, target, prop }) => {
    const pEl = document.getElementById(picker);
    const hEl = document.getElementById(hex);
    const tEl = document.getElementById(target);

    if (pEl && hEl && tEl) {
      pEl.addEventListener("input", () => {
        hEl.value = pEl.value;
        tEl.style[prop] = pEl.value;
        saveDraft();
      });

      hEl.addEventListener("input", () => {
        if (/^#[0-9A-Fa-f]{6}$/.test(hEl.value)) {
          pEl.value = hEl.value;
          tEl.style[prop] = hEl.value;
          saveDraft();
        }
      });
    }
  });

  // Restore saved custom draft from cookies
  const savedDraft = CookieStore.getJSON("custom_theme_draft");
  if (savedDraft) {
    updateDesignerInputs(savedDraft, savedDraft.name);
  } else {
    // Initial preview paint
    updatePreviewElements();
  }
}

function updatePreviewElements() {
  const frame = document.getElementById("hexFrame")?.value || "#1c1c1e";
  const toolbar = document.getElementById("hexToolbar")?.value || "#2c2c2e";
  const text = document.getElementById("hexText")?.value || "#ffffff";
  const ntp = document.getElementById("hexNtp")?.value || "#121212";

  const prevFrame = document.getElementById("prevFrame");
  const prevToolbar = document.getElementById("prevToolbar");
  const prevTab = document.getElementById("prevTab");
  const prevTabText = document.getElementById("prevTabText");
  const prevNtp = document.getElementById("prevNtp");

  if (prevFrame) prevFrame.style.backgroundColor = frame;
  if (prevToolbar) prevToolbar.style.backgroundColor = toolbar;
  if (prevTab) prevTab.style.backgroundColor = toolbar;
  if (prevTabText) prevTabText.style.color = text;
  if (prevNtp) prevNtp.style.backgroundColor = ntp;
}

function updateDesignerInputs(colors, name) {
  if (name) {
    const nameEl = document.getElementById("themeNameInput");
    if (nameEl) nameEl.value = name;
  }
  if (colors.frame) {
    setField("colorFrame", "hexFrame", colors.frame);
  }
  if (colors.toolbar) {
    setField("colorToolbar", "hexToolbar", colors.toolbar);
  }
  if (colors.text) {
    setField("colorText", "hexText", colors.text);
  }
  if (colors.ntp) {
    setField("colorNtp", "hexNtp", colors.ntp);
  }
  updatePreviewElements();
}

function setField(pickerId, hexId, value) {
  const p = document.getElementById(pickerId);
  const h = document.getElementById(hexId);
  if (p && h) {
    p.value = value;
    h.value = value;
  }
}

// Download Compiled Theme Manifest (Safe filename sanitization)
function downloadThemePackage(name, manifestJson) {
  const safeBase = String(name || "custom-theme")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 32);
  const blob = new Blob([manifestJson], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `manifest-${safeBase || "theme"}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================================
// BUTTON ANIMATION & GLOBAL ACTION UPDATE MODAL
// ============================================================================

function triggerSpinAnimation(el) {
  if (!el) return;
  el.classList.remove("is-spinning");
  void el.offsetWidth;
  el.classList.add("is-spinning");
  setTimeout(() => {
    el.classList.remove("is-spinning");
  }, 600);
}

function resolveModalMeta(rawMsg) {
  const cleanMsg = String(rawMsg || "").replace(/^[✓!\s]+/, "").trim();
  const lower = cleanMsg.toLowerCase();

  if (lower.includes("error") || lower.includes("failed") || lower.includes("rejected") || lower.includes("skipped") || lower.includes("please") || lower.includes("must retain") || lower.includes("cancelled") || lower.includes("cannot") || lower.includes("upload at least")) {
    return { title: "Notice", detail: cleanMsg, variant: "warning" };
  }
  if (lower.includes("interval") || lower.includes("auto-cycle") || lower.includes("countdown") || lower.includes("timer") || lower.includes("queue") || lower.includes("rotated") || lower.includes("advancing")) {
    return { title: "Scheduler", detail: cleanMsg, variant: "success" };
  }
  if (lower.includes("default") || lower.includes("reset") || lower.includes("refreshed")) {
    return { title: "Reset", detail: cleanMsg, variant: "info" };
  }
  if (lower.includes("color mode")) {
    return { title: "Mode", detail: cleanMsg, variant: "success" };
  }
  if (lower.includes("wallpaper")) {
    return { title: "Wallpaper", detail: cleanMsg, variant: "success" };
  }
  if (lower.includes("imported") || lower.includes("manifest") || lower.includes("validated")) {
    return { title: "Importer", detail: cleanMsg, variant: "success" };
  }
  if (lower.includes("local device") || lower.includes("local storage")) {
    return { title: "Storage", detail: cleanMsg, variant: "success" };
  }
  if (lower.includes("downloaded") || lower.includes("zip")) {
    return { title: "Export", detail: cleanMsg, variant: "success" };
  }
  return { title: "Updated", detail: cleanMsg, variant: "success" };
}

let actionModalTimer = null;

function closeActionModal() {
  const dialog = document.getElementById("actionUpdateModal");
  if (dialog) {
    dialog.classList.add("hidden");
    try {
      if (dialog.open) dialog.close();
    } catch (_) {}
  }
  clearTimeout(actionModalTimer);
}

function setupActionModal() {
  const dialog = document.getElementById("actionUpdateModal");
  const card = document.getElementById("actionModalCard");
  const okBtn = document.getElementById("actionModalOkBtn");
  const closeBtn = document.getElementById("actionModalCloseBtn");

  okBtn?.addEventListener("click", closeActionModal);
  closeBtn?.addEventListener("click", closeActionModal);

  // Pause auto-dismiss while cursor hovers on the floating dialog card
  card?.addEventListener("mouseenter", () => clearTimeout(actionModalTimer));
  card?.addEventListener("mouseleave", () => {
    if (dialog && !dialog.classList.contains("hidden")) {
      clearTimeout(actionModalTimer);
      actionModalTimer = setTimeout(closeActionModal, 1800);
    }
  });
}

function showToast(msg, durationMs = 2800) {
  const dialog = document.getElementById("actionUpdateModal");
  const titleEl = document.getElementById("actionModalTitle");
  const msgEl = document.getElementById("actionModalMessage");
  const iconEl = document.getElementById("actionModalIcon");
  const progressEl = document.getElementById("actionModalProgress");
  if (!dialog || !msgEl) return;

  const meta = typeof msg === "object" && msg !== null ? msg : resolveModalMeta(msg);
  if (titleEl) titleEl.textContent = meta.title || "Updated";
  msgEl.textContent = meta.detail || "";

  if (iconEl) {
    iconEl.className = `action-modal-icon ${meta.variant || "success"}`;
    if (meta.variant === "warning") {
      iconEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    } else if (meta.variant === "info") {
      iconEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
    } else {
      iconEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    }
  }

  const ms = Number(meta.duration || durationMs) || 2800;
  if (progressEl) {
    progressEl.style.animation = "none";
    void progressEl.offsetWidth;
    progressEl.style.animation = `actionModalShrink ${ms}ms linear forwards`;
  }

  try {
    if (!dialog.open && typeof dialog.show === "function") {
      dialog.show(); // Explicitly non-modal .show() instead of .showModal()
    }
  } catch (_) {}
  dialog.classList.remove("hidden");
  clearTimeout(actionModalTimer);
  actionModalTimer = setTimeout(closeActionModal, ms);
}

function updateActiveBadge(themeName) {
  const badge = document.getElementById("activeThemeBadge");
  if (badge) {
    badge.textContent = themeName === "DEFAULT_BROWSER" ? "Default Browser" : themeName;
  }
  updateDashboardView();
}

// Listen for external OS / Chromium appearance changes & Canvas sync
function setupThemeListeners() {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    console.log("[Appearance] OS color scheme changed:", e.matches ? "Dark" : "Light");
    // If active theme is DEFAULT_BROWSER, Chromium handles appearance seamlessly
  });

  window.addEventListener("message", (event) => {
    // Defense-in-depth: Validate message origin to prevent cross-frame tampering
    if (event.origin && event.origin !== "null" && event.origin !== window.location.origin) {
      return;
    }
    if (event.data?.type === "SYNC_THEME_FROM_CANVAS") {
      appState.activeThemeId = event.data.themeId;
      updateActiveBadge(event.data.name || "Aesthetic Theme");
      renderGallery();
    }
  });
}


// ============================================================================
// MICROSOFT EDGE THEME QUICK INSTALLER CONTROLLER
// Seamless 1-click loading, package downloads, and live auto-detection
// ============================================================================
let currentInstallerTarget = null;

function openEdgeInstallerModal(cardData) {
  const modal = document.getElementById("edgeInstallerModal");
  if (!modal) return;

  const titleEl = document.getElementById("installerThemeTitle");
  const folderCode = document.getElementById("installerFolderCode");
  const stepFolder = document.getElementById("installerStepFolder");
  const swatchFrame = document.getElementById("swatchFrame");
  const swatchToolbar = document.getElementById("swatchToolbar");
  const swatchTab = document.getElementById("swatchTab");
  const swatchNtp = document.getElementById("swatchNtp");
  const pulseDot = document.getElementById("installerPulseDot");
  const statusText = document.getElementById("installerStatusText");

  const mapping = findThemeMeta(cardData.id);
  const folder = mapping ? mapping.folder : cardData.id.replace("preset-", "").replace("theme-", "");
  const manifestName = mapping ? mapping.manifestName : `Instant Theme - ${cardData.name}`;

  currentInstallerTarget = {
    cardData,
    folder,
    manifestName
  };

  if (titleEl) titleEl.textContent = cardData.name;
  if (folderCode) folderCode.textContent = `themes/${folder}`;
  if (stepFolder) stepFolder.textContent = `themes/${folder}`;

  const c = cardData.colors || { frame: "#2c2c2e", toolbar: "#3a3a3c", text: "#ffffff", ntp: "#1c1c1e" };
  if (swatchFrame) swatchFrame.style.backgroundColor = c.frame;
  if (swatchToolbar) swatchToolbar.style.backgroundColor = c.toolbar;
  if (swatchTab) swatchTab.style.backgroundColor = c.text;
  if (swatchNtp) swatchNtp.style.backgroundColor = c.ntp;

  if (pulseDot) pulseDot.className = "status-pulse-dot";
  if (statusText) statusText.innerHTML = `Folder ready at <code>themes/${folder}</code>. Load unpacked in Edge:`;

  modal.classList.remove("hidden");
}

function closeEdgeInstallerModal() {
  const modal = document.getElementById("edgeInstallerModal");
  if (modal) modal.classList.add("hidden");
  currentInstallerTarget = null;
}

function setupEdgeInstaller() {
  const modal = document.getElementById("edgeInstallerModal");
  const closeBtn = document.getElementById("closeInstallerModal");
  const btnOpen = document.getElementById("btnOpenEdgeExtensions");
  const btnDownload = document.getElementById("btnDownloadThemePackage");

  if (closeBtn) {
    closeBtn.addEventListener("click", closeEdgeInstallerModal);
  }

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeEdgeInstallerModal();
    });
  }

  if (btnOpen) {
    btnOpen.addEventListener("click", async () => {
      showToast("Opening edge://extensions in a new tab...");
      await sendExtensionMessage({ type: "OPEN_EXTENSIONS_PAGE" });
    });
  }

  if (btnDownload) {
    btnDownload.addEventListener("click", () => {
      if (!currentInstallerTarget) return;
      downloadSingleThemeZip(currentInstallerTarget);
    });
  }
}

// Auto-detect when the user loads the theme in edge://extensions
function checkInstallerAutoClose(msg) {
  const modal = document.getElementById("edgeInstallerModal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (!currentInstallerTarget) return;

  const targetFolder = currentInstallerTarget.folder;
  const targetManifest = currentInstallerTarget.manifestName.toLowerCase();

  const themeName = (msg.theme?.name || "").toLowerCase();
  const matches = themeName === targetManifest ||
    normalizeStr(themeName) === normalizeStr(targetFolder) ||
    normalizeStr(themeName) === normalizeStr(currentInstallerTarget.cardData.name);

  if (matches) {
    const pulseDot = document.getElementById("installerPulseDot");
    const statusText = document.getElementById("installerStatusText");
    if (pulseDot) pulseDot.className = "status-pulse-dot success";
    if (statusText) statusText.innerHTML = `<strong>✓ Detected in Edge!</strong> Activating theme...`;

    setTimeout(async () => {
      await handleThemeSelect(currentInstallerTarget.cardData);
      closeEdgeInstallerModal();
    }, 1200);
  }
}

// Download a single theme package containing valid manifest.json
function downloadSingleThemeZip(target) {
  const { folder, manifestName, cardData } = target;
  const manifestStr = createThemeManifestJSON(cardData.colors || folder, manifestName);
  const url = URL.createObjectURL(generateSingleFileZip("manifest.json", manifestStr));
  const a = Object.assign(document.createElement("a"), { href: url, download: `theme-${folder}.zip` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Downloaded theme-${folder}.zip! Extract & load in Edge.`);
}

// Lightweight standard uncompressed ZIP generator for single file in pure JS
function generateSingleFileZip(filename, contentStr) {
  const encoder = new TextEncoder();
  const fileData = encoder.encode(contentStr);
  const nameData = encoder.encode(filename);

  let crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c;
  }
  function crc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }

  const fileCrc = crc32(fileData);
  const fileLen = fileData.length;
  const nameLen = nameData.length;

  const localHeader = new Uint8Array(30 + nameLen + fileLen);
  const lv = new DataView(localHeader.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0, true);
  lv.setUint16(8, 0, true);
  lv.setUint16(10, 0, true);
  lv.setUint16(12, 0, true);
  lv.setUint32(14, fileCrc, true);
  lv.setUint32(18, fileLen, true);
  lv.setUint32(22, fileLen, true);
  lv.setUint16(26, nameLen, true);
  lv.setUint16(28, 0, true);
  localHeader.set(nameData, 30);
  localHeader.set(fileData, 30 + nameLen);

  const localOffset = 0;

  const centralHeader = new Uint8Array(46 + nameLen);
  const cv = new DataView(centralHeader.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0, true);
  cv.setUint16(10, 0, true);
  cv.setUint16(12, 0, true);
  cv.setUint16(14, 0, true);
  cv.setUint32(16, fileCrc, true);
  cv.setUint32(20, fileLen, true);
  cv.setUint32(24, fileLen, true);
  cv.setUint16(28, nameLen, true);
  cv.setUint16(30, 0, true);
  cv.setUint16(32, 0, true);
  cv.setUint16(34, 0, true);
  cv.setUint16(36, 0, true);
  cv.setUint32(38, 0, true);
  cv.setUint32(42, localOffset, true);
  centralHeader.set(nameData, 46);

  const centralOffset = localHeader.length;
  const centralLen = centralHeader.length;

  const endRecord = new Uint8Array(22);
  const ev = new DataView(endRecord.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, centralLen, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true);

  const combined = new Uint8Array(localHeader.length + centralHeader.length + endRecord.length);
  combined.set(localHeader, 0);
  combined.set(centralHeader, localHeader.length);
  combined.set(endRecord, localHeader.length + centralHeader.length);
  return new Blob([combined], { type: "application/zip" });
}


// ============================================================================
// LIVE COMPANION SYNC UI CONTROLLER (Phase 4 & 5)
// ============================================================================
async function updateLiveSyncStatus() {
  const syncBtn = document.getElementById("btnLiveSyncSetup");
  if (!syncBtn) return;

  try {
    const status = await checkCompanionStatus();
    if (status.isReadyForLiveSync) {
      syncBtn.textContent = "✓ Synced";
      syncBtn.classList.add("connected");
      syncBtn.title = "Live Tab Bar & New Tab sync active";
    } else if (status.liveThemeConnected && !status.folderHasPermission) {
      syncBtn.textContent = "Load in Edge";
      syncBtn.classList.remove("connected");
      syncBtn.title = "Authorize or load theme in Edge/Chrome";
    } else {
      syncBtn.textContent = "Load in Edge";
      syncBtn.classList.remove("connected");
      syncBtn.title = "Open setup to load theme in Edge/Chrome";
    }
  } catch (_) {}
}

function setupLiveSyncUI() {
  const syncBtn = document.getElementById("btnLiveSyncSetup");
  const modalLiveBtn = document.getElementById("btnModalLiveSetup");

  const openSetupTab = () => {
    showToast("Opened Setup & Manifests Window in a new tab.");
    if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.runtime?.getURL === "function") {
      const url = chrome.runtime.getURL("popup/companion.html");
      chrome.tabs.create({ url });
    } else {
      window.open("companion.html", "_blank");
    }
  };

  if (syncBtn) syncBtn.addEventListener("click", openSetupTab);
  if (modalLiveBtn) modalLiveBtn.addEventListener("click", openSetupTab);
}


// ============================================================================
// THEME STUDIO SIDEBAR DASHBOARD ENGINE
// ============================================================================

export async function updateDashboardView() {
  const activeNameEl = document.getElementById("dashActiveThemeName");
  const modeBadgeEl = document.getElementById("dashModeBadge");
  const syncBadgeEl = document.getElementById("dashSyncBadge");
  const syncDotEl = document.getElementById("dashSyncIndicator");
  const folderStatusEl = document.getElementById("dashFolderStatus");
  const themeStatusEl = document.getElementById("dashThemeStatus");
  const scheduleStatusEl = document.getElementById("dashScheduleStatus");
  const nextThemeEl = document.getElementById("dashNextThemeName");
  const countdownEl = document.getElementById("dashCountdownDisplay");

  // Swatches
  const swatchFrame = document.getElementById("dashSwatchFrame");
  const hexFrame = document.getElementById("dashHexFrame");
  const swatchToolbar = document.getElementById("dashSwatchToolbar");
  const hexToolbar = document.getElementById("dashHexToolbar");
  const swatchText = document.getElementById("dashSwatchText");
  const hexText = document.getElementById("dashHexText");
  const swatchNtp = document.getElementById("dashSwatchNtp");
  const hexNtp = document.getElementById("dashHexNtp");

  const activeId = appState.activeThemeId || "DEFAULT_BROWSER";
  const activeObj = GALLERY_PRESETS.find(p => p.id === activeId) ||
    (appState.customThemes || []).find(t => t.id === activeId) || {
    name: activeId === "DEFAULT_BROWSER" ? "Default Browser" : activeId.replace("preset-", "").replace("theme-", ""),
    colors: null
  };

  if (activeNameEl) {
    activeNameEl.textContent = activeObj.name || (activeId === "DEFAULT_BROWSER" ? "Default Browser" : activeId);
  }

  if (modeBadgeEl) {
    const isDark = appState.themeMode === "dark" || (activeObj.colors && isColorDark(activeObj.colors.frame));
    modeBadgeEl.textContent = isDark ? "Dark Appearance" : "Light Appearance";
  }

  // Check live companion status
  try {
    const status = await checkCompanionStatus();
    const isConnected = !!status.liveThemeConnected;
    const hasPerm = !!status.folderHasPermission;
    const isInstalled = !!status.liveThemeInstalled;
    const activePreset = GALLERY_PRESETS.find((p) => p.id === activeId);
    const isStandaloneInEdge = Boolean(activePreset?.isInstalled);

    if (folderStatusEl) {
      if (isConnected && hasPerm) {
        folderStatusEl.textContent = `Connected (${status.folderName || "live-theme"})`;
        folderStatusEl.style.color = "var(--apple-green)";
      } else if (isConnected) {
        folderStatusEl.textContent = `Needs Re-auth (${status.folderName || "live-theme"})`;
        folderStatusEl.style.color = "var(--apple-orange)";
      } else {
        folderStatusEl.textContent = "Ready to Connect";
        folderStatusEl.style.color = "var(--apple-orange)";
      }
    }

    if (themeStatusEl) {
      if (isStandaloneInEdge) {
        themeStatusEl.textContent = activePreset.isEnabled ? "Active in Edge" : "Installed in Edge";
        themeStatusEl.style.color = "var(--apple-green)";
      } else if (isInstalled) {
        themeStatusEl.textContent = "Companion Loaded (Click ↻ in Edge to repaint)";
        themeStatusEl.style.color = "var(--apple-green)";
      } else {
        themeStatusEl.textContent = `Not Loaded in Edge (${status.folderName || "live-theme"})`;
        themeStatusEl.style.color = "var(--text-secondary)";
      }
    }

    if (syncDotEl) {
      syncDotEl.className = (isStandaloneInEdge && activePreset?.isEnabled) || (isConnected && hasPerm && isInstalled)
        ? "dash-dot-indicator connected"
        : "dash-dot-indicator";
    }

    if (syncBadgeEl) {
      if (isStandaloneInEdge && activePreset?.isEnabled) {
        syncBadgeEl.textContent = "Edge Tab Bar Active";
        syncBadgeEl.className = "dash-sync-badge live-active";
      } else if (isConnected && hasPerm && isInstalled) {
        syncBadgeEl.textContent = "Folder + New Tab Synced";
        syncBadgeEl.className = "dash-sync-badge live-active";
      } else {
        syncBadgeEl.textContent = "New Tab / Extension Only";
        syncBadgeEl.className = "dash-sync-badge";
      }
    }

    // Check real-time IndexedDB database & Local Device Space status
    const apiStatusEl = document.getElementById("dashApiStatus");
    if (apiStatusEl) {
      const dbSt = await getRealtimeStateFromDB();
      const modeLabel = (dbSt?.colorMode || appState.colorMode || "dark") === "dark" ? "Dark" : "Light";
      apiStatusEl.textContent = `${THEMES.length + (appState.customThemes?.length || 0)} Themes · ${modeLabel}`;
      apiStatusEl.style.color = "var(--apple-green)";
    }
    await updateLocalSpaceStatus();
  } catch (e) {
    console.warn("[Dashboard] Companion status error:", e);
  }

  // Update color swatches
  let colors = activeObj.colors;
  if (!colors) {
    const cleanKey = activeId.replace("preset-", "").replace("theme-", "");
    const presetData = THEME_PRESETS[cleanKey];
    if (presetData && presetData.colors) {
      const c = presetData.colors;
      const rgbToHex = (arr) => Array.isArray(arr) ? `#${arr.map(x => x.toString(16).padStart(2, '0')).join('')}` : (arr || "#1e1e1e");
      colors = {
        frame: rgbToHex(c.frame),
        toolbar: rgbToHex(c.toolbar),
        text: rgbToHex(c.tab_text || c.text || [255, 255, 255]),
        ntp: rgbToHex(c.ntp_background || c.ntp || [20, 20, 20])
      };
    } else {
      colors = { frame: "#1e1e1e", toolbar: "#2d2d2d", text: "#ffffff", ntp: "#141414" };
    }
  }

  if (colors) {
    if (swatchFrame && colors.frame) {
      swatchFrame.style.background = colors.frame;
      if (hexFrame) hexFrame.textContent = colors.frame.toUpperCase();
    }
    if (swatchToolbar && colors.toolbar) {
      swatchToolbar.style.background = colors.toolbar;
      if (hexToolbar) hexToolbar.textContent = colors.toolbar.toUpperCase();
    }
    if (swatchText && (colors.text || colors.tab_text)) {
      const txtCol = colors.text || colors.tab_text;
      swatchText.style.background = txtCol;
      if (hexText) hexText.textContent = txtCol.toUpperCase();
    }
    if (swatchNtp && (colors.ntp || colors.background)) {
      const ntpCol = colors.ntp || colors.background;
      swatchNtp.style.background = ntpCol;
      if (hexNtp) hexNtp.textContent = ntpCol.toUpperCase();
    }
  }

  // Update schedule status
  if (scheduleStatusEl) {
    scheduleStatusEl.textContent = appState.scheduleEnabled ? `Active · ${appState.intervalMinutes || 120}m` : "Inactive";
    if (appState.scheduleEnabled) {
      scheduleStatusEl.classList.add("success");
    } else {
      scheduleStatusEl.classList.remove("success");
    }
  }

  const queue = Array.isArray(appState.themeQueue) && appState.themeQueue.length > 0
    ? appState.themeQueue
    : ["DEFAULT_BROWSER", "preset-aurora", "preset-midsummer", "preset-nebula"];
  const nextIndex = (appState.currentIndex + 1) % queue.length;
  const nextThemeId = queue[nextIndex];
  const nextPreset = GALLERY_PRESETS.find(p => p.id === nextThemeId);
  const nextName = nextPreset ? nextPreset.name : nextThemeId.replace("preset-", "").replace("theme-", "");

  if (nextThemeEl) {
    nextThemeEl.textContent = nextName;
  }

  if (countdownEl) {
    if (!appState.scheduleEnabled) {
      countdownEl.textContent = "Paused";
    } else {
      const now = Date.now();
      const target = appState.targetRotationTime || (now + 7200000);
      const remainingSecs = Math.max(0, (target - now) / 1000);
      countdownEl.textContent = formatCountdown(remainingSecs);
    }
  }
}

function setupDashboardSidebar() {
  const sidebar = document.getElementById("dashboardSidebar");
  const overlay = document.getElementById("dashboardSidebarOverlay");
  const toggleBtn = document.getElementById("dashboardToggleBtn");
  const closeBtn = document.getElementById("closeDashboardSidebarBtn");

  const openSidebar = () => {
    if (sidebar) sidebar.classList.remove("hidden");
    if (overlay) overlay.classList.remove("hidden");
    updateDashboardView();
  };

  const closeSidebar = () => {
    if (sidebar) sidebar.classList.add("hidden");
    if (overlay) overlay.classList.add("hidden");
  };

  if (toggleBtn) toggleBtn.addEventListener("click", openSidebar);
  if (closeBtn) closeBtn.addEventListener("click", closeSidebar);
  if (overlay) overlay.addEventListener("click", closeSidebar);

  // Open Setup & Manifests Window
  const btnConnect = document.getElementById("btnDashConnectLiveTheme");
  if (btnConnect) {
    btnConnect.addEventListener("click", async () => {
      showToast("Opened Setup & Manifests Window in a new tab.");
      if (typeof chrome !== "undefined" && chrome.tabs?.create && chrome.runtime?.getURL) {
        await chrome.tabs.create({ url: chrome.runtime.getURL("popup/companion.html") });
      } else {
        window.open("companion.html", "_blank");
      }
    });
  }

  // Force Refresh Tab Bar
  const btnRefresh = document.getElementById("btnDashForceRefresh");
  if (btnRefresh) {
    btnRefresh.addEventListener("click", async () => {
      triggerSpinAnimation(btnRefresh);
      const res = await applyNativeTabBarTheme(appState.activeThemeId || "aurora");
      showToast(res.status === "applied_live_dynamic" ? "Tab Bar Refreshed & Synced!" : "Refreshed active browser theme state");
      updateDashboardView();
    });
  }

  // Rotate Now from Dashboard
  const btnRotate = document.getElementById("btnDashRotateNow");
  if (btnRotate) {
    btnRotate.addEventListener("click", async () => {
      await advanceQueueTheme();
      updateDashboardView();
      showToast("Rotated to next theme in queue!");
    });
  }

  // Go to Scheduler tab
  const btnGoToSched = document.getElementById("btnDashGoToScheduler");
  if (btnGoToSched) {
    btnGoToSched.addEventListener("click", () => {
      closeSidebar();
      document.querySelector('.segment-btn[data-tab="scheduler"]')?.click();
    });
  }

  // Restore Default from Dashboard (shared flow)
  const btnReset = document.getElementById("btnDashResetDefault");
  if (btnReset) {
    btnReset.addEventListener("click", async () => {
      triggerSpinAnimation(btnReset);
      await handleThemeSelect({ id: "DEFAULT_BROWSER", name: "Default Browser", colors: DEFAULT_COLORS });
      updateDashboardView();
    });
  }

  // Fresh Reset (wipe loaded custom themes & reset studio to beginning)
  const btnFreshReset = document.getElementById("btnDashFreshReset");
  if (btnFreshReset) {
    btnFreshReset.addEventListener("click", async () => {
      triggerSpinAnimation(btnFreshReset);
      await performFreshReset(false);
      closeSidebar();
      showToast("✓ Studio refreshed — loaded custom themes cleared & reset to default!");
    });
  }

  // Open Extensions
  const btnExt = document.getElementById("btnDashOpenExtensions");
  if (btnExt) {
    btnExt.addEventListener("click", async () => {
      await sendExtensionMessage({ type: "OPEN_EXTENSIONS_PAGE" });
      showToast("Opening Extensions page in a new tab");
    });
  }

  // Download Active Theme Package ZIP
  const btnZip = document.getElementById("btnDashDownloadZip");
  if (btnZip) {
    btnZip.addEventListener("click", () => {
      const activeObj = resolvePopupTheme(appState.activeThemeId) || resolvePopupTheme("preset-aurora");
      if (activeObj) {
        downloadSingleThemeZip({
          folder: activeObj.folder || "custom-theme",
          manifestName: activeObj.manifestName || activeObj.name,
          cardData: activeObj
        });
      }
    });
  }
}

// ============================================================================
// LOCAL DEVICE SPACE PERMISSIONS & FILE-SYSTEM DB SYNC UI
// ============================================================================
async function updateLocalSpaceStatus() {
  const customText = document.getElementById("localSpaceStatusText");
  const dashText = document.getElementById("dashLocalSpaceStatus");
  const grantBtn = document.getElementById("btnGrantLocalSpace");

  try {
    const st = await getLocalDeviceSpaceStatus();
    if (st.hasFolder && st.folderPermission) {
      const msg = `Synced (${st.folderName}) · ${st.usageMB} MB used`;
      if (customText) customText.textContent = `Active: "${st.folderName}" (${st.usageMB} MB local DB)`;
      if (dashText) {
        dashText.textContent = msg;
        dashText.style.color = "var(--apple-green)";
      }
      if (grantBtn) grantBtn.textContent = "Synced ✓";
    } else if (st.persisted) {
      if (customText) customText.textContent = `Persistent IndexedDB granted (${st.usageMB} MB). Pair folder to save files on disk.`;
      if (dashText) {
        dashText.textContent = `Persistent (${st.usageMB} MB · Pick Folder)`;
        dashText.style.color = "var(--apple-blue)";
      }
      if (grantBtn) grantBtn.textContent = "Link Folder";
    } else {
      if (customText) customText.textContent = "Grant permission to persist settings, themes & wallpapers on your device";
      if (dashText) {
        dashText.textContent = "Permission Needed";
        dashText.style.color = "var(--apple-orange)";
      }
      if (grantBtn) grantBtn.textContent = "Grant Access";
    }
  } catch (_) {}
}

function setupLocalDeviceSpaceUI() {
  const handleGrant = async () => {
    try {
      const res = await requestLocalDeviceSpacePermission(true);
      await loadCustomThemesIntoApp();
      renderGallery();
      await renderWallpaperStudio();
      await updateLocalSpaceStatus();
      if (res.folderPermission) {
        showToast(`✓ Local Device Space "${res.folderName}" authorized & synced!`);
      } else if (res.persisted) {
        showToast("✓ Persistent local browser storage permission granted!");
      } else {
        showToast("Local storage access initialized");
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        showToast(`Local permission cancelled or unavailable: ${err.message || err}`);
      }
    }
  };

  document.getElementById("btnGrantLocalSpace")?.addEventListener("click", handleGrant);
  document.getElementById("btnDashGrantLocalSpace")?.addEventListener("click", handleGrant);
  updateLocalSpaceStatus();
}

// ============================================================================
// LIVE COUNTDOWN TIMER & QUEUE ADVANCEMENT ENGINE
// ============================================================================
let countdownInterval = null;

function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  const pad = (n) => String(n).padStart(2, "0");
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

function updateCountdownDisplay() {
  const card = document.getElementById("countdownCard");
  const digits = document.getElementById("countdownDigits");
  const subtext = document.getElementById("countdownSubtext");
  const fill = document.getElementById("countdownProgressBar");
  const nextThemeEl = document.getElementById("countdownNextTheme");
  const nextSwatch = document.getElementById("countdownNextSwatch");
  const pulseDot = document.getElementById("countdownPulseDot");
  const badge = document.getElementById("countdownStatusBadge");

  const queue = Array.isArray(appState.themeQueue) && appState.themeQueue.length > 0
    ? appState.themeQueue
    : ["DEFAULT_BROWSER", "preset-aurora", "preset-midsummer", "preset-nebula"];

  const nextIndex = (appState.currentIndex + 1) % queue.length;
  const nextThemeId = queue[nextIndex];
  const nextMeta = getQueueThemeMeta(nextThemeId);

  if (nextThemeEl) nextThemeEl.textContent = nextMeta.name;
  if (nextSwatch) {
    nextSwatch.style.background = `linear-gradient(135deg, ${nextMeta.frame} 0%, ${nextMeta.toolbar} 100%)`;
  }

  if (!appState.scheduleEnabled) {
    if (card) {
      card.classList.add("is-paused");
      card.classList.remove("is-active");
    }
    if (digits) digits.textContent = "PAUSED";
    if (subtext) subtext.textContent = "Enable Auto-Cycle to start timer";
    if (fill) fill.style.width = "0%";
    if (pulseDot) pulseDot.style.animation = "none";
    if (badge) badge.textContent = "Scheduler Paused";
    return;
  }

  if (card) {
    card.classList.remove("is-paused");
    card.classList.add("is-active");
  }
  const mins = normalizeAllowedIntervalMinutes(appState.intervalMinutes || 120);
  appState.intervalMinutes = mins;
  const intervalText = mins >= 60 ? `${mins / 60}h` : `${mins}m`;
  if (pulseDot) pulseDot.style.animation = "pulseCountdown 1.4s infinite";
  if (badge) badge.textContent = `Auto-Cycle Active (${intervalText})`;
  if (subtext) subtext.textContent = "Until next theme swap";

  const now = Date.now();
  const totalDurationMs = mins * 60 * 1000;
  let target = appState.targetRotationTime || (now + totalDurationMs);
  if (target - now > totalDurationMs) {
    target = now + totalDurationMs;
    appState.targetRotationTime = target;
  }
  const remainingMs = Math.max(0, target - now);
  const remainingSecs = remainingMs / 1000;

  if (digits) digits.textContent = formatCountdown(remainingSecs);
  const dashCountdownEl = document.getElementById("dashCountdownDisplay");
  if (dashCountdownEl && appState.scheduleEnabled) {
    dashCountdownEl.textContent = formatCountdown(remainingSecs);
  }

  // Progress fill (0% -> 100% as time progresses)
  const elapsedMs = Math.max(0, totalDurationMs - remainingMs);
  const pct = Math.min(100, Math.max(0, (elapsedMs / totalDurationMs) * 100));
  if (fill) fill.style.width = `${pct.toFixed(1)}%`;

  // When timer reaches 0 (and initial state has synced), advance to next theme once
  if (remainingMs <= 0 && appState.scheduleEnabled && appState.hasLoadedInitialState !== false) {
    appState.targetRotationTime = now + totalDurationMs;
    advanceQueueTheme();
  }
}

let isRotating = false;

async function advanceQueueTheme() {
  if (isRotating) return;
  isRotating = true;
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.id) {
      await sendExtensionMessage({ type: "NEXT_QUEUE_THEME" });
      await refreshState();
      renderGallery();
      renderScheduler();
      updateCountdownDisplay();
      return;
    }

    const queue = Array.isArray(appState.themeQueue) && appState.themeQueue.length > 0
      ? appState.themeQueue
      : [...DEFAULT_ROTATION_QUEUE];

    const nextIndex = (appState.currentIndex + 1) % queue.length;
    const nextThemeId = queue[nextIndex];

    appState.currentIndex = nextIndex;
    appState.lastRotationTime = Date.now();
    appState.targetRotationTime = Date.now() + ((appState.intervalMinutes || 120) * 60 * 1000);
    CookieStore.set("schedule_current_index", String(nextIndex));
    CookieStore.set("schedule_target_time", String(appState.targetRotationTime));
    updateCachedUserSettings({
      currentIndex: nextIndex,
      lastRotationTime: appState.lastRotationTime,
      targetRotationTime: appState.targetRotationTime
    });

    await sendExtensionMessage({
      type: "UPDATE_QUEUE",
      themeQueue: queue,
      currentIndex: nextIndex
    });

    const cardData = resolvePopupTheme(nextThemeId) || {
      id: nextThemeId,
      name: getQueueThemeMeta(nextThemeId).name
    };

    await handleThemeSelect(cardData);
    renderScheduler();
    updateCountdownDisplay();
  } finally {
    isRotating = false;
  }
}

function setupCountdownTimer() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(updateCountdownDisplay, 1000);
  updateCountdownDisplay();

  const btnRotate = document.getElementById("btnRotateNow");
  if (btnRotate) {
    btnRotate.addEventListener("click", async () => {
      showToast("Advancing to next theme in queue...");
      await advanceQueueTheme();
    });
  }

  const btnReset = document.getElementById("btnResetCountdown");
  if (btnReset) {
    btnReset.addEventListener("click", async () => {
      triggerSpinAnimation(btnReset);
      appState.lastRotationTime = Date.now();
      appState.targetRotationTime = Date.now() + ((appState.intervalMinutes || 120) * 60 * 1000);
      CookieStore.set("schedule_target_time", String(appState.targetRotationTime));
      updateCachedUserSettings({ targetRotationTime: appState.targetRotationTime, lastRotationTime: appState.lastRotationTime });
      await sendExtensionMessage({ type: "RESET_QUEUE_TIMER" });
      showToast("Countdown timer reset!");
      updateCountdownDisplay();
    });
  }
}

// Run Startup
start();

