/**
 * Tab Bar Theme Generator Module
 * Converts internal theme states and custom palettes into valid Chromium native frame RGB definitions.
 */

import { THEMES, findThemeMeta } from "./themesData.js";
import { hexToRgb, adjustBrightness } from "./sharedUtils.js";

export { hexToRgb, adjustBrightness };

export const THEME_PRESETS = Object.fromEntries(
  THEMES.filter((t) => !t.isDefault).map((t) => [
    t.folder,
    {
      name: t.manifestName,
      folder: t.folder,
      colors: {
        frame: hexToRgb(t.colors.frame),
        toolbar: hexToRgb(t.colors.toolbar),
        tab_text: hexToRgb(t.colors.text),
        ntp_background: hexToRgb(t.colors.ntp)
      }
    }
  ])
);

function blendRgb(a, b, ratio = 0.5) {
  return a.map((v, i) => Math.min(255, Math.max(0, Math.round(v * (1 - ratio) + b[i] * ratio))));
}

function buildFullThemeColors(frame, toolbar, text, ntp) {
  const isDarkFrame = (0.299 * frame[0] + 0.587 * frame[1] + 0.114 * frame[2]) < 140;
  return {
    frame,
    frame_inactive: isDarkFrame ? adjustBrightness(frame, 0.82) : blendRgb(frame, [235, 235, 240], 0.35),
    toolbar,
    tab_text: text,
    tab_background_text: blendRgb(text, frame, 0.38),
    bookmark_text: text,
    omnibox_background: blendRgb(toolbar, ntp, 0.4),
    omnibox_text: text,
    ntp_background: ntp,
    ntp_text: text
  };
}

export function generateThemeManifestObject(themeInput, customName = "Theme Studio - Live Companion", version = "1.0.0") {
  let name = customName;
  let colors;

  const preset = typeof themeInput === "string"
    ? (THEME_PRESETS[themeInput] || (() => { const m = findThemeMeta(themeInput); return m ? THEME_PRESETS[m.folder] : null; })())
    : null;

  if (preset) {
    name = customName || preset.name;
    const p = preset.colors;
    colors = buildFullThemeColors(p.frame, p.toolbar, p.tab_text, p.ntp_background);
  } else if (themeInput && typeof themeInput === "object") {
    const c = themeInput.colors || themeInput;
    const frame = Array.isArray(c.frame) ? c.frame : hexToRgb(c.frame, [20, 24, 36]);
    const toolbar = Array.isArray(c.toolbar) ? c.toolbar : hexToRgb(c.toolbar, [30, 36, 52]);
    const text = Array.isArray(c.text || c.textCol || c.tab_text)
      ? (c.text || c.textCol || c.tab_text)
      : hexToRgb(c.text || c.textCol || c.tab_text, [255, 255, 255]);
    const ntp = Array.isArray(c.ntp || c.ntp_background)
      ? (c.ntp || c.ntp_background)
      : hexToRgb(c.ntp || c.ntp_background, [18, 22, 32]);

    name = customName || themeInput.name || "Theme Studio - Live Companion";
    colors = buildFullThemeColors(frame, toolbar, text, ntp);
  } else {
    colors = buildFullThemeColors([30, 32, 40], [42, 46, 58], [255, 255, 255], [24, 26, 32]);
  }

  return {
    manifest_version: 3,
    version,
    name,
    description: "Native tab bar and toolbar companion theme managed by Instant Theme Changer.",
    theme: { colors }
  };
}

export function createThemeManifestJSON(themeInput, customName, version = "1.0.0") {
  return JSON.stringify(generateThemeManifestObject(themeInput, customName, version), null, 2);
}
