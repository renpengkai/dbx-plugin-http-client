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
  let locale = "zh-CN";
  let appearance = "light";
  let context = {};

  const ready = (async () => {
    if (!plugin) {
      backendError = "no-host";
      return false;
    }
    try {
      await plugin.ready;
      context = plugin.context || {};
      locale = plugin.locale || locale;
      appearance = readAppearance(plugin.theme) || appearance;
      applyAppearance(appearance);
    } catch (error) {
      backendError = String((error && error.message) || error);
      return false;
    }
    if (plugin.onContext) plugin.onContext((next) => { context = next || {}; });
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

  function onEnv(listener) {
    const handler = (event) => {
      const detail = (event && event.detail) || {};
      if (detail.locale) locale = HC.i18n.setLocale(detail.locale);
      const next = readAppearance(detail.theme);
      if (next) applyAppearance(next);
      listener({ locale, appearance });
    };
    window.addEventListener("dbx-plugin-env", handler);
    return () => window.removeEventListener("dbx-plugin-env", handler);
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

  async function saveStore(store) {
    return invoke("store/save", { store }, 20000);
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
    locale = value || locale;
  }

  window.HC.bridge = {
    get backendReady() { return backendReady; },
    get backendError() { return backendError; },
    get locale() { return locale; },
    get appearance() { return appearance; },
    get context() { return context; },
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
    copy,
    MAX_INVOKE_TIMEOUT
  };
})();
