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
        class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("action.newRequest"),
        on: { click: () => { store.createTab(); HC.viewRequest.render(); HC.viewResponse.render(); } }
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
      host.append(el("div", { class: "hc-empty", text: "还没有集合，点击上方按钮新建。" }));
      return;
    }
    store.state.collections.forEach((collection) => {
      const group = el("div", { class: "hc-side-group" });
      const head = el("div", { class: "hc-side-group-head" }, [
        el("span", { text: "▾" }),
        el("span", { class: "hc-grow hc-list-title", text: collection.name }),
        el("span", { class: "hc-badge", text: String(collection.requests.length) })
      ]);
      const actions = el("div", { class: "hc-list-actions" });
      actions.append(iconButton("✎", t("action.rename"), async () => {
        const name = await util.promptDialog({ title: t("dialog.renameTitle"), value: collection.name });
        if (name) store.renameCollection(collection.id, name);
      }));
      actions.append(iconButton("⇪", t("action.export"), () => openExportDialog(collection)));
      actions.append(iconButton("✕", t("action.delete"), async () => {
        if (await util.confirmDialog({ title: t("dialog.deleteTitle"), message: t("dialog.deleteMessage", { name: collection.name }) })) {
          store.deleteCollection(collection.id);
          util.toast(t("toast.deleted"));
        }
      }));
      head.append(actions);
      head.addEventListener("click", () => body.hidden = !body.hidden);
      group.append(head);

      const body = el("div", { class: "hc-side-group-body" });
      if (!collection.requests.length) body.append(el("div", { class: "hc-hint", text: "暂无请求" }));
      collection.requests.forEach((saved) => {
        const item = el("div", { class: "hc-list-item" }, [
          el("span", { class: `hc-tag m-${saved.method}`, text: saved.method }),
          el("div", { class: "hc-grow" }, [
            el("div", { class: "hc-list-title", text: saved.name }),
            el("div", { class: "hc-list-sub", text: saved.url || "" })
          ])
        ]);
        const rowActions = el("div", { class: "hc-list-actions" });
        rowActions.append(iconButton("⇲", t("action.duplicate"), () => {
          store.openSavedRequest(collection.id, saved.id);
          const tab = store.activeTab();
          tab.savedRequestId = "";
          tab.collectionId = "";
        }));
        rowActions.append(iconButton("✕", t("action.delete"), async () => {
          if (await util.confirmDialog({ title: t("dialog.deleteTitle"), message: t("dialog.deleteMessage", { name: saved.name }) })) {
            store.deleteSavedRequest(collection.id, saved.id);
          }
        }));
        item.append(rowActions);
        item.addEventListener("click", (event) => {
          if (event.target.closest(".hc-list-actions")) return;
          store.openSavedRequest(collection.id, saved.id);
          HC.viewRequest.render();
          HC.viewResponse.render();
        });
        body.append(item);
      });
      group.append(body);
      host.append(group);
    });
  }

  function iconButton(text, title, handler) {
    return el("button", { class: "hc-icon-btn", type: "button", text, title, on: { click: (event) => { event.stopPropagation(); handler(); } } });
  }

  /* --------------------------------------------------------------- history */

  function renderHistory(host) {
    if (!store.state.history.length) {
      host.append(el("div", { class: "hc-empty", text: "暂无历史记录。" }));
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
          el("div", { class: "hc-list-sub", text: `${new Date(entry.at).toLocaleTimeString()} · ${util.formatDuration(entry.durationMs)}` })
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
      host.append(el("div", { class: "hc-empty", text: "还没有环境变量，点击上方按钮新建。" }));
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
    const textarea = el("textarea", { class: "hc-textarea", placeholder: "curl 'https://api.example.com/users' -H 'Accept: application/json'", spellcheck: "false" });
    util.openModal({
      title: t("action.import"),
      render: (body) => {
        body.append(el("div", { class: "hc-hint", text: "粘贴集合 JSON 导入，或直接粘贴 cURL 命令导入单个请求。" }));
        body.append(textarea);
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: t("action.import"), kind: "primary",
          onClick: (api) => {
            const text = textarea.value.trim();
            if (!text) return;
            if (text.startsWith("{") || text.startsWith("[")) {
              importJson(text);
            } else {
              const parsed = HC.curl.parseCurl(text);
              if (!parsed) { util.toast(t("toast.importCurlFailed"), "error"); return; }
              store.createTab(Object.assign(parsed.request, { name: parsed.request.name }));
              HC.viewRequest.render();
              HC.viewResponse.render();
              util.toast(t("toast.imported", { count: 1 }), "success");
            }
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
        const target = store.createCollection(collection.name || "imported");
        (collection.requests || []).forEach((request) => {
          target.requests.push(Object.assign({ id: util.uid("saved") }, request));
          count += 1;
        });
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
