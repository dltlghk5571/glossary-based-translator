import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from _utils import is_authorized, read_json_body, send_json, send_unauthorized, send_error  # noqa: E402
import web_pipeline  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not is_authorized(self):
            return send_unauthorized(self)
        try:
            body = read_json_body(self)
            text = (body.get("text") or "").strip()
            if not text:
                return send_error(self, 400, "text is required")
            result = web_pipeline.analyze_text(text)
            send_json(self, 200, result)
        except Exception as e:
            send_error(self, 500, str(e))
