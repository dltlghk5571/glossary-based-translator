"""Direct tests for the Vercel Python function handler (api/index.py,
api/_utils.py) -- spins the handler up on a real local socket via
http.server so do_POST's routing/auth/response-writing runs exactly as it
would in production, without needing `vercel dev`.
"""
import http.client
import http.server
import json
import os
import sys
import threading
import unittest
from http.server import HTTPServer
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "api"))

import index as index_module  # noqa: E402
import _utils  # noqa: E402

# BaseHTTPRequestHandler's default access-log line does a reverse DNS lookup
# (socket.getfqdn()) per request, which is slow/flaky in a sandboxed test
# environment. Skip it here only -- production handler classes are untouched.
http.server.BaseHTTPRequestHandler.address_string = lambda self: self.client_address[0]


class _HandlerServerTestCase(unittest.TestCase):
    def setUp(self):
        self.server = HTTPServer(("127.0.0.1", 0), index_module.handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()

    def post(self, path, payload, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        body = json.dumps(payload).encode("utf-8")
        try:
            conn.request(
                "POST", path, body=body,
                headers={"Content-Type": "application/json", "Connection": "close", **(headers or {})},
            )
            resp = conn.getresponse()
            data = json.loads(resp.read())
            return resp.status, data
        finally:
            conn.close()


class AnalyzeRouteTests(_HandlerServerTestCase):
    @patch.dict(os.environ, {}, clear=True)
    @patch("index.web_pipeline.analyze_text")
    def test_returns_analyze_result(self, mock_analyze):
        mock_analyze.return_value = {
            "candidate_terms": [], "matched_terms": [], "missing_terms": [], "warnings": [],
        }
        status, data = self.post("/api/analyze", {"text": "안녕하세요"})
        self.assertEqual(status, 200)
        self.assertEqual(data["missing_terms"], [])
        mock_analyze.assert_called_once_with("안녕하세요")

    @patch.dict(os.environ, {}, clear=True)
    def test_rejects_empty_text(self):
        status, data = self.post("/api/analyze", {"text": "  "})
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    @patch.dict(os.environ, {}, clear=True)
    @patch("index.web_pipeline.analyze_text")
    def test_pipeline_exception_becomes_500(self, mock_analyze):
        mock_analyze.side_effect = RuntimeError("boom")
        status, data = self.post("/api/analyze", {"text": "안녕하세요"})
        self.assertEqual(status, 500)
        self.assertEqual(data["error"], "boom")

    @patch.dict(os.environ, {"ADMIN_PASSWORD": "secret"})
    def test_unauthorized_without_session_cookie(self):
        status, data = self.post("/api/analyze", {"text": "안녕하세요"})
        self.assertEqual(status, 401)
        self.assertEqual(data["error"], "unauthorized")


class TranslateRouteTests(_HandlerServerTestCase):
    @patch.dict(os.environ, {}, clear=True)
    @patch("index.web_pipeline.translate_text")
    def test_returns_translate_result(self, mock_translate):
        mock_translate.return_value = {
            "translation": "Hello", "audit_report": {"has_violation": False, "violations": [], "format_warnings": []},
            "warnings": [],
        }
        status, data = self.post("/api/translate", {"text": "안녕하세요"})
        self.assertEqual(status, 200)
        self.assertEqual(data["translation"], "Hello")
        mock_translate.assert_called_once_with("안녕하세요")

    @patch.dict(os.environ, {}, clear=True)
    def test_rejects_empty_text(self):
        status, data = self.post("/api/translate", {"text": ""})
        self.assertEqual(status, 400)


class UnknownRouteTests(_HandlerServerTestCase):
    def test_unknown_path_is_404(self):
        status, data = self.post("/api/nope", {"text": "x"})
        self.assertEqual(status, 404)


class IsAuthorizedTests(unittest.TestCase):
    class _FakeHandler:
        def __init__(self, cookie=""):
            self.headers = {"Cookie": cookie}

    @patch.dict(os.environ, {}, clear=True)
    def test_no_admin_password_disables_gate(self):
        self.assertTrue(_utils.is_authorized(self._FakeHandler()))

    @patch.dict(os.environ, {"ADMIN_PASSWORD": "secret"})
    def test_missing_cookie_is_unauthorized(self):
        self.assertFalse(_utils.is_authorized(self._FakeHandler()))

    @patch.dict(os.environ, {"ADMIN_PASSWORD": "secret"})
    def test_valid_session_cookie_is_authorized(self):
        token = _utils._session_token()
        self.assertTrue(_utils.is_authorized(self._FakeHandler(cookie=f"admin_session={token}")))


if __name__ == "__main__":
    unittest.main()
