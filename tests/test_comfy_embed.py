"""Exercise the actual middleware without importing PyTorch or starting ComfyUI."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch


def load_bridge():
    spec = importlib.util.spec_from_file_location("flow_embed_test", Path(__file__).parents[1] / "src-tauri/resources/flow_comfy_embed.py")
    module = importlib.util.module_from_spec(spec)
    fake_web = SimpleNamespace(middleware=lambda function: function)
    fake_server = SimpleNamespace(PromptServer=SimpleNamespace(instance=SimpleNamespace(app=SimpleNamespace(middlewares=[]))))
    with patch.dict("sys.modules", {"aiohttp": SimpleNamespace(web=fake_web), "server": fake_server}):
        spec.loader.exec_module(module)
    return module


class ComfyEmbedTests(TestCase):
    def setUp(self):
        self.bridge = load_bridge()
        self.allowed = self.bridge.origin("http://tauri.localhost")

    def request(self, method="GET", path="/", **headers):
        return SimpleNamespace(method=method, path=path, headers={
            "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate",
            "Referer": "http://tauri.localhost/", **headers,
        })

    def test_only_trusted_root_navigation_is_allowed(self):
        self.assertTrue(self.bridge.flow_navigation(self.request(), self.allowed))
        for request in [self.request("POST"), self.request(path="/prompt"), self.request(path="/ws"),
                        self.request(Referer="http://evil.example/"), self.request(Referer=""),
                        self.request(Referer="http://tauri.localhost.evil.example/"),
                        self.request(Referer="http://user@tauri.localhost/"),
                        self.request(**{"Origin": "null"}), self.request(**{"Origin": "http://evil.example"}),
                        self.request(**{"Sec-Fetch-Dest": "empty"}), self.request(**{"Sec-Fetch-Mode": "cors"})]:
            self.assertFalse(self.bridge.flow_navigation(request, self.allowed), request)
        self.assertFalse(self.bridge.flow_navigation(self.request(), None))

    def test_api_and_other_sites_still_run_original_protection(self):
        calls = []
        async def origin_only_middleware(request, handler):
            calls.append(request)
            return 403
        async def handler(request):
            return 200
        app = SimpleNamespace(middlewares=[origin_only_middleware])
        self.assertTrue(self.bridge.install(app, self.allowed))
        self.assertTrue(self.bridge.install(app, self.allowed))
        self.assertEqual(len(app.middlewares), 1)
        async def run():
            self.assertEqual(await app.middlewares[0](self.request(), handler), 200)
            for request in [self.request("POST", "/prompt"), self.request(path="/queue"), self.request(Referer="http://evil.example/")]:
                self.assertEqual(await app.middlewares[0](request, handler), 403)
        # These coroutines do not perform IO; avoid creating a Windows socket event loop.
        with self.assertRaises(StopIteration):
            run().send(None)
        self.assertEqual(len(calls), 3)

    def test_unrecognized_middleware_is_not_replaced(self):
        app = SimpleNamespace(middlewares=[lambda: None])
        original = list(app.middlewares)
        self.assertFalse(self.bridge.install(app, self.allowed))
        self.assertEqual(app.middlewares, original)
