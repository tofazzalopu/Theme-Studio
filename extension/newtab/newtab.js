import { findThemeMeta } from "../themesData.js";
import {
  getRealtimeStateFromDB,
  getCustomThemesFromDB,
  getAllWallpapersFromDB,
  getWallpaperSettingsFromDB,
  saveWallpaperSettingsInDB,
  getCachedUserSettings,
  updateCachedUserSettings,
  subscribeRealtimeDB
} from "../liveThemeStore.js";

let currentThemeId = "DEFAULT_BROWSER";
let currentColorMode = "dark";
let customThemesCache = [];

function resolveThemeById(themeId) {
  return findThemeMeta(themeId) || customThemesCache.find((t) => t.id === themeId) || null;
}

function applyNtpVisuals(themeId, _themeName, colors, colorMode) {
  currentThemeId = themeId || "DEFAULT_BROWSER";
  if (colorMode) currentColorMode = colorMode;

  const resolved = colors || resolveThemeById(currentThemeId)?.colors || (
    currentColorMode === "light"
      ? { frame: "#e5e5ea", toolbar: "#ffffff", text: "#1d1d1f", ntp: "#f5f5f7" }
      : { frame: "#121319", toolbar: "#1f2230", text: "#f3f4f6", ntp: "#0b0c10" }
  );

  const root = document.documentElement;
  root.setAttribute("data-theme", currentColorMode);
  root.style.setProperty("--ntp-frame", resolved.frame || "#091224");
  root.style.setProperty("--ntp-toolbar", resolved.toolbar || "#152d58");
  root.style.setProperty("--ntp-text", resolved.text || "#ffffff");
  root.style.setProperty("--ntp-bg", resolved.ntp || "#0d1b2a");

  const meta = document.getElementById("metaThemeColor");
  if (meta) meta.content = resolved.frame || "#091224";
}

async function applyActiveWallpaper() {
  const layer = document.getElementById("ntpWallpaperLayer");
  if (!layer) return;

  const [wallpapers, settings] = await Promise.all([
    getAllWallpapersFromDB(),
    getWallpaperSettingsFromDB()
  ]);

  if (!wallpapers.length || !settings.activeWallpaperId) {
    layer.style.backgroundImage = "";
    layer.classList.remove("has-wallpaper");
    document.body.classList.remove("wallpaper-active");
    return;
  }

  const active = wallpapers.find((w) => w.id === settings.activeWallpaperId) || wallpapers[0];
  if (active?.dataUrl) {
    layer.style.backgroundImage = `url("${active.dataUrl}")`;
    layer.classList.add("has-wallpaper");
    document.body.classList.add("wallpaper-active");
  } else {
    layer.style.backgroundImage = "";
    layer.classList.remove("has-wallpaper");
    document.body.classList.remove("wallpaper-active");
  }
}

async function checkWallpaperAutoRotate() {
  const [wallpapers, settings] = await Promise.all([
    getAllWallpapersFromDB(),
    getWallpaperSettingsFromDB()
  ]);
  if (!settings.autoRotate || wallpapers.length < 2) return;
  const now = Date.now();
  if (now < (settings.targetRotateAt || 0)) return;

  const idx = wallpapers.findIndex((w) => w.id === settings.activeWallpaperId);
  const nextWp = wallpapers[idx >= 0 ? (idx + 1) % wallpapers.length : 0];
  const mins = Number(settings.intervalMinutes) || 15;
  await saveWallpaperSettingsInDB({
    activeWallpaperId: nextWp.id,
    lastRotatedAt: now,
    targetRotateAt: now + mins * 60 * 1000
  });
  await applyActiveWallpaper();
}

async function renderMostVisitedSites() {
  const container = document.getElementById("ntpMostVisited");
  if (!container) return;

  let sites = [];
  if (typeof chrome !== "undefined" && chrome.topSites?.get) {
    try {
      sites = await new Promise((resolve) => {
        chrome.topSites.get((res) => resolve(Array.isArray(res) ? res : []));
      });
    } catch (_) {
      sites = [];
    }
  }

  if (!sites || sites.length === 0) {
    sites = [
      { title: "Google", url: "https://www.google.com/" },
      { title: "YouTube", url: "https://www.youtube.com/" },
      { title: "GitHub", url: "https://github.com/" },
      { title: "Gmail", url: "https://mail.google.com/" }
    ];
  }

  container.innerHTML = "";
  const isExtension = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);

  for (const site of sites.slice(0, 8)) {
    const a = document.createElement("a");
    a.className = "ntp-site-tile";
    a.href = site.url;
    a.title = site.title || site.url;

    const iconWrap = document.createElement("div");
    iconWrap.className = "ntp-site-icon-wrap";

    let host = "";
    try {
      host = new URL(site.url).hostname.replace(/^www\./, "");
    } catch (_) {}
    const initial = (site.title || host || "?").trim().charAt(0).toUpperCase() || "?";

    if (isExtension && chrome.runtime?.getURL) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(site.url)}&size=64`);
      img.addEventListener("error", () => {
        img.remove();
        iconWrap.textContent = initial;
      });
      iconWrap.appendChild(img);
    } else {
      iconWrap.textContent = initial;
    }

    const title = document.createElement("span");
    title.className = "ntp-site-title";
    title.textContent = site.title || host || site.url;

    a.append(iconWrap, title);
    container.appendChild(a);
  }
}

function updateClock() {
  const now = new Date();
  const clockEl = document.getElementById("ntpClock");
  const dateEl = document.getElementById("ntpDate");
  if (clockEl) {
    clockEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  }
}

async function initNewTab() {
  const cached = getCachedUserSettings();
  if (Array.isArray(cached.customThemes)) customThemesCache = cached.customThemes;
  if (cached.activeThemeId || cached.colorMode || cached.colors) {
    applyNtpVisuals(
      cached.activeThemeId || "DEFAULT_BROWSER",
      cached.activeThemeName || "Default Browser",
      cached.colors || null,
      cached.colorMode || "dark"
    );
  }

  updateClock();
  setInterval(updateClock, 1000);
  setInterval(checkWallpaperAutoRotate, 5000);

  customThemesCache = await getCustomThemesFromDB();
  const dbState = await getRealtimeStateFromDB();
  let storageState = {};
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    storageState = await chrome.storage.local.get(["activeThemeId", "activeThemeName", "activeThemeColors", "colorMode"]);
  }

  const activeId = storageState.activeThemeId || dbState?.activeThemeId || cached.activeThemeId || "DEFAULT_BROWSER";
  const activeName = storageState.activeThemeName || dbState?.activeThemeName || cached.activeThemeName || "Default Browser";
  const activeColors = storageState.activeThemeColors || dbState?.colors || cached.colors || null;
  const colorMode = storageState.colorMode || dbState?.colorMode || cached.colorMode || "dark";

  updateCachedUserSettings({
    activeThemeId: activeId,
    activeThemeName: activeName,
    colors: activeColors,
    colorMode
  });
  applyNtpVisuals(activeId, activeName, activeColors, colorMode);
  await applyActiveWallpaper();
  await renderMostVisitedSites();

  subscribeRealtimeDB(async (ev) => {
    if (ev.type === "COLOR_MODE_CHANGED" && ev.colorMode) {
      applyNtpVisuals(currentThemeId, null, null, ev.colorMode);
    } else if (ev.type === "DB_STATE_CHANGED" && ev.state) {
      const m = resolveThemeById(ev.state.activeThemeId);
      applyNtpVisuals(
        ev.state.activeThemeId,
        ev.state.activeThemeName || m?.name,
        ev.state.colors || m?.colors,
        ev.state.colorMode || currentColorMode
      );
    } else if (ev.type === "WALLPAPER_CHANGED") {
      await applyActiveWallpaper();
    } else if (ev.type === "CUSTOM_THEMES_CHANGED") {
      customThemesCache = await getCustomThemesFromDB();
    }
  });

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(async (msg) => {
      if (msg?.type === "QUEUE_ROTATED" || msg?.type === "THEME_ENABLED") {
        const m = resolveThemeById(msg.themeId);
        if (m) applyNtpVisuals(m.id, m.name, m.colors, currentColorMode);
      } else if (msg?.type === "THEME_DISABLED") {
        applyNtpVisuals("DEFAULT_BROWSER", "Default Browser", null, currentColorMode);
      } else if (msg?.type === "WALLPAPER_ROTATED") {
        await applyActiveWallpaper();
      }
    });
  }

  document.getElementById("ntpSearchForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("ntpSearchInput")?.value?.trim();
    if (!q) return;
    if (/^https?:\/\//i.test(q) || /^[^\s]+\.[^\s]{2,}$/.test(q)) {
      window.location.href = /^https?:\/\//i.test(q) ? q : `https://${q}`;
    } else {
      window.location.href = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    }
  });
}

initNewTab();
