"""Phone remote page test: fake Firebase app/auth/database modules, 390x844 phone viewport.

Run: ~/projects/ai-tool-venv/bin/python3 test/test_remote.py   (exits 1 on any FAIL)
Saves a screenshot to ~/.tmp/dual-subs-remote.png.
"""

import functools
import http.server
import json
import pathlib
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SDK = "https://www.gstatic.com/firebasejs/13.0.0/"

FAKE_APP = "export const initializeApp = (c) => ({ c });"
FAKE_AUTH = """
const listeners = [];
let user = null;
export const initializeAuth = (app) => getAuth(app); export const browserLocalPersistence = {}; export const browserPopupRedirectResolver = {};
export const getAuth = () => ({});
export class GoogleAuthProvider {}
export const onAuthStateChanged = (a, cb) => { listeners.push(cb); cb(user); return () => {}; };
export const signInWithPopup = async () => { user = { uid: 'u1', email: 'octopus0246@gmail.com', refreshToken: 'refresh-1' }; listeners.forEach((l) => l(user)); return { user }; };
export const signOut = async () => { user = null; listeners.forEach((l) => l(null)); };
"""
FAKE_DB = """
const subs = {};
window.__sent = [];
window.__push = (path, value) => (subs[path] || []).forEach((cb) => cb({ val: () => value }));
export const getDatabase = () => ({});
export const ref = (db, path) => path;
export const serverTimestamp = () => ({ '.sv': 'timestamp' });
export const onValue = (path, cb) => { (subs[path] ||= []).push(cb); return () => { subs[path] = subs[path].filter((x) => x !== cb); }; };
export const set = async (path, value) => { window.__sent.push({ path, value }); };
"""

STATE = {
    "at": 1,
    "movieId": "1",
    "title": "Tale of the Nine Tailed · E3",
    "playing": True,
    "t": 600000,
    "d": 3720000,
    "v": 0.8,
    "m": False,
    "line": {
        "key": "36000",
        "parts": [
            {"t": "나", "w": "나", "k": "word", "s": "known", "c": 36000, "i": 0},
            {"t": "한테 "},
            {"t": "장난친 ", "w": "장난치다", "k": "word", "s": "learning", "c": 36000, "i": 4},
            {"t": "적 ", "w": "적", "k": "word", "s": "unknown", "c": 36000, "i": 8},
            {"t": "있니", "w": "있다", "k": "word", "s": "known", "c": 36000, "i": 10},
            {"t": "?"},
        ],
        "en": "Have you ever tricked me?",
        "hidden": True,
    },
}
PANEL = {
    "word": "적", "form": "적", "kind": "word", "state": "unknown", "c": 36000, "i": 8,
    "link": "https://alexknight0.github.io/korean-dict/#w=%EC%A0%81",
    "patterns": [{"word": "-ㄴ 적이 있다", "def": "An expression for past experience.", "link": "https://x/#w=g"}],
    "kr": [
        {"word": "적", "pos": "의존 명사", "level": "intermediate", "posMatch": True,
         "senses": [{"en": "time; experience", "def": "The time when an act happened.", "best": True}]},
        {"word": "적", "pos": "명사", "posMatch": False, "senses": [{"en": "enemy", "def": "An opponent."}]},
    ],
    "od": [],
    "ai": {"text": "**적** is a bound noun.\n- pattern **-ㄴ 적이 있다**"},
}

failed = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}: {name} {detail if not ok else ''}")
    if not ok:
        failed.append(name)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def main():
    handler = functools.partial(Handler, directory=str(ROOT.parent))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/{ROOT.name}/"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 390, "height": 844})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        def serve(body):
            return lambda route: route.fulfill(content_type="application/javascript", body=body)

        for name, body in (("app", FAKE_APP), ("auth", FAKE_AUTH), ("database", FAKE_DB)):
            # (not `lambda r, b=body`: Playwright passes the request as a 2nd argument)
            page.route(f"{SDK}firebase-{name}.js", serve(body))
        sent = lambda: page.evaluate("window.__sent.map((s) => s.value)")

        print("1/4: sign-in")
        page.goto(url)
        page.wait_for_selector("#signinBtn", state="visible")
        check("signed out: sign-in shown, controls hidden", page.is_hidden("#dock"))
        page.click("#signinBtn")
        page.wait_for_selector("#dock", state="visible")
        check("signed in: waiting for Netflix", page.is_visible("#waiting") and "Not connected" in page.text_content("#status"))

        print("2/4: the line on screen")
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE, ensure_ascii=False)})")
        check("line shown", page.text_content("#line") == "나한테 장난친 적 있니?", page.text_content("#line"))
        gap = page.evaluate("""(() => { const [a, b] = [...document.querySelectorAll('#line .w')].slice(1, 3).map((e) => e.getBoundingClientRect()); return b.left - a.right; })()""")
        check("spaces between words are kept", gap > 3, gap)
        classes = page.eval_on_selector_all("#line .w", "els => els.map((e) => e.className)")
        check("words coloured by state", classes == ["w known", "w learning", "w unknown", "w known"], classes)
        check("status shows playing", page.text_content("#status") == "Playing"
              and "playing" in page.get_attribute("#play", "class") and page.is_visible("#play .i-pause")
              and page.is_hidden("#play .i-play"))
        check("title shown", "Nine Tailed" in page.text_content("#title"))
        MIDDLE = """(() => { const m = document.getElementById('main').getBoundingClientRect(); const n = document.getElementById('now').getBoundingClientRect(); return [n.top - m.top, (n.top + n.bottom) / 2 - (m.top + m.bottom) / 2]; })()"""
        top, off = page.evaluate(MIDDLE)
        check("line centred vertically", abs(off) < 40, (top, off))
        check("English never blurred on the phone", "blurred" not in (page.get_attribute("#en", "class") or ""))
        page.click("#en")
        check("...without sending anything", sent() == [], sent())

        print("3/4: controls")
        for btn, kind in (("#play", "playPause"), ("#prev", "prev"), ("#next", "next")):
            page.click(btn)
            last = sent()[-1]
            check(f"{btn} sends {kind}", last["type"] == kind and last["at"] == {".sv": "timestamp"} and last["id"], last)
        paths = page.evaluate("window.__sent.map((s) => s.path)")
        check("commands go to remote/u1/command", set(paths) == {"remote/u1/command"}, paths)
        ids = [s["id"] for s in sent()]
        check("each command has its own id", len(set(ids)) == len(ids))
        box = page.locator("#dock").bounding_box()
        check("controls at the bottom (thumb reach)", box["y"] + box["height"] >= 844 - 1, box)
        sizes = page.eval_on_selector_all(".dock .buttons button", "els => els.map((e) => [e.id, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])")
        check("five big buttons: line, 10 s, play, 10 s, line", [s[0] for s in sizes] == ["prev", "back10", "play", "fwd10", "next"]
              and all(h >= 124 and w >= 100 for _, w, h in sizes), sizes)
        check("drawn icons, no emoji", all(not (page.text_content(f"#{b}") or "").strip(" line10s") for b in ("prev", "next", "play"))
              and page.locator("#dock svg").count() == 6, [page.text_content(f"#{b}") for b in ("prev", "next", "play")])
        chips = page.locator("#chips").bounding_box()
        check("volume and position chips at the top", chips["y"] < 60, chips)
        centred = page.evaluate("""(() => { const l = document.getElementById('line').getBoundingClientRect(); const ws = [...document.querySelectorAll('#line .w')].map((e) => e.getBoundingClientRect()); return [ws[0].left - l.left, l.right - ws.at(-1).right]; })()""")
        check("line centred", abs(centred[0] - centred[1]) < 20, centred)
        check("position chip shows time / length", page.text_content("#seekBtn").endswith("/ 1:02:00"), page.text_content("#seekBtn"))
        check("no always-on sliders", page.is_hidden("#seek") and page.is_hidden("#vol"))
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE, ensure_ascii=False)})")
        page.wait_for_timeout(2200)
        now = page.text_content("#seekBtn").split(" / ")[0]
        check("...and moves on while playing", now in ("10:01", "10:02", "10:03"), now)  # display ticks every 0.5 s
        page.click("#seekBtn")
        check("tapping it opens the position popup", page.is_visible("#seekSheet") and page.text_content("#tEnd") == "1:02:00")
        seek = page.locator("#seek").bounding_box()
        check("...with a big slider", seek["height"] >= 44 and seek["width"] > 250, seek)
        page.mouse.click(seek["x"] + seek["width"] / 2, seek["y"] + seek["height"] / 2)
        last = sent()[-1]
        check("dragging it sends seek", last["type"] == "seek" and abs(last["ms"] - 1860000) < 60000, last)
        check("...and shows the new time straight away", page.text_content("#tNow").startswith("3")
              and page.text_content("#seekBtn").startswith("3"), (page.text_content("#tNow"), page.text_content("#seekBtn")))
        page.mouse.click(195, 120)  # outside the card
        check("tapping outside closes it", page.is_hidden("#seekSheet"))
        page.click("#fwd10")
        check("+10 s sends skip", sent()[-1]["type"] == "skip" and sent()[-1]["ms"] == 10000, sent()[-1])
        LOADING = "(id) => document.getElementById(id).classList.contains('loading')"
        check("...with a spinner until the computer answers", page.evaluate(LOADING, "fwd10"))
        check("...in place of its icon (no dimmed overlay)", page.is_hidden("#fwd10 .ico") and page.is_visible("#fwd10 small"))
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE, ensure_ascii=False)} )")
        check("...which an unrelated update doesn't stop", page.evaluate(LOADING, "fwd10"))
        ack = sent()[-1]["id"]
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE, ensure_ascii=False)[:-1]}, \"ack\": \"{ack}\"}})")
        check("...and the computer's ack does", not page.evaluate(LOADING, "fwd10"))
        page.click("#play")
        check("play/pause shows a spinner too", page.evaluate(LOADING, "play"))
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE, ensure_ascii=False)[:-1]}, \"ack\": \"{sent()[-1]['id']}\"}})")
        check("...until acknowledged", not page.evaluate(LOADING, "play"))
        page.click("#back10")
        check("-10 s sends skip", sent()[-1]["type"] == "skip" and sent()[-1]["ms"] == -10000, sent()[-1])
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE | {'d': None}, ensure_ascii=False)})")
        page.wait_for_timeout(2100)
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE | {'d': None}, ensure_ascii=False)})")
        check("no position chip without a length", page.is_hidden("#seekBtn"))
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE, ensure_ascii=False)})")
        page.wait_for_timeout(300)

        check("volume chip shows Netflix's volume", page.text_content("#volBtn") == "🔊 80%", page.text_content("#volBtn"))
        page.click("#volBtn")
        check("tapping it opens the volume popup", page.is_visible("#volSheet") and page.input_value("#vol") == "80"
              and page.text_content("#volPct") == "80%", (page.input_value("#vol"), page.text_content("#volPct")))
        vol = page.locator("#vol").bounding_box()
        page.mouse.click(vol["x"] + vol["width"] * 0.25, vol["y"] + vol["height"] / 2)
        last = sent()[-1]
        check("moving it sends the volume", last["type"] == "volume" and 0.15 < last["v"] < 0.35, last)
        page.click("#mute")
        check("mute button sends mute", sent()[-1]["type"] == "mute" and sent()[-1]["muted"] is True
              and page.text_content("#volPct") == "muted" and page.text_content("#volBtn") == "🔇 muted",
              (sent()[-1], page.text_content("#volPct"), page.text_content("#volBtn")))
        page.screenshot(path=str(pathlib.Path.home() / ".tmp" / "dual-subs-remote-vol.png"))
        page.click("#volSheet .sheet-close")
        check("✕ closes it", page.is_hidden("#volSheet"))
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE | {'v': None}, ensure_ascii=False)})")
        page.wait_for_timeout(2100)
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE | {'v': None}, ensure_ascii=False)})")
        check("no volume chip if the computer doesn't send one", page.is_hidden("#volBtn"))
        page.evaluate(f"window.__push('remote/u1/state', {json.dumps(STATE, ensure_ascii=False)})")

        print("4/4: word panel")
        page.click("#line .w.unknown")
        check("tapping a word picks it", sent()[-1] | {"id": 0} == {"id": 0, "type": "pick", "c": 36000, "i": 8, "at": {".sv": "timestamp"}}, sent()[-1])
        check("...and opens its panel at once, before the computer answers", page.is_visible("#panel")
              and page.text_content("#pWord") == "적" and page.text_content("#pState") == "unknown"
              and "Looking up" in page.text_content("#pDict"), (page.text_content("#pWord"), page.text_content("#pDict")))
        page.evaluate("window.__push('remote/u1/panel', null)")  # the computer's answer to an earlier close, arriving late
        check("...and a late answer from before doesn't close it", page.is_visible("#panel"))
        page.evaluate(f"window.__push('remote/u1/panel', {json.dumps(PANEL, ensure_ascii=False)})")
        check("panel shown", page.is_visible("#panel") and page.text_content("#pWord") == "적")
        top, off = page.evaluate(MIDDLE)
        GROUP = """(() => { const m = document.getElementById('main').getBoundingClientRect(); const a = document.getElementById('now').getBoundingClientRect(); const b = document.getElementById('panel').getBoundingClientRect(); return [b.bottom - a.top, m.height, (a.top + b.bottom) / 2 - (m.top + m.bottom) / 2]; })()"""
        h, room, off = page.evaluate(GROUP)
        check("with the panel open, line + panel are centred together", h > room or abs(off) < 20, (h, room, off))
        check("...and the buttons and chips step aside for it", page.is_hidden("#dock") and page.is_hidden("#chips"))
        fit = page.evaluate("(() => { const m = document.getElementById('main'); return [m.scrollHeight, m.clientHeight, getComputedStyle(m).scrollbarWidth]; })()")
        check("a typical word fits without scrolling, and no scroll bar ever shows", fit[0] <= fit[1] and fit[2] == "none", fit)
        # Android's URL bar showing/hiding (and pull-to-refresh) changes the visible height:
        # the page must follow it and never scroll as a whole.
        PAGE_FIT = "[document.documentElement.scrollHeight, innerHeight, Math.round(document.getElementById('dock').getBoundingClientRect().bottom)]"
        for height in (700, 900, 844):
            page.set_viewport_size({"width": 390, "height": height})
            page.wait_for_timeout(100)
            doc_h, inner, dock_bottom = page.evaluate(PAGE_FIT)
            # A word's panel is open here, so the dock is hidden (its bottom reads 0).
            check(f"at {height}px tall: no page scroll", doc_h <= inner and dock_bottom in (0, inner), (doc_h, inner, dock_bottom))
        page.evaluate("window.scrollTo(0, 500)")
        check("the page itself can't be scrolled", page.evaluate("scrollY") == 0, page.evaluate("scrollY"))
        check("picked word highlighted", page.eval_on_selector("#line .w.unknown", "e => e.classList.contains('picked')"))
        on = page.eval_on_selector_all("#pMarks .on", "els => els.map((e) => e.dataset.state)")
        check("current state highlighted", on == ["unknown"], on)
        check("grammar shown", "-ㄴ 적이 있다" in page.text_content("#pGrammar"))
        check("best sense marked, other homonym dimmed",
              page.locator("#pDict li.best").count() == 1 and page.locator("#pDict .meta.other").count() == 1)
        ai = page.inner_html("#pAi")
        check("AI answer rendered with bold", "<b>적</b> is a bound noun." in ai and "• pattern" in ai, ai)
        check("Ask button hidden once answered", page.is_hidden("#pAsk"))
        page.click("#pMarks [data-state=learning]")
        check("Learning sends mark", sent()[-1]["type"] == "mark" and sent()[-1]["state"] == "learning", sent()[-1])
        check("...and shows at once in the panel and the line", page.text_content("#pState") == "learning"
              and "on" in page.get_attribute("#pMarks [data-state=learning]", "class")
              and "learning" in page.get_attribute("#line .w.picked", "class"),
              (page.text_content("#pState"), page.get_attribute("#line .w.picked", "class")))
        page.evaluate(f"window.__push('remote/u1/panel', {json.dumps(PANEL, ensure_ascii=False)})")  # still the old state
        check("...even if the computer's panel from before the tap arrives", page.text_content("#pState") == "learning",
              page.text_content("#pState"))
        page.evaluate(f"window.__push('remote/u1/panel', {json.dumps(PANEL | {'ai': None}, ensure_ascii=False)})")
        page.click("#pAsk")
        check("Ask AI sends ask", sent()[-1]["type"] == "ask")
        check("...with a spinner on the button", "loading" in page.get_attribute("#pAsk", "class"))
        page.evaluate(f"window.__push('remote/u1/panel', {json.dumps(PANEL | {'ai': {'pending': True}}, ensure_ascii=False)})")
        check("...then 'Asking Gemini…' with a spinner", page.is_visible("#pAi .spinner") and "Asking Gemini" in page.text_content("#pAi"))
        page.screenshot(path=str(pathlib.Path.home() / ".tmp" / "dual-subs-remote.png"), full_page=False)
        page.click("#pClose")
        check("close sends unpick", sent()[-1]["type"] == "unpick")
        check("...and closes at once", page.is_hidden("#panel"))
        page.evaluate(f"window.__push('remote/u1/panel', {json.dumps(PANEL, ensure_ascii=False)})")  # sent before the close
        check("...staying closed if an older panel arrives", page.is_hidden("#panel"))
        page.evaluate("window.__push('remote/u1/panel', null)")
        check("panel gone", page.is_hidden("#panel"))
        btn = page.locator("#menuBtn").bounding_box()
        hdr = page.evaluate("(() => { const h = document.querySelector('h1'); return [h.getBoundingClientRect().height, parseFloat(getComputedStyle(h).lineHeight) || 0, getComputedStyle(h).whiteSpace]; })()")
        check("title on one line", hdr[0] < 30 and hdr[2] == "nowrap", hdr)
        check("⋮ menu at the top right", btn["x"] + btn["width"] > 390 - 30 and btn["y"] < 40, btn)
        check("...closed until tapped", page.is_hidden("#menuList"))
        page.click("#menuBtn")
        check("tapping it shows Sign out", page.is_visible("#signout"))
        check("no volume-button app item on a computer", page.is_hidden("#linkApp"))
        page.screenshot(path=str(pathlib.Path.home() / ".tmp" / "dual-subs-remote-menu.png"))
        page.mouse.click(195, 400)
        check("tapping elsewhere closes it", page.is_hidden("#menuList"))
        android = browser.new_page(viewport={"width": 390, "height": 844},
                                   user_agent="Mozilla/5.0 (Linux; Android 16; Pixel 9a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36")
        for name, body in (("app", FAKE_APP), ("auth", FAKE_AUTH), ("database", FAKE_DB)):
            android.route(f"{SDK}firebase-{name}.js", serve(body))
        android.goto(url)
        android.click("#signinBtn")
        android.wait_for_selector("#dock", state="visible")
        android.click("#menuBtn")
        check("on Android: volume-button app in the menu", android.is_visible("#linkApp"))
        android.click("#linkApp")  # (desktop Chromium can't open intent:// links, so it stays here)
        android.wait_for_timeout(300)
        link = android.get_attribute("#linkApp", "data-href") or ""
        check("...which hands the sign-in to the app (or downloads it)",
              link.startswith("intent://link?uid=u1&rt=refresh-1&email=octopus0246%40gmail.com#Intent;scheme=dualsubs;package=io.github.alexknight0.dualsubsvolume;")
              and "S.browser_fallback_url=" in link and "app%2Fdual-subs-volume.apk" in link, link)
        android.close()
        check("no errors", not errors, errors)
        browser.close()
    server.shutdown()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
