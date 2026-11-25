/**
 * Theme Studio - Background Service Worker
 * Handles Chrome Alarms scheduling, native Chromium theme switching,
 * Live Companion folder overwrite, and real-time ThemeStudioDB updates.
 */

import { THEMES, findThemeMeta } from "./themesData.js";
import { normalizeStr, isColorDark } from "./sharedUtils.js";
import { createThemeManifestJSON } from "./themeGenerator.js";
import {
  getLiveDirectoryHandle,
  writeManifestToDirectory,
  findLiveCompanionTheme,
  hotReloadLiveTheme,
  recordThemeSelectionInDB,
  initThemeDatabase,
  getCustomThemesFromDB,
  saveCustomThemeInDB,
  getAllWallpapersFromDB,
  getWallpaperSettingsFromDB,
  saveWallpaperSettingsInDB,
  LIVE_THEME_NAME
} from "./liveThemeStore.js";

function matchPresetMeta(ext) {
  if (!ext?.name) return null;
  const lower = ext.name.toLowerCase();
  const norm = normalizeStr(ext.name);
  return THEMES.find(
    (t) => !t.isDefault && (t.manifestName.toLowerCase() === lower || t.normalized === norm)
  ) || null;
}

function resolveInstalledTheme(identifier, installedThemes, customThemes = []) {
  if (!identifier || !Array.isArray(installedThemes)) return null;
  const byId = installedThemes.find((t) => t.id === identifier);
  if (byId) return byId;

  const meta = findThemeMeta(identifier);
  if (meta && !meta.isDefault) {
    const match = installedThemes.find(
      (t) => t.name.toLowerCase() === meta.manifestName.toLowerCase() || normalizeStr(t.name) === meta.normalized
    );
    if (match) return match;
  }

  const customMeta = Array.isArray(customThemes) ? customThemes.find((t) => t.id === identifier) : null;
  if (customMeta) {
    const normCustom = normalizeStr(customMeta.manifestName || customMeta.name);
    const match = installedThemes.find(
      (t) =>
        t.id === customMeta.installedExtensionId ||
        t.name.toLowerCase() === String(customMeta.manifestName || customMeta.name).toLowerCase() ||
        normalizeStr(t.name) === normCustom
    );
    if (match) return match;
  }

  const normInput = normalizeStr(customMeta?.name || identifier);
  if (!normInput) return null;
  return installedThemes.find((t) => {
    const normInstalled = normalizeStr(t.name);
    return normInstalled === normInput || normInstalled.includes(normInput) || normInput.includes(normInstalled);
  }) || null;
}

async function syncInstalledThemeToLiveList(info, addToQueue = false) {
  if (!info || info.type !== "theme" || info.name?.includes("Live Companion")) return null;

  const matchedPreset = matchPresetMeta(info);
  const existingCustom = await getCustomThemesFromDB();
  const storageData = await chrome.storage.local.get(["customThemes", "syncedLiveThemeIds", "themeQueue"]);
  const mergedCustom = existingCustom.length > 0 ? existingCustom : (storageData.customThemes || []);

  let resolvedId = matchedPreset?.id || null;
  if (!resolvedId) {
    const matchedCustom = mergedCustom.find(
      (t) =>
        t.installedExtensionId === info.id ||
        t.id === info.id ||
        normalizeStr(t.manifestName || t.name) === normalizeStr(info.name)
    );
    if (matchedCustom) {
      await saveCustomThemeInDB({
        ...matchedCustom,
        installedExtensionId: info.id,
        manifestName: info.name,
        isInstalled: true
      });
      resolvedId = matchedCustom.id;
    } else {
      const saved = await saveCustomThemeInDB({
        id: info.id,
        name: info.name,
        manifestName: info.name,
        installedExtensionId: info.id,
        isInstalled: true,
        colors: { frame: "#2c2c2e", toolbar: "#3a3a3c", text: "#ffffff", ntp: "#1c1c1e" }
      });
      resolvedId = saved.id;
    }
  }

  const syncedSet = new Set(Array.isArray(storageData.syncedLiveThemeIds) ? storageData.syncedLiveThemeIds : []);
  if (resolvedId) syncedSet.add(resolvedId);

  const patch = { syncedLiveThemeIds: Array.from(syncedSet) };
  if (addToQueue && resolvedId) {
    const queue = Array.isArray(storageData.themeQueue)
      ? [...storageData.themeQueue]
      : ["DEFAULT_BROWSER", "preset-aurora", "preset-midsummer", "preset-nebula"];
    if (!queue.includes(resolvedId)) {
      queue.push(resolvedId);
      patch.themeQueue = queue;
    }
  }
  await chrome.storage.local.set(patch);
  return resolvedId;
}

function broadcastToExtension(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {}
}

async function resetToDefaultBrowserTheme() {
  try {
    const items = await chrome.management.getAll();
    for (const theme of items.filter((i) => i.type === "theme" && i.enabled)) {
      await chrome.management.setEnabled(theme.id, false);
    }
    await recordThemeSelectionInDB("DEFAULT_BROWSER", "Default Browser", {
      frame: "#e5e5ea", toolbar: "#ffffff", text: "#1d1d1f", ntp: "#f5f5f7"
    }, "light");
    await chrome.storage.local.set({
      activeThemeId: "DEFAULT_BROWSER",
      activeExtensionId: null,
      lastSwitchedAt: Date.now()
    });
    broadcastToExtension({ type: "THEME_DISABLED", themeId: "DEFAULT_BROWSER" });
    return { success: true, activeThemeId: "DEFAULT_BROWSER" };
  } catch (err) {
    console.error("[Theme Manager] Failed to reset to default:", err);
    return { success: false, error: err.message };
  }
}

async function applyTheme(themeId) {
  try {
    if (themeId === "DEFAULT_BROWSER") return await resetToDefaultBrowserTheme();

    let meta = findThemeMeta(themeId);
    const { customThemes: storedCustom = [] } = await chrome.storage.local.get("customThemes");
    const dbCustom = await getCustomThemesFromDB();
    const customList = dbCustom.length >= storedCustom.length ? dbCustom : storedCustom;

    if (!meta) {
      meta = customList.find((t) => t.id === themeId || t.installedExtensionId === themeId) || null;
    }
    const themeName = meta?.name || themeId;
    const colors = meta?.colors || null;
    const colorMode = colors?.frame ? (isColorDark(colors.frame) ? "dark" : "light") : null;

    await recordThemeSelectionInDB(themeId, themeName, colors, colorMode);

    // 1. Standalone installed theme match (instant zero-reload native switch)
    const installedThemes = (await chrome.management.getAll()).filter(
      (i) => i.type === "theme" && !i.name.includes("Live Companion")
    );
    const target = resolveInstalledTheme(themeId, installedThemes, customList);

    if (target) {
      if (target.type !== "theme") {
        return { success: false, error: "Access denied: target extension is not a theme." };
      }
      await chrome.management.setEnabled(target.id, true);
      await chrome.storage.local.set({
        activeThemeId: themeId,
        activeExtensionId: target.id,
        lastSwitchedAt: Date.now()
      });
      broadcastToExtension({ type: "THEME_ENABLED", themeId, extensionId: target.id, name: target.name });
      return { success: true, activeThemeId: themeId, installedExtensionId: target.id, name: target.name };
    }

    // 2. Live Dynamic Companion Overwrite (updates manifest.json on disk & toggles companion)
    try {
      const dirHandle = await getLiveDirectoryHandle();
      const liveCompanion = await findLiveCompanionTheme();
      if (dirHandle && liveCompanion) {
        const expectedName = `${LIVE_THEME_NAME} (${themeName})`;
        const dynamicVer = `1.0.${Math.floor(Date.now() / 1000) % 60000}`;
        const manifestJSON = createThemeManifestJSON(colors || meta?.folder || themeId, expectedName, dynamicVer);
        await writeManifestToDirectory(dirHandle, manifestJSON, false);
        await hotReloadLiveTheme(liveCompanion.id);
        await chrome.storage.local.set({
          activeThemeId: themeId,
          activeExtensionId: liveCompanion.id,
          lastSwitchedAt: Date.now()
        });
        broadcastToExtension({ type: "THEME_ENABLED", themeId, extensionId: liveCompanion.id, name: themeName });
        return { success: true, mode: "live_dynamic", activeThemeId: themeId, installedExtensionId: liveCompanion.id, name: themeName };
      }
    } catch (swLiveErr) {
      console.debug("[Theme Manager] SW live write skipped:", swLiveErr.message);
    }

    // Disable stale standalone theme so previous theme tab bar doesn't remain stuck
    for (const stale of installedThemes.filter((t) => t.enabled)) {
      await chrome.management.setEnabled(stale.id, false).catch(() => {});
    }
    await chrome.storage.local.set({ activeThemeId: themeId, lastSwitchedAt: Date.now() });

    return {
      success: false,
      error: "NOT_INSTALLED",
      themeId,
      themeFolder: meta ? meta.folder : themeId,
      manifestName: meta ? meta.manifestName : themeId
    };
  } catch (err) {
    console.error("[Theme Manager] Failed to apply theme:", err);
    return { success: false, error: err.message };
  }
}

async function rotateQueue(reason = "Alarm") {
  const {
    themeQueue = ["DEFAULT_BROWSER", "preset-aurora", "preset-midsummer", "preset-nebula"],
    currentIndex = 0,
    scheduleEnabled = false,
    intervalMinutes = 120
  } = await chrome.storage.local.get(["themeQueue", "currentIndex", "scheduleEnabled", "intervalMinutes"]);

  if (reason === "Alarm" && !scheduleEnabled) return null;
  if (!Array.isArray(themeQueue) || themeQueue.length === 0) return null;

  const nextIndex = (currentIndex + 1) % themeQueue.length;
  const nextThemeId = themeQueue[nextIndex];
  const now = Date.now();
  const targetRotationTime = now + intervalMinutes * 60 * 1000;

  const applyResult = await applyTheme(nextThemeId);
  await chrome.storage.local.set({ currentIndex: nextIndex, lastRotationTime: now, targetRotationTime });

  broadcastToExtension({
    type: "QUEUE_ROTATED",
    themeId: nextThemeId,
    currentIndex: nextIndex,
    rotationTime: now,
    targetRotationTime
  });
  return { nextIndex, themeId: nextThemeId, applyResult };
}

async function rotateWallpaper(reason = "Alarm") {
  const wallpapers = await getAllWallpapersFromDB();
  const settings = await getWallpaperSettingsFromDB();
  if (reason === "Alarm" && !settings.autoRotate) return null;
  if (!Array.isArray(wallpapers) || wallpapers.length === 0) return null;

  const idx = wallpapers.findIndex((w) => w.id === settings.activeWallpaperId);
  const nextIdx = idx >= 0 ? (idx + 1) % wallpapers.length : 0;
  const nextWp = wallpapers[nextIdx];
  const mins = Number(settings.intervalMinutes) || 15;
  const now = Date.now();
  const updated = await saveWallpaperSettingsInDB({
    activeWallpaperId: nextWp.id,
    lastRotatedAt: now,
    targetRotateAt: now + mins * 60 * 1000
  });
  broadcastToExtension({ type: "WALLPAPER_ROTATED", wallpaperId: nextWp.id, wallpaperSettings: updated });
  return { wallpaperId: nextWp.id, settings: updated };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "theme_cycle_timer") rotateQueue("Alarm");
  if (alarm.name === "wallpaper_cycle_timer") rotateWallpaper("Alarm");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "APPLY_THEME": {
        if (!message.themeId || typeof message.themeId !== "string") {
          sendResponse({ success: false, error: "Invalid theme ID" });
          return;
        }
        sendResponse(await applyTheme(message.themeId));
        break;
      }

      case "RESET_TO_DEFAULT":
        sendResponse(await resetToDefaultBrowserTheme());
        break;

      case "OPEN_EXTENSIONS_PAGE": {
        const isEdge = typeof navigator !== "undefined" && navigator.userAgent.includes("Edg");
        const targetUrl = isEdge ? "edge://extensions" : "chrome://extensions";
        try {
          const newTab = await chrome.tabs.create({ url: targetUrl });
          sendResponse({ success: true, tabId: newTab.id, url: targetUrl });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      }

      case "UPDATE_INTERVAL": {
        const hours = Number(message.intervalHours);
        const minutes = Number(message.intervalMinutes);
        const periodInMinutes = (Number.isFinite(minutes) && minutes >= 1)
          ? minutes
          : ((Number.isFinite(hours) && hours > 0) ? hours * 60 : 120);
        const { scheduleEnabled = false } = await chrome.storage.local.get("scheduleEnabled");
        const now = Date.now();
        const targetRotationTime = now + periodInMinutes * 60 * 1000;
        if (scheduleEnabled) {
          await chrome.alarms.create("theme_cycle_timer", { periodInMinutes });
        }
        await chrome.storage.local.set({
          intervalHours: periodInMinutes / 60,
          intervalMinutes: periodInMinutes,
          lastRotationTime: now,
          targetRotationTime
        });
        sendResponse({ success: true, intervalMinutes: periodInMinutes, intervalHours: periodInMinutes / 60, targetRotationTime });
        break;
      }

      case "SET_TIMER": {
        const hours = Number(message.intervalHours);
        const minutes = Number(message.intervalMinutes);
        const isEnabled = Boolean(message.enabled);

        let periodInMinutes = 0;
        if (Number.isFinite(minutes) && minutes >= 1) periodInMinutes = minutes;
        else if (Number.isFinite(hours) && hours > 0 && hours <= 24) periodInMinutes = hours * 60;

        const patch = { scheduleEnabled: isEnabled };
        if (periodInMinutes > 0) {
          patch.intervalHours = periodInMinutes / 60;
          patch.intervalMinutes = periodInMinutes;
        }

        if (isEnabled && periodInMinutes > 0) {
          const now = Date.now();
          const targetRotationTime = now + periodInMinutes * 60 * 1000;
          patch.lastRotationTime = now;
          patch.targetRotationTime = targetRotationTime;
          await chrome.alarms.create("theme_cycle_timer", { periodInMinutes });
          await chrome.storage.local.set(patch);
          sendResponse({ success: true, scheduleEnabled: true, periodInMinutes, targetRotationTime });
        } else {
          await chrome.alarms.clear("theme_cycle_timer");
          await chrome.storage.local.set(patch);
          sendResponse({ success: true, scheduleEnabled: false, periodInMinutes });
        }
        break;
      }

      case "NEXT_QUEUE_THEME": {
        const res = await rotateQueue("Manual");
        sendResponse(res ? { success: true, ...res } : { success: false, error: "Queue is empty" });
        break;
      }

      case "RESET_QUEUE_TIMER": {
        const { intervalMinutes = 120 } = await chrome.storage.local.get("intervalMinutes");
        const now = Date.now();
        const targetRotationTime = now + intervalMinutes * 60 * 1000;
        await chrome.alarms.create("theme_cycle_timer", { periodInMinutes: intervalMinutes });
        await chrome.storage.local.set({ lastRotationTime: now, targetRotationTime });
        broadcastToExtension({ type: "TIMER_RESET", lastRotationTime: now, targetRotationTime });
        sendResponse({ success: true, targetRotationTime });
        break;
      }

      case "UPDATE_QUEUE": {
        if (Array.isArray(message.themeQueue)) {
          const patch = { themeQueue: message.themeQueue };
          if (Number.isInteger(message.currentIndex)) patch.currentIndex = message.currentIndex;
          await chrome.storage.local.set(patch);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "Queue must be an array" });
        }
        break;
      }

      case "SET_WALLPAPER_TIMER": {
        const mins = Math.max(1, Number(message.intervalMinutes) || 15);
        const enabled = Boolean(message.enabled);
        const now = Date.now();
        const targetRotateAt = now + mins * 60 * 1000;
        if (enabled) {
          await chrome.alarms.create("wallpaper_cycle_timer", { periodInMinutes: mins });
        } else {
          await chrome.alarms.clear("wallpaper_cycle_timer");
        }
        await saveWallpaperSettingsInDB({
          autoRotate: enabled,
          intervalMinutes: mins,
          lastRotatedAt: now,
          targetRotateAt
        });
        sendResponse({ success: true, autoRotate: enabled, intervalMinutes: mins, targetRotateAt });
        break;
      }

      case "ROTATE_WALLPAPER_NOW": {
        const wpRes = await rotateWallpaper("Manual");
        sendResponse(wpRes ? { success: true, ...wpRes } : { success: false, error: "No wallpapers uploaded" });
        break;
      }

      case "GET_STATE": {
        const data = await chrome.storage.local.get([
          "activeThemeId", "activeExtensionId", "themeQueue", "currentIndex",
          "scheduleEnabled", "intervalHours", "intervalMinutes", "customThemes",
          "lastRotationTime", "targetRotationTime", "colorMode"
        ]);
        const installedThemes = (await chrome.management.getAll()).filter((item) => item.type === "theme");
        const dbCustom = await getCustomThemesFromDB();
        const storedCustom = Array.isArray(data.customThemes) ? data.customThemes : [];
        const customMap = new Map();
        for (const t of [...storedCustom, ...dbCustom]) {
          if (t?.id) customMap.set(t.id, t);
        }
        const mergedCustomThemes = Array.from(customMap.values());

        const currentlyEnabled = installedThemes.find((t) => t.enabled);
        const enabledMeta = currentlyEnabled ? matchPresetMeta(currentlyEnabled) : null;

        // Stored activeThemeId in chrome.storage.local is authoritative so stale enabled themes never hijack selection
        const resolvedActive = data.activeThemeId ||
          (currentlyEnabled ? (enabledMeta ? enabledMeta.id : currentlyEnabled.id) : "DEFAULT_BROWSER");

        const resolvedMinutes = Number(data.intervalMinutes) || (Number(data.intervalHours) * 60) || 120;

        sendResponse({
          success: true,
          activeThemeId: resolvedActive,
          activeExtensionId: currentlyEnabled ? currentlyEnabled.id : null,
          colorMode: data.colorMode || "dark",
          installedThemes: installedThemes.map((t) => {
            const m = matchPresetMeta(t);
            const cm = !m ? mergedCustomThemes.find(
              (c) => c.installedExtensionId === t.id || normalizeStr(c.manifestName || c.name) === normalizeStr(t.name)
            ) : null;
            return {
              id: t.id,
              name: t.name,
              description: t.description || "",
              enabled: t.enabled,
              presetId: m ? m.id : (cm ? cm.id : null),
              folder: m ? m.folder : (cm ? cm.folder : null)
            };
          }),
          scheduleEnabled: data.scheduleEnabled || false,
          intervalHours: data.intervalHours || (resolvedMinutes / 60),
          intervalMinutes: resolvedMinutes,
          themeQueue: data.themeQueue || ["DEFAULT_BROWSER", "preset-aurora", "preset-midsummer", "preset-nebula"],
          currentIndex: data.currentIndex || 0,
          customThemes: mergedCustomThemes,
          lastRotationTime: data.lastRotationTime || Date.now(),
          targetRotationTime: data.targetRotationTime || (Date.now() + resolvedMinutes * 60000)
        });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown action: ${message.type}` });
    }
  })();
  return true;
});

chrome.management.onInstalled.addListener(async (info) => {
  if (info.type === "theme") {
    const resolvedId = await syncInstalledThemeToLiveList(info, true);
    broadcastToExtension({ type: "THEME_INSTALLED", theme: info, resolvedId });
  }
});
chrome.management.onEnabled.addListener(async (info) => {
  if (info.type === "theme") {
    await syncInstalledThemeToLiveList(info, false);
    await chrome.storage.local.set({ activeExtensionId: info.id });
    broadcastToExtension({ type: "THEME_ENABLED", theme: info });
  }
});
chrome.management.onDisabled.addListener((info) => {
  if (info.type === "theme") broadcastToExtension({ type: "THEME_DISABLED", theme: info });
});
chrome.management.onUninstalled.addListener((id) => {
  broadcastToExtension({ type: "THEME_UNINSTALLED", themeId: id });
});

chrome.runtime.onInstalled.addListener(async () => {
  await initThemeDatabase(THEMES);
  const { activeThemeId } = await chrome.storage.local.get("activeThemeId");
  if (activeThemeId) return;
  const enabledTheme = (await chrome.management.getAll()).find((i) => i.type === "theme" && i.enabled);
  const matched = enabledTheme ? matchPresetMeta(enabledTheme) : null;
  await chrome.storage.local.set({
    activeThemeId: enabledTheme ? (matched ? matched.id : enabledTheme.id) : "DEFAULT_BROWSER",
    activeExtensionId: enabledTheme ? enabledTheme.id : null,
    scheduleEnabled: false,
    intervalHours: 2,
    intervalMinutes: 120,
    themeQueue: ["DEFAULT_BROWSER", "preset-aurora", "preset-midsummer", "preset-nebula"]
  });
});
