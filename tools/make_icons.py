"""Render icons/icon-192.png and icon-512.png from an inline SVG with Playwright.

Run: ~/projects/ai-tool-venv/bin/python3 tools/make_icons.py
Artwork stays inside the central 80% so maskable crops don't cut it.
"""

import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent

SVG = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="{s}" height="{s}">
  <rect width="100" height="100" fill="#141414"/>
  <rect x="30" y="16" width="40" height="68" rx="9" fill="#262626" stroke="#555" stroke-width="2"/>
  <text x="50" y="42" font-family="Apple SD Gothic Neo, sans-serif" font-weight="700" font-size="20"
        fill="#ffd65c" text-anchor="middle">한</text>
  <path d="M44 52 L58 60 L44 68 Z" fill="#e50914"/>
</svg>
"""


def main():
    (ROOT / "icons").mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for size in (192, 512):
            page = browser.new_page(viewport={"width": size, "height": size})
            page.set_content(f"<body style='margin:0'>{SVG.format(s=size)}</body>")
            page.screenshot(path=str(ROOT / "icons" / f"icon-{size}.png"))
            print(f"icon-{size}.png")
        browser.close()


if __name__ == "__main__":
    main()
