# Theme Studio 🎨

A privacy-first, lightweight **Manifest V3 browser theme studio** for Chromium-based browsers (Google Chrome, Microsoft Edge, Brave, Opera) with curated aesthetic themes, custom Tab Wallpapers, an automated Chrome Alarms scheduler, an in-memory `manifest.json` / `.zip` theme importer, and a customizable New Tab experience.

---

## Key Features

- **53 Built-in Aesthetic Presets (`extension/themesData.js` & `extension/themes/`):** Instant access to themes across **Apple Originals**, **Kawaii**, **Pastel**, **Cafe & Minimal**, **Vapor & Cyber**, **Space & Night**, **Anime & Ghibli**, **Chrome Colors**, **Dark & Black**, and **Window to Wild**, plus **My Studio** for imported/custom themes.
- **Tab Wallpapers Studio:** Upload custom PNG, JPG, or WebP wallpapers stored locally in IndexedDB (`ThemeStudioDB`), with optional interval-based auto-rotation (`5m` to `24h`), quick **Next** / **None** controls, and cross-fade New Tab rendering.
- **Automated Theme Scheduler:** Build custom **Rotation Sequences**, jump between queued themes (`LIVE` indicator & **Rotate** button), and cycle automatically using `chrome.alarms` at `15m`, `30m`, `45m`, `1h`, `2h`, `4h`, or `24h` intervals with persistent countdown state.
- **Secure Theme Importer & Live Theme Designer:** Drop or select Chromium `manifest.json` files (supports BOM/JSONC comments), `.zip` theme archives (Central Directory reader), or unpacked folders in memory (`secureParseAndCompile()` & `extractManifestFromZipBuffer()` in `extension/sharedUtils.js`). Automatically populates the Live Theme Designer (`Frame`, `Toolbar`, `Tab Text`, `New Tab Page`), saves to **My Studio**, and syncs cleanly to any paired local folder.
- **Adaptive New Tab Page (`extension/newtab/newtab.html`):** Displays live clock/date, adaptive theme colors or uploaded wallpapers, local search bar, and Top Sites shortcuts (`topSites` + `favicon`) with zero remote tracking.
- **Persistent Local Storage & Recovery:** Synchronizes active theme, Light/Dark UI mode, scheduler state, and custom `theme.json` manifests across `chrome.storage.local`, `ThemeStudioDB` (IndexedDB), `localStorage` (`theme_studio_user_cache`), chunked browser cookies (`theme_studio_themes_json`), and optional user-authorized local folders via the File System Access API.
- **Browser Extension & Manifest Manager (`extension/popup/companion.html`):** Live-syncs with `chrome.management` events, displays all built-in + custom/developer-loaded themes, allows one-click batch syncing to a paired folder, and exports individual `manifest.json` or `.zip` packages.

---

## Project Structure

```text
.
├── extension/
│   ├── manifest.json             # MV3 extension manifest ("Theme Studio")
│   ├── background.js             # Service worker: chrome.alarms scheduler & management sync
│   ├── liveThemeStore.js         # IndexedDB (ThemeStudioDB), cookies/cache & folder handle sync
│   ├── themeController.js        # Native chromium theme switching & studio state coordination
│   ├── themeGenerator.js         # Manifest V3 Chromium theme JSON generator
│   ├── themesData.js             # Single source of truth for the 53 built-in presets
│   ├── sharedUtils.js            # In-memory sanitizer, ZIP parser & chunked CookieStore
│   ├── popup/
│   │   ├── popup.html            # Main 580×430 Studio UI (Gallery, Scheduler, Customizer)
│   │   ├── popup.css             # Responsive Light/Dark & synced Tab Bar styles
│   │   ├── popup.js              # Gallery, Wallpapers, Scheduler, Importer & Designer logic
│   │   ├── companion.html        # Theme Studio Setup & Manifest Manager window
│   │   └── companion.js          # Live folder pairing & browser theme status sync
│   ├── newtab/
│   │   ├── newtab.html           # Adaptive New Tab override page
│   │   └── newtab.js             # Clock, Top Sites, wallpaper rotation & live theme sync
│   ├── themes/                   # 53 standalone unpacked Chromium theme folders
│   ├── live-theme/               # Paired Live Companion theme template
│   ├── icons/                    # Extension icons (16, 32, 48, 128 px)
│   ├── assets/                   # Theme Studio wordmarks (light & dark variants)
│   ├── PRIVACY_POLICY.md         # Local-only privacy policy
│   └── CHROMEWEBSTORE.md         # Web Store listing & permissions documentation
├── package_extension.py          # Builds distributable extension ZIP package
└── server.py                     # Local development HTTP server (http://127.0.0.1:3000)
```

---

## Security & Privacy Architecture

- **100% Local & Air-Gapped:** Declares zero `host_permissions`. No telemetry, analytics, browsing history, uploaded images, or custom themes leave your device (see [extension/PRIVACY_POLICY.md](extension/PRIVACY_POLICY.md)).
- **Strict In-Memory Validation:** Imported `manifest.json` and `.zip` entries are size-bounded, stripped of comments/BOMs, sanitized against prototype-pollution keys (`__proto__`, `constructor`, `prototype`), checked for valid RGB/hex channel bounds (`0–255`), and scrubbed of HTML/script/SVG payloads.
- **Scoped `chrome.management` Access:** Only inspects and toggles extensions strictly of `type === "theme"`, never modifying other browser extensions.

---

## Installation & Development Setup

### Load Unpacked in Chrome or Microsoft Edge
1. Open `edge://extensions` (Microsoft Edge) or `chrome://extensions` (Google Chrome / Brave).
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `extension/` folder from this repository.
4. Click the **Theme Studio** icon in your browser toolbar.

> **Note on Browser Top-Bar Themes in Chromium MV3:**
> Chrome and Edge do not provide a dynamic JavaScript API (like Firefox's `theme.update`) or allow extensions to silently install unpacked themes. Built-in presets and Customizer themes apply immediately to the Extension UI, Tab Bar mode, and New Tab page; to also switch Chrome/Edge's outer browser window frame natively during clicks or scheduled rotation, load the desired theme folders from `extension/themes/<theme-name>` once via **Load unpacked** (or use **Load in Edge → Sync All Folders**).

### Local UI Preview Server
Start the lightweight Python static server (requires Python 3):
```bash
python server.py
```
Then open `http://127.0.0.1:3000/popup/popup.html` (or `http://127.0.0.1:3000/popup/companion.html`).

### Packaging for Distribution
Build the clean distributable zip archive (`instant-theme-changer.zip`):
```bash
python package_extension.py
```
This packages the `extension/` source files while automatically skipping `Cached Theme.pak` and local runtime subfolders.

### Syntax Verification
Verify all JavaScript modules using Node.js:
```bash
node --check extension/background.js
node --check extension/liveThemeStore.js
node --check extension/themeController.js
node --check extension/sharedUtils.js
node --check extension/popup/popup.js
node --check extension/popup/companion.js
node --check extension/newtab/newtab.js
```
