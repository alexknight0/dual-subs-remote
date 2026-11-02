"""Smoke test of the deployed site (real Firebase SDK): loads, shows sign-in, no errors.

Run: ~/projects/ai-tool-venv/bin/python3 test/smoke_live.py [url]
"""

import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://alexknight0.github.io/dual-subs-remote/"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.goto(URL)
    page.wait_for_selector("#signinBtn", state="visible", timeout=15000)
    page.wait_for_function("document.getElementById('version').dataset.state !== 'checking'", timeout=10000)
    state = page.get_attribute("#version", "data-state")
    print(f"sign-in shown; version light: {state}; errors: {errors}")
    browser.close()
    sys.exit(0 if state == "ok" and not errors else 1)
