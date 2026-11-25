/**
 * Single Source of Truth: Theme Catalog & Lookup Engine
 * Eliminates duplicated theme definitions across popup, canvas, generator, and background worker.
 */

import { normalizeStr } from "./sharedUtils.js";

const CATEGORY_LABELS = {
  apple: "Apple Originals",
  kawaii: "Kawaii",
  pastel: "Pastel",
  cafe: "Cafe & Minimal",
  cyber: "Vapor & Cyber",
  celestial: "Space & Night",
  anime: "Anime & Ghibli",
  chrome: "Chrome Colors",
  dark: "Dark & Black",
  wild: "Window to Wild",
  custom: "Custom"
};

// Compact tuple schema: [id, folder, manifestName, name, category, cssClass, iconType, frame, toolbar, text, ntp]
const RAW_THEMES = [
  ["DEFAULT_BROWSER", "DEFAULT_BROWSER", "Default", "Default", "apple", "theme-card-default", "globe", "#e5e5ea", "#ffffff", "#1d1d1f", "#f5f5f7"],
  ["preset-classic", "classic", "Instant Theme - Classic Light", "Classic", "apple", "theme-card-classic", "sun", "#f5f5f7", "#ebebf0", "#1d1d1f", "#ffffff"],
  ["preset-aurora", "aurora", "Instant Theme - Aurora", "Aurora", "apple", "theme-card-aurora", "moon", "#091224", "#152d58", "#ffffff", "#0d1b2a"],
  ["preset-midsummer", "midsummer", "Instant Theme - Midsummer", "Midsummer", "apple", "theme-card-midsummer", "sparkle", "#fedac2", "#f7b4c9", "#1d1d1f", "#fffaf5"],
  ["preset-nebula", "nebula", "Instant Theme - Nebula", "Nebula", "apple", "theme-card-nebula", "cosmos", "#12092b", "#3a1661", "#ffffff", "#1a0c30"],
  ["preset-lilac", "lilac", "Instant Theme - Lilac", "Lilac", "apple", "theme-card-lilac", "flower", "#dfd7f8", "#eeddf5", "#1d1d1f", "#fbf9ff"],
  ["preset-ocean", "ocean", "Instant Theme - Ocean Blue", "Ocean", "apple", "theme-card-ocean", "waves", "#0f2b48", "#175489", "#ffffff", "#0a192f"],
  ["theme-strawberry-milk", "strawberry-milk", "Aesthetic - Strawberry Milk", "Strawberry Milk", "kawaii", "theme-card-strawberry", "heart", "#ffccd5", "#ffe5ec", "#590d22", "#fff0f3"],
  ["theme-daydreamer-clouds", "daydreamer-clouds", "Aesthetic - Daydreamer Clouds", "Daydream Clouds", "kawaii", "theme-card-daydreamer", "cloud", "#bde0fe", "#cdb4db", "#22223b", "#f0f7ff"],
  ["theme-soft-moon-glow", "soft-moon-glow", "Instant Theme - Soft Moon Glow", "Soft Moon Glow", "kawaii", "theme-card-soft-moon", "moon", "#241e38", "#3d315b", "#ffffff", "#171226"],
  ["theme-baby-panda", "baby-panda", "Instant Theme - Baby Panda", "Baby Panda", "kawaii", "theme-card-baby-panda", "smile", "#dee2e6", "#f8f9fa", "#212529", "#ffffff"],
  ["theme-cotton-candy", "cotton-candy", "Instant Theme - Cotton Candy", "Cotton Candy", "kawaii", "theme-card-cotton-candy", "sparkle", "#f7cad0", "#b5e2fa", "#2b2d42", "#fff1f5"],
  ["theme-sakura-blossom", "sakura-blossom", "Aesthetic - Sakura Blossom", "Sakura Blossom", "pastel", "theme-card-sakura", "flower", "#fbc3bc", "#f7d1cd", "#3d2626", "#fff5f5"],
  ["theme-matcha-latte", "matcha-latte", "Aesthetic - Matcha Latte", "Matcha Latte", "pastel", "theme-card-matcha", "leaf", "#b7c4b0", "#dbe7d5", "#2b3a27", "#f4f8f2"],
  ["theme-lavender-mist", "lavender-mist", "Instant Theme - Lavender Mist", "Lavender Mist", "pastel", "theme-card-lavender", "flower", "#d8b4e2", "#ecd6f5", "#35233c", "#faf4fc"],
  ["theme-butter-honey", "butter-honey", "Aesthetic - Butter & Honey", "Butter & Honey", "pastel", "theme-card-butter-honey", "sun", "#faedcb", "#fefae0", "#4a3e1b", "#fffdf5"],
  ["theme-peach-bellini", "peach-bellini", "Instant Theme - Peach Bellini", "Peach Bellini", "pastel", "theme-card-peach-bellini", "heart", "#ffd6ba", "#ffe5d9", "#402b20", "#fff7f2"],
  ["theme-coffee-shop", "coffee-shop", "Aesthetic - Warm Coffee Shop", "Warm Coffee", "cafe", "theme-card-coffee-shop", "coffee", "#3e2723", "#5d4037", "#ffffff", "#2b1b17"],
  ["theme-clean-slate", "clean-slate", "Instant Theme - Clean Slate", "Clean Slate", "cafe", "theme-card-clean-slate", "feather", "#e2e8f0", "#f8fafc", "#0f172a", "#ffffff"],
  ["theme-botanical-sage", "botanical-sage", "Aesthetic - Botanical Sage", "Botanical Sage", "cafe", "theme-card-botanical-sage", "leaf", "#849974", "#a5b69a", "#1c2817", "#f0f4ee"],
  ["theme-rainy-window", "rainy-window", "Aesthetic - Cozy Rainy Window", "Rainy Window", "cafe", "theme-card-rainy-window", "droplet", "#334155", "#475569", "#f1f5f9", "#1e293b"],
  ["theme-oat-linen", "oat-linen", "Instant Theme - Oat & Linen", "Oat & Linen", "cafe", "theme-card-oat-linen", "coffee", "#d6ccc2", "#f5ebe0", "#3e3832", "#faf6f0"],
  ["theme-cyberpunk-neon", "cyberpunk-neon", "Aesthetic - Cyberpunk Neon", "Cyberpunk Neon", "cyber", "theme-card-cyberpunk", "zap", "#0a0915", "#1f1a3a", "#00f0ff", "#07060f"],
  ["theme-outrun-grid", "outrun-grid", "Aesthetic - Outrun 80s Grid", "Outrun 80s", "cyber", "theme-card-outrun", "terminal", "#18052b", "#3b115a", "#ff2a85", "#0f021c"],
  ["theme-tokyo-lofi", "tokyo-lofi", "Aesthetic - Tokyo Lofi Rain", "Tokyo Lofi Rain", "cyber", "theme-card-tokyo-lofi", "droplet", "#141724", "#23283e", "#e06c75", "#0d0f17"],
  ["theme-sunset-palms", "sunset-palms", "Instant Theme - Sunset Palms", "Sunset Palms", "cyber", "theme-card-sunset-palms", "sun", "#28103f", "#682d8a", "#ff8da1", "#160824"],
  ["theme-midnight-aurora", "midnight-aurora", "Instant Theme - Arctic Aurora", "Arctic Aurora", "celestial", "theme-card-midnight-aurora", "sparkle", "#061a23", "#0e3846", "#4deeea", "#041017"],
  ["theme-deep-space", "deep-space", "Aesthetic - Deep Space Horizon", "Deep Space", "celestial", "theme-card-deep-space", "cosmos", "#0d0221", "#261447", "#ff3864", "#050014"],
  ["theme-oceanic-trench", "oceanic-trench", "Instant Theme - Oceanic Trench", "Oceanic Trench", "celestial", "theme-card-oceanic-trench", "waves", "#0b2545", "#134074", "#8da9c4", "#05192d"],
  ["theme-spirited-bathhouse", "spirited-bathhouse", "Aesthetic - Spirited Bathhouse", "Spirited Night", "anime", "theme-card-spirited-bathhouse", "lantern", "#1b1c2b", "#3f2e56", "#f9c784", "#10111a"],
  ["theme-howls-meadow", "howls-meadow", "Aesthetic - Howls Meadow Sky", "Howl's Meadow", "anime", "theme-card-howls-meadow", "cloud", "#7294d4", "#a7c7e7", "#1d2d44", "#f0f8ff"],
  ["theme-lofi-study", "lofi-study", "Instant Theme - Lofi Study Dusk", "Lofi Study Dusk", "anime", "theme-card-lofi-study", "book", "#2e1f27", "#4a3b43", "#f3d5b5", "#1c1318"],
  ["theme-chrome-just-black", "chrome-just-black", "Instant Theme - Just Black", "Just Black", "chrome", "theme-card-chrome-just-black", "moon", "#000000", "#1c1c1e", "#ffffff", "#121212"],
  ["theme-chrome-classic-blue", "chrome-classic-blue", "Instant Theme - Classic Blue", "Classic Blue", "chrome", "theme-card-chrome-classic-blue", "chrome", "#1a73e8", "#4285f4", "#ffffff", "#f8fafd"],
  ["theme-chrome-oceanic", "chrome-oceanic", "Instant Theme - Oceanic", "Oceanic", "chrome", "theme-card-chrome-oceanic", "waves", "#006064", "#00838f", "#ffffff", "#e0f7fa"],
  ["theme-chrome-ultra-violet", "chrome-ultra-violet", "Instant Theme - Ultra Violet", "Ultra Violet", "chrome", "theme-card-chrome-ultra-violet", "sparkle", "#311b92", "#4527a0", "#ffffff", "#ede7f6"],
  ["theme-chrome-slate", "chrome-slate", "Instant Theme - Slate Grey", "Slate Grey", "chrome", "theme-card-chrome-slate", "feather", "#37474f", "#455a64", "#ffffff", "#eceff1"],
  ["theme-chrome-seafoam", "chrome-seafoam", "Instant Theme - Sea Foam", "Sea Foam", "chrome", "theme-card-chrome-seafoam", "droplet", "#004d40", "#00796b", "#ffffff", "#e0f2f1"],
  ["theme-chrome-banana", "chrome-banana", "Instant Theme - Banana Yellow", "Banana Yellow", "chrome", "theme-card-chrome-banana", "sun", "#f57f17", "#fbc02d", "#212121", "#fffde7"],
  ["theme-chrome-rose", "chrome-rose", "Instant Theme - Rose Magenta", "Rose Magenta", "chrome", "theme-card-chrome-rose", "flower", "#880e4f", "#ad1457", "#ffffff", "#fce4ec"],
  ["theme-chrome-pretty-pink", "chrome-pretty-pink", "Instant Theme - Pretty in Pink", "Pretty in Pink", "chrome", "theme-card-chrome-pretty-pink", "heart", "#c2185b", "#e91e63", "#ffffff", "#f8bbd0"],
  ["theme-chrome-black-white", "chrome-black-white", "Instant Theme - Black & White", "Black & White", "chrome", "theme-card-chrome-black-white", "terminal", "#212121", "#424242", "#ffffff", "#ffffff"],
  ["theme-dark-morpheon", "dark-morpheon", "Instant Theme - Morpheon Dark", "Morpheon Dark", "dark", "theme-card-dark-morpheon", "moon", "#141414", "#1f1f1f", "#d1d5db", "#121212"],
  ["theme-dark-pitch-black", "dark-pitch-black", "Instant Theme - Pitch Black OLED", "Pitch Black OLED", "dark", "theme-card-dark-pitch-black", "moon", "#000000", "#080808", "#e5e5e5", "#000000"],
  ["theme-dark-slinky", "dark-slinky", "Instant Theme - Slinky Elegant", "Slinky Elegant", "dark", "theme-card-dark-slinky", "sparkle", "#1b1b1b", "#252525", "#e2e8f0", "#161616"],
  ["theme-dark-carbon", "dark-carbon", "Instant Theme - Midnight Carbon", "Midnight Carbon", "dark", "theme-card-dark-carbon", "terminal", "#111215", "#1a1c23", "#9ca3af", "#0d0e12"],
  ["theme-dark-void", "dark-void", "Instant Theme - Dark Void", "Dark Void", "dark", "theme-card-dark-void", "cosmos", "#08070d", "#12101c", "#a78bfa", "#050408"],
  ["theme-dark-charcoal", "dark-charcoal", "Instant Theme - Charcoal Minimal", "Charcoal Minimal", "dark", "theme-card-dark-charcoal", "feather", "#262626", "#333333", "#f5f5f5", "#1c1c1c"],
  ["theme-wild-forest", "wild-forest", "Instant Theme - Forest Wilds", "Forest Wilds", "wild", "theme-card-wild-forest", "tree", "#14281d", "#203d2e", "#99d98c", "#0a1710"],
  ["theme-wild-alpine", "wild-alpine", "Instant Theme - Alpine Peaks", "Alpine Peaks", "wild", "theme-card-wild-alpine", "mountain", "#1b2a41", "#274060", "#f1faee", "#0d1b2a"],
  ["theme-wild-dunes", "wild-dunes", "Instant Theme - Golden Dunes", "Golden Dunes", "wild", "theme-card-wild-dunes", "sun", "#3d2612", "#5e3b1c", "#fed9b7", "#241407"],
  ["theme-wild-ocean-mist", "wild-ocean-mist", "Instant Theme - Ocean Mist", "Ocean Mist", "wild", "theme-card-wild-ocean-mist", "waves", "#102a43", "#1f4e78", "#9fb3c8", "#0b1d30"],
  ["theme-wild-rainforest", "wild-rainforest", "Instant Theme - Rainforest Canopy", "Rainforest Canopy", "wild", "theme-card-wild-rainforest", "leaf", "#0f2d1e", "#1b4332", "#74c69d", "#081c12"],
  ["theme-wild-sunset-horizon", "wild-sunset-horizon", "Instant Theme - Sunset Horizon", "Sunset Horizon", "wild", "theme-card-wild-sunset", "sun", "#381d2a", "#592941", "#f7a072", "#200f17"]
];

export const THEMES = RAW_THEMES.map(([id, folder, manifestName, name, category, cssClass, iconType, frame, toolbar, text, ntp]) => ({
  id,
  folder,
  manifestName,
  normalized: normalizeStr(folder === "DEFAULT_BROWSER" ? name : folder),
  name,
  category,
  categoryLabel: CATEGORY_LABELS[category] || category,
  cssClass,
  iconType,
  isDefault: id === "DEFAULT_BROWSER",
  colors: { frame, toolbar, text, ntp },
  // Canvas convenience aliases
  frame,
  toolbar,
  textCol: text,
  ntp,
  wallpaper: `radial-gradient(circle at 85% 30%, ${toolbar}aa 0%, transparent 65%), linear-gradient(135deg, ${frame} 0%, ${ntp} 100%)`
}));

export const THEME_BY_ID = new Map();
for (const t of THEMES) {
  THEME_BY_ID.set(t.id, t);
  if (!t.isDefault) {
    THEME_BY_ID.set(t.folder, t);
    THEME_BY_ID.set(t.normalized, t);
  }
}

export function findThemeMeta(identifier) {
  if (!identifier) return null;
  if (THEME_BY_ID.has(identifier)) return THEME_BY_ID.get(identifier);
  const clean = String(identifier).replace(/^(preset-|theme-)/, "");
  if (THEME_BY_ID.has(clean)) return THEME_BY_ID.get(clean);
  const norm = normalizeStr(identifier);
  return THEME_BY_ID.get(norm) || THEMES.find((t) => normalizeStr(t.name) === norm) || null;
}
