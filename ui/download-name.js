/* Suggest a download filename from a response, matching backend/filename.go.
   The sidecar is authoritative (`suggestedFileName`); this is the fallback when
   that field is missing and the label the UI shows before saving. */

(function () {
  const MIME_EXT = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/x-zip-compressed": ".zip",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/x-icon": ".ico",
    "application/json": ".json",
    "text/json": ".json",
    "text/csv": ".csv",
    "application/csv": ".csv",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "text/html": ".html",
    "text/plain": ".txt",
    "text/css": ".css",
    "text/xml": ".xml",
    "application/xml": ".xml",
    "application/javascript": ".js",
    "text/javascript": ".js",
    "application/gzip": ".gz",
    "application/x-gzip": ".gz",
    "application/x-tar": ".tar",
    "application/wasm": ".wasm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "application/xhtml+xml": ".xhtml"
  };

  const GENERIC_EXT = { ".bin": true, ".dat": true, ".download": true, ".dms": true, ".part": true };

  function headerValue(headers, name) {
    const list = headers || [];
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      if (!entry) continue;
      if (String(entry.key || "").toLowerCase() === name) return String(entry.value || "");
    }
    return "";
  }

  function extensionForMIME(contentType) {
    const base = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (!base || base === "application/octet-stream") return "";
    if (Object.prototype.hasOwnProperty.call(MIME_EXT, base)) return MIME_EXT[base];
    if (base.startsWith("text/")) {
      const sub = base.slice(5);
      if (sub === "plain") return ".txt";
      const cleaned = sub.replace(/[^a-z0-9]+/g, "");
      return cleaned ? `.${cleaned}` : ".txt";
    }
    return "";
  }

  function splitDispPart(value) {
    let quote = "";
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (quote) {
        if (char === "\\" && index + 1 < value.length) { index += 1; continue; }
        if (char === quote) quote = "";
        continue;
      }
      if (char === "\"") { quote = char; continue; }
      if (char === ";") return [value.slice(0, index), value.slice(index + 1)];
    }
    return [value, ""];
  }

  function unquoteDisp(value) {
    const trimmed = String(value || "").trim();
    if (trimmed.length >= 2 && trimmed[0] === "\"" && trimmed[trimmed.length - 1] === "\"") {
      return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    }
    return trimmed;
  }

  function dispositionParam(header, name) {
    const lowerName = name.toLowerCase();
    let rest = header;
    while (rest) {
      const parts = splitDispPart(rest);
      rest = parts[1];
      const part = parts[0].trim();
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      if (part.slice(0, eq).trim().toLowerCase() !== lowerName) continue;
      return unquoteDisp(part.slice(eq + 1));
    }
    return "";
  }

  function decodeRFC5987(value) {
    const trimmed = String(value || "").trim();
    const pieces = trimmed.split("'");
    const encoded = pieces.length >= 3 ? pieces.slice(2).join("'") : trimmed;
    try {
      const decoded = decodeURIComponent(encoded);
      return decoded.trim() ? decoded : "";
    } catch (error) {
      return "";
    }
  }

  function filenameFromContentDisposition(header) {
    const text = String(header || "").trim();
    if (!text) return "";
    const star = dispositionParam(text, "filename*");
    if (star) {
      const decoded = decodeRFC5987(star);
      if (decoded) return decoded;
    }
    return dispositionParam(text, "filename");
  }

  function filenameFromURL(raw) {
    let text = String(raw || "").trim();
    if (!text) return "";
    const scheme = text.indexOf("://");
    if (scheme >= 0) text = text.slice(scheme + 3);
    const slash = text.indexOf("/");
    if (slash < 0) return "";
    let path = text.slice(slash);
    const end = path.search(/[?#]/);
    if (end >= 0) path = path.slice(0, end);
    const segments = path.split("/").filter(Boolean);
    if (!segments.length) return "";
    try { return decodeURIComponent(segments[segments.length - 1]); }
    catch (error) { return segments[segments.length - 1]; }
  }

  function reserved(value) {
    const base = value.replace(/\.[^.]+$/, "").toUpperCase();
    return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base);
  }

  function sanitizeFileName(value) {
    let name = String(value || "").trim().replace(/\\/g, "/");
    const slash = name.lastIndexOf("/");
    if (slash >= 0) name = name.slice(slash + 1);
    const query = name.search(/[?#]/);
    if (query >= 0) name = name.slice(0, query);
    name = name.replace(/[\u0000-\u001f<>:"|?*]/g, "").replace(/^[ .]+|[ .]+$/g, "");
    if (!name || name === "." || name === "..") return "";
    if (reserved(name)) name = `_${name}`;
    if (name.length > 180) {
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot) : "";
      const base = (dot > 0 ? name.slice(0, dot) : name).slice(0, Math.max(1, 180 - ext.length)).replace(/[ .]+$/g, "");
      name = base + ext;
    }
    return name;
  }

  function withExtension(name, contentType, replaceGeneric) {
    const ext = extensionForMIME(contentType);
    const match = name.match(/(\.[^.]+)$/);
    const current = match ? match[1] : "";
    if (!current) return name + (ext || ".bin");
    if (replaceGeneric && GENERIC_EXT[current.toLowerCase()] && ext) return name.slice(0, -current.length) + ext;
    return name;
  }

  function suggest(input) {
    const source = input || {};
    const disposition = source.disposition || headerValue(source.headers, "content-disposition");
    const contentType = source.contentType || headerValue(source.headers, "content-type");
    const url = source.url || "";
    const fromHeader = sanitizeFileName(filenameFromContentDisposition(disposition));
    if (fromHeader) return withExtension(fromHeader, contentType, false);
    const fromURL = sanitizeFileName(filenameFromURL(url));
    if (fromURL) return withExtension(fromURL, contentType, true);
    return `download${extensionForMIME(contentType) || ".bin"}`;
  }

  window.HC = window.HC || {};
  window.HC.downloadName = { suggest, sanitizeFileName, extensionForMIME };
})();
