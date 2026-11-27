# Privacy Policy for Theme Studio

**Last Updated:** November 25, 2026

## 1. Overview
**Theme Studio** ("we", "our", or "the extension") is a lightweight, privacy-first browser personalization extension built for Chromium-based browsers (Google Chrome, Microsoft Edge, Brave, etc.).

We believe your browser appearance, wallpapers, and settings belong exclusively to you. This Privacy Policy explains how data and browser permissions are handled entirely on your local device.

---

## 2. No Personal Data Collection
**Theme Studio does not collect, harvest, monitor, or transmit any personal information or browsing data off your device.**

Specifically, we **do not**:
- Collect personally identifiable information (names, email addresses, IP addresses, etc.)
- Transmit visited websites, URLs, search queries, or page contents to any remote server
- Monitor keystrokes, clipboard contents, or form inputs
- Send data to external APIs, cloud databases, or third-party servers
- Include analytics engines, tracking pixels, telemetry scripts, or advertising SDKs

All functionality operates **100% locally on your device**.

---

## 3. Data Stored Locally On Your Device
To persist themes, wallpapers, and schedules across browser restarts, the extension stores configuration data strictly in local browser storage (`chrome.storage.local`, IndexedDB `ThemeStudioDB`, and client-side preferences) and optionally inside a user-authorized local folder via the browser File System Access API:

| Stored Item | Purpose | Location |
| :--- | :--- | :--- |
| **Active Theme & Color Mode** | Remembers your active theme colors and Light/Dark appearance state | Local Browser Storage (`ThemeStudioDB`, `chrome.storage.local`) |
| **Custom & Imported Themes** | Stores themes parsed from imported `manifest.json`/`.zip` files or created in Live Theme Designer | Local Browser Storage & Optional Authorized Folder |
| **Uploaded Tab Wallpapers** | Stores image wallpapers you upload for your New Tab background and rotation timer | Local Browser IndexedDB & Optional Authorized Folder |
| **Scheduler Queue & Interval** | Stores theme/wallpaper rotation queues and active timer intervals | Local Browser Storage Only |
| **Folder Directory Handles** | Retains read/write access to folders you explicitly select for Live Companion or Local Device Space backup (`theme-studio-settings.json`) | Browser IndexedDB Handles Only |

*Note: Only folders you explicitly authorize via the browser permission prompt can be accessed, and zero data leaves your computer.*

---

## 4. Explanation of Permissions
In accordance with Chrome Web Store and Microsoft Edge Add-ons policies, the extension requests only the permissions required for its features:

- **`management`**:
  *Justification:* Lists installed Chromium theme extensions and enables, disables, or resets them at your request or during scheduled theme rotations. It does not inspect or alter unrelated extension data.
- **`storage`**:
  *Justification:* Stores your active theme, custom presets, scheduler configuration, and wallpaper rotation settings locally.
- **`alarms`**:
  *Justification:* Powers background theme and wallpaper auto-rotation timers efficiently via Chromium's native alarm API.
- **`downloads`**:
  *Justification:* Allows you to download generated theme packages (`.zip` / `manifest.json`) locally to your Downloads folder.
- **`tabs`**:
  *Justification:* Opens the extension's setup/manifests window, Extension Developer page (`edge://extensions` or `chrome://extensions`), or persistent Importer tab when requested.
- **`topSites`** & **`favicon`**:
  *Justification:* Reads your browser's local Most Visited sites and cached local favicons solely to render shortcuts on your New Tab page (`newtab/newtab.html`). This data is displayed only inside your New Tab view and is never logged or transmitted anywhere.

---

## 5. Security & In-Memory Validation
When importing custom theme `manifest.json`, `.zip` archives, or unpacked folders in **Secure Theme Importer**:
- Files are parsed and sanitized strictly in local browser memory (`secureParseAndCompile` and `extractManifestFromZipBuffer` in `sharedUtils.js`).
- Comments, BOMs, prototype-pollution keys (`__proto__`, `constructor`, `prototype`), inline scripts, SVG payloads, and out-of-range color values are blocked before updating the Live Theme Designer or Studio.
- Zero external network requests occur during import or validation.

---

## 6. Third-Party Services & Data Sharing
- **No Third-Party Sharing:** We do not sell, rent, monetize, or disclose any user data to third parties.
- **No External API Requests:** All themes, manifests, wallpapers, and settings run air-gapped on your device.

---

## 7. Data Retention & User Control
- **Data Retention:** Stored preferences, custom themes, and wallpapers remain on your local device until you delete them or uninstall the extension.
- **Data Deletion:** You can clear uploaded wallpapers, restore default browser appearance via **"Restore Browser Default"**, or revoke folder permissions through your browser settings at any time.
- **Uninstallation:** Removing the extension from `edge://extensions` or `chrome://extensions` permanently deletes its browser-managed storage (`chrome.storage.local` and `ThemeStudioDB`). Any files saved to a user-selected local folder remain under your direct filesystem control.

---

## 8. Changes to This Policy
If this Privacy Policy is updated to reflect new capabilities, the **Last Updated** date above will be revised while maintaining strict local-only, zero-tracking operation.

---

## 9. Contact
- **Project:** Theme Studio
- **Support / Issues:** [GitHub Issues](https://github.com/tofazzalopu/Theme-Studio/issues)
- **Contact:** `support@instantthemechanger.local`
