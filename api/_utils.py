"""Shared helpers for the Vercel Python functions under api/. Every endpoint
here reads/writes JSON and requires the same admin cookie the Next.js
middleware (middleware.ts) checks before serving /translate and /glossary."""
import hashlib
import hmac
import json
import os
from http import cookies
from http.server import BaseHTTPRequestHandler


def _session_token():
    password = os.environ.get("ADMIN_PASSWORD", "")
    return hmac.new(password.encode("utf-8"), b"admin", hashlib.sha256).hexdigest()


def is_authorized(handler: BaseHTTPRequestHandler):
    if not os.environ.get("ADMIN_PASSWORD"):
        return True  # no password configured -> gate disabled (local dev)
    raw_cookie = handler.headers.get("Cookie", "")
    jar = cookies.SimpleCookie()
    jar.load(raw_cookie)
    morsel = jar.get("admin_session")
    return bool(morsel) and hmac.compare_digest(morsel.value, _session_token())


def read_json_body(handler: BaseHTTPRequestHandler):
    length = int(handler.headers.get("Content-Length", 0) or 0)
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw or b"{}")


def send_json(handler: BaseHTTPRequestHandler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def send_unauthorized(handler: BaseHTTPRequestHandler):
    send_json(handler, 401, {"ok": False, "error": "unauthorized"})


def send_error(handler: BaseHTTPRequestHandler, status, message):
    send_json(handler, status, {"ok": False, "error": message})
