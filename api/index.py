import hashlib
import hmac
import json
import os
import sys
from http import cookies
from http.server import BaseHTTPRequestHandler

# Vercel imports this file via importlib (not `python api/index.py`), so
# unlike a locally-run script, api/'s own directory is NOT automatically
# added to sys.path -- only the repo root needs adding for `web_pipeline`.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import web_pipeline  # noqa: E402


def _session_token():
    password = os.environ.get("ADMIN_PASSWORD", "")
    return hmac.new(password.encode("utf-8"), b"admin", hashlib.sha256).hexdigest()


def is_authorized(handler):
    if not os.environ.get("ADMIN_PASSWORD"):
        return True  # no password configured -> gate disabled (local dev)
    raw_cookie = handler.headers.get("Cookie", "")
    jar = cookies.SimpleCookie()
    jar.load(raw_cookie)
    morsel = jar.get("admin_session")
    return bool(morsel) and hmac.compare_digest(morsel.value, _session_token())


def read_json_body(handler):
    length = int(handler.headers.get("Content-Length", 0) or 0)
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw or b"{}")


def send_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


# Vercel's Python entrypoint detection gets ambiguous with multiple
# non-canonically-named api/*.py handler files (api/analyze.py, api/translate.py
# each defining their own `handler`) -- it falls back to single-app detection
# and refuses to pick one. A single canonically-named file (api/index.py) with
# one handler dispatching on self.path is the documented, unambiguous pattern.
ROUTES = {
    "/api/analyze": lambda text: web_pipeline.analyze_text(text),
    "/api/translate": lambda text: web_pipeline.translate_text(text),
}


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        route = ROUTES.get(self.path)
        if route is None:
            return send_json(self, 404, {"ok": False, "error": "not found"})
        if not is_authorized(self):
            return send_json(self, 401, {"ok": False, "error": "unauthorized"})
        try:
            body = read_json_body(self)
            text = (body.get("text") or "").strip()
            if not text:
                return send_json(self, 400, {"ok": False, "error": "text is required"})
            result = route(text)
            send_json(self, 200, result)
        except Exception as e:
            send_json(self, 500, {"ok": False, "error": str(e)})
