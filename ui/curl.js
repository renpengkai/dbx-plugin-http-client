/* cURL import / export. Kept dependency free so the workbench has no build step. */

(function () {
  const FLAGS_WITH_VALUE = new Set([
    "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii",
    "--data-urlencode", "-u", "--user", "--url", "-b", "--cookie", "-A", "--user-agent", "-e", "--referer",
    "-F", "--form", "-o", "--output", "--max-time", "-m", "--connect-timeout", "-x", "--proxy", "--json",
    "-T", "--upload-file", "--retry", "--cacert", "--cert", "--key", "--resolve", "--interface"
  ]);

  function tokenize(input) {
    const text = String(input || "").replace(/\\\r?\n/g, " ").replace(/\r?\n/g, " ");
    const tokens = [];
    let current = "";
    let quote = null;
    let pending = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quote) {
        if (character === "\\" && quote === '"' && index + 1 < text.length) {
          const next = text[index + 1];
          if (next === '"' || next === "\\" || next === "$" || next === "`") { current += next; index += 1; continue; }
        }
        if (character === quote) { quote = null; continue; }
        current += character;
        continue;
      }
      if (character === '"' || character === "'") { quote = character; pending = true; continue; }
      if (character === "\\" && index + 1 < text.length) { current += text[index + 1]; index += 1; pending = true; continue; }
      if (/\s/.test(character)) {
        if (pending || current) { tokens.push(current); current = ""; pending = false; }
        continue;
      }
      current += character;
      pending = true;
    }
    if (current || pending) tokens.push(current);
    return tokens;
  }

  function splitOnce(value, separator) {
    const index = value.indexOf(separator);
    if (index < 0) return [value, ""];
    return [value.slice(0, index), value.slice(index + separator.length)];
  }

  function parseHeader(value) {
    const [key, rest] = splitOnce(value, ":");
    return { key: key.trim(), value: rest.trim(), enabled: true };
  }

  function parseUrlEncoded(raw) {
    const rows = [];
    raw.split("&").forEach((pair) => {
      if (!pair) return;
      const [key, value] = splitOnce(pair, "=");
      rows.push({ key: decodeURIComponentSafe(key), value: decodeURIComponentSafe(value.replace(/\+/g, " ")), enabled: true });
    });
    return rows;
  }

  function decodeURIComponentSafe(value) {
    try { return decodeURIComponent(value); } catch (error) { return value; }
  }

  /**
   * Parses a curl command into the workbench request shape.
   * Returns { request, warnings } or null when the input is not a cURL command.
   */
  function parseCurl(input) {
    const tokens = tokenize(input);
    if (!tokens.length) return null;
    let start = 0;
    if (/^curl(\.exe)?$/i.test(tokens[0]) || /[\\/]curl(\.exe)?$/i.test(tokens[0])) start = 1;
    else if (!tokens[0].startsWith("-") && !/^https?:\/\//i.test(tokens[0])) return null;

    const request = {
      name: "imported",
      method: "GET",
      url: "",
      headers: [],
      params: [],
      body: { mode: "none", raw: "", contentType: "application/json", fields: [] },
      auth: { type: "none", username: "", password: "", token: "", key: "", value: "", in: "header" },
      options: { timeoutMs: 30000, followRedirects: true, maxRedirects: 10, verifyTls: true, proxyMode: "environment", proxyUrl: "" }
    };
    const warnings = [];
    let dataParts = [];
    let dataContentType = "";
    let multipart = false;
    let changedMethod = false;

    for (let index = start; index < tokens.length; index += 1) {
      let token = tokens[index];
      let inlineValue = null;
      if (token.startsWith("--") && token.indexOf("=") > 0) {
        const [flag, value] = splitOnce(token, "=");
        token = flag;
        inlineValue = value;
      }
      const takeValue = () => {
        if (inlineValue !== null) return inlineValue;
        index += 1;
        return tokens[index] === undefined ? "" : tokens[index];
      };

      if (token === "--url") { request.url = takeValue(); continue; }
      if (token === "-X" || token === "--request") { request.method = takeValue().toUpperCase(); changedMethod = true; continue; }
      if (token === "-H" || token === "--header") { request.headers.push(parseHeader(takeValue())); continue; }
      if (token === "-d" || token === "--data" || token === "--data-raw" || token === "--data-ascii" || token === "--data-binary") {
        dataParts.push(takeValue()); continue;
      }
      if (token === "--data-urlencode") {
        const raw = takeValue();
        if (raw.indexOf("=") > 0) dataParts.push(raw);
        else dataParts.push(`${raw}=`);
        dataContentType = dataContentType || "application/x-www-form-urlencoded";
        continue;
      }
      if (token === "--json") { dataParts.push(takeValue()); dataContentType = "application/json"; continue; }
      if (token === "-F" || token === "--form") {
        multipart = true;
        const raw = takeValue();
        const [key, value] = splitOnce(raw, "=");
        if (value.startsWith("@") || value.startsWith("<")) {
          warnings.push(HC.i18n.t("toast.importCurlFailed"));
          request.body.fields.push({ key: key.split(";")[0], value: value, enabled: true, kind: "text" });
        } else {
          request.body.fields.push({ key: key.split(";")[0], value, enabled: true, kind: "text" });
        }
        continue;
      }
      if (token === "-u" || token === "--user") {
        const raw = takeValue();
        const [username, password] = splitOnce(raw, ":");
        request.auth = { type: "basic", username, password, token: "", key: "", value: "", in: "header" };
        continue;
      }
      if (token === "-k" || token === "--insecure") { request.options.verifyTls = false; continue; }
      if (token === "-L" || token === "--location") { request.options.followRedirects = true; continue; }
      if (token === "-I" || token === "--head") { request.method = "HEAD"; changedMethod = true; continue; }
      if (token === "-G" || token === "--get") { request.method = "GET"; changedMethod = true; continue; }
      if (token === "-m" || token === "--max-time") { request.options.timeoutMs = Math.round(Number(takeValue()) * 1000) || 30000; continue; }
      if (token === "-x" || token === "--proxy") {
        request.options.proxyMode = "custom";
        request.options.proxyUrl = takeValue();
        continue;
      }
      if (token === "--compressed") continue;
      if (token === "-b" || token === "--cookie") {
        request.headers.push({ key: "Cookie", value: takeValue(), enabled: true });
        continue;
      }
      if (token === "-A" || token === "--user-agent") {
        request.headers.push({ key: "User-Agent", value: takeValue(), enabled: true });
        continue;
      }
      if (token === "-e" || token === "--referer") {
        request.headers.push({ key: "Referer", value: takeValue(), enabled: true });
        continue;
      }
      if (token.startsWith("-")) {
        if (FLAGS_WITH_VALUE.has(token) && inlineValue === null) index += 1;
        continue;
      }
      if (!request.url) request.url = token;
    }

    if (dataParts.length) {
      const raw = dataParts.join("&");
      const contentTypeHeader = request.headers.find((header) => /^content-type$/i.test(header.key));
      const contentType = dataContentType || (contentTypeHeader ? contentTypeHeader.value : "");
      if (/x-www-form-urlencoded/i.test(contentType)) {
        request.body.mode = "urlencoded";
        request.body.fields = parseUrlEncoded(raw);
      } else {
        request.body.mode = "raw";
        request.body.raw = raw;
        request.body.contentType = contentType || "application/json";
      }
    } else if (multipart) {
      request.body.mode = "formdata";
    }

    if (request.auth.type !== "none" && !changedMethod && request.method === "GET") request.method = "POST";
    if (!request.url) return null;
    try {
      const parsed = new URL(request.url);
      if (!parsed.search) {
        request.params = [];
      } else {
        parsed.searchParams.forEach((value, key) => {
          request.params.push({ key, value, enabled: true });
        });
      }
      request.name = parsed.pathname === "/" ? parsed.host : `${parsed.pathname}`;
    } catch (error) {
      warnings.push(error.message);
    }
    return { request, warnings };
  }

  function quote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  /** Renders the current tab as a reproducible curl command. */
  function generateCurl(tab, options) {
    const settings = options || {};
    const resolve = settings.resolve || ((value) => value);
    const lines = [`curl -X ${tab.method} ${quote(resolve(tab.url) || "")}`];
    const rows = (tab.headers || []).filter((row) => row.enabled !== false && row.key);
    rows.forEach((row) => lines.push(`  -H ${quote(`${resolve(row.key)}: ${resolve(row.value)}`)}`));
    if (tab.auth.type === "basic") lines.push(`  -u ${quote(`${resolve(tab.auth.username)}:${resolve(tab.auth.password)}`)}`);
    if (tab.auth.type === "bearer") lines.push(`  -H ${quote(`Authorization: Bearer ${resolve(tab.auth.token)}`)}`);
    if (tab.auth.type === "apikey" && tab.auth.in !== "query") {
      lines.push(`  -H ${quote(`${resolve(tab.auth.key)}: ${resolve(tab.auth.value)}`)}`);
    }
    if (tab.options.verifyTls === false) lines.push("  -k");
    if (tab.options.followRedirects === false) lines.push("  --max-redirs 0");
    if (Number(tab.options.timeoutMs) && Number(tab.options.timeoutMs) !== 30000) {
      lines.push(`  --max-time ${Math.round(Number(tab.options.timeoutMs) / 1000)}`);
    }
    if (tab.options.proxyMode === "custom" && tab.options.proxyUrl) lines.push(`  -x ${quote(resolve(tab.options.proxyUrl))}`);
    if (tab.options.proxyMode === "direct") lines.push("  --noproxy '*'");

    if (tab.body.mode === "raw" && tab.body.raw) {
      lines.push(`  -H ${quote(`Content-Type: ${tab.body.contentType || "application/json"}`)}`);
      lines.push(`  --data-raw ${quote(resolve(tab.body.raw))}`);
    } else if (tab.body.mode === "urlencoded") {
      const body = (tab.body.fields || [])
        .filter((row) => row.enabled !== false && row.key)
        .map((row) => `${encodeURIComponent(resolve(row.key))}=${encodeURIComponent(resolve(row.value))}`)
        .join("&");
      lines.push("  -H 'Content-Type: application/x-www-form-urlencoded'");
      lines.push(`  --data-raw ${quote(body)}`);
    } else if (tab.body.mode === "formdata") {
      (tab.body.fields || []).filter((row) => row.enabled !== false && row.key).forEach((row) => {
        if (row.kind === "file") lines.push(`  -F ${quote(`${resolve(row.key)}=@${row.fileName || "file"}`)}`);
        else lines.push(`  -F ${quote(`${resolve(row.key)}=${resolve(row.value)}`)}`);
      });
    }
    return lines.join(" \\\n");
  }

  window.HC.curl = { parseCurl, generateCurl, tokenize };
})();
