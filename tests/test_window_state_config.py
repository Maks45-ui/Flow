"""Static integration guards; native window restoration needs a desktop runtime."""

import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class WindowStateConfigTests(unittest.TestCase):
    def test_window_state_dependency_is_desktop_only(self):
        manifest = (ROOT / "src-tauri/Cargo.toml").read_text(encoding="utf-8")
        desktop = re.search(
            r"\[target\.'cfg\(any\(target_os = \"macos\", target_os = \"windows\", target_os = \"linux\"\)\)'\.dependencies\]([^\[]*)",
            manifest,
        )
        self.assertIsNotNone(desktop, "Window-state must be a desktop dependency")
        self.assertIn('tauri-plugin-window-state = "2"', desktop.group(1))

    def test_plugin_is_registered_before_application_runs(self):
        source = (ROOT / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
        registration = source.index(
            "builder.plugin(tauri_plugin_window_state::Builder::default().build())"
        )
        self.assertIn("#[cfg(desktop)]", source[registration - 80:registration])
        self.assertLess(registration, source.index(".run(tauri::generate_context!())"))

    def test_main_window_waits_for_restoration_before_becoming_visible(self):
        config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
        main = next(window for window in config["app"]["windows"] if window.get("label", "main") == "main")
        self.assertIs(main["visible"], False)
        self.assertEqual((main["width"], main["height"]), (1280, 800))
        self.assertEqual((main["minWidth"], main["minHeight"]), (920, 600))


if __name__ == "__main__":
    unittest.main()
