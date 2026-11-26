/**
 * Shared Utilities for Theme Studio
 * Safe for both DOM pages (popup, canvas, companion) and MV3 Service Worker.
 */

export function normalizeStr(str) {
  if (!str) return "";
  let s = String(str).toLowerCase();
  for (const prefix of ["instant theme - ", "aesthetic theme - ", "aesthetic - ", "preset-", "theme-"]) {
    s = s.replaceAll(prefix, "");
  }
  return s.replace(/[^a-z0-9]/g, "");
}

export function hexToRgb(hex, fallback = [32, 34, 42]) {
  if (!hex || typeof hex !== "string") return fallback;
  let clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) clean = clean.split("").map((c) => c + c).join("");
  if (clean.length !== 6) return fallback;
  const num = parseInt(clean, 16);
  return Number.isNaN(num) ? fallback : [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

export function adjustBrightness(rgb, factor = 0.85) {
  return rgb.map((v) => Math.min(255, Math.max(0, Math.round(v * factor))));
}

export function validateHexColor(hex) {
  return typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex.trim());
}

function stripJsonCommentsAndBom(raw) {
  let s = raw.replace(/^\uFEFF/, "");
  let out = "";
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inStr) {
      out += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

export function secureParseAndCompile(rawJson, fallbackName = "Imported Theme") {
  if (typeof rawJson !== "string" || rawJson.length === 0) {
    throw new Error("Empty theme file");
  }
  if (rawJson.length > 1024 * 1024) {
    throw new Error("Manifest exceeds 1 MB text limit");
  }
  if (/<\s*script|onload\s*=|onerror\s*=|<\s*svg/i.test(rawJson)) {
    throw new Error("Disallowed HTML or script content detected");
  }

  const sanitizedRaw = stripJsonCommentsAndBom(rawJson);
  const parsed = JSON.parse(sanitizedRaw, (key, value) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error("Disallowed prototype key in JSON");
    }
    return value;
  });

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid theme JSON");
  }

  const rawColors = parsed.theme?.colors || parsed.colors;
  if (!rawColors || typeof rawColors !== "object") {
    throw new Error("Missing theme.colors object in manifest.json");
  }

  const clampByte = (n) => {
    const num = typeof n === "string" ? Number(n.trim()) : n;
    if (typeof num !== "number" || !Number.isFinite(num) || num < 0 || num > 255) {
      throw new Error("Invalid RGB channel value (must be 0-255)");
    }
    return Math.round(num);
  };

  const toRgb = (val, fallback) => {
    if (typeof val === "string") {
      if (validateHexColor(val)) return hexToRgb(val, fallback);
      const m = val.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (m) return [clampByte(m[1]), clampByte(m[2]), clampByte(m[3])];
    }
    if (!Array.isArray(val) || val.length < 3) return fallback;
    return [clampByte(val[0]), clampByte(val[1]), clampByte(val[2])];
  };

  let rawName = String(parsed.name || "").trim();
  if (!rawName || /^__MSG_.*__$/.test(rawName)) {
    rawName = fallbackName || "Imported Theme";
  }
  const cleanName = rawName.replace(/[<>]/g, "").slice(0, 64);

  const frameRgb = toRgb(rawColors.frame || rawColors.frame_inactive || rawColors.ntp_header, [28, 28, 30]);
  const toolbarRgb = toRgb(rawColors.toolbar || rawColors.ntp_header || rawColors.frame, frameRgb);
  const textRgb = toRgb(
    rawColors.tab_text || rawColors.text || rawColors.tab_background_text || rawColors.bookmark_text || rawColors.ntp_text,
    [255, 255, 255]
  );
  const ntpRgb = toRgb(rawColors.ntp_background || rawColors.ntp || rawColors.background_tab || rawColors.toolbar, toolbarRgb);

  return JSON.stringify({
    manifest_version: 3,
    version: String(parsed.version || "1.0.0").replace(/[^0-9.]/g, "").slice(0, 16) || "1.0.0",
    name: cleanName,
    description: String(parsed.description || "Validated custom Chromium theme").replace(/[<>]/g, "").slice(0, 200),
    theme: {
      colors: {
        frame: frameRgb,
        toolbar: toolbarRgb,
        tab_text: textRgb,
        ntp_background: ntpRgb
      }
    }
  }, null, 2);
}

/**
 * Pure JS ZIP reader using Central Directory (supports Data Descriptors, deflate-raw & stored).
 */
export async function extractManifestFromZipBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder("utf-8");

  const decodeEntryPayload = async (localOffset, compSize, method) => {
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("Invalid ZIP local header");
    }
    const nameLen = view.getUint16(localOffset + 26, true);
    const extraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + nameLen + extraLen;
    if (compSize > 1024 * 1024 || dataStart + compSize > bytes.length) {
      throw new Error("Manifest entry exceeds size bounds");
    }
    const payload = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) return decoder.decode(payload);
    if (method === 8 && typeof DecompressionStream !== "undefined") {
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([payload]).stream().pipeThrough(ds);
      return await new Response(stream).text();
    }
    throw new Error(`Unsupported ZIP compression method (${method})`);
  };

  // 1. Scan backwards for End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  const minScan = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minScan; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    let pos = cdOffset;
    let fallbackJson = null;

    while (pos + 46 <= bytes.length && pos < cdOffset + cdSize) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const method = view.getUint16(pos + 10, true);
      const compSize = view.getUint32(pos + 20, true);
      const uncompSize = view.getUint32(pos + 24, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localOffset = view.getUint32(pos + 42, true);

      const fileName = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      if (/(^|\/)manifest\.json$/i.test(fileName)) {
        if (uncompSize > 1024 * 1024) throw new Error("manifest.json inside ZIP exceeds 1 MB");
        return await decodeEntryPayload(localOffset, compSize, method);
      }
      if (!fallbackJson && /\.json$/i.test(fileName) && compSize <= 1024 * 1024) {
        fallbackJson = { localOffset, compSize, method };
      }

      pos += 46 + nameLen + extraLen + commentLen;
    }

    if (fallbackJson) {
      return await decodeEntryPayload(fallbackJson.localOffset, fallbackJson.compSize, fallbackJson.method);
    }
  }

  throw new Error("No manifest.json found inside ZIP package");
}

export function isColorDark(hex) {
  const [r, g, b] = hexToRgb(hex, [255, 255, 255]);
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  if (typeof document === "undefined") return String(str);
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

export const CookieStore = {
  get(name) {
    try {
      if (typeof document !== "undefined") {
        const escaped = name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1");
        const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
        if (match) return decodeURIComponent(match[1]);
      }
    } catch (_) { }
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(name) : null;
    } catch (_) {
      return null;
    }
  },
  set(name, value, days = 365) {
    try {
      if (typeof document !== "undefined") {
        document.cookie = `${name}=${encodeURIComponent(String(value))}; max-age=${days * 86400}; path=/; SameSite=Lax`;
      }
    } catch (_) { }
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(name, String(value));
    } catch (_) { }
  },
  remove(name) {
    try {
      if (typeof document !== "undefined") {
        document.cookie = `${name}=; max-age=0; path=/; SameSite=Lax`;
      }
    } catch (_) { }
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(name);
    } catch (_) { }
  },
  getJSON(name, fallback = null) {
    const raw = this.get(name);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  },
  setJSON(name, value, days = 365) {
    try {
      this.set(name, JSON.stringify(value), days);
    } catch (_) { }
  },
  removeChunked(name) {
    this.remove(name);
    const count = Number(this.get(`${name}__n`) || 0);
    this.remove(`${name}__n`);
    for (let i = 0; i < Math.max(count, 16); i++) {
      if (this.get(`${name}__${i}`) !== null) {
        this.remove(`${name}__${i}`);
      }
    }
  },
  setChunked(name, rawValue, days = 365) {
    try {
      const str = String(rawValue ?? "");
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(name, str);
      } catch (_) {}
      if (typeof document === "undefined") return;

      const prevCount = Number(this.get(`${name}__n`) || 0);
      const chunks = [];
      let current = "";
      for (const ch of str) {
        const nextEncodedLen = encodeURIComponent(current + ch).length;
        if (nextEncodedLen > 2800 && current.length > 0) {
          chunks.push(current);
          current = ch;
        } else {
          current += ch;
        }
      }
      if (current.length > 0 || chunks.length === 0) chunks.push(current);

      document.cookie = `${name}__n=${chunks.length}; max-age=${days * 86400}; path=/; SameSite=Lax`;
      for (let i = 0; i < chunks.length; i++) {
        document.cookie = `${name}__${i}=${encodeURIComponent(chunks[i])}; max-age=${days * 86400}; path=/; SameSite=Lax`;
      }
      for (let i = chunks.length; i < prevCount; i++) {
        document.cookie = `${name}__${i}=; max-age=0; path=/; SameSite=Lax`;
      }
    } catch (_) {}
  },
  getChunked(name) {
    try {
      if (typeof document !== "undefined") {
        const countRaw = this.get(`${name}__n`);
        const count = Number(countRaw || 0);
        if (count > 0) {
          const parts = [];
          let valid = true;
          for (let i = 0; i < count; i++) {
            const match = document.cookie.match(new RegExp(`(?:^|; )${name}__${i}=([^;]*)`));
            if (!match) {
              valid = false;
              break;
            }
            parts.push(decodeURIComponent(match[1]));
          }
          if (valid) return parts.join("");
        }
      }
    } catch (_) {}
    try {
      if (typeof localStorage !== "undefined") {
        const v = localStorage.getItem(name);
        if (v !== null) return v;
      }
    } catch (_) {}
    return this.get(name);
  },
  setChunkedJSON(name, value, days = 365) {
    try {
      this.setChunked(name, JSON.stringify(value), days);
    } catch (_) {}
  },
  getChunkedJSON(name, fallback = null) {
    const raw = this.getChunked(name);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }
};

export function setupHorizontalScroll(container, leftBtn, rightBtn, step = 180) {
  if (!container) return;

  container.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > 0) {
      e.preventDefault();
      container.scrollLeft += e.deltaY * 1.25;
    }
  }, { passive: false });

  let isDown = false, startX = 0, scrollLeft = 0;
  container.addEventListener("mousedown", (e) => {
    isDown = true;
    startX = e.pageX - container.offsetLeft;
    scrollLeft = container.scrollLeft;
  });
  window?.addEventListener("mouseup", () => {
    if (isDown) {
      isDown = false;
      container.classList.remove("is-dragging");
    }
  });
  container.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    const walk = (e.pageX - container.offsetLeft) - startX;
    if (Math.abs(walk) > 4) {
      container.classList.add("is-dragging");
      e.preventDefault();
      container.scrollLeft = scrollLeft - walk * 1.35;
    }
  });

  const update = () => {
    const maxScroll = container.scrollWidth - container.clientWidth;
    const atStart = container.scrollLeft <= 4;
    const atEnd = container.scrollLeft >= maxScroll - 4 || maxScroll <= 2;
    if (leftBtn) {
      leftBtn.disabled = atStart;
      leftBtn.classList.toggle("disabled", atStart);
      leftBtn.style.opacity = atStart ? "0.3" : "1";
    }
    if (rightBtn) {
      rightBtn.disabled = atEnd;
      rightBtn.classList.toggle("disabled", atEnd);
      rightBtn.style.opacity = atEnd ? "0.3" : "1";
    }
  };

  leftBtn?.addEventListener("click", () => container.scrollBy({ left: -step, behavior: "smooth" }));
  rightBtn?.addEventListener("click", () => container.scrollBy({ left: step, behavior: "smooth" }));
  container.addEventListener("scroll", update, { passive: true });
  window?.addEventListener("resize", update);
  setTimeout(update, 150);
}
