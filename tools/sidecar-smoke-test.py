#!/usr/bin/env python3
"""Protocol smoke test for the DBX HTTP Client sidecar.

Speaks protocol v1 (JSON Lines on stdin/stdout) to the backend exactly like DBX
does, and asserts the behaviour of every RPC method against a throwaway HTTP
server. Use it before packaging a release.

    go build -o dist/backend ./backend          # or use dbx-plugin dev
    python3 tools/sidecar-smoke-test.py dist/backend
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BINARY = sys.argv[1] if len(sys.argv) > 1 else "dist/backend"
PORT = int(os.environ.get("SMOKE_PORT", "18080"))
BASE = f"http://127.0.0.1:{PORT}"
STATE = {}

# Keep the sidecar away from the real user configuration directory.
SANDBOX_HOME = tempfile.mkdtemp(prefix="dbx-http-client-smoke-")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, status, payload, content_type="application/json", headers=None):
        if isinstance(payload, str):
            payload = payload.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Test-Header", "dbx-http-client")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = self.path
        if path.startswith("/json"):
            self._send(200, json.dumps({"hello": "world", "query": path}))
        elif path.startswith("/large"):
            self._send(200, "A" * (1536 * 1024), "text/plain")
        elif path.startswith("/quiet"):
            self._send(204, b"", "text/plain")
        elif path.startswith("/redirect"):
            self._send(302, b"", "text/plain", {"Location": "/json?redirected=1"})
        elif path.startswith("/slow"):
            time.sleep(3)
            self._send(200, json.dumps({"slow": True}))
        elif path.startswith("/missing"):
            self._send(404, json.dumps({"error": "not found"}))
        elif path.startswith("/gzip"):
            import gzip
            self._send(200, gzip.compress(json.dumps({"compressed": True}).encode()), "application/json",
                       {"Content-Encoding": "gzip"})
        elif path.startswith("/dl/sheet"):
            self._send(200, b"PK\x03\x04fake-xlsx",
                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                       {"Content-Disposition": "attachment; filename=\"fallback.xlsx\"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E8%A1%A8.xlsx"})
        elif path.startswith("/dl/photo"):
            self._send(200, b"\xff\xd8\xff\xd9", "image/jpeg")
        elif path.startswith("/dl/archive.zip"):
            self._send(200, b"PK", "application/octet-stream")
        elif path.startswith("/dl/blob"):
            self._send(200, b"PK", "application/zip")
        elif path.startswith("/dl/report.pdf"):
            self._send(200, b"%PDF-1.4", "application/pdf",
                       {"Content-Disposition": 'attachment; filename="report.pdf"'})
        else:
            self._send(200, json.dumps({"path": path}))

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        STATE["echo"] = {
            "contentType": self.headers.get("Content-Type"),
            "authorization": self.headers.get("Authorization"),
            "x-custom": self.headers.get("X-Custom"),
            "length": len(raw),
            "body": raw[:400].decode("utf-8", "replace"),
            "raw": raw[:8192],
        }
        self._send(200, json.dumps({"received": len(raw)}))


def rpc(process, method, params=None, request_id=1):
    process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}) + "\n")
    process.stdin.flush()
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError("sidecar closed stdout")
        payload = json.loads(line)
        if payload.get("id") == request_id:
            return payload


def base_request(**overrides):
    request = {
        "requestId": "smoke-1",
        "method": "GET",
        "url": f"{BASE}/json",
        "headers": [],
        "body": {"mode": "none"},
        "auth": {"type": "none"},
        "options": {"timeoutMs": 5000, "followRedirects": True, "verifyTls": True},
    }
    request.update(overrides)
    return request


def main():
    if not os.path.exists(BINARY):
        print(f"backend binary not found: {BINARY}")
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = dict(os.environ, HOME=SANDBOX_HOME)
    process = subprocess.Popen(BINARY, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, bufsize=1, env=environment)
    failures = []

    def check(name, condition, detail=""):
        if not condition:
            failures.append(name)
        print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

    init = rpc(process, "plugin/initialize", {"host": {"protocolVersions": [1]}})
    check("plugin/initialize negotiates protocol v1", init.get("result", {}).get("protocolVersion") == 1)
    ping = rpc(process, "plugin/ping")
    check("plugin/ping responds", ping.get("result", {}).get("ok") is True, json.dumps(ping.get("result")))

    result = rpc(process, "http/send", base_request())["result"]
    check("GET returns 200", result["status"] == 200, f"status={result['status']}")
    check("GET body preview is JSON", '"hello": "world"' in base64.b64decode(result["bodyPreviewBase64"]).decode())
    check("GET reports the sent headers",
          {"host", "user-agent", "accept-encoding"} <= {header["key"].lower() for header in result["requestHeaders"]})
    check("GET exposes a bodyId", result["bodyId"].startswith("body-"))

    missing = rpc(process, "does/not/exist")
    check("unknown method yields -32601", missing.get("error", {}).get("code") == -32601)

    result = rpc(process, "http/send", base_request(url="file:///etc/passwd"))["result"]
    check("file:// scheme rejected", result["ok"] is False and result["error"]["kind"] == "invalid-url")
    result = rpc(process, "http/send", base_request(url="http://127.0.0.1:18099/nope"))["result"]
    check("connection refused classified", result["error"]["kind"] == "connection", result["error"]["kind"])
    result = rpc(process, "http/send", base_request(url="http://does-not-exist.invalid/x",
                                                    options={"proxyMode": "direct"}))["result"]
    # `.invalid` is reserved (RFC 2606) so it never resolves. A sandboxed or
    # offline resolver may surface that as a bare EOF instead of a *net.DNSError,
    # hence either kind is acceptable — but never `invalid-url`: the URL is
    # perfectly well-formed and that kind is reserved for URLs we cannot parse.
    kind = result["error"]["kind"]
    check("dns failure classified", kind in ("dns", "network"), kind)
    result = rpc(process, "http/send", base_request(url=f"{BASE}/slow", options={"timeoutMs": 800}))["result"]
    check("timeout classified", result["error"]["kind"] == "timeout", result["error"]["kind"])
    result = rpc(process, "http/send", base_request(options={"proxyMode": "custom", "proxyUrl": "gopher://x"}))["result"]
    check("invalid proxy scheme rejected", result["error"]["kind"] == "invalid-proxy", result["error"]["kind"])

    result = rpc(process, "http/send", base_request(url=f"{BASE}/redirect"))["result"]
    check("redirect followed and recorded",
          result["status"] == 200 and result["redirects"][0]["status"] == 302, json.dumps(result["redirects"]))
    result = rpc(process, "http/send", base_request(url=f"{BASE}/redirect",
                                                    options={"followRedirects": False}))["result"]
    check("redirect kept when disabled", result["status"] == 302, f"status={result['status']}")
    result = rpc(process, "http/send", base_request(url=f"{BASE}/missing"))["result"]
    check("404 is a successful exchange", result["ok"] is True and result["status"] == 404)
    result = rpc(process, "http/send", base_request(url=f"{BASE}/quiet"))["result"]
    check("204 handled", result["status"] == 204 and result["sizeBytes"] == 0)
    result = rpc(process, "http/send", base_request(url=f"{BASE}/gzip"))["result"]
    check("gzip response decoded", '"compressed": true' in base64.b64decode(result["bodyPreviewBase64"]).decode())

    result = rpc(process, "http/send", base_request(url=f"{BASE}/large"))["result"]
    check("preview capped at 256 KiB", result["bodyPreviewBytes"] == 256 * 1024)
    check("large body stored in full", result["sizeBytes"] == 1536 * 1024)
    offset, chunks = 0, b""
    while offset < result["sizeBytes"]:
        chunk = rpc(process, "http/body", {"bodyId": result["bodyId"], "offset": offset,
                                           "length": 512 * 1024})["result"]
        chunks += base64.b64decode(chunk["dataBase64"])
        offset += chunk["length"]
        if chunk["eof"]:
            break
    check("body chunks reassemble", chunks == b"A" * 1536 * 1024, f"{len(chunks)} bytes")
    stale = rpc(process, "http/body", {"bodyId": "body-nope", "offset": 0, "length": 10})
    check("unknown bodyId yields -32004", stale.get("error", {}).get("code") == -32004)
    saved = rpc(process, "http/body/save", {"bodyId": result["bodyId"],
                                           "directory": os.path.join(SANDBOX_HOME, "downloads"),
                                           "fileName": "large.txt"})["result"]
    check("body saved to disk", saved["bytes"] == 1536 * 1024 and saved["path"].endswith("large.txt"), saved["path"])

    downloads = os.path.join(SANDBOX_HOME, "downloads")
    sheet = rpc(process, "http/send", base_request(url=f"{BASE}/dl/sheet"))["result"]
    check("filename* wins over filename", sheet.get("suggestedFileName") == "季度报表.xlsx", sheet.get("suggestedFileName"))
    saved = rpc(process, "http/body/save", {"bodyId": sheet["bodyId"], "directory": downloads})["result"]
    check("save without fileName uses filename*", saved["path"].endswith("季度报表.xlsx"), saved["path"])
    saved_again = rpc(process, "http/body/save", {"bodyId": sheet["bodyId"], "directory": downloads})["result"]
    check("second save does not overwrite", saved_again["path"].endswith("季度报表 (1).xlsx"), saved_again["path"])

    photo = rpc(process, "http/send", base_request(url=f"{BASE}/dl/photo"))["result"]
    check("jpeg name comes from the url", photo.get("suggestedFileName") == "photo.jpg", photo.get("suggestedFileName"))
    archive = rpc(process, "http/send", base_request(url=f"{BASE}/dl/archive.zip"))["result"]
    check("octet-stream keeps the url extension", archive.get("suggestedFileName") == "archive.zip", archive.get("suggestedFileName"))
    blob = rpc(process, "http/send", base_request(url=f"{BASE}/dl/blob"))["result"]
    check("zip mime adds extension to the url segment", blob.get("suggestedFileName") == "blob.zip", blob.get("suggestedFileName"))
    report = rpc(process, "http/send", base_request(url=f"{BASE}/dl/report.pdf"))["result"]
    check("content-disposition filename is used", report.get("suggestedFileName") == "report.pdf", report.get("suggestedFileName"))

    result = rpc(process, "http/send", base_request(
        method="POST", url=f"{BASE}/echo",
        headers=[{"key": "X-Custom", "value": "yes"}, {"key": "X-Skip", "value": "no", "enabled": False}],
        body={"mode": "raw", "raw": '{"name":"杰特"}', "contentType": "application/json"},
        auth={"type": "basic", "username": "alice", "password": "secret"}))["result"]
    check("custom header forwarded", STATE["echo"]["x-custom"] == "yes")
    check("disabled header dropped", STATE["echo"]["x-custom"] != "no")
    check("basic auth applied", STATE["echo"]["authorization"] == "Basic YWxpY2U6c2VjcmV0")
    check("content-type from body mode", STATE["echo"]["contentType"] == "application/json")
    check("request body preview rendered", "杰特" in result["requestBodyPreview"], result["requestBodyPreview"])

    rpc(process, "http/send", base_request(method="POST", url=f"{BASE}/echo", auth={"type": "bearer", "token": "tok-123"}))
    check("bearer token applied", STATE["echo"]["authorization"] == "Bearer tok-123")
    result = rpc(process, "http/send", base_request(
        auth={"type": "apikey", "key": "api_key", "value": "abc", "in": "query"}))["result"]
    check("apikey injected into the query string", "api_key=abc" in result["finalUrl"], result["finalUrl"])

    result = rpc(process, "http/send", base_request(method="POST", url=f"{BASE}/echo", body={
        "mode": "urlencoded", "fields": [{"key": "a", "value": "1"}, {"key": "b", "value": "空格 值"}]}))["result"]
    check("urlencoded body encoded", STATE["echo"]["body"] == "a=1&b=%E7%A9%BA%E6%A0%BC+%E5%80%BC", STATE["echo"]["body"])

    payload = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
    result = rpc(process, "http/send", base_request(method="POST", url=f"{BASE}/echo", body={
        "mode": "formdata", "fields": [{"key": "note", "value": "hi"},
                                       {"key": "avatar", "kind": "file", "fileName": "a.png",
                                        "contentType": "application/x-png-custom",
                                        "dataBase64": payload}]}))["result"]
    raw_body = STATE["echo"]["raw"]
    check("multipart content-type", (STATE["echo"]["contentType"] or "").startswith("multipart/form-data"))
    check("multipart summary in preview", "multipart" in result["requestBodyPreview"])
    check("multipart text field leaves the sidecar", b'name="note"' in raw_body and b"hi" in raw_body)
    check("multipart file part carries the filename", b'filename="a.png"' in raw_body)
    check("multipart file bytes leave the sidecar", b"\x89PNG\r\n\x1a\nfake" in raw_body)
    check("multipart file uses the field content type", b"application/x-png-custom" in raw_body)
    oversized = base64.b64encode(b"x" * (1200 * 1024)).decode()
    result = rpc(process, "http/send", base_request(method="POST", url=f"{BASE}/echo", body={
        "mode": "formdata", "fields": [{"key": "big", "kind": "file", "fileName": "b.bin",
                                        "dataBase64": oversized}]}))["result"]
    check("oversized inline file rejected", result["error"]["kind"] == "invalid-body", result["error"]["kind"])

    message = json.dumps({"jsonrpc": "2.0", "id": 99, "method": "http/send",
                          "params": base_request(url=f"{BASE}/large", options={"progressEvents": True, "timeoutMs": 5000})})
    process.stdin.write(message + "\n")
    process.stdin.flush()
    phases = []
    while True:
        payload_message = json.loads(process.stdout.readline())
        if payload_message.get("method") == "http/progress":
            phases.append(payload_message["params"]["phase"])
        if payload_message.get("id") == 99:
            break
    check("progress events emitted", "sending" in phases and "receiving" in phases, json.dumps(sorted(set(phases))))

    document = {"collections": [{"name": "demo"}], "environments": [{"name": "dev"}]}
    saved = rpc(process, "store/save", {"store": document})["result"]
    check("store saved outside the config dir sandbox", SANDBOX_HOME in saved["path"], saved["path"])
    loaded = rpc(process, "store/load")["result"]
    check("store round-trips", loaded["store"] == document)
    failed = rpc(process, "store/save", {"store": {"blob": "x" * (5 * 1024 * 1024)}})
    check("oversized store rejected", failed.get("error", {}).get("code") == -32602)

    message = json.dumps({"jsonrpc": "2.0", "id": 77, "method": "http/send",
                          "params": base_request(requestId="cancel-me", url=f"{BASE}/slow",
                                                 options={"timeoutMs": 20000})})
    process.stdin.write(message + "\n")
    process.stdin.flush()
    time.sleep(0.4)
    cancel = rpc(process, "http/cancel", {"requestId": "cancel-me"}, request_id=78)
    check("cancel acknowledged", cancel["result"]["cancelled"] is True)
    while True:
        payload_message = json.loads(process.stdout.readline())
        if payload_message.get("id") == 77:
            check("cancelled request reported as canceled",
                  payload_message["result"]["error"]["kind"] == "canceled", payload_message["result"]["error"]["kind"])
            break

    bad = rpc(process, "http/send", "not-an-object")
    check("invalid params rejected", bad.get("error", {}).get("code") == -32602)
    bad = rpc(process, "http/send", {})
    check("missing url reported", bad.get("result", {}).get("error", {}).get("kind") == "invalid-url")

    process.stdin.close()
    process.wait(timeout=10)
    server.shutdown()
    print()
    if failures:
        print(f"{len(failures)} FAILED: {failures}")
        return 1
    print("all sidecar checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
