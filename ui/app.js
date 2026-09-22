/* Workbench shell: tab strip, toolbars, splitters, shortcuts and the boot
   sequence. */

(function () {
  const util = HC.util;
  const store = HC.store;
  const bridge = HC.bridge;
  const t = (key, params) => HC.i18n.t(key, params);
  const el = util.el;

  const VERSION = "0.1.3";

  function staticLabels() {
    document.documentElement.lang = HC.i18n.locale;
    document.title = t("brand");
    util.$("#brand-name").textContent = t("brand");
    util.$("#btn-toggle-sidebar").title = t("side.toggle");
    util.$("#label-environment").textContent = t("label.environment");
    util.$("#btn-import-curl").textContent = t("action.importCurl");
    util.$("#btn-settings").textContent = t("action.settings");
    util.$("#btn-send").textContent = t("action.send");
    util.$("#btn-cancel").textContent = t("action.cancel");
    util.$("#btn-save").title = t("action.save");
    util.$("#btn-copy-curl").title = t("action.copyCurl");
    util.$$(".hc-side-tab").forEach((button) => {
      button.textContent = t(`side.${button.dataset.sideView}`);
    });
  }

  /* ------------------------------------------------------------ tab strip -- */

  function renderTabs() {
    const host = util.clear(util.$("#tabstrip"));
    store.state.tabs.forEach((tab) => {
      const active = tab.id === store.state.activeTabId;
      const node = el("div", { class: `hc-tab${active ? " is-active" : ""}`, title: store.requestTitle(tab) }, [
        el("span", { class: `hc-tag m-${tab.method}`, text: tab.method }),
        el("span", { class: "hc-tab-label", text: store.requestTitle(tab) }),
        tab.dirty ? el("span", { class: "hc-tab-dot", title: "未保存" }) : null,
        el("button", {
          class: "hc-tab-close", type: "button", text: "✕", title: t("action.close"),
          on: { click: (event) => { event.stopPropagation(); store.closeTab(tab.id); } }
        })
      ]);
      node.addEventListener("click", () => {
        store.setActiveTab(tab.id);
        HC.viewRequest.render();
        HC.viewResponse.render();
      });
      node.addEventListener("auxclick", (event) => { if (event.button === 1) store.closeTab(tab.id); });
      host.append(node);
    });
    host.append(el("button", {
      class: "hc-icon-btn", type: "button", text: "+", title: t("action.newRequest"),
      on: { click: () => { store.createTab(); HC.viewRequest.render(); HC.viewResponse.render(); } }
    }));
  }

  /* --------------------------------------------------------- environment --- */

  function renderEnvironmentSelect() {
    const select = util.clear(util.$("#env-select"));
    select.append(el("option", { value: "", text: t("env.none") }));
    store.state.environments.forEach((environment) => {
      select.append(el("option", { value: environment.id, text: environment.name }));
    });
    select.value = store.state.activeEnvironmentId || "";
  }

  /* -------------------------------------------------------------- toolbar -- */

  function renderToolbarState() {
    const tab = store.activeTab();
    const send = util.$("#btn-send");
    const cancel = util.$("#btn-cancel");
    const save = util.$("#btn-save");
    if (!tab) return;
    send.hidden = !!tab.sending;
    cancel.hidden = !tab.sending;
    send.disabled = !bridge.backendReady;
    send.title = bridge.backendReady ? t("action.send") : t("err.backendHint");
    save.textContent = tab.savedRequestId ? (tab.dirty ? "★" : "✦") : "☆";
    save.title = t("action.save");
  }

  /* -------------------------------------------------------------- sending -- */

  async function send() {
    const tab = store.activeTab();
    if (!tab) return;
    if (!bridge.backendReady) {
      util.toast(t("err.backendHint"), "error");
      return;
    }
    if (!String(tab.url || "").trim()) {
      util.toast(t("toast.urlRequired"), "error");
      util.$("#url-input").focus();
      return;
    }
    const missing = store.collectMissingVariables(tab);
    if (missing.length) util.toast(`未定义变量：${missing.join(", ")}`, "error");

    const requestId = util.uid("run");
    tab.response = null;
    tab.fullBody = null;
    HC.viewResponse.setSending(tab, true, requestId);
    renderToolbarState();
    HC.viewResponse.render();

    const started = performance.now();
    try {
      const spec = store.buildSpec(tab, requestId);
      const result = await bridge.send(spec);
      tab.response = result;
      store.pushHistory(tab, result);
    } catch (error) {
      tab.response = {
        ok: false,
        error: { kind: "network", message: t("err.invoke", { message: (error && error.message) || String(error) }) },
        durationMs: Math.round(performance.now() - started),
        method: tab.method,
        url: tab.url,
        requestHeaders: []
      };
    } finally {
      HC.viewResponse.setSending(tab, false, "");
      renderToolbarState();
      HC.viewResponse.render();
    }
  }

  async function cancel() {
    const tab = store.activeTab();
    if (!tab || !tab.requestId) return;
    await bridge.cancel(tab.requestId);
  }

  async function saveRequest() {
    const tab = store.activeTab();
    if (!tab) return;
    const nameInput = el("input", { class: "hc-input", type: "text", value: store.requestTitle(tab) });
    const collectionSelect = el("select", { class: "hc-select hc-select-flat" });
    const folderSelect = el("select", { class: "hc-select hc-select-flat" });
    const fillCollections = () => {
      util.clear(collectionSelect);
      store.state.collections.forEach((collection) => collectionSelect.append(el("option", { value: collection.id, text: collection.name })));
      collectionSelect.value = tab.collectionId || (store.state.collections[0] || {}).id || "";
    };
    const fillFolders = () => {
      util.clear(folderSelect);
      folderSelect.append(el("option", { value: "", text: t("dialog.collectionRoot") }));
      store.listFolders(collectionSelect.value).forEach((folder) => {
        folderSelect.append(el("option", { value: folder.id, text: folder.path }));
      });
      if (tab.folderId) folderSelect.value = tab.folderId;
    };
    fillCollections();
    fillFolders();
    collectionSelect.addEventListener("change", fillFolders);
    util.openModal({
      title: t("dialog.saveTitle"),
      render: (body) => {
        body.append(el("label", { class: "hc-field" }, [el("span", { class: "hc-field-label", text: t("dialog.name") }), nameInput]));
        body.append(el("label", { class: "hc-field" }, [el("span", { class: "hc-field-label", text: t("dialog.collection") }), collectionSelect]));
        body.append(el("label", { class: "hc-field" }, [el("span", { class: "hc-field-label", text: t("dialog.folder") }), folderSelect]));
        body.append(el("div", { class: "hc-hint", text: `${tab.method} ${tab.url}` }));
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: t("action.save2"), kind: "primary",
          onClick: (api) => {
            const name = nameInput.value.trim() || store.requestTitle(tab);
            let collectionId = collectionSelect.value;
            if (!collectionId) collectionId = store.createCollection(t("misc.untitledCollection")).id;
            store.saveRequestTo(collectionId, tab, name, folderSelect.value);
            util.toast(t("toast.saved"), "success");
            api.close();
            renderTabs();
            HC.viewSidebar.render();
            renderToolbarState();
          }
        }
      ]
    });
  }

  async function copyCurl() {
    const tab = store.activeTab();
    if (!tab) return;
    const command = HC.curl.generateCurl(tab, { resolve: (value) => store.resolve(value) });
    const ok = await bridge.copy(command);
    util.toast(ok ? t("toast.copied") : t("toast.copyFailed"), ok ? "success" : "error");
  }

  function openCurlImport() {
    const textarea = el("textarea", {
      class: "hc-textarea", spellcheck: "false",
      placeholder: "curl -X POST 'https://api.example.com/users' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"name\":\"demo\"}'"
    });
    util.openModal({
      title: t("dialog.importCurlTitle"),
      render: (body) => {
        body.append(el("div", { class: "hc-hint", text: t("dialog.importCurlHint") }));
        body.append(textarea);
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: t("action.import"), kind: "primary",
          onClick: (api) => {
            const parsed = HC.curl.parseCurl(textarea.value);
            if (!parsed) { util.toast(t("toast.importCurlFailed"), "error"); return; }
            store.createTab(Object.assign(parsed.request, { name: parsed.request.name }));
            HC.viewRequest.render();
            HC.viewResponse.render();
            api.close();
          }
        }
      ]
    });
  }

  function openSettings() {
    util.openModal({
      title: t("dialog.settingsTitle"),
      render: (body) => {
        const grid = el("div", { class: "hc-form-grid" });
        const row = (label, value) => {
          grid.append(el("span", { class: "hc-field-label", text: label }));
          grid.append(el("span", { text: value }));
        };
        row(t("settings.backend"), bridge.backendReady ? t("settings.backendReady") : t("settings.backendMissing"));
        row(t("settings.storage"), store.state.memoryOnly ? t("dialog.memoryOnly") : (store.state.storePath || "—"));
        row(t("settings.language"), HC.i18n.locale);
        row(t("settings.version"), VERSION);
        row(t("misc.dynamicVars"), t("misc.dynamicHint"));
        body.append(grid);
        body.append(el("div", { class: "hc-hint", text: t("settings.dataHint") }));
        const actions = el("div", { class: "hc-body-toolbar" }, [
          el("button", {
            class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("settings.exportAll"),
            on: {
              click: async () => {
                const ok = await bridge.copy(JSON.stringify(store.serializable(), null, 2));
                util.toast(ok ? t("toast.copied") : t("toast.copyFailed"), ok ? "success" : "error");
              }
            }
          }),
          el("button", {
            class: "hc-btn hc-btn-sm hc-btn-danger", type: "button", text: t("settings.clearAll"),
            on: {
              click: async () => {
                if (!await util.confirmDialog({ title: t("settings.clearAll"), message: t("dialog.deleteMessage", { name: t("brand") }) })) return;
                store.state.collections = [];
                store.state.environments = [];
                store.state.history = [];
                store.state.activeEnvironmentId = "";
                store.createCollection(t("misc.untitledCollection"));
                store.emit("sidebar");
                store.emit("environments");
                store.persist();
                util.closeModal();
                util.toast(t("toast.deleted"));
              }
            }
          })
        ]);
        body.append(actions);
      },
      actions: [{ label: t("action.close"), kind: "primary", onClick: (api) => api.close() }]
    });
  }

  /* ------------------------------------------------------------- splitters */

  function applyLayout() {
    const sidebar = util.$("#sidebar");
    const requestPane = util.$("#request-pane");
    sidebar.style.width = `${store.state.settings.sidebarWidth}px`;
    sidebar.classList.toggle("is-collapsed", !!store.state.settings.sidebarCollapsed);
    util.$("#sidebar-splitter").hidden = !!store.state.settings.sidebarCollapsed;
    requestPane.style.flex = `0 0 ${store.state.settings.requestPercent}%`;
  }

  function wireSplitters() {
    const wire = (element, onMove) => {
      element.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        element.setPointerCapture(event.pointerId);
        const move = (moveEvent) => onMove(moveEvent);
        const up = () => {
          element.releasePointerCapture(event.pointerId);
          element.removeEventListener("pointermove", move);
          element.removeEventListener("pointerup", up);
          store.persist();
        };
        element.addEventListener("pointermove", move);
        element.addEventListener("pointerup", up);
      });
    };
    wire(util.$("#sidebar-splitter"), (event) => {
      const width = Math.min(Math.max(event.clientX, 180), window.innerWidth - 360);
      store.state.settings.sidebarWidth = width;
      applyLayout();
    });
    wire(util.$("#pane-splitter"), (event) => {
      const main = util.$(".hc-main").getBoundingClientRect();
      const percent = ((event.clientY - main.top) / main.height) * 100;
      store.state.settings.requestPercent = Math.min(Math.max(percent, 20), 80);
      applyLayout();
    });
  }

  /* ------------------------------------------------------------------ wire */

  function wire() {
    util.$("#btn-send").addEventListener("click", send);
    util.$("#btn-cancel").addEventListener("click", cancel);
    util.$("#btn-save").addEventListener("click", saveRequest);
    util.$("#btn-copy-curl").addEventListener("click", copyCurl);
    util.$("#btn-import-curl").addEventListener("click", openCurlImport);
    util.$("#btn-settings").addEventListener("click", openSettings);
    util.$("#btn-toggle-sidebar").addEventListener("click", () => {
      store.state.settings.sidebarCollapsed = !store.state.settings.sidebarCollapsed;
      applyLayout();
      store.persist();
    });

    const methodSelect = util.$("#method-select");
    store.METHODS.forEach((method) => methodSelect.append(el("option", { value: method, text: method })));
    methodSelect.addEventListener("change", () => {
      const tab = store.activeTab();
      tab.method = methodSelect.value;
      store.markDirty(tab);
      renderTabs();
      HC.viewRequest.render();
    });

    const urlInput = util.$("#url-input");
    urlInput.addEventListener("input", () => {
      const tab = store.activeTab();
      tab.url = urlInput.value;
      store.markDirty(tab);
      HC.viewRequest.updateUrlFlag(tab);
    });
    urlInput.addEventListener("change", () => {
      const tab = store.activeTab();
      tab.url = urlInput.value;
      store.markDirty(tab);
      HC.viewRequest.syncParamsFromUrl(tab);
      HC.viewRequest.render();
    });
    urlInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); send(); }
    });

    util.$("#env-select").addEventListener("change", (event) => store.setActiveEnvironment(event.target.value));

    util.$$(".hc-side-tab").forEach((button) => {
      button.addEventListener("click", () => {
        store.state.sideView = button.dataset.sideView;
        util.$$(".hc-side-tab").forEach((item) => item.classList.toggle("is-active", item === button));
        HC.viewSidebar.render();
      });
    });

    store.subscribe((reason) => {
      if (reason === "loaded" || reason === "tabs") { renderTabs(); renderToolbarState(); }
      if (reason === "tab-dirty") renderToolbarState();
      if (reason === "sidebar") HC.viewSidebar.render();
      if (reason === "environments") { renderEnvironmentSelect(); HC.viewSidebar.render(); }
      if (reason === "loaded") { HC.viewRequest.render(); HC.viewResponse.render(); }
    });

    document.addEventListener("keydown", (event) => {
      const primary = event.metaKey || event.ctrlKey;
      if (!primary) return;
      if (event.key === "Enter") { event.preventDefault(); send(); }
      else if (event.key.toLowerCase() === "s") { event.preventDefault(); saveRequest(); }
      else if (event.key.toLowerCase() === "t") { event.preventDefault(); store.createTab(); HC.viewRequest.render(); HC.viewResponse.render(); }
      else if (event.key.toLowerCase() === "k") { event.preventDefault(); util.$("#url-input").focus(); }
    });

    window.addEventListener("beforeunload", () => { store.persist(); });
    bridge.onEnv(({ locale }) => {
      HC.i18n.setLocale(locale);
      staticLabels();
      renderTabs();
      renderEnvironmentSelect();
      HC.viewSidebar.render();
      HC.viewRequest.render();
      HC.viewResponse.render();
      renderToolbarState();
    });
  }

  function renderAll() {
    renderTabs();
    renderEnvironmentSelect();
    renderToolbarState();
    HC.viewSidebar.render();
    HC.viewRequest.render();
    HC.viewResponse.render();
  }

  async function boot() {
    HC.i18n.setLocale(bridge.locale);
    staticLabels();
    wire();
    applyLayout();
    wireSplitters();

    // Never block the UI forever when the page is opened outside DBX.
    const settled = await Promise.race([
      bridge.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 4000))
    ]);
    HC.i18n.setLocale(bridge.locale);
    staticLabels();
    await store.init();
    renderAll();
    if (settled) {
      if (!bridge.backendReady) util.toast(t("err.backendHint"), "error");
      return;
    }
    // The handshake was still in flight when the guard fired. Refresh the toolbar
    // once it lands, otherwise the send button stays disabled for the whole session.
    bridge.ready.then(() => {
      renderToolbarState();
      if (!bridge.backendReady) util.toast(t("err.backendHint"), "error");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
