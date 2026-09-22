#!/usr/bin/env python3
"""Throwaway target server that the plugin's tests send requests against.

Used by both `sidecar-smoke-test.py` (protocol level) and `ui-e2e-test.mjs`
(workbench UI in jsdom). Override the port with `PORT=...` if 18080 is taken.
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT") or 18080)
STATE = {}


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
        self.send_header("X-Demo-Server", "dbx-http-client")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _drain(self):
        """Consume a request body on methods that do not use one.

        The connection is keep-alive, so any unread body bytes would be parsed as
        the next request line and the client would see a spurious 501.
        """
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)

    def do_GET(self):
        self._drain()
        path = self.path
        if path.startswith("/users"):
            self._send(200, json.dumps({
                "page": 1,
                "items": [
                    {"id": 1, "name": "张三", "email": "zhangsan@example.com", "active": True},
                    {"id": 2, "name": "李四", "email": "lisi@example.com", "active": False},
                ],
                "total": 2,
                "query": path,
            }, ensure_ascii=False))
        elif path.startswith("/html"):
            self._send(200, "<!doctype html><html><body><h1>示例页面</h1><p>本页面不会被沙箱渲染。</p></body></html>", "text/html; charset=utf-8")
        elif path.startswith("/image"):
            self._send(200, bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" "05fe02fea7c1c1c10000000049454e44ae426082"), "image/png")
        elif path.startswith("/redirect"):
            self._send(302, b"", "text/plain", {"Location": "/users?redirected=1"})
        elif path.startswith("/large"):
            self._send(200, "A" * (1536 * 1024), "text/plain")
        elif path.startswith("/slow"):
            time.sleep(5)
            self._send(200, json.dumps({"slow": True}))
        elif path.startswith("/missing"):
            self._send(404, json.dumps({"error": "not found"}))
        elif path.startswith("/status/500"):
            self._send(500, json.dumps({"error": "boom"}))
        elif path.startswith("/dl/sheet"):
            self._send(200, b"PK\x03\x04fake-xlsx",
                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                       {"Content-Disposition": "attachment; filename=\"fallback.xlsx\"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E8%A1%A8.xlsx"})
        elif path.startswith("/dl/photo"):
            self._send(200, bytes.fromhex("ffd8ffd9"), "image/jpeg")
        elif path.startswith("/dl/report.pdf"):
            self._send(200, b"%PDF-1.4", "application/pdf",
                       {"Content-Disposition": 'attachment; filename="report.pdf"'})
        else:
            self._send(200, json.dumps({"path": path}))

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        state = {
            "contentType": self.headers.get("Content-Type"),
            "authorization": self.headers.get("Authorization"),
            "headers": {key: value for key, value in self.headers.items()},
            "body": raw.decode("utf-8", "replace"),
            "length": len(raw),
        }
        STATE.update(state)
        self._send(200, json.dumps({"received": state, "at": time.strftime("%H:%M:%S")}, ensure_ascii=False))

    def do_PUT(self):
        self.do_POST()

    def do_DELETE(self):
        self._drain()
        self._send(200, json.dumps({"deleted": self.path}))


if __name__ == "__main__":
    print(f"test target server listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
