/* DOM helpers, formatting, dialogs, toasts and the reusable key/value editor. */

(function () {
  const t = (key, params) => HC.i18n.t(key, params);

  function $(selector, root) { return (root || document).querySelector(selector); }
  function $$(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((key) => {
        const value = props[key];
        if (value === undefined || value === null) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "html") node.innerHTML = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key === "style") Object.assign(node.style, value);
        else if (key === "on") Object.keys(value).forEach((event) => node.addEventListener(event, value[event]));
        else if (key === "checked" || key === "disabled" || key === "selected" || key === "hidden") node[key] = !!value;
        else if (key === "value") node.value = value;
        else node.setAttribute(key, value);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach((child) => {
        if (child === null || child === undefined || child === false) return;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
      });
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  let sequence = 0;
  function uid(prefix) {
    sequence += 1;
    return `${prefix || "id"}-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function escapeHtml(text, keepQuotes) {
    let out = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (!keepQuotes) out = out.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return out;
  }

  function escapeAttr(value) { return escapeHtml(value, true); }

  function formatBytes(size) {
    if (size === 0) return "0 B";
    if (!size || size < 0) return "—";
    const unit = 1024;
    if (size < unit) return `${size} B`;
    const units = ["KiB", "MiB", "GiB"];
    let value = size;
    let index = -1;
    while (value >= unit && index < units.length - 1) { value /= unit; index += 1; }
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined) return "—";
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function statusClass(status, ok) {
    if (!ok && !status) return "is-fail";
    if (status >= 500) return "is-5xx";
    if (status >= 400) return "is-4xx";
    if (status >= 300) return "is-3xx";
    if (status >= 200) return "is-2xx";
    return "is-fail";
  }

  /* ------------------------------------------------------------ clipboard -- */

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) { /* fall through to the legacy path */ }
    try {
      const area = el("textarea", { value: text, style: { position: "fixed", opacity: "0" } });
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (error) {
      return false;
    }
  }

  /* --------------------------------------------------------------- toasts -- */

  function toast(message, kind) {
    const host = $("#toast-host");
    if (!host) return;
    const node = el("div", { class: `hc-toast${kind ? ` is-${kind}` : ""}`, text: message });
    host.append(node);
    setTimeout(() => {
      node.style.transition = "opacity .2s";
      node.style.opacity = "0";
      setTimeout(() => node.remove(), 220);
    }, kind === "error" ? 6000 : 2800);
  }

  /* --------------------------------------------------------------- modals -- */

  let modalCloser = null;

  function closeModal() {
    const host = $("#modal-host");
    if (!host || host.hidden) return;
    host.hidden = true;
    clear(host);
    modalCloser = null;
  }

  function openModal(options) {
    const host = $("#modal-host");
    closeModal();
    const body = el("div", { class: "hc-modal-body" });
    const foot = el("div", { class: "hc-modal-foot" });
    const modal = el("div", { class: "hc-modal" }, [
      el("div", { class: "hc-modal-head" }, [
        el("span", { class: "hc-grow", text: options.title }),
        el("button", { class: "hc-icon-btn", type: "button", title: t("action.close"), text: "✕", on: { click: closeModal } })
      ]),
      body,
      foot
    ]);
    host.append(modal);
    host.hidden = false;

    const api = { body, foot, close: closeModal, modal };
    (options.actions || []).forEach((action) => {
      foot.append(el("button", {
        class: `hc-btn ${action.kind === "primary" ? "hc-btn-primary" : action.kind === "danger" ? "hc-btn-danger" : "hc-btn-ghost"}`,
        type: "button",
        text: action.label,
        disabled: action.disabled,
        on: { click: () => action.onClick(api) }
      }));
    });
    if (options.render) options.render(body, api);
    modalCloser = closeModal;
    setTimeout(() => {
      const focusable = body.querySelector("input, textarea, select");
      if (focusable) focusable.focus();
    }, 20);
    return api;
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modalCloser) { event.preventDefault(); modalCloser(); }
  });
  document.addEventListener("click", (event) => {
    if (event.target && event.target.id === "modal-host") closeModal();
  });

  function confirmDialog(options) {
    return new Promise((resolve) => {
      openModal({
        title: options.title,
        render: (body) => {
          body.append(el("div", { text: options.message }));
          if (options.detail) body.append(el("div", { class: "hc-hint", text: options.detail }));
        },
        actions: [
          { label: t("action.cancel2"), onClick: (api) => { api.close(); resolve(false); } },
          { label: options.confirmLabel || t("action.delete"), kind: options.kind || "danger", onClick: (api) => { api.close(); resolve(true); } }
        ]
      });
    });
  }

  function promptDialog(options) {
    return new Promise((resolve) => {
      const input = el("input", { class: "hc-input", type: "text", value: options.value || "", placeholder: options.placeholder || "" });
      const submit = (api) => {
        const value = input.value.trim();
        if (!value && options.required !== false) { input.focus(); return; }
        api.close();
        resolve(value);
      };
      openModal({
        title: options.title,
        render: (body, api) => {
          body.append(el("label", { class: "hc-field" }, [
            el("span", { class: "hc-field-label", text: options.label || t("dialog.name") }), input
          ]));
          if (options.hint) body.append(el("div", { class: "hc-hint", text: options.hint }));
          input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(api); } });
        },
        actions: [
          { label: t("action.cancel2"), onClick: (api) => { api.close(); resolve(null); } },
          { label: t("action.confirm"), kind: "primary", onClick: submit }
        ]
      });
    });
  }

  /* --------------------------------------------------- key/value editor --- */

  function emptyRow() { return { key: "", value: "", enabled: true }; }

  function createKVEditor(host, options) {
    const rows = options.rows;
    const allowFiles = !!options.allowFiles;
    const onChange = options.onChange || function () {};
    clear(host);
    host.classList.add("hc-kv");
    if (options.narrow) host.classList.add("is-narrow");
    host.append(el("div", { class: "hc-kv-head" }, [
      el("span", {}),
      el("span", { text: options.keyLabel || t("kv.key") }),
      el("span", { text: options.valueLabel || t("kv.value") }),
      el("span", {})
    ]));
    const body = el("div", {});
    host.append(body);
    let syncGuard = false;

    function ensureTail() {
      const last = rows[rows.length - 1];
      if (!last || last.key || last.value || last.fileName) {
        const row = emptyRow();
        rows.push(row);
        body.append(buildRow(row));
      }
    }

    function buildRow(row) {
      const wrap = el("div", { class: "hc-kv-row" });
      if (allowFiles && row.kind === "file") wrap.classList.add("is-file");
      const checkbox = el("input", { type: "checkbox", checked: row.enabled !== false });
      if (row.enabled === false) wrap.classList.add("is-off");
      checkbox.addEventListener("change", () => {
        row.enabled = checkbox.checked;
        wrap.classList.toggle("is-off", !checkbox.checked);
        emit();
      });
      wrap.append(el("label", { class: "hc-kv-check" }, [checkbox]));

      const keyInput = el("input", {
        type: "text", value: row.key || "",
        placeholder: options.keyPlaceholder || t("kv.key"), spellcheck: "false"
      });
      keyInput.addEventListener("input", () => { row.key = keyInput.value; emit(); });
      wrap.append(keyInput);

      if (allowFiles && row.kind === "file") {
        const fileInput = el("input", { type: "file", style: { display: "none" } });
        const label = el("div", { class: "hc-kv-file" });
        const name = el("span", { class: "hc-kv-file-name ellipsis", text: row.fileName ? `${row.fileName} (${formatBytes(row.size || 0)})` : t("body.noFile") });
        const pick = el("button", { class: "hc-btn hc-btn-sm hc-btn-ghost", type: "button", text: t("body.chooseFile") });
        const drop = el("button", { class: "hc-icon-btn", type: "button", text: "✕", title: t("body.clearFile"), hidden: !row.fileName });
        pick.addEventListener("click", () => fileInput.click());
        drop.addEventListener("click", () => {
          row.fileName = ""; row.dataBase64 = ""; row.size = 0;
          name.textContent = t("body.noFile"); drop.hidden = true; emit();
        });
        fileInput.addEventListener("change", async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          if (file.size > 1024 * 1024) { toast(t("toast.fileTooLarge"), "error"); fileInput.value = ""; return; }
          row.fileName = file.name; row.size = file.size; row.dataBase64 = await readFileBase64(file);
          name.textContent = `${file.name} (${formatBytes(file.size)})`;
          drop.hidden = false; emit();
        });
        label.append(pick, name, drop, fileInput);
        wrap.append(label);
      } else {
        const valueInput = el("input", {
          type: "text", value: row.value || "",
          placeholder: options.valuePlaceholder || t("kv.value"), spellcheck: "false"
        });
        valueInput.addEventListener("input", () => { row.value = valueInput.value; emit(); });
        wrap.append(valueInput);
      }

      const remove = el("button", { class: "hc-kv-del", type: "button", text: "✕", title: t("action.delete") });
      remove.addEventListener("click", () => {
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
        wrap.remove();
        ensureTail();
        emit();
      });
      wrap.append(remove);
      return wrap;
    }

    function emit() {
      if (syncGuard) return;
      syncGuard = true;
      ensureTail();
      syncGuard = false;
      onChange(rows);
    }

    rows.forEach((row) => body.append(buildRow(row)));
    ensureTail();
    return { rows, refresh: () => createKVEditor(host, options), element: host };
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /* ------------------------------------------------------- highlighting --- */

  function highlightJson(text) {
    const escaped = escapeHtml(text, true);
    return escaped.replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
      (match, string, colon, literal) => {
        if (string) {
          const cls = colon ? "hc-json-key" : "hc-json-string";
          return `<span class="${cls}">${string}</span>${colon || ""}`;
        }
        if (literal) return `<span class="hc-json-literal">${literal}</span>`;
        return `<span class="hc-json-number">${match}</span>`;
      }
    );
  }

  function tryFormatJson(text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object") return null;
      return JSON.stringify(parsed, null, 2);
    } catch (error) {
      return null;
    }
  }

  function looksLikeJson(text) {
    const trimmed = String(text || "").trim();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  }

  function tryFormatXml(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed.startsWith("<")) return null;
    let depth = 0;
    const tokens = trimmed.replace(/>\s*</g, ">\n<").split("\n");
    return tokens.map((token) => {
      const line = token.trim();
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const out = "  ".repeat(depth) + line;
      if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth += 1;
      return out;
    }).join("\n");
  }

  function isTextual(contentType) {
    const type = String(contentType || "").toLowerCase();
    return !type || /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|sql)|image\/svg)/.test(type);
  }

  function isImage(contentType) {
    return /^image\/(?!svg)/.test(String(contentType || "").toLowerCase());
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function decodeText(base64) {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(base64ToBytes(base64)); }
    catch (error) { return ""; }
  }

  window.HC.util = {
    $, $$, el, clear, uid, escapeHtml, escapeAttr,
    formatBytes, formatDuration, statusClass,
    copyText, toast, openModal, closeModal, confirmDialog, promptDialog,
    createKVEditor, emptyRow, readFileBase64,
    highlightJson, tryFormatJson, tryFormatXml, isTextual, isImage, looksLikeJson,
    debounce, decodeText, base64ToBytes
  };
})();
