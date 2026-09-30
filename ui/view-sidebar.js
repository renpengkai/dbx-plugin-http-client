/* Sidebar: collections, history and environment/variable management. */

(function () {
  const util = HC.util;
  const store = HC.store;
  const t = (key, params) => HC.i18n.t(key, params);
  const el = util.el;

  function render() {
    wireSearch();
    renderActions();
    const host = util.clear(util.$("#sidebar-body"));
    const view = store.state.sideView;
    if (view === "collections") renderCollections(host);
    else if (view === "history") renderHistory(host);
    else renderEnvironments(host);
  }

  function renderActions() {
    const host = util.clear(util.$("#sidebar-actions"));
    const view = store.state.sideView;
    if (view === "collections") {
      host.append(el("button", {
        class: "hc-btn hc-btn-sm", type: "button", text: `+ ${t("action.newCollection")}`,
        on: {
          click: async () => {
            const name = await util.promptDialog({ title: t("dialog.newCollectionTitle"), label: t("dialog.name") });
            if (name) store.createCollection(name);
          }
        }
      }));
      host.append(el("button", {
        class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("action.import"),
        on: { click: openImportDialog }
      }));
    } else if (view === "history") {
      host.append(el("button", {
        class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("action.clearHistory"),
        disabled: !store.state.history.length,
        on: {
          click: async () => {
            if (await util.confirmDialog({ title: t("action.clearHistory"), message: t("dialog.deleteMessage", { name: t("side.history") }) })) {
              store.clearHistory();
              util.toast(t("toast.historyCleared"));
            }
          }
        }
      }));
    } else {
      host.append(el("button", {
        class: "hc-btn hc-btn-sm", type: "button", text: `+ ${t("env.new")}`,
        on: {
          click: async () => {
            const name = await util.promptDialog({ title: t("env.new"), label: t("dialog.name") });
            if (name) store.createEnvironment(name);
          }
        }
      }));
      host.append(el("button", {
        class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("action.import"),
        on: { click: openEnvironmentImport }
      }));
      host.append(el("button", {
        class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("action.export"),
        on: { click: openEnvironmentExport }
      }));
    }
  }

  /* Search filters the collection tree without writing collapsed flags, so
     clearing the box restores the tree the user had expanded. */
  let searchQuery = "";

  function wireSearch() {
    const input = util.$("#sidebar-search-input");
    const wrap = util.$("#sidebar-search-wrap");
    if (wrap) wrap.hidden = store.state.sideView !== "collections";
    if (!input) return;
    input.placeholder = t("side.searchPlaceholder");
    input.setAttribute("aria-label", t("side.searchLabel"));
    if (input.dataset.wired) return;
    input.dataset.wired = "1";
    input.addEventListener("input", () => {
      searchQuery = input.value;
      render();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && input.value) {
        event.preventDefault();
        event.stopPropagation();
        input.value = "";
        searchQuery = "";
        render();
      }
    });
  }

  function focusSearch() {
    if (store.state.sideView !== "collections") {
      store.state.sideView = "collections";
      util.$$(".hc-side-tab").forEach((item) => item.classList.toggle("is-active", item.dataset.sideView === "collections"));
    }
    render();
    const input = util.$("#sidebar-search-input");
    if (!input) return;
    input.focus();
    input.select();
  }

  function queryText() {
    return searchQuery.trim().toLowerCase();
  }

  function nodeMatches(node, query) {
    if (!query) return true;
    const name = String((node && node.name) || "").toLowerCase();
    if (name.includes(query)) return true;
    if (node && node.kind === "request") {
      if (String(node.url || "").toLowerCase().includes(query)) return true;
      if (String(node.method || "").toLowerCase().includes(query)) return true;
    }
    return false;
  }

  function treeHasMatch(items, query) {
    return (items || []).some((item) => nodeMatches(item, query) || (item.kind === "folder" && treeHasMatch(item.items, query)));
  }

  function highlight(text, query) {
    const value = text == null ? "" : String(text);
    const span = el("span");
    const needle = query.trim().toLowerCase();
    if (!needle) {
      span.textContent = value;
      return span;
    }
    const lower = value.toLowerCase();
    let start = 0;
    let index = lower.indexOf(needle);
    if (index < 0) {
      span.textContent = value;
      return span;
    }
    while (index >= 0) {
      if (index > start) span.append(document.createTextNode(value.slice(start, index)));
      span.append(el("mark", { class: "hc-search-hit", text: value.slice(index, index + needle.length) }));
      start = index + needle.length;
      index = lower.indexOf(needle, start);
    }
    if (start < value.length) span.append(document.createTextNode(value.slice(start)));
    return span;
  }

  /* ----------------------------------------------------------- collections */

  function renderCollections(host) {
    const query = queryText();
    if (!store.state.collections.length) {
      host.append(el("div", { class: "hc-empty", text: t("side.emptyCollections") }));
      return;
    }
    let shown = 0;
    store.state.collections.forEach((collection) => {
      if (query && !nodeMatches(collection, query) && !treeHasMatch(collection.items, query)) return;
      shown += 1;
      host.append(renderCollection(collection, query));
    });
    if (!shown) host.append(el("div", { class: "hc-empty", text: t("side.searchEmpty") }));
  }

  function titleNode(name, query) {
    const node = highlight(name, query);
    node.classList.add("hc-grow", "hc-list-title");
    node.title = name || "";
    return node;
  }

  function renderCollection(collection, query) {
    const count = store.countRequests(collection.items);
    const searching = !!query;
    const collapsed = searching ? false : !!collection.collapsed;
    const group = el("div", {
      class: "hc-side-group",
      dataset: { nodeId: collection.id, kind: "collection" }
    });
    const head = el("div", {
      class: "hc-side-group-head",
      "aria-expanded": collapsed ? "false" : "true"
    }, [
      el("span", { class: "hc-chevron", text: collapsed ? "▸" : "▾" }),
      titleNode(collection.name, query),
      el("span", { class: "hc-badge", text: String(count) })
    ]);
    const menuItems = collectionMenu(collection);
    head.append(moreButton(menuItems));
    head.addEventListener("contextmenu", (event) => openContextMenu(event, menuItems, head));
    head.addEventListener("click", () => {
      if (queryText()) return;
      store.toggleCollapsed(collection.id);
    });
    group.append(head);
    group.append(renderItemList(collection, collection.items, collapsed, {
      query,
      ancestorMatched: searching && nodeMatches(collection, query)
    }));
    return group;
  }

  function renderItemList(collection, items, collapsed, search) {
    const body = el("div", { class: "hc-side-group-body", hidden: collapsed });
    const query = (search && search.query) || "";
    const ancestorMatched = !!(search && search.ancestorMatched);
    const visible = (items || []).filter((item) => {
      if (!query || ancestorMatched) return true;
      return nodeMatches(item, query) || (item.kind === "folder" && treeHasMatch(item.items, query));
    });
    if (!visible.length) {
      body.append(el("div", { class: "hc-hint", text: query ? t("side.searchEmpty") : t("side.noRequests") }));
      return body;
    }
    visible.forEach((item) => {
      if (item.kind === "folder") body.append(renderFolder(collection, item, search));
      else body.append(renderSavedRequest(collection, item, query));
    });
    return body;
  }

  function renderFolder(collection, folder, search) {
    const query = (search && search.query) || "";
    const searching = !!query;
    const collapsed = searching ? false : !!folder.collapsed;
    const group = el("div", {
      class: "hc-side-group hc-tree-folder",
      dataset: { nodeId: folder.id, kind: "folder" }
    });
    const head = el("div", {
      class: "hc-side-group-head",
      "aria-expanded": collapsed ? "false" : "true"
    }, [
      el("span", { class: "hc-chevron", text: collapsed ? "▸" : "▾" }),
      titleNode(folder.name, query),
      el("span", { class: "hc-badge", text: String(store.countRequests(folder.items)) })
    ]);
    const menuItems = folderMenu(collection, folder);
    head.append(moreButton(menuItems));
    head.addEventListener("contextmenu", (event) => openContextMenu(event, menuItems, head));
    head.addEventListener("click", () => {
      if (queryText()) return;
      store.toggleCollapsed(folder.id);
    });
    group.append(head);
    const nested = renderItemList(collection, folder.items, collapsed, {
      query,
      ancestorMatched: !!(search && search.ancestorMatched) || (searching && nodeMatches(folder, query))
    });
    if (!query && (!folder.items || !folder.items.length)) {
      util.clear(nested);
      nested.append(el("div", { class: "hc-hint", text: t("side.emptyFolder") }));
    }
    group.append(nested);
    return group;
  }

  function requestIsDirty(savedId) {
    return store.state.tabs.some((tab) => tab.savedRequestId === savedId && tab.dirty);
  }

  function renderSavedRequest(collection, saved, query) {
    const active = store.activeTab() && store.activeTab().savedRequestId === saved.id;
    const name = titleNode(saved.name, query || "");
    name.classList.remove("hc-grow");
    const url = highlight(saved.url || "", query || "");
    url.classList.add("hc-list-sub");
    url.title = saved.url || "";
    const methodHit = query && String(saved.method || "").toLowerCase().includes(query);
    const item = el("div", {
      class: `hc-list-item${active ? " is-active" : ""}`,
      dataset: { nodeId: saved.id, kind: "request" },
      title: saved.url ? `${saved.name}\n${saved.url}` : saved.name
    }, [
      el("span", { class: `hc-tag m-${saved.method}${methodHit ? " hc-search-hit" : ""}`, text: saved.method }),
      el("div", { class: "hc-grow" }, [name, url]),
      el("span", { class: "hc-dirty-dot", title: t("tab.unsaved"), hidden: !requestIsDirty(saved.id) })
    ]);
    const menuItems = requestMenu(collection, saved);
    item.append(moreButton(menuItems));
    item.addEventListener("contextmenu", (event) => openContextMenu(event, menuItems, item));
    item.addEventListener("click", (event) => {
      if (event.target.closest(".hc-list-actions")) return;
      store.openSavedRequest(collection.id, saved.id);
      HC.viewRequest.render();
      HC.viewResponse.render();
    });
    return item;
  }

  function moreButton(items) {
    return el("div", { class: "hc-list-actions" }, [
      el("button", {
        class: "hc-icon-btn hc-more-btn",
        type: "button",
        text: "⋯",
        title: t("action.more"),
        "aria-label": t("action.more"),
        "aria-haspopup": "menu",
        "data-action": "more",
        on: {
          click: (event) => {
            event.preventDefault();
            event.stopPropagation();
            const row = event.currentTarget.closest(".hc-side-group-head, .hc-list-item");
            if (row && row.classList.contains("is-menu-open")) {
              closeContextMenu();
              return;
            }
            openContextMenu(event, items, row);
          }
        }
      })
    ]);
  }

  async function promptFolder(collectionId, parentId) {
    const name = await util.promptDialog({ title: t("dialog.newSubcollectionTitle"), label: t("dialog.name") });
    if (name) store.createFolder(collectionId, parentId, name);
  }

  function collectionMenu(collection) {
    return [
      { action: "new-subcollection", label: t("action.newSubcollection"), onClick: () => promptFolder(collection.id, "") },
      { action: "rename", label: t("action.rename"), onClick: async () => {
        const name = await util.promptDialog({ title: t("dialog.renameTitle"), value: collection.name });
        if (name) store.renameCollection(collection.id, name);
      } },
      { action: "export", label: t("action.export"), onClick: () => openExportDialog(collection) },
      { action: "delete", label: t("action.delete"), danger: true, onClick: () => confirmDeleteCollection(collection) }
    ];
  }

  function folderMenu(collection, folder) {
    return [
      { action: "new-subcollection", label: t("action.newSubcollection"), onClick: () => promptFolder(collection.id, folder.id) },
      { action: "rename", label: t("action.rename"), onClick: async () => {
        const name = await util.promptDialog({ title: t("dialog.renameTitle"), value: folder.name });
        if (name) store.renameFolder(folder.id, name);
      } },
      { action: "move", label: t("action.move"), onClick: () => openMoveDialog(folder, collection.id) },
      { action: "delete", label: t("action.delete"), danger: true, onClick: () => confirmDeleteFolder(folder) }
    ];
  }

  function requestMenu(collection, saved) {
    return [
      { action: "move", label: t("action.move"), onClick: () => openMoveDialog(saved, collection.id) },
      { action: "duplicate", label: t("action.duplicate"), onClick: () => {
        store.openSavedRequest(collection.id, saved.id);
        const tab = store.activeTab();
        tab.savedRequestId = "";
        tab.collectionId = "";
        tab.folderId = "";
        HC.viewRequest.render();
        HC.viewResponse.render();
      } },
      { action: "delete", label: t("action.delete"), danger: true, onClick: async () => {
        if (await util.confirmDialog({ title: t("dialog.deleteTitle"), message: t("dialog.deleteMessage", { name: saved.name }) })) {
          store.deleteSavedRequest(collection.id, saved.id);
          util.toast(t("toast.deleted"));
        }
      } }
    ];
  }

  let contextMenuNode = null;
  let contextMenuAnchor = null;

  function closeContextMenu() {
    if (contextMenuAnchor) {
      contextMenuAnchor.classList.remove("is-menu-open");
      contextMenuAnchor = null;
    }
    if (contextMenuNode) {
      contextMenuNode.remove();
      contextMenuNode = null;
    }
  }

  function openContextMenu(event, items, anchor) {
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
    const menu = el("div", { class: "hc-context-menu", id: "hc-context-menu", role: "menu" });
    items.forEach((item) => {
      const button = el("button", {
        type: "button",
        class: `hc-context-item${item.danger ? " is-danger" : ""}`,
        role: "menuitem",
        on: { click: (clickEvent) => { clickEvent.stopPropagation(); closeContextMenu(); item.onClick(); } }
      }, [el("span", { text: item.label })]);
      if (item.action) button.dataset.action = item.action;
      menu.append(button);
    });
    document.body.append(menu);
    const width = Math.max(168, menu.offsetWidth || 180);
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - (items.length * 32 + 12)));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    contextMenuNode = menu;
    if (anchor) {
      anchor.classList.add("is-menu-open");
      contextMenuAnchor = anchor;
    }
  }

  document.addEventListener("click", () => closeContextMenu());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeContextMenu(); });

  async function confirmDeleteCollection(collection) {
    const counts = store.countTree(collection.items);
    const message = (counts.folders || counts.requests)
      ? t("dialog.deleteTreeMessage", { name: collection.name, folders: counts.folders, requests: counts.requests })
      : t("dialog.deleteMessage", { name: collection.name });
    if (await util.confirmDialog({ title: t("dialog.deleteTitle"), message })) {
      store.deleteCollection(collection.id);
      util.toast(t("toast.deleted"));
    }
  }

  async function confirmDeleteFolder(folder) {
    const counts = store.countTree(folder.items);
    const message = (counts.folders || counts.requests)
      ? t("dialog.deleteFolderMessage", { name: folder.name, folders: counts.folders, requests: counts.requests })
      : t("dialog.deleteMessage", { name: folder.name });
    if (await util.confirmDialog({
      title: t("dialog.deleteTitle"),
      message
    })) {
      store.deleteFolder(folder.id);
      util.toast(t("toast.deleted"));
    }
  }

  function openMoveDialog(node, collectionId) {
    const collectionSelect = el("select", { class: "hc-select hc-select-flat" });
    store.state.collections.forEach((collection) => {
      collectionSelect.append(el("option", { value: collection.id, text: collection.name }));
    });
    collectionSelect.value = collectionId || (store.state.collections[0] || {}).id || "";
    const folderSelect = el("select", { class: "hc-select hc-select-flat" });
    const refill = () => {
      util.clear(folderSelect);
      folderSelect.append(el("option", { value: "", text: t("dialog.collectionRoot") }));
      store.listFolders(collectionSelect.value).forEach((folder) => {
        if (node.kind === "folder" && (folder.id === node.id || store.folderContains(node.id, folder.id))) return;
        folderSelect.append(el("option", { value: folder.id, text: folder.path }));
      });
    };
    refill();
    collectionSelect.addEventListener("change", refill);
    const located = store.locate(node.id);
    if (located && located.parent && located.collection.id === collectionSelect.value) folderSelect.value = located.parent.id;
    util.openModal({
      title: t("dialog.moveTitle"),
      render: (body) => {
        body.append(el("div", { class: "hc-hint", text: node.name }));
        body.append(el("label", { class: "hc-field" }, [
          el("span", { class: "hc-field-label", text: t("dialog.collection") }), collectionSelect
        ]));
        body.append(el("label", { class: "hc-field" }, [
          el("span", { class: "hc-field-label", text: t("dialog.moveTarget") }), folderSelect
        ]));
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: t("action.move"), kind: "primary",
          onClick: (api) => {
            const ok = store.moveItem(node.id, collectionSelect.value, folderSelect.value);
            util.toast(ok ? t("toast.moved") : t("toast.moveFailed"), ok ? "success" : "error");
            api.close();
          }
        }
      ]
    });
  }

  /* --------------------------------------------------------------- history */

  function renderHistory(host) {
    if (!store.state.history.length) {
      host.append(el("div", { class: "hc-empty", text: t("side.emptyHistory") }));
      return;
    }
    const list = el("div", { class: "hc-list" });
    store.state.history.forEach((entry) => {
      let path = entry.url;
      try {
        const parsed = new URL(entry.url);
        path = `${parsed.host}${parsed.pathname}`;
      } catch (error) { /* keep the raw url */ }
      const item = el("div", { class: "hc-list-item" }, [
        el("span", { class: `hc-tag m-${entry.method}`, text: entry.method }),
        el("div", { class: "hc-grow" }, [
          el("div", { class: "hc-list-title", text: path }),
          el("div", { class: "hc-list-sub", text: `${new Date(entry.at).toLocaleTimeString(HC.i18n.locale)} · ${util.formatDuration(entry.durationMs)}` })
        ]),
        el("span", {
          class: `hc-status ${util.statusClass(entry.status, entry.ok)}`,
          text: entry.ok && entry.status ? String(entry.status) : "ERR"
        })
      ]);
      item.addEventListener("click", () => {
        store.openHistoryEntry(entry.id);
        HC.viewRequest.render();
        HC.viewResponse.render();
      });
      list.append(item);
    });
    host.append(list);
  }

  /* ---------------------------------------------------------- environments */

  function renderEnvironments(host) {
    if (!store.state.environments.length) {
      host.append(el("div", { class: "hc-empty", text: t("side.emptyEnvironments") }));
      host.append(el("div", { class: "hc-hint", text: t("misc.dynamicVars") + "：" + t("misc.dynamicHint") }));
      return;
    }
    const list = el("div", { class: "hc-list" });
    store.state.environments.forEach((environment) => {
      const active = environment.id === store.state.activeEnvironmentId;
      const nameNode = el("span", { class: "hc-grow hc-list-title", text: environment.name, title: environment.name });
      const item = el("div", { class: `hc-list-item${active ? " is-active" : ""}` }, [
        el("span", { text: active ? "◉" : "◯" }),
        nameNode
      ]);
      const menuItems = [
        { action: "rename", label: t("action.rename"), onClick: async () => {
          const name = await util.promptDialog({ title: t("dialog.renameTitle"), value: environment.name });
          if (name) { environment.name = name; store.persist(); store.emit("environments"); }
        } },
        { action: "export", label: t("action.export"), onClick: () => openEnvironmentExport(environment.id) },
        { action: "delete", label: t("action.delete"), danger: true, onClick: async () => {
          if (await util.confirmDialog({ title: t("dialog.deleteTitle"), message: t("dialog.deleteMessage", { name: environment.name }) })) {
            store.deleteEnvironment(environment.id);
          }
        } }
      ];
      item.append(moreButton(menuItems));
      item.addEventListener("contextmenu", (event) => openContextMenu(event, menuItems, item));
      item.addEventListener("click", (event) => {
        if (event.target.closest(".hc-list-actions")) return;
        store.setActiveEnvironment(environment.id);
      });
      list.append(item);
    });
    host.append(list);

    const environment = store.activeEnvironment();
    if (!environment) return;
    const section = el("div", { class: "hc-side-group" });
    section.append(el("div", { class: "hc-side-group-head" }, [
      el("span", { class: "hc-grow", text: `${t("env.variables")} · ${environment.name}` })
    ]));
    const kvHost = el("div", {});
    section.append(kvHost);
    section.append(el("div", { class: "hc-hint", text: t("env.variablesHint") }));
    host.append(section);
    util.createKVEditor(kvHost, {
      rows: environment.variables && environment.variables.length ? environment.variables : (environment.variables = [util.emptyRow()]),
      narrow: true,
      onChange: () => { store.schedulePersist(); HC.viewRequest.updateUrlFlag(store.activeTab()); }
    });
  }

  /* --------------------------------------------------------------- dialogs */

  function openImportDialog() {
    const textarea = el("textarea", { class: "hc-textarea", placeholder: JSON.stringify({ collections: [{ name: t("misc.exampleCollection"), items: [{ kind: "folder", name: t("misc.exampleFolder"), items: [{ kind: "request", name: t("misc.exampleRequest"), method: "GET", url: "https://api.example.com/users" }] }] }] }), spellcheck: "false" });
    util.openModal({
      title: t("action.import"),
      render: (body) => {
        body.append(el("div", { class: "hc-hint", text: t("side.importHint") }));
        body.append(textarea);
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: t("action.import"), kind: "primary",
          onClick: (api) => {
            const text = textarea.value.trim();
            if (!text) return;
            if (text.startsWith("{") || text.startsWith("[")) importJson(text);
            else util.toast(t("toast.importJsonOnly"), "error");
            api.close();
          }
        }
      ]
    });
  }

  function importJson(text) {
    try {
      const document = JSON.parse(text);
      const collections = Array.isArray(document) ? document : (document.collections || [document]);
      let count = 0;
      collections.forEach((collection) => {
        if (!collection || typeof collection !== "object") return;
        const target = store.importCollection(collection);
        if (!target) return;
        count += store.countRequests(target.items);
      });
      store.persist();
      store.emit("sidebar");
      util.toast(t("toast.imported", { count }), "success");
    } catch (error) {
      util.toast(t("toast.importFailed", { message: error.message }), "error");
    }
  }

  function openExportDialog(collection) {
    const payload = JSON.stringify({ collections: [collection] }, null, 2);
    const textarea = el("textarea", { class: "hc-textarea", value: payload, spellcheck: "false" });
    util.openModal({
      title: t("dialog.exportTitle"),
      render: (body) => {
        body.append(el("div", { class: "hc-hint", text: t("dialog.exportHint") }));
        body.append(textarea);
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: t("action.copy"), kind: "primary",
          onClick: async (api) => {
            const ok = await HC.bridge.copy(textarea.value);
            util.toast(ok ? t("toast.copied") : t("toast.copyFailed"), ok ? "success" : "error");
            api.close();
          }
        }
      ]
    });
  }

  function safeFilePart(name) {
    const cleaned = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 40);
    return cleaned || "environment";
  }

  async function openEnvironmentExport(onlyId) {
    if (!store.state.environments.length) {
      util.toast(t("env.exportEmpty"), "error");
      return;
    }
    const current = onlyId
      ? store.state.environments.find((item) => item.id === onlyId)
      : store.activeEnvironment();
    const scope = el("select", { class: "hc-select hc-select-flat" });
    scope.append(el("option", { value: "all", text: t("env.exportAll") }));
    scope.append(el("option", {
      value: "current",
      text: current ? t("env.exportCurrentNamed", { name: current.name }) : t("env.exportCurrent"),
      disabled: !current
    }));
    if (onlyId && current) scope.value = "current";
    util.openModal({
      title: t("env.exportTitle"),
      render: (body) => {
        body.append(el("div", { class: "hc-hint", text: t("env.exportHint") }));
        body.append(el("label", { class: "hc-field" }, [
          el("span", { class: "hc-field-label", text: t("env.exportScope") }),
          scope
        ]));
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: t("action.export"), kind: "primary",
          onClick: async (api) => {
            const which = scope.value === "current" ? "current" : "all";
            const environmentId = which === "current" ? (onlyId || (store.activeEnvironment() && store.activeEnvironment().id) || "") : "";
            const named = environmentId ? store.state.environments.find((item) => item.id === environmentId) : null;
            const payload = store.exportEnvironmentDocument(which, environmentId);
            if (!payload.environments.length) {
              util.toast(t("env.exportEmpty"), "error");
              return;
            }
            const fileName = named
              ? `http-client-env-${safeFilePart(named.name)}.json`
              : "http-client-environments.json";
            try {
              const saved = await HC.bridge.saveTextFile(fileName, JSON.stringify(payload, null, 2));
              if (saved && saved.cancelled) {
                util.toast(t("env.cancelled"));
                return;
              }
              util.toast(t("env.exported", { path: (saved && saved.path) || fileName }), "success");
              api.close();
            } catch (error) {
              util.toast(t("env.exportFailed", { message: (error && error.message) || error }), "error");
            }
          }
        }
      ]
    });
  }

  async function openEnvironmentImport() {
    let picked;
    try {
      picked = await HC.bridge.pickTextFile();
    } catch (error) {
      util.toast(t("env.importFailed", { message: (error && error.message) || error }), "error");
      return;
    }
    if (!picked || !String(picked.text || "").trim()) return;
    let list;
    try {
      list = store.parseEnvironmentDocument(picked.text);
    } catch (error) {
      util.toast(t("env.importFailed", { message: error.message }), "error");
      return;
    }
    const collisions = store.environmentNamesCollide(list);
    const mode = el("select", { class: "hc-select hc-select-flat" });
    mode.append(el("option", { value: "overwrite", text: t("env.overwrite") }));
    mode.append(el("option", { value: "keep", text: t("env.keepBoth") }));
    util.openModal({
      title: t("env.importTitle"),
      render: (body) => {
        body.append(el("div", { class: "hc-hint", text: t("env.importHint") }));
        body.append(el("div", { text: t("env.preview", { count: list.length, names: list.map((item) => item.name).join("、") }) }));
        body.append(el("div", {
          class: "hc-hint",
          text: collisions.length ? t("env.conflictNames", { names: collisions.join("、") }) : t("env.noConflict")
        }));
        body.append(el("label", { class: "hc-field" }, [
          el("span", { class: "hc-field-label", text: t("env.conflict") }),
          mode
        ]));
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: t("action.import"), kind: "primary",
          onClick: (api) => {
            const result = store.importEnvironments(list, mode.value === "keep" ? "keep" : "overwrite");
            util.toast(t("env.imported", result), "success");
            api.close();
          }
        }
      ]
    });
  }

  window.HC.viewSidebar = { render, openImportDialog, openExportDialog, focusSearch, openEnvironmentImport, openEnvironmentExport };
})();
