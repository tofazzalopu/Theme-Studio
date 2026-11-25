# Chrome Web Store Listing — Instant Theme Changer

> Last Updated: 2026-11-25

## Store Listing

**Extension Name** [REQUIRED]  
Instant Theme Changer

**Short Description** [REQUIRED]  
Instantly customize and auto-rotate your browser appearance, New Tab wallpapers, and custom Chromium themes with zero telemetry.

**Detailed Description** [REQUIRED]  
Transform your browser's look in one click with Instant Theme Changer — an ultra-lightweight, privacy-first theme studio with 50+ curated aesthetic palettes, custom tab wallpapers, and an automated scheduler.

Whether you enjoy minimal pastels, cozy cafe tones, OLED dark modes, cyberpunk vibes, anime inspirations, or official Chrome Color palettes, Instant Theme Changer updates your browser appearance locally with zero external network tracking.

KEY FEATURES
- 50+ Curated Themes: Instant access to Chrome Colors, Dark & Black, Window to Wild, Kawaii, Pastel, Cafe & Minimal, Cyber & Retro, Space & Night, Anime & Ghibli, and Apple Originals.
- Tab Wallpapers Studio: Upload custom PNG/JPG/WebP wallpapers with optional interval-based auto-rotation across new tabs.
- Automated Theme Scheduler: Build a custom rotation sequence and automatically cycle themes via Chromium Alarms (`1m` to `24h`).
- Secure Theme Importer & Live Designer: Drop or scan any Chromium `manifest.json`, `.zip` theme archive, or theme folder in memory to populate Live Theme Designer, save to Studio, or export packages.
- Native Browser Tab Bar Sync: Seamless setup guide and local folder pairing to apply themes across Edge and Chrome.
- Minimal New Tab Experience: Adaptive wallpaper canvas, live clock, search bar, and local Most Visited site shortcuts.

HOW TO USE IT
1. Click the extension icon in your toolbar to open Theme Studio.
2. Pick any theme in Gallery or upload custom wallpapers under Wallpapers.
3. Optional: Switch to Scheduler to automate your theme rotation queue.
4. Optional: Switch to Customizer to import a `manifest.json` / `.zip` / folder or design your own colorway.
5. Click the reset button anytime to restore your native browser default appearance.

PRIVACY & PERFORMANCE PROMISE
Instant Theme Changer runs 100% locally on your device (`ThemeStudioDB` IndexedDB & `chrome.storage.local`). It does not track browsing history, inject ads, or send data to external servers.

**Category** [REQUIRED]  
Photos & Art / Productivity

**Single Purpose** [REQUIRED]  
Customize and automatically rotate browser appearance themes and New Tab wallpapers locally on the user's device.

**Primary Language** [REQUIRED]  
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|---|---|---|---|
| Store Icon [REQUIRED] | 128×128 PNG | Ready | `icons/icon-128.png` |
| Store Icon (Small) | 48×48 PNG | Ready | `icons/icon-48.png` |
| Store Icon (Mini) | 16×16 PNG | Ready | `icons/icon-16.png` |

---

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `management` | permissions | Queries installed Chromium theme states and enables/disables or resets browser theme packages upon user selection or scheduled rotation. |
| `storage` | permissions | Stores user-selected theme IDs, custom studio presets, rotation queues, wallpaper settings, and UI mode preferences locally. |
| `alarms` | permissions | Schedules background theme and wallpaper rotation timers efficiently via Chromium's native alarms API. |
| `downloads` | permissions | Lets the user export and download validated theme `manifest.json` and `.zip` packages locally. |
| `tabs` | permissions | Opens setup windows, extension developer pages (`edge://extensions` / `chrome://extensions`), or persistent importer tabs when triggered by the user. |
| `topSites` | permissions | Reads local Most Visited browser shortcuts solely to render quick site tiles on the extension's New Tab page. |
| `favicon` | permissions | Displays cached local site favicons alongside Most Visited shortcuts on the New Tab page without external requests. |

---

## Privacy & Data Use

### Data Collection
**Does the extension collect user data?** No

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|---|---|---|---|---|
| Personally identifiable info | No | No | None | No |
| Health / Financial info | No | No | None | No |
| Authentication / Communications | No | No | None | No |
| Location | No | No | None | No |
| Web history / Activity / Content | No | No | None | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy
Included in `extension/PRIVACY_POLICY.md`.

## Distribution
- **Visibility**: Public
- **Regions**: All regions

## Developer Info
- **Publisher Name**: Instant Theme Changer Studio
- **Contact Email**: `support@instantthemechanger.local`
- **Support URL**: `https://github.com/instant-theme-changer/issues`
