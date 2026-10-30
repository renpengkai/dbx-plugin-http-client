/* OpenAPI / Swagger import helpers. Prefer the sidecar parser (YAML + JSON);
   fall back to a lightweight browser JSON parser when the backend is offline. */

(function () {
  window.HC = window.HC || {};

  function looksLikeOpenAPI(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;
    if (/^\s*\{/.test(raw)) {
      try {
        const doc = JSON.parse(raw);
        return !!(doc && (doc.openapi || doc.swagger) && doc.paths);
      } catch (error) {
        return false;
      }
    }
    return /(?:^|\n)\s*(?:openapi|swagger)\s*:/i.test(raw) && /(?:^|\n)\s*paths\s*:/i.test(raw);
  }

  function importLocalJSON(text, baseUrl) {
    const doc = JSON.parse(text);
    if (!doc.paths) throw new Error("missing paths");
    const title = (doc.info && doc.info.title) || "OpenAPI Import";
    let resolvedBase = String(baseUrl || "").trim();
    if (!resolvedBase) {
      if (Array.isArray(doc.servers) && doc.servers[0] && doc.servers[0].url) {
        resolvedBase = String(doc.servers[0].url).replace(/\/$/, "");
      } else if (doc.host) {
        const scheme = (doc.schemes && doc.schemes[0]) || "https";
        resolvedBase = `${scheme}://${doc.host}${doc.basePath || ""}`.replace(/\/$/, "");
      }
    }
    const httpMethods = { get: 1, post: 1, put: 1, patch: 1, delete: 1, head: 1, options: 1, trace: 1 };
    const requests = [];
    Object.keys(doc.paths).sort().forEach((pathKey) => {
      const item = doc.paths[pathKey] || {};
      Object.keys(item).sort().forEach((methodKey) => {
        if (!httpMethods[methodKey.toLowerCase()]) return;
        const op = item[methodKey] || {};
        const method = methodKey.toUpperCase();
        const name = op.summary || op.operationId || `${method} ${pathKey}`;
        let url = resolvedBase ? `${resolvedBase}${pathKey.startsWith("/") ? pathKey : `/${pathKey}`}` : pathKey;
        const headers = [];
        const params = [];
        const collect = [].concat(item.parameters || [], op.parameters || []);
        collect.forEach((param) => {
          if (!param || !param.name) return;
          const example = param.example != null ? String(param.example) : "";
          if (param.in === "header") headers.push({ key: param.name, value: example, enabled: true });
          else if (param.in === "query") params.push({ key: param.name, value: example, enabled: true });
          else if (param.in === "path") url = url.replace(`{${param.name}}`, example || `:${param.name}`);
        });
        let body = { mode: "none", raw: "", contentType: "application/json", fields: [] };
        if (op.requestBody && op.requestBody.content) {
          const content = op.requestBody.content;
          const ct = content["application/json"] ? "application/json"
            : content["application/x-www-form-urlencoded"] ? "application/x-www-form-urlencoded"
              : content["multipart/form-data"] ? "multipart/form-data"
                : Object.keys(content)[0];
          if (ct === "application/x-www-form-urlencoded") body = { mode: "urlencoded", raw: "", contentType: ct, fields: [] };
          else if (ct === "multipart/form-data") body = { mode: "formdata", raw: "", contentType: ct, fields: [] };
          else {
            const media = content[ct] || {};
            let raw = "{}";
            if (media.example != null) raw = typeof media.example === "string" ? media.example : JSON.stringify(media.example, null, 2);
            body = { mode: "raw", raw, contentType: ct || "application/json", fields: [] };
          }
        }
        requests.push({
          name, method, url,
          headers: headers.length ? headers : [{ key: "", value: "", enabled: true }],
          params: params.length ? params : [{ key: "", value: "", enabled: true }],
          body,
          auth: { type: "none" },
          options: {}
        });
      });
    });
    return {
      ok: true,
      collection: { name: title, requests },
      count: requests.length,
      info: { title, baseUrl: resolvedBase }
    };
  }

  async function importDocument(text, options) {
    const opts = options || {};
    const payload = {
      document: text,
      baseUrl: opts.baseUrl || "",
      collectionName: opts.collectionName || ""
    };
    if (HC.bridge.backendReady) {
      return HC.bridge.invoke("openapi/import", payload, 30000);
    }
    if (!String(text || "").trim().startsWith("{")) {
      throw new Error("YAML OpenAPI import requires the native sidecar");
    }
    return importLocalJSON(text, opts.baseUrl);
  }

  window.HC.swagger = { looksLikeOpenAPI, importDocument, importLocalJSON };
})();
