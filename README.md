# Theme Studio 🎨

A secure, ultra-lightweight theme manager for Chromium-based browsers (Chrome, Edge, Brave, Opera) featuring an **Apple-crafted UI** and native browser appearance integration.

---

## 🌟 Key Highlights

- **Apple-Inspired Design**: Exact aesthetic matching macOS / iOS design principles with frosted glass (`backdrop-filter`), smooth rounded corners (`border-radius: 18px`), floating pill badges, subtle spring transitions, and responsive light/dark mode.
- **Native Browser Settings Integration**: Reverts cleanly to Chromium's native default appearance (`chrome://settings/appearance`) without corrupting user state, auto-synchronizing with your OS `prefers-color-scheme`.
- **Sandboxed Rust WebAssembly Core**: High-speed, memory-safe JSON sanitization and color validation preventing prototype pollution, memory exhaustion (DoS), and script/SVG injection.
- **Zero Network Egress (Air-Gapped)**: Declares zero `host_permissions`. No data, browsing telemetry, or custom themes ever leave your device.
- **Scope-Restricted `chrome.management` Guard**: Strict verification that extensions being inspected or toggled are strictly of type `"theme"`. Never touches other extensions or user tools.
- **Automated Scheduling**: Chrome Alarms scheduler for automated theme cycling at customizable intervals (1h, 2h, 4h, 8h, 24h).

---

## 🎨 Theme Gallery Presets

Inspired by the reference design:
| Theme | Aesthetic | Visual Tone |
| :--- | :--- | :--- |
| **Default** | 🌐 Chromium Native | Auto-syncs with OS Light / Dark mode |
| **Classic** | ☀️ Clean Porcelain | Minimalist soft light gradient |
| **Aurora** | 🌙 Deep Cosmos | Silky dark navy, indigo, and cyan wave |
| **Midsummer** | ✨ Pearlescent Dawn | Warm peach, lavender, and fluid iridescent gradient |
| **Nebula** | 🌌 Deep Violet | Rich purple and magenta glow |
| **Lilac** | 🌸 Soft Orchid | Serene pastel lavender |
| **Ocean** | 🌊 Azure Depths | Cobalt and cyan deep water gradient |
| **Installed** | 🧩 User Themes | Automatically detects any installed Chromium themes |

---

## 🛡️ Security Architecture & Threat Model

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SECURITY PERIMETER                             │
│                                                                             │
│  [Untrusted Upload (JSON/Theme)]                                            │
│            │                                                                │
│            ▼                                                                │
│  ┌───────────────────────────────────┐                                      │
│  │ Rust / Wasm Sandboxed Validator    │ ◄── Memory-safe, no buffer overflows │
│  │ - Size check (< 1 MB)             │ ◄── Rejects JSON bombs                │
│  │ - Hex bitwise bounds check        │ ◄── Strict schema deserialization     │
│  │ - Strips all scripts / HTML / SVG │ ◄── Rejects XSS / SVG injections      │
│  └───────────────────────────────────┘                                      │
│            │ (Clean JSON Only)                                              │
│            ▼                                                                │
│  ┌───────────────────────────────────┐                                      │
│  │ Extension Service Worker          │                                      │
│  │ - Management API Guard            │ ◄── Restricts actions to type="theme" │
│  │ - Air-Gapped (No Network Egress)  │ ◄── host_permissions: [] (No leaks)  │
│  └───────────────────────────────────┘                                      │
│            │                                                                │
│            ▼                                                                │
│  [Chromium Native Theme Engine / Default Settings]                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Memory-Safe Validation**: Compiles pure Rust into WebAssembly. Deserialization uses `#[serde(deny_unknown_fields)]` to reject injected keys and prototype poisoning (`__proto__`, `constructor`).
2. **Strict Hex Bounds**: Validates `#RRGGBB` using regex-free bitwise arithmetic parsing each channel as `u8` (0–255).
3. **No SVG Injection**: Chromium themes only accept RGB colors or raster PNGs. SVGs containing embedded JavaScript (`<script>` or `onload`) are strictly rejected.
4. **Air-Gapped Operation**: Manifest V3 declarations contain no external permissions or network egress routes.

---

## 🚀 Installation & Loading into Chromium

1. Open your Chromium browser (Chrome, Edge, Brave).
2. Navigate to `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
3. Enable **Developer mode** toggle in the top-right corner.
4. Click **Load unpacked**.
5. Select the `extension` folder located at:
   ```
   E:\AI Class\Instant Theme Changer\extension
   ```
6. The **Theme Studio** icon will appear in your extensions bar! Click it to open the Theme Gallery.

---

## 🛠️ Building from Source

### Prerequisites
- [Rust toolchain](https://rustup.rs/) (1.70+)
- Node.js & `wasm-pack`

### Build Command
To recompile the Rust WebAssembly module:
```bash
npx wasm-pack build --target web --out-dir extension/pkg
```
This generates the optimized `theme_engine_bg.wasm` (< 95 KB) and JS bindings into `extension/pkg/`.

