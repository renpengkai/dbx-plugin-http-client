/* Request pane: URL row wiring, section tabs and the params / headers / body /
   auth / options panels. */

(function () {
  const util = HC.util;
  const store = HC.store;
  const t = (key, params) => HC.i18n.t(key, params);
  const el = util.el;

  const SECTIONS = [
    { id: "params", label: "section.params" },
    { id: "headers", label: "section.headers" },
    { id: "body", label: "section.body" },
    { id: "auth", label: "section.auth" },
    { id: "options", label: "section.options" }
  ];

  const BODY_MODES = [
    { id: "none", label: "body.none" },
    { id: "raw", label: "body.raw" },
    { id: "urlencoded", label: "body.urlencoded" },
    { id: "formdata", label: "body.formdata" }
  ];

  const CONTENT_TYPES = ["application/json", "application/xml", "text/plain", "text/html", "application/x-www-form-urlencoded", ""];

  let currentTab = null;

  /* --------------------------------------------------------------- URL sync */

  function parseQuery(url) {
    const index = url.indexOf("?");
    if (index < 0) return [];
    const hashIndex = url.indexOf("#", index);
    const query = url.slice(index + 1, hashIndex < 0 ? undefined : hashIndex);
    const rows = [];
    query.split("&").forEach((pair) => {
      if (!pair) return;
      const eq = pair.indexOf("=");
      if (eq < 0) rows.push({ key: decodeSafe(pair), value: "", enabled: true });
      else rows.push({ key: decodeSafe(pair.slice(0, eq)), value: decodeSafe(pair.slice(eq + 1)), enabled: true });
    });
    return rows;
  }

  function decodeSafe(value) {
    try { return decodeURIComponent(value.replace(/\+/g, " ")); } catch (error) { return value; }
  }

  function buildQuery(rows) {
    return rows
      .filter((row) => row.enabled !== false && String(row.key || "").trim() !== "")
      .map((row) => `${encodeURIComponent(row.key)}=${encodeURIComponent(row.value === undefined ? "" : row.value)}`)
      .join("&");
  }

  function syncParamsFromUrl(tab) {
    const parsed = parseQuery(tab.url || "");
    const signature = (rows) => rows.filter((row) => row.key || row.value).map((row) => `${row.key}=${row.value}`).join("&");
    if (signature(parsed) === signature(tab.params || [])) return false;
    tab.params = parsed.concat([util.emptyRow()]);
    return true;
  }

  function syncUrlFromParams(tab) {
    const query = buildQuery(tab.params || []);
    const input = util.$("#url-input");
    const url = tab.url || "";
    const index = url.indexOf("?");
    const hashIndex = url.indexOf("#");
    const base = index < 0 ? url : url.slice(0, index);
    const hash = hashIndex < 0 ? "" : url.slice(hashIndex);
    const next = query ? `${base}?${query}${hash}` : `${base}${hash}`;
    tab.url = next;
    if (input) input.value = next;
    updateUrlFlag(tab);
  }

  function updateUrlFlag(tab) {
    const flag = util.$("#url-flag");
    if (!flag) return;
    const missing = store.collectMissingVariables(tab);
    if (missing.length) {
      flag.hidden = false;
      flag.textContent = `{{${missing[0]}}}?`;
      flag.title = missing.join(", ");
    } else {
      flag.hidden = true;
      flag.textContent = "";
    }
  }

  /* -------------------------------------------------------------- rendering */

  function render() {
    const tab = store.activeTab();
    if (!tab) return;
    currentTab = tab;
    const methodSelect = util.$("#method-select");
    const urlInput = util.$("#url-input");
    methodSelect.value = tab.method;
    if (urlInput.value !== tab.url) urlInput.value = tab.url || "";
    updateUrlFlag(tab);
    renderSections(tab);
    renderPanels(tab);
    updateTitle(tab);
  }

  function updateTitle(tab) {
    const nameInput = util.$("#request-title");
    if (nameInput && document.activeElement !== nameInput) nameInput.value = store.requestTitle(tab);
  }

  function countActive(rows) {
    return (rows || []).filter((row) => row && row.enabled !== false && row.key).length;
  }

  function renderSections(tab) {
    const host = util.clear(util.$("#request-sections"));
    SECTIONS.forEach((section) => {
      const button = el("button", {
        class: `hc-section${tab.section === section.id ? " is-active" : ""}`,
        type: "button",
        text: t(section.label),
        on: {
          click: () => {
            tab.section = section.id;
            store.schedulePersist();
            render();
          }
        }
      });
      let badge = null;
      if (section.id === "params") badge = countActive(tab.params);
      if (section.id === "headers") badge = countActive(tab.headers);
      if (section.id === "body" && tab.body.mode !== "none") badge = "•";
      if (section.id === "auth" && tab.auth.type !== "none") badge = "•";
      if (section.id === "options") {
        const defaults = tab.options.verifyTls === false || tab.options.proxyMode !== "environment";
        badge = defaults ? "•" : null;
      }
      if (badge !== null && badge !== 0 && badge !== "") {
        button.append(el("span", { class: "hc-badge is-on", text: String(badge) }));
      }
      host.append(button);
    });
  }

  function renderPanels(tab) {
    const host = util.clear(util.$("#request-panels"));
    const panel = el("div", { class: "hc-panel" });
    host.append(panel);
    if (tab.section === "params") renderParams(panel, tab);
    else if (tab.section === "headers") renderHeaders(panel, tab);
    else if (tab.section === "body") renderBody(panel, tab);
    else if (tab.section === "auth") renderAuth(panel, tab);
    else renderOptions(panel, tab);
  }

  function markChanged(tab) {
    store.markDirty(tab);
  }

  function renderParams(panel, tab) {
    const hint = el("div", { class: "hc-hint" });
    hint.append(document.createTextNode(t("params.syncHint")));
    hint.append(el("code", { text: t("params.variable") }));
    hint.append(document.createTextNode(t("params.resolveHint")));
    panel.append(hint);
    const kvHost = el("div", {});
    panel.append(kvHost);
    util.createKVEditor(kvHost, {
      rows: tab.params.length ? tab.params : (tab.params = [util.emptyRow()]),
      keyPlaceholder: t("kv.key"),
      onChange: () => { syncUrlFromParams(tab); markChanged(tab); }
    });
  }

  function renderHeaders(panel, tab) {
    const toolbar = el("div", { class: "hc-body-toolbar" });
    toolbar.append(el("span", { class: "hc-hint", text: t("headers.presets") }));
    ["Accept: application/json", "Content-Type: application/json", "Authorization: Bearer ", "User-Agent: "].forEach((preset) => {
      const [key, value] = preset.split(": ");
      toolbar.append(el("button", {
        class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: key,
        on: {
          click: () => {
            // 先清掉尾部的空白行，再追加预设行，最后补一行新的空行。否则预设会
            // 排在既有空行之后，界面上就多出一行空列（编辑器始终保留一行待输入）。
            const rows = tab.headers;
            while (rows.length && !rows[rows.length - 1].key && !rows[rows.length - 1].value) rows.pop();
            rows.push({ key, value: value || "", enabled: true });
            store.markDirty(tab);
            render();
          }
        }
      }));
    });
    panel.append(toolbar);
    const kvHost = el("div", {});
    panel.append(kvHost);
    util.createKVEditor(kvHost, {
      rows: tab.headers.length ? tab.headers : (tab.headers = [util.emptyRow()]),
      onChange: () => markChanged(tab)
    });
  }

  function renderBody(panel, tab) {
    const modeRow = el("div", { class: "hc-body-toolbar" });
    BODY_MODES.forEach((mode) => {
      const input = el("input", { type: "radio", name: "body-mode" });
      const label = el("label", { class: `hc-radio${tab.body.mode === mode.id ? " is-on" : ""}` }, [input, el("span", { text: t(mode.label) })]);
      input.addEventListener("change", () => {
        tab.body.mode = mode.id;
        if (mode.id === "formdata" && !tab.body.fields.length) tab.body.fields = [util.emptyRow()];
        if (mode.id === "urlencoded" && !tab.body.fields.length) tab.body.fields = [util.emptyRow()];
        store.markDirty(tab);
        render();
      });
      modeRow.append(label);
    });
    panel.append(modeRow);

    if (tab.body.mode === "none") {
      panel.append(el("div", { class: "hc-hint", text: t("body.empty") }));
      return;
    }

    if (tab.body.mode === "raw") {
      const contentTypeSelect = el("select", { id: "content-type-select", class: "hc-select hc-select-flat" });
      CONTENT_TYPES.forEach((type) => contentTypeSelect.append(el("option", { value: type, text: type || t("body.noContentType") })));
      contentTypeSelect.value = tab.body.contentType || "application/json";
      contentTypeSelect.addEventListener("change", () => { tab.body.contentType = contentTypeSelect.value; markChanged(tab); });
      const toolbar = el("div", { class: "hc-body-toolbar" }, [
        el("span", { class: "hc-hint", text: t("body.contentType") }),
        contentTypeSelect,
        el("button", {
          class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("action.format"),
          on: {
            click: () => {
              const formatted = util.tryFormatJson(textarea.value) || util.tryFormatXml(textarea.value);
              if (formatted) { textarea.value = formatted; tab.body.raw = formatted; markChanged(tab); }
            }
          }
        }),
        el("span", { class: "hc-hint", text: t("body.rawHint") })
      ]);
      const textarea = el("textarea", {
        class: "hc-textarea", spellcheck: "false", placeholder: t("body.placeholder"), value: tab.body.raw || ""
      });
      textarea.addEventListener("input", () => { tab.body.raw = textarea.value; markChanged(tab); });
      panel.append(toolbar, textarea);
      return;
    }

    const allowFiles = tab.body.mode === "formdata";
    panel.append(el("div", {
      class: "hc-hint",
      text: allowFiles ? t("body.formHint") : t("body.urlHint")
    }));
    const kvHost = el("div", {});
    panel.append(kvHost);
    util.createKVEditor(kvHost, {
      rows: tab.body.fields.length ? tab.body.fields : (tab.body.fields = [util.emptyRow()]),
      allowFiles,
      onChange: () => markChanged(tab)
    });
  }

  function renderAuth(panel, tab) {
    const types = [
      { id: "none", label: "auth.none" },
      { id: "basic", label: "auth.basic" },
      { id: "bearer", label: "auth.bearer" },
      { id: "apikey", label: "auth.apikey" }
    ];
    const row = el("div", { class: "hc-body-toolbar" });
    types.forEach((type) => {
      const input = el("input", { type: "radio", name: "auth-type" });
      const label = el("label", { class: `hc-radio${tab.auth.type === type.id ? " is-on" : ""}` }, [input, el("span", { text: t(type.label) })]);
      input.addEventListener("change", () => {
        tab.auth.type = type.id;
        store.markDirty(tab);
        render();
      });
      row.append(label);
    });
    panel.append(row);

    if (tab.auth.type === "none") {
      panel.append(el("div", { class: "hc-hint", text: t("auth.hint") }));
      return;
    }

    const grid = el("div", { class: "hc-form-grid" });
    const field = (labelKey, key, options) => {
      grid.append(el("span", { class: "hc-field-label", text: t(labelKey) }));
      const input = el("input", {
        class: "hc-input",
        type: (options && options.type) || "text",
        value: tab.auth[key] || "",
        placeholder: (options && options.placeholder) || ""
      });
      input.addEventListener("input", () => { tab.auth[key] = input.value; markChanged(tab); });
      grid.append(input);
    };

    if (tab.auth.type === "basic") {
      field("auth.username", "username");
      field("auth.password", "password", { type: "password" });
    } else if (tab.auth.type === "bearer") {
      field("auth.token", "token", { type: "password", placeholder: "eyJhbGciOi..." });
    } else if (tab.auth.type === "apikey") {
      field("auth.key", "key", { placeholder: "X-API-Key" });
      field("auth.value", "value", { type: "password" });
      grid.append(el("span", { class: "hc-field-label", text: t("auth.in") }));
      const select = el("select", { class: "hc-select" }, [
        el("option", { value: "header", text: t("auth.inHeader") }),
        el("option", { value: "query", text: t("auth.inQuery") })
      ]);
      select.value = tab.auth.in || "header";
      select.addEventListener("change", () => { tab.auth.in = select.value; markChanged(tab); });
      grid.append(select);
    }
    panel.append(grid);
    panel.append(el("div", { class: "hc-hint", text: t("auth.hint") }));
  }

  function renderOptions(panel, tab) {
    const grid = el("div", { class: "hc-form-grid" });

    const numberField = (labelKey, key, options) => {
      grid.append(el("span", { class: "hc-field-label", text: t(labelKey) }));
      const input = el("input", {
        class: "hc-input", type: "number", value: tab.options[key],
        min: options.min, max: options.max, step: options.step || 1
      });
      input.addEventListener("change", () => {
        const value = Number(input.value);
        if (Number.isFinite(value)) { tab.options[key] = value; markChanged(tab); }
      });
      grid.append(input);
    };

    const checkboxField = (labelKey, key, inverted) => {
      grid.append(el("span", { class: "hc-field-label", text: t(labelKey) }));
      const input = el("input", { type: "checkbox", checked: inverted ? tab.options[key] === false : tab.options[key] !== false });
      input.addEventListener("change", () => { tab.options[key] = inverted ? !input.checked : input.checked; markChanged(tab); });
      const wrap = el("label", { class: "hc-checkbox" }, [input]);
      if (key === "verifyTls" && tab.options.verifyTls === false) {
        wrap.append(el("span", { class: "hc-hint", text: t("options.verifyTlsOff") }));
      }
      grid.append(wrap);
    };

    numberField("options.timeout", "timeoutMs", { min: 500, max: 115000, step: 500 });
    numberField("options.maxRedirects", "maxRedirects", { min: 0, max: 50 });
    checkboxField("options.followRedirects", "followRedirects");
    checkboxField("options.verifyTls", "verifyTls");

    grid.append(el("span", { class: "hc-field-label", text: t("options.proxy") }));
    const proxySelect = el("select", { class: "hc-select" }, [
      el("option", { value: "environment", text: t("options.proxy.environment") }),
      el("option", { value: "direct", text: t("options.proxy.direct") }),
      el("option", { value: "custom", text: t("options.proxy.custom") })
    ]);
    proxySelect.value = tab.options.proxyMode || "environment";
    proxySelect.addEventListener("change", () => { tab.options.proxyMode = proxySelect.value; markChanged(tab); render(); });
    grid.append(proxySelect);

    if (tab.options.proxyMode === "custom") {
      grid.append(el("span", { class: "hc-field-label", text: t("options.proxyUrl") }));
      const proxyInput = el("input", { class: "hc-input", type: "text", value: tab.options.proxyUrl || "", placeholder: "http://127.0.0.1:7890" });
      proxyInput.addEventListener("input", () => { tab.options.proxyUrl = proxyInput.value; markChanged(tab); });
      grid.append(proxyInput);
    }

    grid.append(el("span", { class: "hc-field-label", text: t("options.maxBodyBytes") }));
    const sizeSelect = el("select", { class: "hc-select hc-select-flat" }, [
      el("option", { value: "1048576", text: "1 MiB" }),
      el("option", { value: "8388608", text: "8 MiB" }),
      el("option", { value: "33554432", text: "32 MiB" }),
      el("option", { value: "67108864", text: "64 MiB" })
    ]);
    sizeSelect.value = String(tab.options.maxBodyBytes || 33554432);
    sizeSelect.addEventListener("change", () => { tab.options.maxBodyBytes = Number(sizeSelect.value); markChanged(tab); });
    grid.append(sizeSelect);

    panel.append(grid);
    panel.append(el("div", { class: "hc-hint", text: t("options.hint") }));
  }

  window.HC.viewRequest = { render, syncParamsFromUrl, syncUrlFromParams, updateUrlFlag, buildQuery };
})();
