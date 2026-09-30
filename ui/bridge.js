/* Thin wrapper around `window.dbxPlugin`. Everything the workbench does over the
   DBX Host Bridge funnels through here so the rest of the UI stays transport
   agnostic and can degrade cleanly when no backend is attached. */

(function () {
  const util = HC.util;
  const plugin = typeof window.dbxPlugin !== "undefined" ? window.dbxPlugin : null;

  const MAX_INVOKE_TIMEOUT = 120000;
  const PROGRESS_LISTENERS = new Set();

  let backendReady = false;
  let backendError = "";
  let locale = "en";
  let appearance = "light";
  let context = {};
  let contextDir = "";

  const ready = (async () => {
    if (!plugin) {
      backendError = "no-host";
      return false;
    }
    try {
      await plugin.ready;
      context = plugin.context || {};
      applyContext(context);
      locale = HC.i18n.setLocale(plugin.locale);
      appearance = readAppearance(plugin.theme) || appearance;
      applyAppearance(appearance);
    } catch (error) {
      backendError = String((error && error.message) || error);
      return false;
    }
    if (plugin.onContext) plugin.onContext((next) => { context = next || {}; applyContext(next || {}); });
    if (plugin.onEvent) {
      plugin.onEvent((message) => {
        const method = message && (message.method || (message.event && message.event.method));
        const params = (message && message.params) || (message.event && message.event.params) || {};
        if (method === "http/progress") {
          PROGRESS_LISTENERS.forEach((listener) => {
            try { listener(params); } catch (error) { /* listener errors must not break the stream */ }
          });
        }
      });
    }
    try {
      await plugin.invoke("plugin/ping", {}, { timeoutMs: 5000 });
      backendReady = true;
    } catch (error) {
      backendReady = false;
      backendError = String((error && error.message) || error);
    }
    return backendReady;
  })();

  function readAppearance(theme) {
    if (!theme) return null;
    if (typeof theme === "string") return theme;
    return theme.appearance || null;
  }

  function applyAppearance(value) {
    if (!value) return;
    appearance = value;
    document.documentElement.dataset.dbxTheme = value;
  }

  /* The connection form carries the optional storage directory. The config can
     arrive nested a few different ways, so walk it defensively and cache what
     we find; store.init() pushes it to the sidecar as a belt-and-braces path. */
  const DIR_KEYS = ["storage_dir", "storageDir", "storage_path", "storagePath", "data_dir", "dataDir"];

  function pickDir(object, depth) {
    if (!object || typeof object !== "object" || depth > 4) return "";
    for (const key of DIR_KEYS) {
      const value = object[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    for (const key of Object.keys(object)) {
      const value = object[key];
      if (value && typeof value === "object") {
        const found = pickDir(value, depth + 1);
        if (found) return found;
      }
    }
    return "";
  }

  function applyContext(next) {
    const dir = pickDir(next, 0);
    if (dir) contextDir = dir;
  }

  function onEnv(listener) {
    const handler = (event) => {
      const detail = (event && event.detail) || {};
      if (detail.locale) locale = HC.i18n.setLocale(detail.locale);
      const next = readAppearance(detail.theme);
      if (next) applyAppearance(next);
      listener({ locale, appearance });
    };
    // The dev host dispatches on window; DBX itself dispatches on document.
    // Listen to both so a non-bubbling event is observed either way.
    document.addEventListener("dbx-plugin-env", handler);
    window.addEventListener("dbx-plugin-env", handler);
    return () => {
      document.removeEventListener("dbx-plugin-env", handler);
      window.removeEventListener("dbx-plugin-env", handler);
    };
  }

  function onProgress(listener) {
    PROGRESS_LISTENERS.add(listener);
    return () => PROGRESS_LISTENERS.delete(listener);
  }

  function requireBackend() {
    if (!plugin) throw new Error(HC.i18n.t("err.backendHint"));
    return plugin;
  }

  async function invoke(method, params, timeoutMs) {
    const bridge = requireBackend();
    return bridge.invoke(method, params, { timeoutMs: Math.min(timeoutMs || 30000, MAX_INVOKE_TIMEOUT) });
  }

  function sendTimeoutFor(spec) {
    const requestTimeout = (spec.options && spec.options.timeoutMs) || 30000;
    return Math.min(requestTimeout + 5000, MAX_INVOKE_TIMEOUT);
  }

  async function send(spec) {
    return invoke("http/send", spec, sendTimeoutFor(spec));
  }

  async function cancel(requestId) {
    try {
      return await invoke("http/cancel", { requestId }, 10000);
    } catch (error) {
      return { cancelled: false };
    }
  }

  async function readBody(bodyId, offset, length) {
    return invoke("http/body", { bodyId, offset, length }, 20000);
  }

  async function saveBody(bodyId, options) {
    return invoke("http/body/save", Object.assign({ bodyId }, options || {}), 30000);
  }

  async function loadStore() {
    return invoke("store/load", {}, 10000);
  }

  async function saveStore(store, storageDir) {
    const params = { store };
    if (storageDir) params.storage_dir = storageDir;
    return invoke("store/save", params, 20000);
  }

  async function setStoreDir(dir) {
    return invoke("store/setDir", { dir }, 10000);
  }

  function fileTransferApi() {
    return plugin && plugin.fileTransfer ? plugin.fileTransfer : null;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let index = 0; index < bytes.length; index += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step));
    }
    return btoa(binary);
  }

  function base64ToText(parts) {
    const binary = parts.map((part) => atob(part)).join("");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }

  /* Desktop DBX exposes a native save dialog on fileTransfer. Web hosts leave
     that namespace undefined; fall back to the sidecar Downloads folder, which
     is the same path http/body/save already uses. */
  async function saveTextFile(name, text) {
    const transfer = fileTransferApi();
    if (transfer && typeof transfer.beginSave === "function" && typeof transfer.write === "function" && typeof transfer.finish === "function") {
      const bytes = new TextEncoder().encode(text);
      const target = await transfer.beginSave({ name, contentType: "application/json", size: bytes.length });
      if (!target || !target.handleId) return { cancelled: true };
      try {
        await transfer.write(target.handleId, 0, bytes);
      } catch (error) {
        await transfer.write(target.handleId, 0, bytesToBase64(bytes));
      }
      await transfer.finish(target.handleId);
      return { path: name, via: "dialog" };
    }
    if (backendReady) {
      const saved = await invoke("file/writeText", { fileName: name, content: text }, 15000);
      return { path: (saved && saved.path) || name, via: "sidecar" };
    }
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return { path: name, via: "browser" };
  }

  async function pickTextFile() {
    const transfer = fileTransferApi();
    if (transfer && typeof transfer.pick === "function" && typeof transfer.read === "function") {
      const picked = await transfer.pick({ multiple: false });
      const files = picked && picked.files;
      if (!files || !files.length) return null;
      const file = files[0];
      const parts = [];
      let offset = 0;
      for (;;) {
        const chunk = await transfer.read(file.handleId, offset, 256 * 1024);
        if (chunk && chunk.dataBase64) parts.push(chunk.dataBase64);
        const length = (chunk && chunk.length) || 0;
        offset += length;
        if (!chunk || chunk.eof || !length) break;
        if (offset > 2 * 1024 * 1024) {
          if (typeof transfer.cancel === "function") await transfer.cancel(file.handleId);
          throw new Error("too-large");
        }
      }
      if (typeof transfer.cancel === "function") {
        try { await transfer.cancel(file.handleId); } catch (error) { /* handle already closed */ }
      }
      return { name: file.name || "environments.json", text: base64ToText(parts) };
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, text: String(reader.result || "") });
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      });
      input.click();
    });
  }

  async function copy(text) {
    if (plugin && plugin.copy) {
      try {
        await plugin.copy(text);
        return true;
      } catch (error) { /* fall back to the DOM path below */ }
    }
    return util.copyText(text);
  }

  function notifyLocale(value) {
    locale = HC.i18n.setLocale(value);
  }

  window.HC.bridge = {
    get backendReady() { return backendReady; },
    get backendError() { return backendError; },
    get locale() { return locale; },
    get appearance() { return appearance; },
    get context() { return context; },
    get contextDir() { return contextDir; },
    get hasHost() { return !!plugin; },
    ready,
    onEnv,
    onProgress,
    notifyLocale,
    invoke,
    send,
    cancel,
    readBody,
    saveBody,
    loadStore,
    saveStore,
    setStoreDir,
    saveTextFile,
    pickTextFile,
    copy,
    MAX_INVOKE_TIMEOUT
  };
})();
