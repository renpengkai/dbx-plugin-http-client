/* Response pane: status line, body/headers/cookies/request views, chunked body
   loading for oversized responses and saving to disk through the sidecar. */

(function () {
  const util = HC.util;
  const store = HC.store;
  const t = (key, params) => HC.i18n.t(key, params);
  const el = util.el;

  const RESPONSE_TABS = [
    { id: "body", label: "response.body" },
    { id: "headers", label: "response.headers" },
    { id: "cookies", label: "response.cookies" },
    { id: "request", label: "response.request" }
  ];

  let progressUnsubscribe = null;
  let loading = false;

  function viewState(tab) {
    if (!tab.responseView) tab.responseView = { tab: "body", bodyMode: "pretty" };
    return tab.responseView;
  }

  function render() {
    const host = util.$("#response-pane");
    if (!host) return;
    const tab = store.activeTab();
    util.clear(host);
    if (!tab) return;
    const result = tab.response;

    if (tab.sending && !result) {
      host.append(el("div", { class: "hc-response-empty" }, [
        el("div", { class: "hc-body-toolbar" }, [
          el("span", { class: "hc-spinner" }),
          el("span", { text: t("response.sending") }),
          el("span", { class: "hc-hint", id: "response-progress", text: formatProgress(tab.progress) })
        ])
      ]));
      return;
    }
    if (!result) {
      host.append(el("div", { class: "hc-response-empty", text: t("response.empty") }));
      return;
    }
    if (result.ok === false) {
      host.append(renderError(tab, result));
      return;
    }
    host.append(renderStatusBar(tab, result));

    const state = viewState(tab);
    const tabsHost = el("div", { class: "hc-response-tabs" });
    RESPONSE_TABS.forEach((item) => {
      const icon = item.id === "headers" ? ` (${(result.headers || []).length})`
        : item.id === "cookies" ? ` (${(result.setCookies || []).length})` : "";
      tabsHost.append(el("button", {
        class: `hc-section${state.tab === item.id ? " is-active" : ""}`,
        type: "button",
        text: t(item.label) + icon,
        on: { click: () => { state.tab = item.id; render(); } }
      }));
    });
    host.append(tabsHost);

    const bodyHost = el("div", { class: "hc-response-body" });
    host.append(bodyHost);
    if (state.tab === "body") renderBody(bodyHost, tab, result);
    else if (state.tab === "headers") renderHeaders(bodyHost, result);
    else if (state.tab === "cookies") renderCookies(bodyHost, result);
    else renderRequest(bodyHost, result);
  }

  function formatProgress(progress) {
    if (!progress) return "";
    if (progress.phase === "receiving" && progress.received) return util.formatBytes(progress.received);
    return progress.phase === "receiving" ? "接收响应…" : "正在发送…";
  }

  function renderStatusBar(tab, result) {
    const status = result.status || 0;
    const host = el("div", { class: "hc-response-head" });
    host.append(el("span", {
      class: `hc-status ${util.statusClass(status, true)}`,
      text: status ? `${status} ${result.statusText || ""}`.trim() : "—"
    }));
    host.append(el("span", { class: "hc-metrics", text: `HTTP/${result.httpVersion || "1.1"}` }));
    host.append(el("span", { class: "hc-metrics", text: util.formatDuration(result.durationMs) }));
    host.append(el("span", { class: "hc-metrics", text: util.formatBytes(result.sizeBytes) }));
    if (result.firstByteMs !== undefined && result.firstByteMs !== null) {
      host.append(el("span", { class: "hc-metrics", text: `TTFB ${util.formatDuration(result.firstByteMs)}` }));
    }
    if ((result.redirects || []).length) {
      host.append(el("span", {
        class: "hc-metrics",
        text: `${t("response.redirects")} ×${result.redirects.length}`,
        title: result.redirects.map((hop) => `${hop.status} → ${hop.location}`).join("\n")
      }));
    }
    host.append(el("span", { class: "hc-grow" }));
    if (result.finalUrl) {
      host.append(el("span", { class: "hc-hint", text: result.finalUrl, title: result.finalUrl }));
    }
    host.append(el("button", {
      class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("response.saveToFile"),
      on: { click: () => saveToFile(tab, result) }
    }));
    host.append(el("button", {
      class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("response.copyBody"),
      on: { click: () => copyBody(tab, result) }
    }));
    return host;
  }

  function renderError(tab, result) {
    const error = result.error || {};
    const kindLabel = t(`err.${error.kind}`) || t("err.network");
    const host = el("div", { class: "hc-error-card" });
    host.append(el("h4", { text: `${kindLabel}（${error.kind || "unknown"}）` }));
    host.append(el("div", { text: error.message || "" }));
    host.append(el("div", { class: "hc-hint", text: `${util.formatDuration(result.durationMs)} · ${result.method} ${result.url}` }));
    if ((result.redirects || []).length) {
      host.append(el("div", { class: "hc-hint", text: result.redirects.map((hop) => `${hop.status} → ${hop.location}`).join("\n") }));
    }
    const detail = el("button", { class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("response.sentHeaders") });
    const detailHost = el("div", { hidden: true });
    detail.addEventListener("click", () => {
      detailHost.hidden = !detailHost.hidden;
      if (!detailHost.hidden && !detailHost.childNodes.length) detailHost.append(headersTable(result.requestHeaders));
    });
    host.append(el("div", { class: "hc-body-toolbar" }, [detail]));
    host.append(detailHost);
    return host;
  }

  function currentBytes(tab, result) {
    if (tab.fullBody) return tab.fullBody;
    return util.base64ToBytes(result.bodyPreviewBase64 || "");
  }

  function currentText(tab, result) {
    return util.decodeText(tab.fullBody
      ? bytesToBase64(tab.fullBody)
      : (result.bodyPreviewBase64 || ""));
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192));
    }
    return btoa(binary);
  }

  function renderBody(host, tab, result) {
    const state = viewState(tab);
    const truncated = !tab.fullBody && (result.bodyPreviewBytes || 0) < (result.sizeBytes || 0);
    const total = result.sizeBytes || 0;
    const loaded = tab.fullBody ? tab.fullBody.length : (result.bodyPreviewBytes || 0);

    const toolbar = el("div", { class: "hc-body-toolbar" });
    const modes = [
      { id: "pretty", label: "response.pretty" },
      { id: "raw", label: "response.raw" },
      { id: "preview", label: "response.preview" }
    ];
    modes.forEach((mode) => {
      const input = el("input", { type: "radio", name: "body-view" });
      const label = el("label", { class: `hc-radio${state.bodyMode === mode.id ? " is-on" : ""}` }, [input, el("span", { text: t(mode.label) })]);
      input.addEventListener("change", () => { state.bodyMode = mode.id; render(); });
      toolbar.append(label);
    });
    toolbar.append(el("span", { class: "hc-hint", text: `${result.contentType || "unknown"} · ${util.formatBytes(loaded)}` }));
    host.append(toolbar);

    if (truncated) {
      const bar = el("div", { class: "hc-truncated" });
      bar.append(el("span", { text: t("response.truncated", { loaded: util.formatBytes(loaded), total: util.formatBytes(total) }) }));
      const loadButton = el("button", {
        class: "hc-btn hc-btn-sm", type: "button", text: t("response.loadFull"),
        disabled: !HC.bridge.backendReady || loading
      });
      loadButton.addEventListener("click", () => loadFullBody(tab, result, loadButton));
      bar.append(loadButton);
      host.append(bar);
    } else if (tab.fullBody && total > (result.bodyPreviewBytes || 0)) {
      host.append(el("div", { class: "hc-truncated" }, [el("span", { text: t("response.loaded", { size: util.formatBytes(tab.fullBody.length) }) })]));
    }

    if (state.bodyMode === "preview") {
      if (util.isImage(result.contentType)) {
        host.append(el("img", {
          class: "hc-preview-image",
          src: `data:${result.contentType};base64,${tab.fullBody ? bytesToBase64(tab.fullBody) : result.bodyPreviewBase64}`,
          alt: "response image"
        }));
        return;
      }
      if (/text\/html/i.test(result.contentType || "")) {
        host.append(el("div", { class: "hc-hint", text: t("response.htmlNote") }));
      } else if (!util.isTextual(result.contentType)) {
        host.append(el("div", { class: "hc-hint", text: `二进制响应（${result.contentType || "unknown"}），请使用「保存到文件」。` }));
        return;
      }
      host.append(el("pre", { class: "hc-code", text: currentText(tab, result).slice(0, 200000) }));
      return;
    }

    const content = currentText(tab, result);
    if (!util.isTextual(result.contentType)) {
      host.append(el("div", { class: "hc-hint", text: `二进制响应（${result.contentType || "unknown"}，${util.formatBytes(total)}），请使用「保存到文件」查看。` }));
      return;
    }
    if (state.bodyMode === "pretty") {
      const pretty = util.tryFormatJson(content) || (util.looksLikeJson(content) ? content : null);
      if (pretty) {
        host.append(el("pre", { class: "hc-code", html: util.highlightJson(pretty) }));
        return;
      }
    }
    host.append(el("pre", { class: "hc-code", text: content.slice(0, 500000) }));
  }

  async function loadFullBody(tab, result, button) {
    if (loading) return;
    loading = true;
    button.disabled = true;
    const total = result.sizeBytes || 0;
    const bytes = new Uint8Array(total);
    let offset = 0;
    try {
      while (offset < total) {
        const chunk = await HC.bridge.readBody(result.bodyId, offset, 512 * 1024);
        const piece = util.base64ToBytes(chunk.dataBase64 || "");
        bytes.set(piece, chunk.offset);
        offset = chunk.offset + chunk.length;
        button.textContent = t("response.loading", { percent: Math.round((offset / total) * 100) });
        if (chunk.eof || !chunk.length) break;
      }
      tab.fullBody = bytes.subarray(0, offset);
      render();
    } catch (error) {
      util.toast(t("toast.loadFailed", { message: error.message || error }), "error");
      button.disabled = false;
      button.textContent = t("response.loadFull");
    } finally {
      loading = false;
    }
  }

  async function copyBody(tab, result) {
    const text = tab.fullBody ? util.decodeText(bytesToBase64(tab.fullBody)) : (result.bodyPreviewBase64 ? util.decodeText(result.bodyPreviewBase64) : "");
    const ok = await HC.bridge.copy(text);
    util.toast(ok ? t("toast.copied") : t("toast.copyFailed"), ok ? "success" : "error");
  }

  async function saveToFile(tab, result) {
    if (!HC.bridge.backendReady) {
      util.toast(t("err.backendHint"), "error");
      return;
    }
    try {
      const saved = await HC.bridge.saveBody(result.bodyId, {});
      util.toast(t("toast.savedTo", { path: saved.path }), "success");
    } catch (error) {
      util.toast(t("toast.saveFailed", { message: error.message || error }), "error");
    }
  }

  function headersTable(headers) {
    const table = el("table", { class: "hc-table" });
    table.append(el("thead", {}, [el("tr", {}, [el("th", { text: t("kv.key") }), el("th", { text: t("kv.value") })])]));
    const body = el("tbody", {});
    (headers || []).forEach((header) => {
      body.append(el("tr", {}, [el("td", { text: header.key }), el("td", { text: header.value })]));
    });
    table.append(body);
    return table;
  }

  function renderHeaders(host, result) {
    host.append(headersTable(result.headers));
  }

  function renderCookies(host, result) {
    if (!(result.setCookies || []).length) {
      host.append(el("div", { class: "hc-hint", text: t("response.noCookies") }));
      return;
    }
    const list = el("div", { class: "hc-list" });
    result.setCookies.forEach((cookie) => list.append(el("div", { class: "hc-list-item" }, [el("span", { class: "hc-list-title", text: cookie })])));
    host.append(list);
  }

  function renderRequest(host, result) {
    host.append(el("div", { class: "hc-hint", text: `${result.method} ${result.finalUrl || result.url}` }));
    host.append(el("h4", { text: t("response.sentHeaders") }));
    host.append(headersTable(result.requestHeaders));
    if (result.requestBodyPreview) {
      host.append(el("h4", { text: t("response.sentBody") }));
      host.append(el("pre", { class: "hc-code", text: result.requestBodyPreview }));
    }
    if ((result.redirects || []).length) {
      host.append(el("h4", { text: t("response.redirects") }));
      const list = el("div", { class: "hc-list" });
      result.redirects.forEach((hop) => {
        list.append(el("div", { class: "hc-list-item" }, [
          el("span", { class: "hc-tag", text: String(hop.status) }),
          el("span", { class: "hc-list-title", text: hop.location })
        ]));
      });
      host.append(list);
    }
  }

  /* Live progress while a request is in flight. */
  function subscribeProgress() {
    if (progressUnsubscribe) return;
    progressUnsubscribe = HC.bridge.onProgress((params) => {
      const tab = store.state.tabs.find((item) => item.sending && item.requestId === params.requestId);
      if (!tab) return;
      tab.progress = params;
      const node = util.$("#response-progress");
      if (node) node.textContent = formatProgress(params);
    });
  }

  function setSending(tab, sending, requestId) {
    tab.sending = sending;
    tab.requestId = requestId || "";
    tab.progress = null;
    if (sending) subscribeProgress();
  }

  window.HC.viewResponse = { render, setSending };
})();
