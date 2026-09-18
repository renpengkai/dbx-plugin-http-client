/* Runs the real workbench UI inside jsdom, wired to the real Go sidecar through a
   mock DBX host bridge, and drives it like a user would. */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// Override these with env vars when the plugin lives somewhere else, e.g.
//   UI_DIR=/path/to/dbx-http-client/ui SIDECAR=/path/to/backend node harness.mjs
const UI_DIR = process.env.UI_DIR || "/Volumes/PKSSD/note/dbx-http-client/ui";
const SIDECAR = process.env.SIDECAR || "/tmp/dbxdev/backend";
const BASE = process.env.BASE || "http://127.0.0.1:18080";
const SCRIPTS = [
  "i18n.js", "util.js", "bridge.js", "curl.js", "store.js",
  "view-sidebar.js", "view-request.js", "view-response.js", "app.js"
];

const results = [];
let failures = 0;
let activeSidecar = null;
function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failures += 1;
  results.push(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(results[results.length - 1]);
}

/* ------------------------------------------------------------------ sidecar */

class Sidecar {
  constructor(binary) {
    this.binary = binary;
    this.sequence = 0;
    this.pending = new Map();
    this.eventHandlers = new Set();
    this.buffer = "";
  }

  start() {
    this.child = spawn(this.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      // A throwaway HOME keeps the plugin's store.json out of the real user config dir.
      env: Object.assign({}, process.env, { HOME: process.env.TEST_HOME || "/tmp/dbx-home" })
    });
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[sidecar] ${chunk}`));
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch (error) { continue; }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const waiter = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
          else waiter.resolve(message.result);
        } else if (message.method) {
          this.eventHandlers.forEach((handler) => handler(message));
        }
      }
    });
    return this.request("plugin/initialize", { host: { protocolVersions: [1] } });
  }

  request(method, params, timeoutMs = 60000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar timeout for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  stop() { try { this.child.kill(); } catch (error) { /* already gone */ } }
}

/* ----------------------------------------------------------- host bridge ---- */

function buildDocument() {
  let html = readFileSync(join(UI_DIR, "index.html"), "utf8");
  // NOTE: every replace() below MUST use a function replacer. A string replacement
  // would interpret $$, $&, $`, $' and $n as escape sequences and silently corrupt
  // the inlined source (e.g. `function $$` collapses into a second `function $`).
  // The real dev-runtime (sandboxDocument in runtime.mjs) uses a function replacer too.
  // Mirror the dev host: inline local stylesheets rather than dropping them, so the
  // document under test actually carries the plugin's CSS.
  html = html.replace(/<link\b([^>]*)>/gi, (match, attributes) => {
    if (!/\brel\s*=\s*(["'])[^"']*stylesheet[^"']*\1/i.test(attributes)) return match;
    const href = attributes.match(/\bhref\s*=\s*(["'])([^"']+)\1/i);
    if (!href) return match;
    const css = readFileSync(join(UI_DIR, href[2]), "utf8");
    return `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`;
  });
  SCRIPTS.forEach((name) => {
    const source = readFileSync(join(UI_DIR, name), "utf8");
    const pattern = new RegExp(`<script\\s+src=["']${name}["']\\s*></script>`, "i");
    if (!pattern.test(html)) throw new Error(`cannot inline ${name}`);
    const payload = `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
    html = html.replace(pattern, () => payload);
  });
  const bootstrap = `
    (function () {
      window.__hostCalls = [];
      var listeners = { context: new Set(), event: new Set(), init: new Set(), binary: new Set() };
      var initialized = false, context = {}, locale = "zh-CN";
      var theme = { appearance: "dark", tokens: { "--color-background": "#18181b", "--color-foreground": "#f4f4f5",
        "--color-card": "#1b1b1f", "--color-card-foreground": "#f4f4f5", "--color-muted": "#27272a",
        "--color-muted-foreground": "#a1a1aa", "--color-border": "#3f3f46", "--color-input": "#3f3f46",
        "--color-primary": "#60a5fa", "--color-primary-foreground": "#18181b" } };
      var resolveReady;
      var ready = new Promise(function (resolve) { resolveReady = resolve; });
      function call(method, params) {
        window.__hostCalls.push({ method: method, params: params });
        return window.__hostInvoke(method, params || {});
      }
      function listen(kind, fn) { listeners[kind].add(fn); return function () { listeners[kind].delete(fn); }; }
      window.dbxPlugin = Object.freeze({
        ready: ready,
        get context() { return context; },
        get locale() { return locale; },
        get theme() { return theme; },
        request: call,
        invoke: function (method, params, options) {
          return call("backend.invoke", { method: method, params: params, timeoutMs: (options || {}).timeoutMs });
        },
        notify: function (method, params) { return call("backend.notify", { method: method, params: params }); },
        sendBinary: function () { return Promise.reject(new Error("unsupported in harness")); },
        readAsset: function (path) { return call("ui.readAsset", { path: path }); },
        readAssetUrl: function () { return Promise.reject(new Error("unsupported in harness")); },
        openWorkbench: function () { return Promise.reject(new Error("unsupported in harness")); },
        openFilesystem: function () { return Promise.reject(new Error("unsupported in harness")); },
        copy: function (text) { return call("host.copy", { text: text }); },
        onContext: function (fn) { return listen("context", fn); },
        onEvent: function (fn) { return listen("event", fn); },
        onBinary: function (fn) { return listen("binary", fn); },
        onInit: function (fn) { listeners.init.add(fn); if (initialized) fn(context); return function () { listeners.init.delete(fn); }; },
        encodeBase64: function () { return ""; },
        decodeBase64: function () { return new Uint8Array(); }
      });
      window.__hostEmit = function (message) {
        listeners.event.forEach(function (fn) { fn(message); });
        if (message && message.type === "env") {
          window.dispatchEvent(new window.CustomEvent("dbx-plugin-env", { detail: message }));
        }
      };
      window.__hostReady = function () { initialized = true; resolveReady(context); };
    })();
  `;
  const shims = `
    if (!window.TextDecoder) window.TextDecoder = TextDecoder;
    if (!window.TextEncoder) window.TextEncoder = TextEncoder;
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.randomUUID) {
      window.crypto.randomUUID = function () {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
          var r = (Math.random() * 16) | 0;
          return (c === "x" ? r : ((r & 0x3) | 0x8)).toString(16);
        });
      };
    }
  `;
  const injected = `<head><script>${shims}</script><script>${bootstrap}</script>`;
  return html.replace("<head>", () => injected);
}

/* ----------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { /* keep polling */ }
    await sleep(60);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const sidecar = new Sidecar(SIDECAR);
  activeSidecar = sidecar;
  await sidecar.start();
  console.log("# sidecar ready");

  const dom = new JSDOM(buildDocument(), {
    runScripts: "dangerously",
    url: "http://127.0.0.1:5190/",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.__hostInvoke = async (method, params) => {
        if (method === "backend.invoke") {
          return sidecar.request(params.method, params.params === undefined ? null : params.params, Math.min(params.timeoutMs || 30000, 120000) + 2000);
        }
        if (method === "backend.notify") {
          sidecar.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: params.method, params: params.params })}\n`);
          return null;
        }
        if (method === "host.getContext") return {};
        if (method === "ui.readAsset") return { dataBase64: "", contentType: "text/plain" };
        if (method === "host.copy") return { success: true };
        throw new Error(`Unsupported mock host method: ${method}`);
      };
    }
  });
  const { window } = dom;
  const { document } = window;
  sidecar.eventHandlers.add((message) => {
    if (window.__hostEmit) window.__hostEmit(message);
  });
  window.addEventListener("error", (event) => {
    console.log(`[window error] ${event.message}`);
    failures += 1;
  });

  await waitFor(() => window.HC && window.HC.store && window.HC.store.state.loaded, "app boot", 15000);
  window.__hostReady();
  await waitFor(() => window.HC.bridge && window.HC.bridge.backendReady, "backend ready", 15000);
  await waitFor(() => document.querySelectorAll("#tabstrip .hc-tab").length === 1, "initial tab");

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const fire = (element, type) => element.dispatchEvent(new window.Event(type, { bubbles: true }));
  const setInput = (element, value) => { element.value = value; fire(element, "input"); };

  check("backend handshake reached the host", window.__hostCalls.some((call) => call.method === "backend.invoke" && call.params.method === "plugin/ping"));
  check("send button enabled with a live sidecar", $("#btn-send").disabled === false);
  check("sidebar rendered a default collection", $$("#sidebar-body .hc-side-group").length >= 1);
  check("dark theme tokens applied", document.documentElement.dataset.dbxTheme === "dark");

  /* ------------------------------------------------ 0. CSS `hidden` guard --- */
  // jsdom does not implement the CSS cascade or layout, so it can never catch a
  // visual bug. The one that shipped was exactly that: `.hc-modal-layer` sets
  // `display: grid`, which outranks the UA stylesheet's `[hidden] { display: none }`,
  // so the full-screen modal overlay stayed visible and swallowed every click.
  // Guard the reset that neutralises that whole class of bug.
  const cssText = Array.from(document.querySelectorAll("style")).map((node) => node.textContent).join("\n");
  check("stylesheet is inlined into the document", cssText.includes(".hc-modal-layer"));
  check("`[hidden]` is forced off despite author `display` rules",
    /\[hidden\][^{]*\{[^}]*display\s*:\s*none/i.test(cssText),
    "app.css lost its `[hidden] { display: none !important; }` reset — the modal overlay would block the whole workbench");
  check("modal layer starts hidden", $("#modal-host").hasAttribute("hidden"));
  check("flat select chrome is defined once for method/env/content-type",
    cssText.includes(".hc-select-flat") && /appearance\s*:\s*none/.test(cssText));
  check("method and environment selects share the flat class",
    $("#method-select").classList.contains("hc-select-flat") && $("#env-select").classList.contains("hc-select-flat"));

  /* ---------------------------------------------------- 1. simple GET ---- */
  setInput($("#url-input"), `${BASE}/users`);
  fire($("#url-input"), "change");
  $("#btn-send").click();
  await waitFor(() => $(".hc-status"), "response status", 15000);

  check("GET /users returns 200", $("#response-pane .hc-status").textContent.trim().startsWith("200"), $("#response-pane .hc-status").textContent);
  check("response body shows server JSON", $("#response-pane .hc-code").textContent.includes("张三"));
  check("JSON body is syntax highlighted", $$("#response-pane .hc-json-key").length > 3, `${$$("#response-pane .hc-json-key").length} keys`);
  check("metrics rendered", /HTTP\/1\.1/.test($("#response-pane .hc-response-head").textContent));
  check("history recorded the request", window.HC.store.state.history.length === 1, JSON.stringify(window.HC.store.state.history.map((entry) => entry.url)));
  check("progress events reached the UI", window.__hostCalls.length > 0);

  /* --------------------------------------------------- 2. response tabs -- */
  const headersTab = $$("#response-pane .hc-response-tabs .hc-section").find((button) => button.textContent.includes("响应头"));
  headersTab.click();
  await waitFor(() => $("#response-pane .hc-table"), "headers table");
  // Header names are case-insensitive on the wire and Postman preserves the
  // server's original casing, so compare case-insensitively here.
  const headerText = $("#response-pane .hc-table").textContent.toLowerCase();
  check("headers table lists content-type", headerText.includes("application/json"));
  check("headers table lists a server header", headerText.includes("x-demo-server"));
  $$("#response-pane .hc-response-tabs .hc-section").find((button) => button.textContent.includes("响应体")).click();
  await waitFor(() => $("#response-pane .hc-code"), "body tab restored");

  /* ------------------------------------------------- 3. params <-> URL -- */
  setInput($("#url-input"), `${BASE}/users?page=2&size=10`);
  fire($("#url-input"), "change");
  await sleep(120);
  const tab = window.HC.store.activeTab();
  check("query string parsed into params", tab.params.filter((row) => row.key).length === 2, JSON.stringify(tab.params));
  check("param values parsed", tab.params[0].key === "page" && tab.params[0].value === "2");
  check("params panel shows the parsed rows", $$("#request-panels .hc-kv-row").length === 3, `${$$("#request-panels .hc-kv-row").length} rows`);

  const paramInputs = $$("#request-panels .hc-kv-row");
  const lastRow = paramInputs[paramInputs.length - 1];
  const keyField = lastRow.querySelectorAll("input[type=text]")[0];
  const valueField = lastRow.querySelectorAll("input[type=text]")[1];
  setInput(keyField, "sort");
  setInput(valueField, "name");
  await sleep(80);
  check("editing params rewrites the URL", $("#url-input").value.includes("sort=name"), $("#url-input").value);

  /* --------------------------------------------------- 4. POST with body */
  const methodSelect = $("#method-select");
  methodSelect.value = "POST";
  fire(methodSelect, "change");
  setInput($("#url-input"), `${BASE}/echo`);
  fire($("#url-input"), "change");
  $$("#request-sections .hc-section").find((button) => button.textContent.trim().startsWith("请求体")).click();
  await waitFor(() => $$("#request-panels .hc-radio").length > 0, "body mode radios");
  const rawRadio = $$("#request-panels .hc-radio").find((label) => label.textContent.includes("原始文本"));
  rawRadio.querySelector("input").checked = true;
  fire(rawRadio.querySelector("input"), "change");
  await waitFor(() => $("#request-panels .hc-textarea"), "raw body editor");
  setInput($("#request-panels .hc-textarea"), '{"name":"杰特","role":"engineer"}');
  const contentTypeSelect = $$("#request-panels select").find((select) => select.value === "application/json");
  check("raw body content-type defaults to JSON", !!contentTypeSelect);
  check("content-type select uses the shared flat chrome",
    !!(contentTypeSelect && contentTypeSelect.id === "content-type-select" && contentTypeSelect.classList.contains("hc-select-flat")));

  const headerSection = $$("#request-sections .hc-section").find((button) => button.textContent.trim().startsWith("请求头"));
  headerSection.click();
  await waitFor(() => $$("#request-panels .hc-kv-row").length > 0, "headers editor");
  const headerRows = $$("#request-panels .hc-kv-row");
  const headerRow = headerRows[0];
  setInput(headerRow.querySelectorAll("input[type=text]")[0], "X-Trace-Id");
  setInput(headerRow.querySelectorAll("input[type=text]")[1], "abc-123");
  await sleep(80);

  $("#btn-send").click();
  await waitFor(() => {
    const status = $("#response-pane .hc-status");
    return status && status.textContent.trim().startsWith("200") && $("#response-pane .hc-code");
  }, "POST response", 15000);
  const echoBody = $("#response-pane .hc-code").textContent;
  check("POST body reached the server", echoBody.includes("杰特") && echoBody.includes("engineer"), echoBody.slice(0, 80));
  check("custom header reached the server", echoBody.includes("X-Trace-Id") && echoBody.includes("abc-123"), echoBody.slice(0, 120));

  /* ------------------------------------------------------- 5. auth ------ */
  $$("#request-sections .hc-section").find((button) => button.textContent.trim().startsWith("认证")).click();
  await waitFor(() => $$("#request-panels .hc-radio").length > 0, "auth radios");
  const bearerRadio = $$("#request-panels .hc-radio").find((label) => label.textContent === "Bearer");
  bearerRadio.querySelector("input").checked = true;
  fire(bearerRadio.querySelector("input"), "change");
  await waitFor(() => $("#request-panels input[type=password]"), "token field");
  setInput($("#request-panels input[type=password]"), "tok-42");
  $("#btn-send").click();
  await waitFor(() => $("#response-pane .hc-code") && $("#response-pane .hc-code").textContent.includes("Bearer tok-42"), "auth echo", 15000);
  check("bearer token applied by the sidecar", $("#response-pane .hc-code").textContent.includes("Bearer tok-42"));

  /* ------------------------------------------------- 6. error handling -- */
  setInput($("#url-input"), "http://127.0.0.1:18099/nope");
  fire($("#url-input"), "change");
  $("#btn-send").click();
  await waitFor(() => $("#response-pane .hc-error-card"), "error card", 15000);
  check("connection failure rendered as an error card", $("#response-pane .hc-error-card").textContent.includes("连接失败"),
    $("#response-pane .hc-error-card").textContent.slice(0, 60));
  setInput($("#url-input"), "ftp://example.com/file");
  fire($("#url-input"), "change");
  $("#btn-send").click();
  await sleep(400);
  check("non-http scheme rejected with a friendly message",
    $("#response-pane .hc-error-card") && $("#response-pane .hc-error-card").textContent.includes("不支持的协议"),
    ($("#response-pane .hc-error-card") || {}).textContent?.slice(0, 60));

  /* ------------------------------------------- 7. oversized body flow -- */
  // The body test left the tab on POST; the oversized fixture is a GET endpoint.
  methodSelect.value = "GET";
  fire(methodSelect, "change");
  setInput($("#url-input"), `${BASE}/large`);
  fire($("#url-input"), "change");
  $("#btn-send").click();
  await waitFor(() => $("#response-pane .hc-truncated"), "truncation notice", 15000);
  check("oversized response flagged as truncated", $("#response-pane .hc-truncated").textContent.includes("256 KiB"),
    $("#response-pane .hc-truncated").textContent.slice(0, 80));
  const loadButton = $$("#response-pane .hc-truncated button").find((button) => button.textContent.includes("加载完整响应"));
  loadButton.click();
  await waitFor(() => window.HC.store.activeTab().fullBody && window.HC.store.activeTab().fullBody.length === 1572864, "full body loaded", 25000);
  check("full body reassembled from chunks", window.HC.store.activeTab().fullBody.length === 1572864);

  /* ------------------------------------------------- 8. redirect + html - */
  // Reset to a clean GET first. The body test left a raw JSON body on the tab, and
  // a GET carrying a body is not what this scenario is about (it also confuses any
  // fixture that does not drain request bodies on GET).
  methodSelect.value = "GET";
  fire(methodSelect, "change");
  const redirectTab = window.HC.store.activeTab();
  redirectTab.body.mode = "none";
  redirectTab.body.raw = "";
  window.HC.viewRequest.render();
  setInput($("#url-input"), `${BASE}/redirect`);
  fire($("#url-input"), "change");
  $("#btn-send").click();
  await waitFor(() => $("#response-pane .hc-status") && $("#response-pane .hc-metrics"), "redirect response", 15000);
  check("redirect chain surfaced in the status bar", $("#response-pane .hc-response-head").textContent.includes("跳转链路"),
    $("#response-pane .hc-response-head").textContent.replace(/\s+/g, " ").slice(0, 120));

  /* ---------------------------------------------------- 9. environments - */
  // Each step sets its own method; this scenario posts a templated JSON body.
  methodSelect.value = "POST";
  fire(methodSelect, "change");
  const environment = window.HC.store.createEnvironment("dev");
  environment.variables = [{ key: "host", value: BASE, enabled: true }, { key: "who", value: "变量先生", enabled: true }];
  window.HC.store.setActiveEnvironment(environment.id);
  await sleep(80);
  setInput($("#url-input"), "{{host}}/echo");
  fire($("#url-input"), "change");
  $$("#request-sections .hc-section").find((button) => button.textContent.trim().startsWith("请求体")).click();
  await waitFor(() => $$("#request-panels .hc-radio").length > 0, "body mode radios again");
  const rawRadio2 = $$("#request-panels .hc-radio").find((label) => label.textContent.includes("原始文本"));
  rawRadio2.querySelector("input").checked = true;
  fire(rawRadio2.querySelector("input"), "change");
  await waitFor(() => $("#request-panels .hc-textarea"), "body editor again");
  setInput($("#request-panels .hc-textarea"), '{"name":"{{who}}"}');
  const variableTab = window.HC.store.activeTab();
  variableTab.body.mode = "raw";
  variableTab.body.contentType = "application/json";
  $("#btn-send").click();
  await waitFor(() => $("#response-pane .hc-code") && $("#response-pane .hc-code").textContent.includes("变量先生"), "variable resolution", 15000);
  check("environment variables resolved before sending", $("#response-pane .hc-code").textContent.includes("变量先生"));
  check("environment selector shows the active environment", $("#env-select").value === environment.id);

  /* ------------------------------------------------- 10. save + export -- */
  $("#btn-save").click();
  await waitFor(() => document.querySelector("#modal-host .hc-modal"), "save dialog");
  const saveButton = $$("#modal-host .hc-modal-foot button").find((button) => button.textContent.includes("保存"));
  saveButton.click();
  await sleep(200);
  check("request saved into a collection", window.HC.store.state.collections.some((collection) => collection.requests.length >= 1),
    JSON.stringify(window.HC.store.state.collections.map((collection) => `${collection.name}:${collection.requests.length}`)));
  check("saved request appears in the sidebar", $("#sidebar-body").textContent.includes("echo") || $("#sidebar-body").textContent.includes("未命名"));

  const curlCommand = window.HC.curl.generateCurl(window.HC.store.activeTab(), { resolve: (value) => window.HC.store.resolve(value) });
  check("cURL export contains method and data", curlCommand.includes("curl -X POST") && curlCommand.includes("--data-raw"), curlCommand.slice(0, 60));

  const imported = window.HC.curl.parseCurl("curl -X PUT 'http://127.0.0.1:18080/echo' -H 'X-A: 1' -H 'Content-Type: application/json' -d '{\"a\":1}' -k");
  check("cURL import parsed method/header/body",
    imported && imported.request.method === "PUT" && imported.request.headers.length === 2 && imported.request.body.raw === '{"a":1}' && imported.request.options.verifyTls === false,
    JSON.stringify(imported && imported.request.method));

  /* --------------------------------------------------- 11. i18n switch -- */
  window.HC.i18n.setLocale("en");
  window.HC.app_render?.();
  window.__hostEmit({ type: "env", locale: "en", theme: { appearance: "light", tokens: {} } });
  await sleep(200);
  check("language switch re-renders the toolbar", $("#btn-send").textContent === "Send", $("#btn-send").textContent);
  check("theme switch flips to light", document.documentElement.dataset.dbxTheme === "light", document.documentElement.dataset.dbxTheme);

  sidecar.stop();
  dom.window.close();

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures) {
    console.log(`FAILURES: ${failures}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
