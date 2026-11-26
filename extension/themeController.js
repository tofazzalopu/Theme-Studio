/**
 * Theme Controller Module
 * Controls Chromium native tab bar theme toggling, paired live-folder updates,
 * and real-time ThemeStudioDB (IndexedDB) + New Tab synchronization.
 */

import { THEME_PRESETS, createThemeManifestJSON } from "./themeGenerator.js";
import { findThemeMeta } from "./themesData.js";
import { isColorDark, normalizeStr } from "./sharedUtils.js";
import {
  getLiveDirectoryHandle,
  verifyPermission,
  writeManifestToDirectory,
  findLiveCompanionTheme,
  hotReloadLiveTheme,
  recordThemeSelectionInDB,
  getCustomThemesFromDB,
  LIVE_THEME_NAME
} from "./liveThemeStore.js";

/**
 * Apply a theme to the browser (ThemeStudioDB, New Tab, installed themes, and paired folder).
 */
export async function applyNativeTabBarTheme(themeKeyOrObj, customName, explicitColorMode = null) {
  const isDefault =
    !themeKeyOrObj ||
    themeKeyOrObj === "default" ||
    themeKeyOrObj === "DEFAULT_BROWSER" ||
    (typeof themeKeyOrObj === "object" && themeKeyOrObj.id === "DEFAULT_BROWSER");

  const meta = isDefault
    ? findThemeMeta("DEFAULT_BROWSER")
    : findThemeMeta(typeof themeKeyOrObj === "string" ? themeKeyOrObj : (themeKeyOrObj.id || themeKeyOrObj.name));

  const targetId = isDefault
    ? "DEFAULT_BROWSER"
    : (typeof themeKeyOrObj === "string" ? themeKeyOrObj : (themeKeyOrObj?.id || meta?.id || "custom-theme"));

  const themeName = isDefault
    ? "Default Browser"
    : (customName || meta?.name || themeKeyOrObj?.name || "Custom Theme");

  const colors = isDefault
    ? (meta?.colors || { frame: "#e5e5ea", toolbar: "#ffffff", text: "#1d1d1f", ntp: "#f5f5f7" })
    : (typeof themeKeyOrObj === "object" && (themeKeyOrObj.colors || themeKeyOrObj.frame)
        ? (themeKeyOrObj.colors || themeKeyOrObj)
        : (meta?.colors || null));

  const derivedColorMode = explicitColorMode || (colors?.frame ? (isColorDark(colors.frame) ? "dark" : "light") : null);

  // Record immediately in ThemeStudioDB + chrome.storage.local (updates New Tab & open UIs in real time)
  await recordThemeSelectionInDB(targetId, themeName, colors, derivedColorMode);

  // Case 1: Revert to browser default
  if (isDefault) {
    if (typeof chrome !== "undefined" && chrome.management) {
      const extensions = await chrome.management.getAll();
      for (const theme of extensions.filter((ext) => ext.type === "theme" && ext.enabled)) {
        await chrome.management.setEnabled(theme.id, false);
      }
      await chrome.storage.local.set({ activeThemeId: "DEFAULT_BROWSER", activeExtensionId: null });
    }
    return { status: "restored_default", name: "Default Browser", colorMode: derivedColorMode };
  }

  // Case 2: Instant zero-reload switch if a standalone theme package is loaded in Edge/Chrome
  const targetPreset = meta ? THEME_PRESETS[meta.folder] : null;
  if (typeof chrome !== "undefined" && chrome.management) {
    const extensions = await chrome.management.getAll();
    const customList = await getCustomThemesFromDB();
    const customObj = customList.find((t) => t.id === targetId || t.installedExtensionId === targetId);
    const normTarget = normalizeStr(meta?.manifestName || customObj?.manifestName || themeName);

    const installedTheme = extensions.find((ext) => {
      if (ext.type !== "theme") return false;
      if (ext.name.includes("Live Companion")) return false;
      if (ext.id === targetId || ext.id === customObj?.installedExtensionId) return true;
      if (targetPreset && ext.name === targetPreset.name) return true;
      if (meta?.manifestName && ext.name.toLowerCase() === meta.manifestName.toLowerCase()) return true;
      if (customObj?.manifestName && ext.name.toLowerCase() === customObj.manifestName.toLowerCase()) return true;
      const normExt = normalizeStr(ext.name);
      return normExt === normTarget || ext.name.toLowerCase() === themeName.toLowerCase();
    });

    if (installedTheme) {
      await chrome.management.setEnabled(installedTheme.id, true);
      if (chrome.storage) {
        await chrome.storage.local.set({
          activeThemeId: targetId,
          activeExtensionId: installedTheme.id
        });
      }
      return { status: "applied_instantly", name: installedTheme.name, id: installedTheme.id, colorMode: derivedColorMode };
    }

    // Disable any previously enabled static theme when switching to a theme not installed standalone
    for (const stale of extensions.filter((ext) => ext.type === "theme" && ext.enabled && !ext.name.includes("Live Companion"))) {
      await chrome.management.setEnabled(stale.id, false);
    }
    if (chrome.storage) {
      await chrome.storage.local.set({ activeExtensionId: null });
    }
  }

  // Case 3: Paired Single-Folder Live Overwrite
  const manifestInput = colors || meta?.folder || targetId;
  try {
    const dirHandle = await getLiveDirectoryHandle();
    const liveCompanion = await findLiveCompanionTheme();

    if (dirHandle) {
      // Check write permission WITHOUT popping a modal inside an extension popup (which closes popups)
      const hasPerm = await verifyPermission(dirHandle, true, false);
      if (!hasPerm) {
        return { status: "needs_folder_permission", name: themeName, colorMode: derivedColorMode };
      }

      const expectedName = `${LIVE_THEME_NAME} (${themeName})`;
      const dynamicVer = `1.0.${Math.floor(Date.now() / 1000) % 60000}`;
      const liveManifestJSON = createThemeManifestJSON(manifestInput, expectedName, dynamicVer);
      await writeManifestToDirectory(dirHandle, liveManifestJSON, false);

      if (liveCompanion) {
        await hotReloadLiveTheme(liveCompanion.id);
        let didReloadFromDisk = false;
        try {
          const updated = await chrome.management.get(liveCompanion.id);
          didReloadFromDisk = updated?.name === expectedName;
        } catch (_) {}

        if (typeof chrome !== "undefined" && chrome.storage) {
          await chrome.storage.local.set({
            activeThemeId: targetId,
            activeExtensionId: liveCompanion.id
          });
        }

        return {
          status: didReloadFromDisk ? "applied_live_dynamic" : "manifest_written_needs_reload",
          name: themeName,
          id: liveCompanion.id,
          colorMode: derivedColorMode
        };
      }

      return { status: "folder_updated_needs_load", name: themeName, colorMode: derivedColorMode };
    }
  } catch (err) {
    console.warn("[Theme Controller] Live dynamic update fallback:", err);
  }

  // Case 4: Requires one-time live companion or theme package load
  return {
    status: "requires_unpacked_load",
    manifestContent: createThemeManifestJSON(manifestInput, targetPreset ? targetPreset.name : themeName),
    themeName,
    folder: meta?.folder || targetId.replace(/^(preset-|theme-)/, ""),
    colorMode: derivedColorMode
  };
}

/**
 * Check the overall companion, folder permission, and ThemeStudioDB sync status
 */
export async function checkCompanionStatus() {
  let liveThemeConnected = false;
  let folderHasPermission = false;
  let folderName = null;
  let liveThemeInstalled = false;
  let activeThemeName = "Default Browser";

  try {
    const dirHandle = await getLiveDirectoryHandle();
    liveThemeConnected = Boolean(dirHandle);
    if (dirHandle) {
      folderName = dirHandle.name || "live-theme";
      folderHasPermission = await verifyPermission(dirHandle, true, false);
    }
    liveThemeInstalled = Boolean(await findLiveCompanionTheme());

    if (typeof chrome !== "undefined" && chrome.management) {
      const active = (await chrome.management.getAll()).find((e) => e.type === "theme" && e.enabled);
      if (active) activeThemeName = active.name;
    }
  } catch (_) {}

  return {
    liveThemeConnected,
    folderHasPermission,
    folderName,
    liveThemeInstalled,
    isReadyForLiveSync: liveThemeConnected && folderHasPermission && liveThemeInstalled,
    activeThemeName
  };
}
