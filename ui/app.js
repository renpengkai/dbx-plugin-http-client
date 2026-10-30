/* Workbench shell: tab strip, toolbars, splitters, shortcuts and the boot
   sequence. */

(function () {
  const util = HC.util;
  const store = HC.store;
  const bridge = HC.bridge;
  const t = (key, params) => HC.i18n.t(key, params);
  const el = util.el;

  const VERSION = "0.2.1";

  function surfaceMode() {
    const context = bridge.context || {};
    return context.surface || "tab";
  }

  function applySurface() {
    const surface = surfaceMode();
    document.documentElement.dataset.surface = surface;
    if (surface === "dock" && !store.state.settings._dockApplied) {
      store.state.settings.sidebarCollapsed = true;
      store.state.settings.requestPercent = 55;
      store.state.settings._dockApplied = true;
    }
  }

  function staticLabels() {
    document.documentElement.lang = HC.i18n.locale;
    document.title = t("brand");
    util.$("#sidebar-splitter").title = t("side.resize");
    util.$("#pane-splitter").title = t("pane.resize");
    util.$("#method-select").setAttribute("aria-label", t("request.method"));
    const protocolSelect = util.$("#protocol-select");
    if (protocolSelect) protocolSelect.setAttribute("aria-label", t("request.protocol"));
    util.$("#brand-name").textContent = t("brand");
    util.$("#btn-toggle-sidebar").title = t("side.toggle");
    util.$("#label-environment").textContent = t("label.environment");
    util.$("#btn-import-swagger").textContent = t("action.importSwagger");
    util.$("#btn-import-curl").textContent = t("action.importCurl");
    util.$("#btn-settings").textContent = t("action.settings");
    util.$("#btn-send").textContent = t("action.send");
    util.$("#btn-cancel").textContent = t("action.cancel");
    util.$("#btn-copy-curl").title = t("action.copyCurl");
    const saveMenu = util.$("#btn-save-menu");
    if (saveMenu) saveMenu.title = `${t("action.saveAs")} (${modLabel()}+Shift+S)`;
    util.$("#btn-grpc-reflect").textContent = t("action.grpcReflect");
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
        el("span", {
          class: `hc-tag m-${(tab.protocol || "http") === "grpc" ? "GRPC" : tab.method}`,
          text: (tab.protocol || "http") === "grpc" ? "gRPC" : tab.method
        }),
        el("span", { class: "hc-tab-label", text: store.requestTitle(tab) }),
        tab.dirty ? el("span", { class: "hc-tab-dot", title: t("tab.unsaved") }) : null,
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
      node.addEventListener("contextmenu", (event) => openTabMenu(event, tab));
      node.addEventListener("auxclick", (event) => { if (event.button === 1) store.closeTab(tab.id); });
      host.append(node);
    });
    host.append(el("button", {
      class: "hc-icon-btn", type: "button", text: "+", title: t("action.newRequest"),
      on: { click: () => { store.createTab(); HC.viewRequest.render(); HC.viewResponse.render(); } }
    }));
  }

  /* ---------------------------------------------------- tab context menu -- */

  let tabMenuNode = null;
  let saveMenuNode = null;

  function closeTabMenu() {
    if (tabMenuNode) { tabMenuNode.remove(); tabMenuNode = null; }
  }

  function closeSaveMenu() {
    if (saveMenuNode) { saveMenuNode.remove(); saveMenuNode = null; }
  }

  function openSaveMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    closeTabMenu();
    if (saveMenuNode) { closeSaveMenu(); return; }
    const mod = modLabel();
    const items = [
      { label: t("action.saveInPlace"), hint: `${mod}+S`, onClick: () => saveRequest() },
      { label: t("action.saveAs"), hint: `${mod}+Shift+S`, onClick: () => saveRequestAs() }
    ];
    const menu = el("div", { class: "hc-context-menu", id: "hc-save-menu", role: "menu" });
    items.forEach((item) => {
      menu.append(el("button", {
        type: "button",
        class: "hc-context-item",
        role: "menuitem",
        on: {
          click: (clickEvent) => {
            clickEvent.stopPropagation();
            closeSaveMenu();
            item.onClick();
          }
        }
      }, [
        el("span", { text: item.label }),
        el("span", { class: "hc-context-hint", text: item.hint })
      ]));
    });
    document.body.append(menu);
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 196;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = Math.min(rect.bottom + 4, window.innerHeight - 80);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    saveMenuNode = menu;
  }

  function openTabMenu(event, tab) {
    event.preventDefault();
    event.stopPropagation();
    closeTabMenu();
    const index = store.state.tabs.findIndex((item) => item.id === tab.id);
    const last = store.state.tabs.length - 1;
    const items = [
      { label: t("tab.closeLeft"), disabled: index <= 0, onClick: () => store.closeTabsToSide(tab.id, "left") },
      { label: t("tab.closeRight"), disabled: index >= last, onClick: () => store.closeTabsToSide(tab.id, "right") },
      { label: t("tab.closeOthers"), disabled: store.state.tabs.length <= 1, onClick: () => store.closeTabs([tab.id]) },
      { label: t("tab.closeAll"), onClick: () => store.closeTabs([]) }
    ];
    const menu = el("div", { class: "hc-context-menu", id: "hc-tab-menu" });
    items.forEach((item) => {
      const button = el("button", {
        type: "button",
        class: "hc-context-item",
        text: item.label,
        disabled: item.disabled,
        on: {
          click: (clickEvent) => {
            clickEvent.stopPropagation();
            closeTabMenu();
            if (item.disabled) return;
            item.onClick();
            HC.viewRequest.render();
            HC.viewResponse.render();
          }
        }
      });
      menu.append(button);
    });
    document.body.append(menu);
    const width = 168;
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - (items.length * 32 + 12)));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    tabMenuNode = menu;
  }

  document.addEventListener("click", () => { closeTabMenu(); closeSaveMenu(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeTabMenu(); closeSaveMenu(); }
  });

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

  function modLabel() {
    return /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘" : "Ctrl";
  }

  function savedRequestExists(tab) {
    if (!tab || !tab.savedRequestId) return null;
    const located = store.locate(tab.savedRequestId);
    if (!located || located.item.kind !== "request") return null;
    return located;
  }

  function renderToolbarState() {
    const tab = store.activeTab();
    const send = util.$("#btn-send");
    const cancel = util.$("#btn-cancel");
    const save = util.$("#btn-save");
    if (!tab || !save) return;
    send.hidden = !!tab.sending;
    cancel.hidden = !tab.sending;
    send.disabled = !bridge.backendReady;
    send.title = bridge.backendReady ? t("action.send") : t("err.backendHint");
    const exists = savedRequestExists(tab);
    save.textContent = exists ? (tab.dirty ? "★" : "✦") : "☆";
    save.title = exists
      ? `${t("action.saveInPlace")} (${modLabel()}+S)`
      : `${t("action.save")} (${modLabel()}+S)`;
  }

  function syncDirtyIndicators() {
    const nodes = util.$$("#tabstrip .hc-tab");
    store.state.tabs.forEach((tab, index) => {
      const node = nodes[index];
      if (!node) return;
      let dot = node.querySelector(".hc-tab-dot");
      if (tab.dirty && !dot) {
        dot = el("span", { class: "hc-tab-dot", title: t("tab.unsaved") });
        const close = node.querySelector(".hc-tab-close");
        if (close) node.insertBefore(dot, close);
        else node.append(dot);
      } else if (!tab.dirty && dot) {
        dot.remove();
      } else if (dot) {
        dot.title = t("tab.unsaved");
      }
    });
    util.$$("#sidebar-body .hc-list-item").forEach((row) => {
      const dot = row.querySelector(".hc-dirty-dot");
      if (!dot) return;
      const dirty = store.state.tabs.some((tab) => tab.savedRequestId === row.dataset.nodeId && tab.dirty);
      dot.hidden = !dirty;
    });
  }

  /* -------------------------------------------------------------- sending -- */

  async function send() {
    const tab = store.activeTab();
    if (!tab) return;
    if (!bridge.backendReady) {
      util.toast(t("err.backendHint"), "error");
      return;
    }
    const isGrpc = (tab.protocol || "http") === "grpc";
    if (isGrpc) {
      if (!tab.grpc) tab.grpc = { target: "", method: "", plaintext: true, authority: "" };
      tab.grpc.target = tab.url || tab.grpc.target;
      if (!String(tab.grpc.target || "").trim()) {
        util.toast(t("toast.grpcTargetRequired"), "error");
        util.$("#url-input").focus();
        return;
      }
      if (!String(tab.grpc.method || "").trim()) {
        util.toast(t("toast.grpcMethodRequired"), "error");
        return;
      }
    } else if (!String(tab.url || "").trim()) {
      util.toast(t("toast.urlRequired"), "error");
      util.$("#url-input").focus();
      return;
    }
    const missing = store.collectMissingVariables(tab);
    if (missing.length) util.toast(t("toast.undefinedVariables", { names: missing.join(", ") }), "error");

    const requestId = util.uid("run");
    tab.response = null;
    tab.fullBody = null;
    HC.viewResponse.setSending(tab, true, requestId);
    renderToolbarState();
    HC.viewResponse.render();

    const started = performance.now();
    try {
      const spec = store.buildSpec(tab, requestId);
      const result = isGrpc ? await bridge.grpcSend(spec) : await bridge.send(spec);
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

  function finishSave(okMessage) {
    if (okMessage) util.toast(okMessage, "success");
    renderTabs();
    HC.viewSidebar.render();
    renderToolbarState();
    const save = util.$("#btn-save");
    if (!save) return;
    save.textContent = "✓";
    save.classList.add("is-saved");
    setTimeout(() => {
      save.classList.remove("is-saved");
      renderToolbarState();
    }, 900);
  }

  function saveInPlace(tab) {
    const located = savedRequestExists(tab);
    if (!located) return false;
    const folderId = located.parent ? located.parent.id : "";
    const name = (tab.name && tab.name !== t("tab.untitled")) ? tab.name : (located.item.name || store.requestTitle(tab));
    store.saveRequestTo(located.collection.id, tab, name, folderId);
    finishSave(t("toast.saved"));
    return true;
  }

  async function saveRequest() {
    const tab = store.activeTab();
    if (!tab) return;
    if (saveInPlace(tab)) return;
    openSaveDialog(tab, false);
  }

  async function saveRequestAs() {
    const tab = store.activeTab();
    if (!tab) return;
    openSaveDialog(tab, true);
  }

  function openSaveDialog(tab, asCopy) {
    const initialName = asCopy && savedRequestExists(tab)
      ? t("misc.copyName", { name: tab.name || store.requestTitle(tab) })
      : store.requestTitle(tab);
    const nameInput = el("input", { class: "hc-input", type: "text", value: initialName });
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
      title: asCopy ? t("dialog.saveAsTitle") : t("dialog.saveTitle"),
      render: (body) => {
        body.append(el("label", { class: "hc-field" }, [el("span", { class: "hc-field-label", text: t("dialog.name") }), nameInput]));
        body.append(el("label", { class: "hc-field" }, [el("span", { class: "hc-field-label", text: t("dialog.collection") }), collectionSelect]));
        body.append(el("label", { class: "hc-field" }, [el("span", { class: "hc-field-label", text: t("dialog.folder") }), folderSelect]));
        body.append(el("div", { class: "hc-hint", text: `${tab.method} ${tab.url}` }));
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: asCopy ? t("action.saveAs") : t("action.save2"), kind: "primary",
          onClick: (api) => {
            const name = nameInput.value.trim() || store.requestTitle(tab);
            let collectionId = collectionSelect.value;
            if (!collectionId) collectionId = store.createCollection(t("misc.untitledCollection")).id;
            store.saveRequestTo(collectionId, tab, name, folderSelect.value, asCopy ? { copy: true } : null);
            api.close();
            finishSave(t("toast.saved"));
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

  /* Lets the user repoint the store at a custom directory from Settings, so the
     data survives a Docker container rebuild even when no connection form was
     used. The sidecar probes the path before switching. */
  function renderStorageDirField() {
    const wrap = el("div", { class: "hc-field hc-field-block" });
    const label = el("span", { class: "hc-field-label", text: t("settings.storageDir") });
    const input = el("input", {
      class: "hc-input", type: "text", spellcheck: "false",
      value: store.state.dirConfigured ? (store.state.storeDir || "") : "",
      placeholder: t("settings.storageDirPlaceholder")
    });
    const apply = el("button", {
      class: "hc-btn hc-btn-sm hc-btn-primary", type: "button", text: t("settings.applyDir"),
      disabled: !bridge.backendReady
    });
    const row = el("div", { class: "hc-body-toolbar" }, [input, apply]);
    wrap.append(label, row);
    wrap.append(el("div", {
      class: "hc-hint",
      text: t("settings.storageDirHint") + " " + (t("settings.storageDirDefault") + ": " + (store.state.storePath || "—"))
    }));
    apply.addEventListener("click", async () => {
      const dir = input.value.trim();
      if (!dir) { util.toast(t("settings.dirFailed", { message: "empty" }), "error"); return; }
      apply.disabled = true;
      try {
        await store.setStoreDir(dir);
        util.toast(t("settings.dirSaved"), "success");
      } catch (error) {
        util.toast(t("settings.dirFailed", { message: (error && error.message) || error }), "error");
      } finally {
        apply.disabled = false;
      }
    });
    return wrap;
  }

  function webdavConfigFromForm(fields) {
    return {
      endpoint: fields.endpoint.value.trim(),
      username: fields.username.value.trim(),
      password: fields.password.value,
      remotePath: fields.remotePath.value.trim() || "DBX/http-client/store.json",
      userAgent: fields.userAgent.value.trim()
    };
  }

  function openSettings() {
    if (!store.state.settings.webdav) {
      store.state.settings.webdav = {
        endpoint: "", username: "", password: "",
        remotePath: "DBX/http-client/store.json", userAgent: "", autoSync: false
      };
    }
    const webdav = store.state.settings.webdav;
    const fields = {
      endpoint: el("input", { class: "hc-input", type: "url", value: webdav.endpoint || "", placeholder: "https://dav.example.com/remote.php/dav/files/user" }),
      username: el("input", { class: "hc-input", type: "text", value: webdav.username || "" }),
      password: el("input", { class: "hc-input", type: "password", value: webdav.password || "" }),
      remotePath: el("input", { class: "hc-input", type: "text", value: webdav.remotePath || "DBX/http-client/store.json" }),
      userAgent: el("input", { class: "hc-input", type: "text", value: webdav.userAgent || "", placeholder: "Zotero/10.0.0" }),
      autoSync: el("input", { type: "checkbox" })
    };
    fields.autoSync.checked = !!webdav.autoSync;

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
        row(t("settings.surface"), surfaceMode());
        row(t("misc.dynamicVars"), t("misc.dynamicHint"));
        body.append(grid);
        body.append(renderStorageDirField());
        body.append(el("div", { class: "hc-hint", text: t("settings.dataHint") }));

        body.append(el("h3", { class: "hc-subtitle", text: t("settings.webdavTitle") }));
        body.append(el("div", { class: "hc-hint", text: t("settings.webdavHint") }));
        const syncGrid = el("div", { class: "hc-form-grid" });
        const addField = (label, node) => {
          syncGrid.append(el("span", { class: "hc-field-label", text: label }));
          syncGrid.append(node);
        };
        addField(t("settings.webdavEndpoint"), fields.endpoint);
        addField(t("settings.webdavUsername"), fields.username);
        addField(t("settings.webdavPassword"), fields.password);
        addField(t("settings.webdavRemotePath"), fields.remotePath);
        addField(t("settings.webdavUserAgent"), fields.userAgent);
        addField(t("settings.webdavAutoSync"), el("label", { class: "hc-checkbox" }, [fields.autoSync, el("span", { text: t("settings.webdavAutoSyncHint") })]));
        body.append(syncGrid);

        const syncActions = el("div", { class: "hc-body-toolbar" }, [
          el("button", {
            class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("settings.webdavTest"),
            on: {
              click: async () => {
                if (!bridge.backendReady) { util.toast(t("err.backendHint"), "error"); return; }
                try {
                  const result = await bridge.webdavTest(webdavConfigFromForm(fields));
                  util.toast(t("toast.webdavOk", { status: result.status }), "success");
                } catch (error) {
                  util.toast(t("toast.webdavFailed", { message: (error && error.message) || String(error) }), "error");
                }
              }
            }
          }),
          el("button", {
            class: "hc-btn hc-btn-sm", type: "button", text: t("settings.webdavUpload"),
            on: {
              click: async () => {
                if (!bridge.backendReady) { util.toast(t("err.backendHint"), "error"); return; }
                try {
                  const config = webdavConfigFromForm(fields);
                  Object.assign(store.state.settings.webdav, config, { autoSync: fields.autoSync.checked });
                  await store.persist();
                  const result = await bridge.webdavUpload(config, store.serializable());
                  util.toast(t("toast.webdavUploaded", { bytes: result.bytes }), "success");
                } catch (error) {
                  util.toast(t("toast.webdavFailed", { message: (error && error.message) || String(error) }), "error");
                }
              }
            }
          }),
          el("button", {
            class: "hc-btn hc-btn-sm", type: "button", text: t("settings.webdavDownload"),
            on: {
              click: async () => {
                if (!bridge.backendReady) { util.toast(t("err.backendHint"), "error"); return; }
                if (!await util.confirmDialog({ title: t("settings.webdavDownload"), message: t("settings.webdavDownloadConfirm") })) return;
                try {
                  const config = webdavConfigFromForm(fields);
                  const result = await bridge.webdavDownload(config);
                  store.state.tabs = [];
                  store.state.collections = [];
                  store.state.environments = [];
                  store.state.history = [];
                  store.state.activeEnvironmentId = "";
                  store.hydrate(result.store);
                  if (!store.state.tabs.length) store.createTab();
                  Object.assign(store.state.settings.webdav, config, { autoSync: fields.autoSync.checked });
                  await store.persist();
                  store.emit("loaded");
                  store.emit("sidebar");
                  store.emit("environments");
                  renderAll();
                  util.toast(t("toast.webdavDownloaded", { bytes: result.bytes }), "success");
                } catch (error) {
                  util.toast(t("toast.webdavFailed", { message: (error && error.message) || String(error) }), "error");
                }
              }
            }
          })
        ]);
        body.append(syncActions);

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
      actions: [
        {
          label: t("action.save2"), kind: "primary",
          onClick: (api) => {
            Object.assign(store.state.settings.webdav, webdavConfigFromForm(fields), { autoSync: fields.autoSync.checked });
            store.persist();
            util.toast(t("toast.saved"), "success");
            api.close();
          }
        },
        { label: t("action.close"), onClick: (api) => api.close() }
      ]
    });
  }

  function openSwaggerImport() {
    const textarea = el("textarea", {
      class: "hc-textarea", spellcheck: "false",
      placeholder: '{\n  "openapi": "3.0.0",\n  "info": { "title": "Demo" },\n  "paths": {}\n}'
    });
    const baseInput = el("input", { class: "hc-input", type: "text", placeholder: "https://api.example.com" });
    util.openModal({
      title: t("dialog.importSwaggerTitle"),
      render: (body) => {
        body.append(el("div", { class: "hc-hint", text: t("dialog.importSwaggerHint") }));
        body.append(el("label", { class: "hc-field" }, [
          el("span", { class: "hc-field-label", text: t("dialog.baseUrl") }),
          baseInput
        ]));
        body.append(textarea);
      },
      actions: [
        { label: t("action.cancel2"), onClick: (api) => api.close() },
        {
          label: t("action.import"), kind: "primary",
          onClick: async (api) => {
            const text = textarea.value.trim();
            if (!text) return;
            try {
              const result = await HC.swagger.importDocument(text, { baseUrl: baseInput.value.trim() });
              const collection = store.createCollection((result.collection && result.collection.name) || "OpenAPI");
              (result.collection.requests || []).forEach((request) => {
                collection.requests.push(Object.assign({ id: util.uid("saved"), protocol: "http" }, request));
              });
              store.persist();
              store.emit("sidebar");
              util.toast(t("toast.imported", { count: result.count || collection.requests.length }), "success");
              api.close();
            } catch (error) {
              util.toast(t("toast.importFailed", { message: (error && error.message) || String(error) }), "error");
            }
          }
        }
      ]
    });
  }

  async function reflectGrpc() {
    const tab = store.activeTab();
    if (!tab || (tab.protocol || "http") !== "grpc") return;
    if (!bridge.backendReady) { util.toast(t("err.backendHint"), "error"); return; }
    if (!tab.grpc) tab.grpc = { target: "", method: "", plaintext: true, authority: "" };
    tab.grpc.target = tab.url || tab.grpc.target;
    if (!String(tab.grpc.target || "").trim()) {
      util.toast(t("toast.grpcTargetRequired"), "error");
      return;
    }
    try {
      const result = await bridge.grpcReflect({
        target: store.resolve(tab.grpc.target),
        plaintext: tab.grpc.plaintext !== false,
        verifyTls: tab.options.verifyTls !== false,
        authority: store.resolve(tab.grpc.authority || ""),
        headers: (tab.headers || []).filter((row) => row.enabled !== false && row.key).map((row) => ({
          key: store.resolve(row.key), value: store.resolve(row.value), enabled: true
        })),
        timeoutMs: Number(tab.options.timeoutMs) || 30000
      });
      const methods = [];
      (result.services || []).forEach((service) => {
        (service.methods || []).forEach((method) => {
          methods.push(method.fullName || `${service.name}/${method.name}`);
        });
      });
      if (!methods.length) {
        util.toast(t("toast.grpcNoMethods"), "error");
        return;
      }
      const select = el("select", { class: "hc-select" });
      methods.forEach((name) => select.append(el("option", { value: name, text: name })));
      if (tab.grpc.method) select.value = tab.grpc.method;
      util.openModal({
        title: t("dialog.grpcReflectTitle"),
        render: (body) => {
          body.append(el("div", { class: "hc-hint", text: t("dialog.grpcReflectHint", { count: methods.length }) }));
          body.append(select);
        },
        actions: [
          { label: t("action.cancel2"), onClick: (api) => api.close() },
          {
            label: t("action.confirm"), kind: "primary",
            onClick: (api) => {
              tab.grpc.method = select.value;
              tab.section = "grpc";
              store.markDirty(tab);
              HC.viewRequest.render();
              api.close();
            }
          }
        ]
      });
    } catch (error) {
      util.toast(t("toast.grpcReflectFailed", { message: (error && error.message) || String(error) }), "error");
    }
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
    util.$("#btn-save-menu").addEventListener("click", (event) => openSaveMenu(event));
    util.$("#btn-copy-curl").addEventListener("click", copyCurl);
    util.$("#btn-import-curl").addEventListener("click", openCurlImport);
    util.$("#btn-import-swagger").addEventListener("click", openSwaggerImport);
    util.$("#btn-grpc-reflect").addEventListener("click", reflectGrpc);
    util.$("#btn-settings").addEventListener("click", openSettings);
    util.$("#btn-toggle-sidebar").addEventListener("click", () => {
      store.state.settings.sidebarCollapsed = !store.state.settings.sidebarCollapsed;
      applyLayout();
      store.persist();
    });

    const protocolSelect = util.$("#protocol-select");
    protocolSelect.addEventListener("change", () => {
      const tab = store.activeTab();
      tab.protocol = protocolSelect.value;
      if (tab.protocol === "grpc") {
        if (!tab.grpc) tab.grpc = { target: "", method: "", plaintext: true, authority: "" };
        tab.grpc.target = tab.url || tab.grpc.target;
        tab.body.mode = "raw";
        tab.body.contentType = "application/json";
        if (!tab.body.raw) tab.body.raw = "{\n}\n";
        tab.section = "grpc";
      } else if (tab.section === "grpc") {
        tab.section = "params";
      }
      store.markDirty(tab);
      renderTabs();
      HC.viewRequest.render();
      renderToolbarState();
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
      if ((tab.protocol || "http") === "grpc") {
        if (!tab.grpc) tab.grpc = { target: "", method: "", plaintext: true, authority: "" };
        tab.grpc.target = urlInput.value;
      }
      store.markDirty(tab);
      HC.viewRequest.updateUrlFlag(tab);
    });
    urlInput.addEventListener("change", () => {
      const tab = store.activeTab();
      tab.url = urlInput.value;
      if ((tab.protocol || "http") === "grpc") {
        if (!tab.grpc) tab.grpc = { target: "", method: "", plaintext: true, authority: "" };
        tab.grpc.target = urlInput.value;
      } else {
        HC.viewRequest.syncParamsFromUrl(tab);
      }
      store.markDirty(tab);
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
      if (reason === "tab-dirty") { renderToolbarState(); syncDirtyIndicators(); }
      if (reason === "sidebar") HC.viewSidebar.render();
      if (reason === "environments") { renderEnvironmentSelect(); HC.viewSidebar.render(); }
      if (reason === "loaded") { HC.viewRequest.render(); HC.viewResponse.render(); }
    });

    document.addEventListener("keydown", (event) => {
      const primary = event.metaKey || event.ctrlKey;
      if (!primary) return;
      const sidebarFocused = event.target && event.target.closest && event.target.closest("#sidebar");
      if (event.key === "Enter") { event.preventDefault(); send(); }
      else if (event.key.toLowerCase() === "s") {
        if (!util.$("#modal-host").hidden) return;
        event.preventDefault();
        if (event.shiftKey) saveRequestAs();
        else saveRequest();
      }
      else if (event.key.toLowerCase() === "t") { event.preventDefault(); store.createTab(); HC.viewRequest.render(); HC.viewResponse.render(); }
      else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (sidebarFocused) HC.viewSidebar.focusSearch();
        else util.$("#url-input").focus();
      }
      else if (event.key.toLowerCase() === "f" && sidebarFocused) {
        event.preventDefault();
        HC.viewSidebar.focusSearch();
      }
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

  async function maybeAutoSync() {
    const webdav = store.state.settings.webdav;
    if (!webdav || !webdav.autoSync || !webdav.endpoint || !bridge.backendReady) return;
    try {
      await bridge.webdavUpload({
        endpoint: webdav.endpoint,
        username: webdav.username,
        password: webdav.password,
        remotePath: webdav.remotePath,
        userAgent: webdav.userAgent
      }, store.serializable());
    } catch (error) {
      /* auto-sync is best-effort; settings stay local */
    }
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
    applySurface();
    await store.init();
    applySurface();
    applyLayout();
    renderAll();
    if (settled) {
      if (!bridge.backendReady) util.toast(t("err.backendHint"), "error");
      else maybeAutoSync();
      return;
    }
    // The handshake was still in flight when the guard fired. Refresh the toolbar
    // once it lands, otherwise the send button stays disabled for the whole session.
    bridge.ready.then(() => {
      HC.i18n.setLocale(bridge.locale);
      staticLabels();
      applySurface();
      applyLayout();
      renderAll();
      renderToolbarState();
      if (!bridge.backendReady) util.toast(t("err.backendHint"), "error");
      else maybeAutoSync();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
