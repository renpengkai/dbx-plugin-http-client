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
    tab.folderId = (patch && patch.folderId) || "";
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

  /* A collection is a tree. `items` holds requests and folders; folders nest
     the same way. Documents saved before 0.1.2 used a flat `requests` array
     (and, if present, a `folders` array). migrateCollection folds both into
     `items` so existing workbenches keep every saved request. */

  function migrateCollections(collections) {
    return (collections || []).map(migrateCollection).filter(Boolean);
  }

  function migrateCollection(collection) {
    if (!collection || typeof collection !== "object" || Array.isArray(collection)) return null;
    const node = {
      id: collection.id || util.uid("col"),
      name: collection.name || t("misc.untitledCollection"),
      collapsed: !!collection.collapsed,
      items: []
    };
    if (Array.isArray(collection.items)) {
      collection.items.forEach((item) => {
        const migrated = migrateNode(item);
        if (migrated) node.items.push(migrated);
      });
      return node;
    }
    (collection.folders || []).forEach((folder) => {
      const migrated = migrateNode(Object.assign({ kind: "folder" }, folder));
      if (migrated) node.items.push(migrated);
    });
    (collection.requests || []).forEach((request) => {
      const migrated = migrateNode(Object.assign({ kind: "request" }, request));
      if (migrated) node.items.push(migrated);
    });
    return node;
  }

  function migrateNode(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    const explicit = node.kind === "folder" || node.kind === "request" ? node.kind : "";
    const looksFolder = explicit === "folder" || (
      !explicit && !node.method && node.url === undefined &&
      (Array.isArray(node.items) || Array.isArray(node.folders) || Array.isArray(node.requests))
    );
    if (looksFolder) {
      const folder = {
        kind: "folder",
        id: node.id || util.uid("folder"),
        name: node.name || t("misc.untitledFolder"),
        collapsed: !!node.collapsed,
        items: []
      };
      if (Array.isArray(node.items)) {
        node.items.forEach((child) => {
          const migrated = migrateNode(child);
          if (migrated) folder.items.push(migrated);
        });
      } else {
        (node.folders || []).forEach((child) => {
          const migrated = migrateNode(Object.assign({ kind: "folder" }, child));
          if (migrated) folder.items.push(migrated);
        });
        (node.requests || []).forEach((child) => {
          const migrated = migrateNode(Object.assign({ kind: "request" }, child));
          if (migrated) folder.items.push(migrated);
        });
      }
      return folder;
    }
    return {
      kind: "request",
      id: node.id || util.uid("saved"),
      name: node.name || t("tab.untitled"),
      method: node.method || "GET",
      url: node.url || "",
      headers: node.headers || [],
      params: node.params || [],
      body: node.body || { mode: "none", raw: "", fields: [] },
      auth: node.auth || { type: "none" },
      options: node.options || {}
    };
  }

  function eachNode(items, visitor, parent) {
    const list = items || [];
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      if (!item) continue;
      if (visitor(item, list, index, parent || null)) return true;
      if (item.kind === "folder" && eachNode(item.items, visitor, item)) return true;
    }
    return false;
  }

  function locate(itemId) {
    if (!itemId) return null;
    for (let index = 0; index < state.collections.length; index += 1) {
      const collection = state.collections[index];
      let found = null;
      eachNode(collection.items, (item, list, itemIndex, parent) => {
        if (item.id === itemId) {
          found = { collection, list, index: itemIndex, item, parent };
          return true;
        }
        return false;
      });
      if (found) return found;
    }
    return null;
  }

  function folderItems(collection, folderId) {
    if (!collection) return null;
    if (!folderId) return collection.items;
    const located = locate(folderId);
    if (!located || located.item.kind !== "folder" || located.collection.id !== collection.id) return null;
    if (!Array.isArray(located.item.items)) located.item.items = [];
    return located.item.items;
  }

  function containsId(item, id) {
    if (!item || item.kind !== "folder" || !id) return false;
    let yes = false;
    eachNode(item.items, (child) => {
      if (child.id === id) { yes = true; return true; }
      return false;
    });
    return yes;
  }

  function folderContains(ancestorFolderId, nodeId) {
    const located = locate(ancestorFolderId);
    if (!located || located.item.kind !== "folder") return false;
    return containsId(located.item, nodeId);
  }

  function countRequests(items) {
    return countTree(items).requests;
  }

  function countTree(items) {
    const counts = { folders: 0, requests: 0 };
    eachNode(items, (item) => {
      if (item.kind === "folder") counts.folders += 1;
      else if (item.kind === "request") counts.requests += 1;
      return false;
    });
    return counts;
  }

  function requestIdsUnder(item) {
    const ids = [];
    if (!item) return ids;
    if (item.kind === "request") {
      ids.push(item.id);
      return ids;
    }
    eachNode(item.items || item, (child) => {
      if (child.kind === "request") ids.push(child.id);
      return false;
    });
    return ids;
  }

  function detachTabs(ids) {
    const set = {};
    (ids || []).forEach((id) => { set[id] = true; });
    state.tabs.forEach((tab) => {
      if (set[tab.savedRequestId]) {
        tab.savedRequestId = "";
        tab.collectionId = "";
        tab.folderId = "";
        tab.dirty = true;
      }
    });
  }

  function listFolders(collectionId) {
    const collection = state.collections.find((item) => item.id === collectionId);
    if (!collection) return [];
    const out = [];
    const walk = (items, prefix) => {
      (items || []).forEach((item) => {
        if (item.kind !== "folder") return;
        const path = prefix ? `${prefix} / ${item.name}` : item.name;
        out.push({ id: item.id, name: item.name, path });
        walk(item.items, path);
      });
    };
    walk(collection.items, "");
    return out;
  }

  function createCollection(name) {
    const collection = {
      id: util.uid("col"),
      name: name || t("misc.untitledCollection"),
      collapsed: false,
      items: []
    };
    state.collections.push(collection);
    persist();
    emit("sidebar");
    return collection;
  }

  function createFolder(collectionId, parentId, name) {
    const collection = state.collections.find((item) => item.id === collectionId);
    if (!collection) return null;
    const items = folderItems(collection, parentId);
    if (!items) return null;
    const folder = {
      kind: "folder",
      id: util.uid("folder"),
      name: name || t("misc.untitledFolder"),
      collapsed: false,
      items: []
    };
    items.push(folder);
    collection.collapsed = false;
    if (parentId) {
      const parent = locate(parentId);
      if (parent && parent.item.kind === "folder") parent.item.collapsed = false;
    }
    persist();
    emit("sidebar");
    return folder;
  }

  function toggleCollapsed(id) {
    const collection = state.collections.find((item) => item.id === id);
    if (collection) collection.collapsed = !collection.collapsed;
    else {
      const located = locate(id);
      if (!located || located.item.kind !== "folder") return;
      located.item.collapsed = !located.item.collapsed;
    }
    persist();
    emit("sidebar");
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

  function saveRequestTo(collectionId, tab, name, folderId) {
    let collection = state.collections.find((item) => item.id === collectionId);
    if (!collection) collection = createCollection(t("misc.untitledCollection"));
    if (!Array.isArray(collection.items)) collection.items = [];
    const targetFolderId = folderId === undefined ? (tab.folderId || "") : (folderId || "");
    const snapshot = snapshotRequest(tab, name);
    snapshot.kind = "request";
    let items = folderItems(collection, targetFolderId);
    let resolvedFolder = targetFolderId;
    if (!items) {
      items = collection.items;
      resolvedFolder = "";
    }
    const existing = tab.savedRequestId ? locate(tab.savedRequestId) : null;
    const samePlace = existing && existing.item.kind === "request" &&
      existing.collection.id === collection.id &&
      ((existing.parent && existing.parent.id) || "") === resolvedFolder;
    if (samePlace) existing.list[existing.index] = snapshot;
    else {
      if (existing && existing.item.kind === "request") existing.list.splice(existing.index, 1);
      items.push(snapshot);
    }
    tab.collectionId = collection.id;
    tab.folderId = resolvedFolder;
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
    let located = null;
    const hinted = state.collections.find((item) => item.id === collectionId);
    if (hinted) {
      eachNode(hinted.items, (item, list, index, parent) => {
        if (item.kind === "request" && item.id === requestId) {
          located = { collection: hinted, item, parent };
          return true;
        }
        return false;
      });
    }
    if (!located) {
      const found = locate(requestId);
      if (found && found.item.kind === "request") located = found;
    }
    if (!located) return;
    const saved = located.item;
    const existing = state.tabs.find((tab) => tab.savedRequestId === saved.id);
    if (existing) { setActiveTab(existing.id); return; }
    const tab = createTab({
      name: saved.name, method: saved.method, url: saved.url,
      headers: JSON.parse(JSON.stringify(saved.headers || [])),
      params: JSON.parse(JSON.stringify(saved.params || [])),
      body: Object.assign({ mode: "none", raw: "", fields: [] }, JSON.parse(JSON.stringify(saved.body || {}))),
      auth: Object.assign({ type: "none" }, JSON.parse(JSON.stringify(saved.auth || {}))),
      options: Object.assign(emptyRequest().options, saved.options || {}),
      collectionId: located.collection.id,
      folderId: located.parent ? located.parent.id : "",
      savedRequestId: saved.id
    });
    tab.dirty = false;
    emit("request");
  }

  function deleteSavedRequest(collectionId, requestId) {
    const located = locate(requestId);
    if (!located || located.item.kind !== "request") return;
    if (collectionId && located.collection.id !== collectionId) return;
    located.list.splice(located.index, 1);
    detachTabs([requestId]);
    persist();
    emit("sidebar");
    emit("tabs");
  }

  function deleteFolder(folderId) {
    const located = locate(folderId);
    if (!located || located.item.kind !== "folder") return;
    const ids = requestIdsUnder(located.item);
    located.list.splice(located.index, 1);
    detachTabs(ids);
    persist();
    emit("sidebar");
    emit("tabs");
  }

  function deleteCollection(collectionId) {
    const collection = state.collections.find((item) => item.id === collectionId);
    if (!collection) return;
    const ids = requestIdsUnder({ kind: "folder", items: collection.items });
    state.collections = state.collections.filter((item) => item.id !== collectionId);
    detachTabs(ids);
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

  function renameFolder(folderId, name) {
    const located = locate(folderId);
    if (!located || located.item.kind !== "folder") return;
    located.item.name = name;
    persist();
    emit("sidebar");
  }

  function moveItem(itemId, targetCollectionId, targetFolderId) {
    const located = locate(itemId);
    const target = state.collections.find((item) => item.id === targetCollectionId);
    if (!located || !target || located.item.kind === undefined) return false;
    const folderId = targetFolderId || "";
    if (located.item.kind === "folder") {
      if (folderId === located.item.id || (folderId && containsId(located.item, folderId))) return false;
    }
    const dest = folderItems(target, folderId);
    if (!dest) return false;
    if (dest === located.list && located.parent && (located.parent.id || "") === folderId) {
      /* already in this folder; still allow a no-op success */
    }
    located.list.splice(located.index, 1);
    dest.push(located.item);
    if (located.item.kind === "request") {
      state.tabs.forEach((tab) => {
        if (tab.savedRequestId === located.item.id) {
          tab.collectionId = target.id;
          tab.folderId = folderId;
        }
      });
    } else {
      const ids = {};
      requestIdsUnder(located.item).forEach((id) => { ids[id] = true; });
      state.tabs.forEach((tab) => {
        if (ids[tab.savedRequestId]) tab.collectionId = target.id;
      });
    }
    target.collapsed = false;
    if (folderId) {
      const parent = locate(folderId);
      if (parent && parent.item.kind === "folder") parent.item.collapsed = false;
    }
    persist();
    emit("sidebar");
    emit("tabs");
    return true;
  }

  function rekeyItems(items) {
    (items || []).forEach((item) => {
      item.id = util.uid(item.kind === "folder" ? "folder" : "saved");
      if (item.kind === "folder") rekeyItems(item.items);
    });
  }

  function importCollection(raw) {
    const migrated = migrateCollection(raw);
    if (!migrated) return null;
    migrated.id = util.uid("col");
    rekeyItems(migrated.items);
    state.collections.push(migrated);
    return migrated;
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
        contentType: row.kind === "file" ? (row.contentType || "") : "",
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
      version: 2,
      collections: state.collections,
      environments: state.environments,
      activeEnvironmentId: state.activeEnvironmentId,
      history: state.history,
      settings: state.settings,
      tabs: state.tabs.map((tab) => ({
        name: tab.name, method: tab.method, url: tab.url, headers: tab.headers, params: tab.params,
        body: tab.body, auth: tab.auth, options: tab.options, collectionId: tab.collectionId,
        folderId: tab.folderId || "", savedRequestId: tab.savedRequestId, section: tab.section
      }))
    };
  }

  function hydrate(document) {
    if (!document || typeof document !== "object") return;
    if (Array.isArray(document.collections)) state.collections = migrateCollections(document.collections);
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
        tab.folderId = saved.folderId || "";
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
    const cached = readLocalCache();
    let sawDocument = !!cached;
    hydrate(cached);
    if (HC.bridge.backendReady) {
      try {
        const result = await HC.bridge.loadStore();
        state.storePath = result.path || "";
        state.memoryOnly = false;
        if (result && result.exists) sawDocument = true;
        if (result.store) {
          state.tabs = [];
          state.collections = [];
          state.environments = [];
          state.history = [];
          state.activeEnvironmentId = "";
          hydrate(result.store);
          sawDocument = true;
        }
      } catch (error) {
        state.memoryOnly = true;
      }
    } else {
      state.memoryOnly = true;
    }
    // A brand-new profile gets one empty collection. A store that already
    // exists — even with an empty collection list — is left alone, so deleting
    // the last collection stays deleted.
    if (!state.collections.length && !sawDocument) {
      createCollection(t("misc.untitledCollection"));
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
    createFolder, renameFolder, deleteFolder, toggleCollapsed,
    saveRequestTo, openSavedRequest, deleteSavedRequest,
    moveItem, listFolders, countRequests, countTree, locate, folderContains,
    importCollection, migrateCollection,
    pushHistory, clearHistory, openHistoryEntry,
    createEnvironment, deleteEnvironment, activeEnvironment, setActiveEnvironment,
    variableMap, resolve, unresolvedVariables, collectMissingVariables, buildSpec,
    serializable, hydrate
  };
})();
