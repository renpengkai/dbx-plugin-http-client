/* Workbench state: open tabs, collections, environments, history, persistence
   and {{variable}} resolution. Persistence prefers the native sidecar (a 0600
   file under the user config directory) and silently falls back to localStorage
   or pure memory. */

(function () {
  const util = HC.util;
  const t = (key, params) => HC.i18n.t(key, params);

  const STORAGE_KEY = "dbx-http-client/store";
  const HISTORY_LIMIT = 60;

  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"];

  const state = {
    tabs: [],
    activeTabId: "",
    collections: [],
    environments: [],
    history: [],
    activeEnvironmentId: "",
    settings: { sidebarWidth: 260, sidebarCollapsed: false, requestPercent: 45 },
    storePath: "",
    memoryOnly: true,
    sideView: "collections",
    loaded: false
  };

  const listeners = new Set();
  let persistTimer = null;

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(reason, payload) {
    listeners.forEach((listener) => {
      try { listener(reason, payload); } catch (error) { console.error(error); }
    });
  }

  /* --------------------------------------------------------- model factory -- */

  function emptyRequest() {
    return {
      id: util.uid("req"),
      name: t("tab.untitled"),
      method: "GET",
      url: "",
      headers: [],
      params: [],
      body: { mode: "none", raw: "", contentType: "application/json", fields: [] },
      auth: { type: "none", username: "", password: "", token: "", key: "", value: "", in: "header" },
      options: {
        timeoutMs: 30000,
        followRedirects: true,
        maxRedirects: 10,
        verifyTls: true,
        proxyMode: "environment",
        proxyUrl: "",
        maxBodyBytes: 33554432,
        progressEvents: true
      }
    };
  }

  function createTab(patch) {
    const tab = Object.assign(emptyRequest(), { section: "params" }, patch || {});
    tab.response = null;
    tab.sending = false;
    tab.savedRequestId = (patch && patch.savedRequestId) || "";
    tab.collectionId = (patch && patch.collectionId) || "";
    tab.dirty = false;
    state.tabs.push(tab);
    state.activeTabId = tab.id;
    persist();
    emit("tabs");
    return tab;
  }

  function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0] || null;
  }

  function setActiveTab(id) {
    if (!state.tabs.some((tab) => tab.id === id)) return;
    state.activeTabId = id;
    persist();
    emit("tabs");
  }

  function closeTab(id) {
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    state.tabs.splice(index, 1);
    if (!state.tabs.length) createTab();
    else if (state.activeTabId === id) state.activeTabId = state.tabs[Math.max(0, index - 1)].id;
    persist();
    emit("tabs");
  }

  function duplicateTab(id) {
    const source = state.tabs.find((tab) => tab.id === id);
    if (!source) return;
    const clone = JSON.parse(JSON.stringify(source));
    clone.id = util.uid("req");
    clone.name = `${source.name} 副本`;
    clone.response = null;
    clone.sending = false;
    clone.dirty = true;
    state.tabs.push(clone);
    state.activeTabId = clone.id;
    persist();
    emit("tabs");
  }

  function markDirty(tab) {
    if (tab) tab.dirty = true;
    schedulePersist();
    emit("tab-dirty", tab);
  }

  /* ------------------------------------------------------------ collections */

  function createCollection(name) {
    const collection = { id: util.uid("col"), name: name || t("misc.untitledCollection"), requests: [] };
    state.collections.push(collection);
    persist();
    emit("sidebar");
    return collection;
  }

  function requestTitle(tab) {
    if (tab.name && tab.name !== t("tab.untitled")) return tab.name;
    if (!tab.url) return t("tab.untitled");
    try {
      const parsed = new URL(tab.url);
      return `${parsed.pathname}${parsed.search}` || parsed.host;
    } catch (error) {
      return tab.url.slice(0, 40);
    }
  }

  function saveRequestTo(collectionId, tab, name) {
    let collection = state.collections.find((item) => item.id === collectionId);
    if (!collection) collection = createCollection(t("misc.untitledCollection"));
    const snapshot = snapshotRequest(tab, name);
    if (tab.collectionId === collection.id && tab.savedRequestId) {
      const index = collection.requests.findIndex((item) => item.id === tab.savedRequestId);
      if (index >= 0) collection.requests[index] = snapshot;
      else collection.requests.push(snapshot);
    } else {
      collection.requests.push(snapshot);
    }
    tab.collectionId = collection.id;
    tab.savedRequestId = snapshot.id;
    tab.name = snapshot.name;
    tab.dirty = false;
    persist();
    emit("sidebar");
    emit("tabs");
    return snapshot;
  }

  function snapshotRequest(tab, name) {
    return {
      id: tab.savedRequestId || util.uid("saved"),
      name: name || requestTitle(tab),
      method: tab.method,
      url: tab.url,
      headers: JSON.parse(JSON.stringify(tab.headers || [])),
      params: JSON.parse(JSON.stringify(tab.params || [])),
      body: JSON.parse(JSON.stringify(tab.body || {})),
      auth: JSON.parse(JSON.stringify(tab.auth || {})),
      options: JSON.parse(JSON.stringify(tab.options || {}))
    };
  }

  function openSavedRequest(collectionId, requestId) {
    const collection = state.collections.find((item) => item.id === collectionId);
    if (!collection) return;
    const saved = collection.requests.find((item) => item.id === requestId);
    if (!saved) return;
    const existing = state.tabs.find((tab) => tab.savedRequestId === saved.id);
    if (existing) { setActiveTab(existing.id); return; }
    const tab = createTab({
      name: saved.name, method: saved.method, url: saved.url,
      headers: JSON.parse(JSON.stringify(saved.headers || [])),
      params: JSON.parse(JSON.stringify(saved.params || [])),
      body: Object.assign({ mode: "none", raw: "", fields: [] }, JSON.parse(JSON.stringify(saved.body || {}))),
      auth: Object.assign({ type: "none" }, JSON.parse(JSON.stringify(saved.auth || {}))),
      options: Object.assign(emptyRequest().options, saved.options || {}),
      collectionId, savedRequestId: saved.id
    });
    tab.dirty = false;
    emit("request");
  }

  function deleteSavedRequest(collectionId, requestId) {
    const collection = state.collections.find((item) => item.id === collectionId);
    if (!collection) return;
    collection.requests = collection.requests.filter((item) => item.id !== requestId);
    state.tabs.forEach((tab) => {
      if (tab.savedRequestId === requestId) { tab.savedRequestId = ""; tab.collectionId = ""; tab.dirty = true; }
    });
    persist();
    emit("sidebar");
    emit("tabs");
  }

  function deleteCollection(collectionId) {
    state.collections = state.collections.filter((item) => item.id !== collectionId);
    state.tabs.forEach((tab) => {
      if (tab.collectionId === collectionId) { tab.collectionId = ""; tab.savedRequestId = ""; tab.dirty = true; }
    });
    persist();
    emit("sidebar");
    emit("tabs");
  }

  function renameCollection(collectionId, name) {
    const collection = state.collections.find((item) => item.id === collectionId);
    if (!collection) return;
    collection.name = name;
    persist();
    emit("sidebar");
  }

  /* --------------------------------------------------------------- history -- */

  function pushHistory(tab, result) {
    if (!tab.url) return;
    state.history.unshift({
      id: util.uid("hist"),
      at: new Date().toISOString(),
      method: tab.method,
      url: tab.url,
      status: result && result.status ? result.status : 0,
      ok: !!(result && result.ok),
      durationMs: (result && result.durationMs) || 0,
      snapshot: snapshotRequest(tab, requestTitle(tab))
    });
    if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
    persist();
    emit("sidebar");
  }

  function clearHistory() {
    state.history = [];
    persist();
    emit("sidebar");
  }

  function openHistoryEntry(id) {
    const entry = state.history.find((item) => item.id === id);
    if (!entry) return;
    const saved = entry.snapshot;
    createTab({
      name: requestTitle(saved), method: saved.method, url: saved.url,
      headers: JSON.parse(JSON.stringify(saved.headers || [])),
      params: JSON.parse(JSON.stringify(saved.params || [])),
      body: JSON.parse(JSON.stringify(saved.body || {})),
      auth: JSON.parse(JSON.stringify(saved.auth || {})),
      options: Object.assign(emptyRequest().options, saved.options || {})
    });
    emit("request");
  }

  /* ---------------------------------------------------------- environments -- */

  function createEnvironment(name) {
    const environment = { id: util.uid("env"), name: name || t("misc.environment"), variables: [util.emptyRow()] };
    state.environments.push(environment);
    if (!state.activeEnvironmentId) state.activeEnvironmentId = environment.id;
    persist();
    emit("environments");
    return environment;
  }

  function deleteEnvironment(id) {
    state.environments = state.environments.filter((item) => item.id !== id);
    if (state.activeEnvironmentId === id) state.activeEnvironmentId = (state.environments[0] || {}).id || "";
    persist();
    emit("environments");
  }

  function activeEnvironment() {
    return state.environments.find((item) => item.id === state.activeEnvironmentId) || null;
  }

  function setActiveEnvironment(id) {
    state.activeEnvironmentId = id;
    persist();
    emit("environments");
    emit("request");
  }

  /* ------------------------------------------------------------ variables -- */

  function variableMap() {
    const map = {};
    const environment = activeEnvironment();
    if (environment) {
      (environment.variables || []).forEach((row) => {
        if (row.enabled === false || !row.key) return;
        map[row.key] = row.value;
      });
    }
    return map;
  }

  function dynamicVariable(name) {
    switch (name) {
      case "$uuid": return (crypto.randomUUID ? crypto.randomUUID() : util.uid("uuid"));
      case "$timestamp": return String(Math.floor(Date.now() / 1000));
      case "$isoTimestamp": return new Date().toISOString();
      case "$randomInt": return String(Math.floor(Math.random() * 1000));
      case "$randomFloat": return (Math.random() * 1000).toFixed(6);
      case "$randomBoolean": return Math.random() > 0.5 ? "true" : "false";
      case "$randomString": return Math.random().toString(36).slice(2, 12);
      default: return null;
    }
  }

  function resolve(text, vars) {
    if (!text) return text;
    const table = vars || variableMap();
    return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawName) => {
      const name = rawName.trim();
      if (name.startsWith("$")) {
        const value = dynamicVariable(name);
        return value === null ? match : value;
      }
      return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : match;
    });
  }

  function unresolvedVariables(text, vars) {
    if (!text) return [];
    const table = vars || variableMap();
    const missing = [];
    String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawName) => {
      const name = rawName.trim();
      if (name.startsWith("$")) return match;
      if (!Object.prototype.hasOwnProperty.call(table, name) && missing.indexOf(name) < 0) missing.push(name);
      return match;
    });
    return missing;
  }

  function activeRows(rows) {
    return (rows || []).filter((row) => row && row.enabled !== false && String(row.key || "").trim() !== "");
  }

  /* Builds the RPC payload for the sidecar with every variable resolved. */
  function buildSpec(tab, requestId) {
    const vars = variableMap();
    const resolveText = (value) => resolve(value, vars);
    const spec = {
      requestId,
      method: tab.method,
      url: resolveText(tab.url).trim(),
      headers: activeRows(tab.headers).map((row) => ({ key: resolveText(row.key), value: resolveText(row.value), enabled: true })),
      body: { mode: tab.body.mode, raw: "", contentType: "", fields: [] },
      auth: {
        type: tab.auth.type,
        username: resolveText(tab.auth.username),
        password: resolveText(tab.auth.password),
        token: resolveText(tab.auth.token),
        key: resolveText(tab.auth.key),
        value: resolveText(tab.auth.value),
        in: tab.auth.in
      },
      options: {
        timeoutMs: Number(tab.options.timeoutMs) || 30000,
        followRedirects: tab.options.followRedirects !== false,
        maxRedirects: Number(tab.options.maxRedirects) || 10,
        verifyTls: tab.options.verifyTls !== false,
        maxBodyBytes: Number(tab.options.maxBodyBytes) || 33554432,
        progressEvents: true,
        proxyMode: tab.options.proxyMode || "environment",
        proxyUrl: resolveText(tab.options.proxyUrl)
      }
    };
    if (tab.body.mode === "raw") {
      spec.body.raw = resolveText(tab.body.raw);
      spec.body.contentType = tab.body.contentType || "";
    } else if (tab.body.mode === "urlencoded" || tab.body.mode === "formdata") {
      spec.body.fields = activeRows(tab.body.fields).map((row) => ({
        key: resolveText(row.key),
        value: row.kind === "file" ? "" : resolveText(row.value),
        kind: row.kind === "file" ? "file" : "text",
        fileName: row.fileName || "",
        dataBase64: row.dataBase64 || ""
      }));
    }
    return spec;
  }

  function collectMissingVariables(tab) {
    const vars = variableMap();
    const parts = [tab.url];
    (tab.headers || []).forEach((row) => { if (row.enabled !== false) parts.push(row.key, row.value); });
    if (tab.body.mode === "raw") parts.push(tab.body.raw);
    (tab.body.fields || []).forEach((row) => { if (row.enabled !== false) parts.push(row.key, row.value); });
    Object.keys(tab.auth || {}).forEach((key) => parts.push(tab.auth[key]));
    const missing = new Set();
    parts.forEach((part) => unresolvedVariables(part, vars).forEach((name) => missing.add(name)));
    return Array.from(missing);
  }

  /* ----------------------------------------------------------- persistence -- */

  function serializable() {
    return {
      version: 1,
      collections: state.collections,
      environments: state.environments,
      activeEnvironmentId: state.activeEnvironmentId,
      history: state.history,
      settings: state.settings,
      tabs: state.tabs.map((tab) => ({
        name: tab.name, method: tab.method, url: tab.url, headers: tab.headers, params: tab.params,
        body: tab.body, auth: tab.auth, options: tab.options, collectionId: tab.collectionId,
        savedRequestId: tab.savedRequestId, section: tab.section
      }))
    };
  }

  function hydrate(document) {
    if (!document || typeof document !== "object") return;
    if (Array.isArray(document.collections)) state.collections = document.collections;
    if (Array.isArray(document.environments)) state.environments = document.environments;
    if (Array.isArray(document.history)) state.history = document.history;
    if (document.activeEnvironmentId) state.activeEnvironmentId = document.activeEnvironmentId;
    if (document.settings) Object.assign(state.settings, document.settings);
    if (document.storePath) state.storePath = document.storePath;
    if (Array.isArray(document.tabs) && document.tabs.length) {
      document.tabs.forEach((saved) => {
        const tab = Object.assign(emptyRequest(), saved);
        tab.id = util.uid("req");
        tab.response = null;
        tab.sending = false;
        tab.dirty = false;
        tab.section = saved.section || "params";
        state.tabs.push(tab);
      });
      state.activeTabId = state.tabs[0].id;
    }
  }

  function writeLocalCache() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable()));
    } catch (error) { /* opaque origin or quota exceeded: the sidecar is the source of truth */ }
  }

  function readLocalCache() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 700);
  }

  async function persist() {
    clearTimeout(persistTimer);
    const document = serializable();
    writeLocalCache();
    if (!HC.bridge.backendReady) {
      state.memoryOnly = true;
      return;
    }
    try {
      const result = await HC.bridge.saveStore(document);
      state.memoryOnly = false;
      state.storePath = result.path || state.storePath;
    } catch (error) {
      state.memoryOnly = true;
    }
  }

  async function init() {
    hydrate(readLocalCache());
    if (HC.bridge.backendReady) {
      try {
        const result = await HC.bridge.loadStore();
        state.storePath = result.path || "";
        state.memoryOnly = false;
        if (result.store) {
          state.tabs = [];
          state.collections = [];
          state.environments = [];
          state.history = [];
          state.activeEnvironmentId = "";
          hydrate(result.store);
        }
      } catch (error) {
        state.memoryOnly = true;
      }
    } else {
      state.memoryOnly = true;
    }
    if (!state.collections.length) {
      const collection = createCollection(t("misc.untitledCollection"));
      collection.requests = [];
    }
    if (!state.tabs.length) createTab();
    state.loaded = true;
    emit("loaded");
    emit("tabs");
    emit("sidebar");
    emit("environments");
  }

  window.HC.store = {
    state, METHODS, subscribe, emit, init, persist, schedulePersist,
    createTab, activeTab, setActiveTab, closeTab, duplicateTab, markDirty,
    emptyRequest, snapshotRequest, requestTitle,
    createCollection, renameCollection, deleteCollection,
    saveRequestTo, openSavedRequest, deleteSavedRequest,
    pushHistory, clearHistory, openHistoryEntry,
    createEnvironment, deleteEnvironment, activeEnvironment, setActiveEnvironment,
    variableMap, resolve, unresolvedVariables, collectMissingVariables, buildSpec,
    serializable, hydrate
  };
})();
