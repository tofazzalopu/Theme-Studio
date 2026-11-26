/**
 * ThemeStudioDB (IndexedDB) & Live Native Sync Engine
 * Persistent real-time browser database for themes, color mode, history,
 * paired live-theme folder handle, and Chromium hot-reload.
 */

import { CookieStore } from "./sharedUtils.js";

const DB_NAME = "ThemeStudioDB";
const DB_VERSION = 3;
const STORE_HANDLES = "handles";
const STORE_THEMES = "themes";
const STORE_STATE = "app_state";
const STORE_HISTORY = "history";
const STORE_WALLPAPERS = "wallpapers";
const KEY_HANDLE = "live_companion_dir";
const KEY_LOCAL_SPACE = "local_device_space_dir";
const KEY_STATE = "realtime_state";
const KEY_WALLPAPER_STATE = "wallpaper_settings";

export const LIVE_THEME_NAME = "Theme Studio - Live Companion";
export const USER_CACHE_KEY = "theme_studio_user_cache";
export const THEMES_COOKIE_KEY = "theme_studio_themes_json";
export const STUDIO_DATA_VERSION = "2.0-fresh";
export const DEFAULT_ROTATION_QUEUE = ["DEFAULT_BROWSER", "preset-aurora", "preset-midsummer", "preset-nebula"];
export const DEFAULT_COLORS = { frame: "#e5e5ea", toolbar: "#ffffff", text: "#1d1d1f", ntp: "#f5f5f7" };
const DELETED_THEMES_COOKIE_KEY = "theme_studio_deleted_ids";

/**
 * Synchronous local browser settings/mode cache (localStorage) for instant
 * hydration across popup, companion setup window, and New Tab pages.
 */
export function getCachedUserSettings() {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function updateCachedUserSettings(patch) {
  if (!patch || typeof patch !== "object") return getCachedUserSettings();
  try {
    if (typeof localStorage === "undefined") return {};
    const next = {
      ...getCachedUserSettings(),
      ...patch,
      cachedAt: new Date().toISOString()
    };
    localStorage.setItem(USER_CACHE_KEY, JSON.stringify(next));
    return next;
  } catch (_) {
    return {};
  }
}

const dbChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("theme_studio_db")
  : null;

function broadcastDBEvent(payload) {
  try {
    dbChannel?.postMessage(payload);
  } catch (_) {}
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not supported in this context"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
      if (!db.objectStoreNames.contains(STORE_THEMES)) {
        const themesStore = db.createObjectStore(STORE_THEMES, { keyPath: "id" });
        themesStore.createIndex("category", "category", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_WALLPAPERS)) {
        db.createObjectStore(STORE_WALLPAPERS, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ============================================================================
// REAL-TIME BROWSER DATABASE (Themes, Color Mode & History)
// ============================================================================

export async function initThemeDatabase(themesList = []) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_THEMES, "readwrite");
      const store = tx.objectStore(STORE_THEMES);
      const now = new Date().toISOString();

      for (const t of themesList) {
        const getReq = store.get(t.id);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          store.put({
            id: t.id,
            folder: t.folder,
            name: t.name,
            category: t.category,
            colors: t.colors,
            installCount: existing?.installCount || 0,
            isActive: existing?.isActive || false,
            updatedAt: now
          });
        };
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.debug("[ThemeStudioDB] init warning:", err);
    return false;
  }
}

export async function getRealtimeStateFromDB() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_STATE, "readonly");
      const req = tx.objectStore(STORE_STATE).get(KEY_STATE);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
  }
}

export async function getAllThemesFromDB() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_THEMES, "readonly");
      const req = tx.objectStore(STORE_THEMES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (_) {
    return [];
  }
}

export async function setRealtimeColorModeInDB(colorMode) {
  const normalizedMode = colorMode === "light" ? "light" : "dark";
  const now = new Date().toISOString();

  try {
    const db = await openDB();
    const existing = await getRealtimeStateFromDB();
    const updatedState = {
      ...(existing || {}),
      key: KEY_STATE,
      colorMode: normalizedMode,
      updatedAt: now
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_STATE, "readwrite");
      tx.objectStore(STORE_STATE).put(updatedState);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });

    updateCachedUserSettings({ colorMode: normalizedMode });
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ colorMode: normalizedMode });
    }
    broadcastDBEvent({ type: "COLOR_MODE_CHANGED", colorMode: normalizedMode, state: updatedState });
    return updatedState;
  } catch (err) {
    console.debug("[ThemeStudioDB] setRealtimeColorMode error:", err);
    return null;
  }
}

export async function recordThemeSelectionInDB(themeId, themeName, colors = null, colorMode = null) {
  const now = new Date().toISOString();

  try {
    const db = await openDB();
    const prevState = await getRealtimeStateFromDB();
    const cached = getCachedUserSettings();
    const resolvedMode = colorMode || prevState?.colorMode || cached.colorMode || "dark";

    const sameTheme = prevState?.activeThemeId === themeId;
    const resolvedColors = colors || (sameTheme ? prevState?.colors : null) || null;

    const nextState = {
      key: KEY_STATE,
      activeThemeId: themeId,
      activeThemeName: themeName || themeId,
      colors: resolvedColors,
      colorMode: resolvedMode,
      updatedAt: now
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_THEMES, STORE_STATE, STORE_HISTORY], "readwrite");
      const themesStore = tx.objectStore(STORE_THEMES);

      // Update active flags and install count
      const allReq = themesStore.getAll();
      allReq.onsuccess = () => {
        const items = allReq.result || [];
        let found = false;
        for (const item of items) {
          const isTarget = item.id === themeId;
          if (isTarget) found = true;
          if (item.isActive || isTarget) {
            themesStore.put({
              ...item,
              isActive: isTarget,
              installCount: isTarget ? (item.installCount || 0) + 1 : (item.installCount || 0),
              updatedAt: now
            });
          }
        }
        if (!found && themeId) {
          themesStore.put({
            id: themeId,
            name: themeName || themeId,
            category: "custom",
            colors: colors || null,
            installCount: 1,
            isActive: true,
            updatedAt: now
          });
        }
      };

      tx.objectStore(STORE_STATE).put(nextState);
      tx.objectStore(STORE_HISTORY).add({
        themeId,
        themeName: themeName || themeId,
        colorMode: resolvedMode,
        timestamp: now
      });

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });

    updateCachedUserSettings({
      activeThemeId: themeId,
      activeThemeName: themeName || themeId,
      colors: resolvedColors,
      colorMode: resolvedMode
    });

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({
        activeThemeId: themeId,
        activeThemeName: themeName || themeId,
        colorMode: resolvedMode,
        activeThemeColors: resolvedColors
      });
    }

    broadcastDBEvent({ type: "DB_STATE_CHANGED", state: nextState });
    return nextState;
  } catch (err) {
    console.debug("[ThemeStudioDB] recordThemeSelection error:", err);
    return null;
  }
}

export function subscribeRealtimeDB(callback) {
  const onMsg = (ev) => {
    if (ev?.data) callback(ev.data);
  };
  dbChannel?.addEventListener("message", onMsg);

  const onStorage = (changes, area) => {
    if (area !== "local") return;
    if (changes.colorMode) {
      callback({ type: "COLOR_MODE_CHANGED", colorMode: changes.colorMode.newValue });
    }
    if (changes.activeWallpaperId || changes.wallpaperAutoRotate || changes.wallpaperIntervalMinutes) {
      callback({ type: "WALLPAPER_CHANGED", wallpaperState: changes });
    }
    if (changes.customThemes) {
      callback({ type: "CUSTOM_THEMES_CHANGED", customThemes: changes.customThemes.newValue });
    }
    if (changes.activeThemeId) {
      callback({
        type: "DB_STATE_CHANGED",
        state: {
          activeThemeId: changes.activeThemeId.newValue,
          activeThemeName: changes.activeThemeName?.newValue,
          colors: changes.activeThemeColors?.newValue,
          colorMode: changes.colorMode?.newValue
        }
      });
    }
  };
  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(onStorage);
  }

  return () => {
    dbChannel?.removeEventListener("message", onMsg);
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.removeListener(onStorage);
    }
  };
}

// ============================================================================
// PAIRED LIVE-FOLDER HANDLE & HOT-RELOAD ENGINE
// ============================================================================

export async function saveLiveDirectoryHandle(dirHandle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, "readwrite");
    const req = tx.objectStore(STORE_HANDLES).put(dirHandle, KEY_HANDLE);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function getLiveDirectoryHandle() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_HANDLES, "readonly");
      const req = tx.objectStore(STORE_HANDLES).get(KEY_HANDLE);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
  }
}

export async function clearLiveDirectoryHandle() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_HANDLES, "readwrite");
      const req = tx.objectStore(STORE_HANDLES).delete(KEY_HANDLE);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch (_) {
    return false;
  }
}

export async function verifyPermission(fileHandle, readWrite = true, promptIfNeeded = true) {
  if (!fileHandle) return false;
  const options = { mode: readWrite ? "readwrite" : "read" };
  try {
    if ((await fileHandle.queryPermission(options)) === "granted") {
      return true;
    }
    if (promptIfNeeded && typeof fileHandle.requestPermission === "function") {
      if ((await fileHandle.requestPermission(options)) === "granted") {
        return true;
      }
    }
  } catch (err) {
    console.debug("[Live Theme Store] Permission check error:", err);
  }
  return false;
}

export async function writeManifestToDirectory(dirHandle, manifestContent, promptIfNeeded = true) {
  const hasPerm = await verifyPermission(dirHandle, true, promptIfNeeded);
  if (!hasPerm) {
    throw new Error("Missing readwrite permission for live theme directory");
  }
  const fileHandle = await dirHandle.getFileHandle("manifest.json", { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(manifestContent);
  await writable.close();
  return true;
}

export async function findLiveCompanionTheme() {
  if (typeof chrome === "undefined" || !chrome.management) return null;
  try {
    const items = await chrome.management.getAll();
    const themes = items.filter((ext) => ext.type === "theme");

    // Strictly match genuine Live Companion packages (never hijack unrelated custom/developer themes)
    return (
      themes.find((ext) => ext.name === LIVE_THEME_NAME || ext.name.includes("Live Companion")) ||
      null
    );
  } catch (err) {
    console.debug("[Live Theme Store] management query error:", err);
    return null;
  }
}

export async function hotReloadLiveTheme(liveThemeId) {
  if (typeof chrome === "undefined" || !chrome.management) return false;
  try {
    // Switching directly without setEnabled(false) first prevents jarring white/dark flash on the Tab Bar
    const info = await chrome.management.get(liveThemeId).catch(() => null);
    if (info && !info.enabled) {
      await chrome.management.setEnabled(liveThemeId, true);
    }
    return true;
  } catch (err) {
    console.error("[Live Theme Store] Hot-reload error:", err);
    return false;
  }
}

async function getThemesRootDir(dirHandle) {
  if (!dirHandle) return null;
  return dirHandle.name?.toLowerCase() === "themes"
    ? dirHandle
    : await dirHandle.getDirectoryHandle("themes", { create: true });
}

async function writeTextFileInDir(dirHandle, filename, content) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

function parseThemeColorsFromManifestText(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    const c = parsed?.theme?.colors;
    if (!c) return null;
    const toHex = (arr, fallback) => {
      if (!Array.isArray(arr) || arr.length < 3) return fallback;
      return "#" + [arr[0], arr[1], arr[2]].map((n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0))).toString(16).padStart(2, "0")).join("");
    };
    const frame = toHex(c.frame || c.frame_inactive, "#2c2c2e");
    const toolbar = toHex(c.toolbar || c.frame, frame);
    const text = toHex(c.tab_text || c.bookmark_text || c.ntp_text, "#ffffff");
    const ntp = toHex(c.ntp_background || c.toolbar, toolbar);
    return { parsed, colors: { frame, toolbar, text, ntp }, manifestJson: rawText };
  } catch (_) {
    return null;
  }
}

export async function readThemeManifestFromThemesFolders(themeName) {
  if (!themeName) return null;
  const slug = String(themeName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const normTarget = String(themeName).toLowerCase().replace(/[^a-z0-9]/g, "");

  // 1. Check authorized paired local themes directories (written during Customizer upload)
  const dirs = [await getLocalStorageDirHandle(), await getLiveDirectoryHandle()].filter(Boolean);
  for (const dirHandle of dirs) {
    try {
      const ok = await verifyPermission(dirHandle, false, false);
      if (!ok) continue;
      const themesRoot = dirHandle.name?.toLowerCase() === "themes"
        ? dirHandle
        : await dirHandle.getDirectoryHandle("themes", { create: false }).catch(() => null);
      if (!themesRoot) continue;

      if (slug) {
        const directSub = await themesRoot.getDirectoryHandle(slug, { create: false }).catch(() => null);
        if (directSub) {
          const fh = await directSub.getFileHandle("manifest.json", { create: false }).catch(() => null);
          if (fh) {
            const res = parseThemeColorsFromManifestText(await (await fh.getFile()).text());
            if (res) return { ...res, folder: slug };
          }
        }
      }

      for await (const [entryName, handle] of themesRoot.entries()) {
        if (handle.kind !== "directory") continue;
        const fh = await handle.getFileHandle("manifest.json", { create: false }).catch(() => null);
        if (!fh) continue;
        const res = parseThemeColorsFromManifestText(await (await fh.getFile()).text());
        const mNorm = String(res?.parsed?.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (res && mNorm && mNorm === normTarget) {
          return { ...res, folder: entryName };
        }
      }
    } catch (_) {}
  }

  // 2. Check bundled extension/themes/<slug>/manifest.json if present inside the extension package
  if (slug && typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    try {
      const resp = await fetch(chrome.runtime.getURL(`themes/${slug}/manifest.json`));
      if (resp.ok) {
        const res = parseThemeColorsFromManifestText(await resp.text());
        if (res) return { ...res, folder: slug };
      }
    } catch (_) {}
  }
  return null;
}

export async function writeSingleCustomThemeToPairedDirs(themeObj) {
  if (!themeObj?.folder || !themeObj?.manifestJson) return 0;
  let writtenCount = 0;
  const dirs = [await getLocalStorageDirHandle(), await getLiveDirectoryHandle()].filter(Boolean);
  for (const dirHandle of dirs) {
    try {
      const ok = await verifyPermission(dirHandle, true, false);
      if (!ok) continue;
      const themesRoot = await getThemesRootDir(dirHandle);
      const subDir = await themesRoot.getDirectoryHandle(themeObj.folder, { create: true });
      await writeTextFileInDir(subDir, "manifest.json", themeObj.manifestJson);
      writtenCount += 1;
    } catch (_) {}
  }
  return writtenCount;
}

export async function syncAllThemesToPairedDir(themesList, createManifestFn) {
  const dirHandle = (await getLocalStorageDirHandle()) || (await getLiveDirectoryHandle());
  if (!dirHandle) return { ok: false, reason: "no_dir", count: 0 };
  const ok = await verifyPermission(dirHandle, true, true);
  if (!ok) return { ok: false, reason: "no_permission", count: 0 };

  const themesRoot = await getThemesRootDir(dirHandle);
  let count = 0;
  for (const item of themesList || []) {
    if (!item || item.isDefault || !item.folder || item.folder === "developer-unpacked") continue;
    try {
      const jsonStr = item.manifestJson || createManifestFn(item.folder, item.manifestName || item.name);
      const subDir = await themesRoot.getDirectoryHandle(item.folder, { create: true });
      await writeTextFileInDir(subDir, "manifest.json", jsonStr);
      count += 1;
    } catch (_) {}
  }
  return { ok: true, count, folderName: dirHandle.name || "themes" };
}

// ============================================================================
// CUSTOM THEMES STUDIO PERSISTENCE (IndexedDB + Local Device Sync)
// ============================================================================

function mergeCustomThemeRecords(base, incoming) {
  if (!base) return incoming;
  if (!incoming) return base;
  const pickColors = () => {
    if (incoming.colors && !incoming._isFallbackColors) return incoming.colors;
    if (base.colors && !base._isFallbackColors) return base.colors;
    return incoming.colors || base.colors || null;
  };
  const colors = pickColors();
  return {
    ...base,
    ...incoming,
    id: incoming.id || base.id,
    folder: incoming.folder && incoming.folder !== "custom-theme" ? incoming.folder : (base.folder || incoming.folder),
    name: incoming.name && incoming.name !== "Custom Theme" ? incoming.name : (base.name || incoming.name),
    manifestName: incoming.manifestName || base.manifestName || incoming.name || base.name,
    category: "custom",
    cssClass: incoming.cssClass || base.cssClass || "theme-card-custom",
    iconType: incoming.iconType || base.iconType || "palette",
    isCustom: true,
    installedExtensionId: incoming.installedExtensionId ?? base.installedExtensionId ?? null,
    isInstalled: Boolean(incoming.isInstalled || base.isInstalled || incoming.installedExtensionId || base.installedExtensionId),
    manifestJson: incoming.manifestJson || base.manifestJson || null,
    colors,
    _isFallbackColors: Boolean((incoming._isFallbackColors && !base.colors) || (!colors))
  };
}

async function getDeletedCustomThemeIds() {
  const cookieList = CookieStore.getJSON(DELETED_THEMES_COOKIE_KEY, []);
  const set = new Set(Array.isArray(cookieList) ? cookieList : []);
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const { deletedCustomThemeIds = [] } = await chrome.storage.local.get("deletedCustomThemeIds");
      for (const id of deletedCustomThemeIds) set.add(id);
    } catch (_) {}
  }
  return set;
}

export async function getCustomThemesFromDB() {
  const deletedIds = await getDeletedCustomThemeIds();
  const mergedMap = new Map();

  const ingest = (list) => {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      if (!t || !t.id || deletedIds.has(t.id)) continue;
      if (!t.isCustom && !String(t.id).startsWith("custom-") && !t.manifestJson) continue;
      const existing = mergedMap.get(t.id);
      mergedMap.set(t.id, mergeCustomThemeRecords(existing, { ...t, isCustom: true }));
    }
  };

  // 1. Cookie backup + localStorage cache (survives extension reloads/new addon installs)
  const cookieThemes = CookieStore.getChunkedJSON(THEMES_COOKIE_KEY, []);
  ingest(cookieThemes);
  const cachedThemes = getCachedUserSettings().customThemes;
  ingest(cachedThemes);

  // 2. chrome.storage.local
  let storageThemes = [];
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const data = await chrome.storage.local.get("customThemes");
      storageThemes = Array.isArray(data?.customThemes) ? data.customThemes : [];
      ingest(storageThemes);
    } catch (_) {}
  }

  // 3. IndexedDB ThemeStudioDB
  const dbThemes = (await getAllThemesFromDB()).filter((t) => t && t.isCustom);
  ingest(dbThemes);

  const merged = Array.from(mergedMap.values());

  // Re-hydrate IndexedDB & extension storage if any store fell behind
  if (merged.length > 0 && dbThemes.length < merged.length) {
    try {
      const db = await openDB();
      await new Promise((resolve) => {
        const tx = db.transaction(STORE_THEMES, "readwrite");
        const store = tx.objectStore(STORE_THEMES);
        for (const rec of merged) {
          store.put(rec);
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) {}
  }
  if (merged.length > storageThemes.length && typeof chrome !== "undefined" && chrome.storage?.local) {
    chrome.storage.local.set({ customThemes: merged }).catch(() => {});
  }

  return merged;
}

async function syncCustomThemeCache(allCustom) {
  const serializable = (allCustom || []).map(({
    id, name, folder, manifestName, colors, manifestJson, installedExtensionId, isInstalled, updatedAt, _isFallbackColors
  }) => ({
    id,
    name,
    folder,
    manifestName,
    colors,
    manifestJson: manifestJson || null,
    installedExtensionId: installedExtensionId || null,
    isInstalled: Boolean(isInstalled),
    isCustom: true,
    updatedAt: updatedAt || new Date().toISOString(),
    ...(_isFallbackColors ? { _isFallbackColors: true } : {})
  }));

  // Connect theme.json & saved custom themes cleanly with browser cookies + localStorage cache
  CookieStore.setChunkedJSON(THEMES_COOKIE_KEY, serializable);
  updateCachedUserSettings({ customThemes: serializable });

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ customThemes: serializable });
  }
  broadcastDBEvent({ type: "CUSTOM_THEMES_CHANGED", customThemes: serializable });
  await syncDatabaseToLocalDevice(false).catch(() => {});
}

export async function saveCustomThemeInDB(themeObj) {
  const db = await openDB();
  const now = new Date().toISOString();
  const slug = String(themeObj.name || "custom-theme")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "custom-theme";

  const targetId = themeObj.id || `custom-${slug}-${Date.now()}`;

  // Clear from deleted list if user explicitly re-saves/imports the same ID
  const deletedIds = await getDeletedCustomThemeIds();
  if (deletedIds.has(targetId)) {
    deletedIds.delete(targetId);
    const nextDeleted = Array.from(deletedIds);
    CookieStore.setJSON(DELETED_THEMES_COOKIE_KEY, nextDeleted);
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ deletedCustomThemeIds: nextDeleted }).catch(() => {});
    }
  }

  // Merge with any existing record across DB, cookies, and storage so metadata/theme.json is never lost
  const existingAll = await getCustomThemesFromDB();
  const existing = existingAll.find((t) => t.id === targetId) || null;

  const baseRecord = {
    id: targetId,
    folder: themeObj.folder || slug,
    name: themeObj.name || "Custom Theme",
    category: "custom",
    cssClass: "theme-card-custom",
    iconType: "palette",
    isCustom: true,
    manifestName: themeObj.manifestName || themeObj.name || "Custom Theme",
    installedExtensionId: themeObj.installedExtensionId ?? null,
    isInstalled: Boolean(themeObj.isInstalled),
    colors: themeObj.colors || null,
    manifestJson: themeObj.manifestJson || null,
    _isFallbackColors: Boolean(themeObj._isFallbackColors),
    updatedAt: now
  };
  const record = mergeCustomThemeRecords(existing, baseRecord);
  record.updatedAt = now;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_THEMES, "readwrite");
    tx.objectStore(STORE_THEMES).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });

  const allCustom = await getCustomThemesFromDB();
  await syncCustomThemeCache(allCustom);
  return record;
}

export async function deleteCustomThemeFromDB(themeId) {
  try {
    const deletedIds = await getDeletedCustomThemeIds();
    if (themeId) deletedIds.add(themeId);
    const nextDeleted = Array.from(deletedIds).slice(-100);
    CookieStore.setJSON(DELETED_THEMES_COOKIE_KEY, nextDeleted);
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ deletedCustomThemeIds: nextDeleted }).catch(() => {});
    }

    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_THEMES, "readwrite");
      tx.objectStore(STORE_THEMES).delete(themeId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    const allCustom = await getCustomThemesFromDB();
    await syncCustomThemeCache(allCustom);
    return true;
  } catch (_) {
    return false;
  }
}

// ============================================================================
// USER UPLOADED WALLPAPERS & AUTO-ROTATION ENGINE
// ============================================================================

export async function getAllWallpapersFromDB() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_WALLPAPERS, "readonly");
      const req = tx.objectStore(STORE_WALLPAPERS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (_) {
    return [];
  }
}

export async function saveWallpaperInDB({ id, name, dataUrl, mimeType }) {
  const db = await openDB();
  const item = {
    id: id || `wp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(name || "Wallpaper").slice(0, 64),
    dataUrl,
    mimeType: mimeType || "image/jpeg",
    createdAt: new Date().toISOString()
  };

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_WALLPAPERS, "readwrite");
    tx.objectStore(STORE_WALLPAPERS).put(item);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });

  broadcastDBEvent({ type: "WALLPAPER_CHANGED", wallpaper: item });
  await syncWallpaperToLocalDevice(item).catch(() => {});
  return item;
}

export async function deleteWallpaperFromDB(id) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_WALLPAPERS, "readwrite");
      tx.objectStore(STORE_WALLPAPERS).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    const settings = await getWallpaperSettingsFromDB();
    if (settings.activeWallpaperId === id) {
      await saveWallpaperSettingsInDB({ activeWallpaperId: null });
    } else {
      broadcastDBEvent({ type: "WALLPAPER_CHANGED" });
    }
    return true;
  } catch (_) {
    return false;
  }
}

export async function getWallpaperSettingsFromDB() {
  const defaults = {
    activeWallpaperId: null,
    autoRotate: false,
    intervalMinutes: 15,
    lastRotatedAt: Date.now(),
    targetRotateAt: Date.now() + 15 * 60 * 1000
  };
  try {
    const db = await openDB();
    const saved = await new Promise((resolve) => {
      const tx = db.transaction(STORE_STATE, "readonly");
      const req = tx.objectStore(STORE_STATE).get(KEY_WALLPAPER_STATE);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    return { ...defaults, ...(saved || {}) };
  } catch (_) {
    return defaults;
  }
}

export async function saveWallpaperSettingsInDB(patch) {
  const prev = await getWallpaperSettingsFromDB();
  const next = {
    ...prev,
    ...patch,
    key: KEY_WALLPAPER_STATE,
    updatedAt: new Date().toISOString()
  };
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STATE, "readwrite");
    tx.objectStore(STORE_STATE).put(next);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      activeWallpaperId: next.activeWallpaperId,
      wallpaperAutoRotate: Boolean(next.autoRotate),
      wallpaperIntervalMinutes: Number(next.intervalMinutes) || 15,
      wallpaperLastRotatedAt: next.lastRotatedAt,
      wallpaperTargetRotateAt: next.targetRotateAt
    });
  }
  broadcastDBEvent({ type: "WALLPAPER_CHANGED", wallpaperState: next });
  await syncDatabaseToLocalDevice(false).catch(() => {});
  return next;
}

// ============================================================================
// LOCAL DEVICE SPACE PERMISSIONS & FILE-SYSTEM DB SYNC
// ============================================================================

export async function getLocalStorageDirHandle() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_HANDLES, "readonly");
      const req = tx.objectStore(STORE_HANDLES).get(KEY_LOCAL_SPACE);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
  }
}

export async function saveLocalStorageDirHandle(dirHandle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, "readwrite");
    const req = tx.objectStore(STORE_HANDLES).put(dirHandle, KEY_LOCAL_SPACE);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function getLocalDeviceSpaceStatus() {
  let persisted = false;
  let usageMB = 0;
  let quotaMB = 0;
  try {
    if (typeof navigator !== "undefined" && navigator.storage) {
      if (typeof navigator.storage.persisted === "function") {
        persisted = await navigator.storage.persisted();
      }
      if (typeof navigator.storage.estimate === "function") {
        const est = await navigator.storage.estimate();
        usageMB = Number(((est.usage || 0) / (1024 * 1024)).toFixed(2));
        quotaMB = Number(((est.quota || 0) / (1024 * 1024)).toFixed(0));
      }
    }
  } catch (_) {}

  const dirHandle = await getLocalStorageDirHandle();
  const folderPermission = dirHandle ? await verifyPermission(dirHandle, true, false) : false;

  return {
    persisted,
    usageMB,
    quotaMB,
    hasFolder: Boolean(dirHandle),
    folderName: dirHandle?.name || null,
    folderPermission
  };
}

export async function requestLocalDeviceSpacePermission(pickFolder = true) {
  let persisted = false;
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      persisted = await navigator.storage.persist();
    }
  } catch (_) {}

  let dirHandle = await getLocalStorageDirHandle();
  if (pickFolder && typeof window !== "undefined" && typeof window.showDirectoryPicker === "function") {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await saveLocalStorageDirHandle(dirHandle);
  }

  let folderPermission = false;
  if (dirHandle) {
    folderPermission = await verifyPermission(dirHandle, true, true);
    if (folderPermission) {
      await restoreDatabaseFromLocalDevice(dirHandle).catch(() => {});
      await syncDatabaseToLocalDevice(false).catch(() => {});
    }
  }

  return {
    persisted,
    folderName: dirHandle?.name || null,
    folderPermission
  };
}

async function syncWallpaperToLocalDevice(wallpaperItem) {
  const dirHandle = await getLocalStorageDirHandle();
  if (!dirHandle || !wallpaperItem?.dataUrl) return false;
  const ok = await verifyPermission(dirHandle, true, false);
  if (!ok) return false;

  const wpDir = await dirHandle.getDirectoryHandle("wallpapers", { create: true });
  const ext = wallpaperItem.mimeType?.includes("png") ? "png" : (wallpaperItem.mimeType?.includes("webp") ? "webp" : "jpg");
  const safeName = `${wallpaperItem.id}.${ext}`;
  const fh = await wpDir.getFileHandle(safeName, { create: true });
  const res = await fetch(wallpaperItem.dataUrl);
  const blob = await res.blob();
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return true;
}

export async function syncDatabaseToLocalDevice(promptIfNeeded = false) {
  const dirHandle = await getLocalStorageDirHandle();
  if (!dirHandle) return false;
  const ok = await verifyPermission(dirHandle, true, promptIfNeeded);
  if (!ok) return false;

  const [realtimeState, wallpaperSettings, customThemes, wallpapers] = await Promise.all([
    getRealtimeStateFromDB(),
    getWallpaperSettingsFromDB(),
    getCustomThemesFromDB(),
    getAllWallpapersFromDB()
  ]);

  const snapshot = {
    schema: "theme-studio-local-db/v1",
    updatedAt: new Date().toISOString(),
    realtimeState,
    wallpaperSettings,
    customThemes,
    wallpapersIndex: wallpapers.map(({ id, name, mimeType, createdAt }) => ({ id, name, mimeType, createdAt }))
  };

  await writeTextFileInDir(dirHandle, "theme-studio-settings.json", JSON.stringify(snapshot, null, 2));

  // Also write unpacked custom theme folders inside paired themes/<folder>/manifest.json
  if (customThemes.length > 0) {
    const themesDir = await getThemesRootDir(dirHandle);
    for (const ct of customThemes) {
      if (!ct.manifestJson || !ct.folder) continue;
      const folderHandle = await themesDir.getDirectoryHandle(ct.folder, { create: true });
      await writeTextFileInDir(folderHandle, "manifest.json", ct.manifestJson);
    }
  }
  return true;
}

/**
 * Wipe loaded custom themes, stale timers/cookies/cache, and reset Theme Studio cleanly.
 */
export async function resetAllStudioData({ themesList = [], clearWallpapers = false } = {}) {
  CookieStore.removeChunked(THEMES_COOKIE_KEY);
  [
    DELETED_THEMES_COOKIE_KEY, "active_theme_id", "active_theme_name", "active_theme_colors",
    "schedule_enabled", "schedule_interval_minutes", "schedule_interval_hours",
    "theme_rotation_queue", "custom_theme_draft", "active_gallery_category", "active_nav_tab"
  ].forEach((k) => CookieStore.remove(k));

  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(USER_CACHE_KEY);
      localStorage.setItem("studio_data_version", STUDIO_DATA_VERSION);
    }
  } catch (_) {}

  try {
    const db = await openDB();
    const stores = [STORE_THEMES, STORE_STATE, STORE_HISTORY];
    if (clearWallpapers) stores.push(STORE_WALLPAPERS);
    await new Promise((resolve) => {
      const tx = db.transaction(stores, "readwrite");
      for (const s of stores) tx.objectStore(s).clear();
      tx.objectStore(STORE_STATE).put({
        key: KEY_STATE,
        activeThemeId: "DEFAULT_BROWSER",
        activeThemeName: "Default Browser",
        colors: DEFAULT_COLORS,
        colorMode: "dark",
        updatedAt: new Date().toISOString()
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (_) {}

  if (themesList.length > 0) {
    await initThemeDatabase(themesList);
  }

  if (typeof chrome !== "undefined" && chrome.management) {
    try {
      const installed = (await chrome.management.getAll()).filter((t) => t.type === "theme" && t.enabled);
      for (const ext of installed) {
        await chrome.management.setEnabled(ext.id, false).catch(() => {});
      }
    } catch (_) {}
  }

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      studioDataVersion: STUDIO_DATA_VERSION,
      activeThemeId: "DEFAULT_BROWSER",
      activeThemeName: "Default Browser",
      activeThemeColors: DEFAULT_COLORS,
      activeExtensionId: null,
      colorMode: "dark",
      scheduleEnabled: false,
      intervalHours: 2,
      intervalMinutes: 120,
      themeQueue: [...DEFAULT_ROTATION_QUEUE],
      currentIndex: 0,
      customThemes: [],
      deletedCustomThemeIds: [],
      syncedLiveThemeIds: [],
      lastRotationTime: Date.now(),
      targetRotationTime: Date.now() + 7200000
    }).catch(() => {});
  }

  broadcastDBEvent({ type: "CUSTOM_THEMES_CHANGED", customThemes: [] });
  broadcastDBEvent({ type: "FULL_DATA_RESET" });
  return true;
}

export async function ensureFreshDataMigration(themesList = []) {
  let storedVersion = null;
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const data = await chrome.storage.local.get("studioDataVersion");
      storedVersion = data?.studioDataVersion || null;
    } catch (_) {}
  }
  if (!storedVersion && typeof localStorage !== "undefined") {
    try {
      storedVersion = localStorage.getItem("studio_data_version");
    } catch (_) {}
  }
  if (storedVersion === STUDIO_DATA_VERSION) return false;
  await resetAllStudioData({ themesList, clearWallpapers: false });
  return true;
}

export async function restoreDatabaseFromLocalDevice(dirHandle) {
  if (!dirHandle) return false;
  const ok = await verifyPermission(dirHandle, false, false);
  if (!ok) return false;

  const fh = await dirHandle.getFileHandle("theme-studio-settings.json");
  const file = await fh.getFile();
  const raw = await file.text();
  const snapshot = JSON.parse(raw);
  if (!snapshot || snapshot.schema !== "theme-studio-local-db/v1") return false;

  if (Array.isArray(snapshot.customThemes)) {
    const db = await openDB();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_THEMES, "readwrite");
      const store = tx.objectStore(STORE_THEMES);
      for (const ct of snapshot.customThemes) {
        if (ct?.id) store.put({ ...ct, isCustom: true });
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }
  return true;
}
