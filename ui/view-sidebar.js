/* Sidebar: collections, history and environment/variable management. */

(function () {
  const util = HC.util;
  const store = HC.store;
  const t = (key, params) => HC.i18n.t(key, params);
  const el = util.el;

  function render() {
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
    }
  }

  /* ----------------------------------------------------------- collections */

  function renderCollections(host) {
    if (!store.state.collections.length) {
      host.append(el("div", { class: "hc-empty", text: t("side.emptyCollections") }));
      return;
    }
    store.state.collections.forEach((collection) => host.append(renderCollection(collection)));
  }

  function renderCollection(collection) {
    const count = store.countRequests(collection.items);
    const group = el("div", {
      class: "hc-side-group",
      dataset: { nodeId: collection.id, kind: "collection" }
    });
    const head = el("div", {
      class: "hc-side-group-head",
      "aria-expanded": collection.collapsed ? "false" : "true"
    }, [
      el("span", { class: "hc-chevron", text: collection.collapsed ? "▸" : "▾" }),
      el("span", { class: "hc-grow hc-list-title", text: collection.name }),
      el("span", { class: "hc-badge", text: String(count) })
    ]);
    const actions = el("div", { class: "hc-list-actions" });
    actions.append(textButton(t("action.subcollection"), t("action.newSubcollection"), () => promptFolder(collection.id, "")));
    head.addEventListener("contextmenu", (event) => openContextMenu(event, collectionMenu(collection)));
    actions.append(iconButton("✎", t("action.rename"), async () => {
      const name = await util.promptDialog({ title: t("dialog.renameTitle"), value: collection.name });
      if (name) store.renameCollection(collection.id, name);
    }));
    actions.append(iconButton("⇪", t("action.export"), () => openExportDialog(collection)));
    actions.append(iconButton("✕", t("action.delete"), () => confirmDeleteCollection(collection)));
    head.append(actions);
    head.addEventListener("click", () => store.toggleCollapsed(collection.id));
    group.append(head);
    group.append(renderItemList(collection, collection.items, !!collection.collapsed));
    return group;
  }

  function renderItemList(collection, items, collapsed) {
    const body = el("div", { class: "hc-side-group-body", hidden: collapsed });
    if (!items || !items.length) {
      body.append(el("div", { class: "hc-hint", text: t("side.noRequests") }));
      return body;
    }
    items.forEach((item) => {
      if (item.kind === "folder") body.append(renderFolder(collection, item));
      else body.append(renderSavedRequest(collection, item));
    });
    return body;
  }

  function renderFolder(collection, folder) {
    const group = el("div", {
      class: "hc-side-group hc-tree-folder",
      dataset: { nodeId: folder.id, kind: "folder" }
    });
    const head = el("div", {
      class: "hc-side-group-head",
      "aria-expanded": folder.collapsed ? "false" : "true"
    }, [
      el("span", { class: "hc-chevron", text: folder.collapsed ? "▸" : "▾" }),
      el("span", { class: "hc-grow hc-list-title", text: folder.name }),
      el("span", { class: "hc-badge", text: String(store.countRequests(folder.items)) })
    ]);
    const actions = el("div", { class: "hc-list-actions" });
    actions.append(textButton(t("action.subcollection"), t("action.newSubcollection"), () => promptFolder(collection.id, folder.id)));
    head.addEventListener("contextmenu", (event) => openContextMenu(event, folderMenu(collection, folder)));
    actions.append(iconButton("✎", t("action.rename"), async () => {
      const name = await util.promptDialog({ title: t("dialog.renameTitle"), value: folder.name });
      if (name) store.renameFolder(folder.id, name);
    }));
    actions.append(iconButton("→", t("action.move"), () => openMoveDialog(folder, collection.id)));
    actions.append(iconButton("✕", t("action.delete"), () => confirmDeleteFolder(folder)));
    head.append(actions);
    head.addEventListener("click", () => store.toggleCollapsed(folder.id));
    group.append(head);
    const nested = renderItemList(collection, folder.items, !!folder.collapsed);
    if (!folder.items || !folder.items.length) {
      util.clear(nested);
      nested.append(el("div", { class: "hc-hint", text: t("side.emptyFolder") }));
    }
    group.append(nested);
    return group;
  }

  function renderSavedRequest(collection, saved) {
    const active = store.activeTab() && store.activeTab().savedRequestId === saved.id;
    const item = el("div", {
      class: `hc-list-item${active ? " is-active" : ""}`,
      dataset: { nodeId: saved.id, kind: "request" }
    }, [
      el("span", { class: `hc-tag m-${saved.method}`, text: saved.method }),
      el("div", { class: "hc-grow" }, [
        el("div", { class: "hc-list-title", text: saved.name }),
        el("div", { class: "hc-list-sub", text: saved.url || "" })
      ])
    ]);
    const rowActions = el("div", { class: "hc-list-actions" });
    rowActions.append(iconButton("→", t("action.move"), () => openMoveDialog(saved, collection.id)));
    rowActions.append(iconButton("⇲", t("action.duplicate"), () => {
      store.openSavedRequest(collection.id, saved.id);
      const tab = store.activeTab();
      tab.savedRequestId = "";
      tab.collectionId = "";
      tab.folderId = "";
      HC.viewRequest.render();
      HC.viewResponse.render();
    }));
    rowActions.append(iconButton("✕", t("action.delete"), async () => {
      if (await util.confirmDialog({ title: t("dialog.deleteTitle"), message: t("dialog.deleteMessage", { name: saved.name }) })) {
        store.deleteSavedRequest(collection.id, saved.id);
        util.toast(t("toast.deleted"));
      }
    }));
    item.append(rowActions);
    item.addEventListener("contextmenu", (event) => openContextMenu(event, requestMenu(collection, saved)));
    item.addEventListener("click", (event) => {
      if (event.target.closest(".hc-list-actions")) return;
      store.openSavedRequest(collection.id, saved.id);
      HC.viewRequest.render();
      HC.viewResponse.render();
    });
    return item;
  }

  async function promptFolder(collectionId, parentId) {
    const name = await util.promptDialog({ title: t("dialog.newSubcollectionTitle"), label: t("dialog.name") });
    if (name) store.createFolder(collectionId, parentId, name);
  }

  function collectionMenu(collection) {
    return [
      { label: t("action.newSubcollection"), onClick: () => promptFolder(collection.id, "") },
      { label: t("action.rename"), onClick: async () => {
        const name = await util.promptDialog({ title: t("dialog.renameTitle"), value: collection.name });
        if (name) store.renameCollection(collection.id, name);
      } },
      { label: t("action.export"), onClick: () => openExportDialog(collection) },
      { label: t("action.delete"), danger: true, onClick: () => confirmDeleteCollection(collection) }
    ];
  }

  function folderMenu(collection, folder) {
    return [
      { label: t("action.newSubcollection"), onClick: () => promptFolder(collection.id, folder.id) },
      { label: t("action.rename"), onClick: async () => {
        const name = await util.promptDialog({ title: t("dialog.renameTitle"), value: folder.name });
        if (name) store.renameFolder(folder.id, name);
      } },
      { label: t("action.move"), onClick: () => openMoveDialog(folder, collection.id) },
      { label: t("action.delete"), danger: true, onClick: () => confirmDeleteFolder(folder) }
    ];
  }

  function requestMenu(collection, saved) {
    return [
      { label: t("action.move"), onClick: () => openMoveDialog(saved, collection.id) },
      { label: t("action.duplicate"), onClick: () => {
        store.openSavedRequest(collection.id, saved.id);
        const tab = store.activeTab();
        tab.savedRequestId = "";
        tab.collectionId = "";
        tab.folderId = "";
        HC.viewRequest.render();
        HC.viewResponse.render();
      } },
      { label: t("action.delete"), danger: true, onClick: async () => {
        if (await util.confirmDialog({ title: t("dialog.deleteTitle"), message: t("dialog.deleteMessage", { name: saved.name }) })) {
          store.deleteSavedRequest(collection.id, saved.id);
          util.toast(t("toast.deleted"));
        }
      } }
    ];
  }

  let contextMenuNode = null;

  function closeContextMenu() {
    if (contextMenuNode) {
      contextMenuNode.remove();
      contextMenuNode = null;
    }
  }

  function openContextMenu(event, items) {
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
    const menu = el("div", { class: "hc-context-menu", id: "hc-context-menu" });
    items.forEach((item) => {
      menu.append(el("button", {
        type: "button",
        class: `hc-context-item${item.danger ? " is-danger" : ""}`,
        text: item.label,
        on: { click: (clickEvent) => { clickEvent.stopPropagation(); closeContextMenu(); item.onClick(); } }
      }));
    });
    document.body.append(menu);
    const width = 168;
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - (items.length * 32 + 12)));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    contextMenuNode = menu;
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

  function textButton(text, title, handler) {
    return el("button", {
      class: "hc-mini-btn", type: "button", text, title,
      "data-action": "new-subcollection",
      on: { click: (event) => { event.stopPropagation(); handler(); } }
    });
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

  function iconButton(text, title, handler) {
    return el("button", { class: "hc-icon-btn", type: "button", text, title, on: { click: (event) => { event.stopPropagation(); handler(); } } });
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
      const item = el("div", { class: `hc-list-item${active ? " is-active" : ""}` }, [
        el("span", { text: active ? "◉" : "◯" }),
        el("span", { class: "hc-grow hc-list-title", text: environment.name })
      ]);
      const actions = el("div", { class: "hc-list-actions" });
      actions.append(iconButton("✎", t("action.rename"), async () => {
        const name = await util.promptDialog({ title: t("dialog.renameTitle"), value: environment.name });
        if (name) { environment.name = name; store.persist(); store.emit("environments"); }
      }));
      actions.append(iconButton("✕", t("action.delete"), async () => {
        if (await util.confirmDialog({ title: t("dialog.deleteTitle"), message: t("dialog.deleteMessage", { name: environment.name }) })) {
          store.deleteEnvironment(environment.id);
        }
      }));
      item.append(actions);
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

  window.HC.viewSidebar = { render, openImportDialog, openExportDialog };
})();
