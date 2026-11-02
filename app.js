// Phone remote for the Netflix Dual Subs extension. The extension (on the computer
// playing Netflix) mirrors what's on screen into Firebase Realtime Database
// /remote/{uid}/state and /panel; this page shows them and writes commands to
// /remote/{uid}/command, which the extension watches (src/remote.js in the extension
// repo). Only Alex's account can read or write (database.rules.json there).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import { getDatabase, onValue, ref, serverTimestamp, set } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-database.js';
import { VERSION } from './version.js';

const app = initializeApp({
  apiKey: 'AIzaSyAwUezOndGsztkWGH00Z-PqNRUnyZHouHU',
  authDomain: 'dual-subs-2b0407.firebaseapp.com',
  projectId: 'dual-subs-2b0407',
  appId: '1:729739067887:web:134e9a9668a73c6b69f61a',
  databaseURL: 'https://dual-subs-2b0407-default-rtdb.asia-southeast1.firebasedatabase.app',
});
const auth = getAuth(app);
const db = getDatabase(app);
const $ = (id) => document.getElementById(id);

// The extension writes `state` when it changes and at least every 5 s.
const STALE_MS = 12000;

let uid = null;
let unsubs = [];
let state = null;
let stateAt = 0; // local time the last state arrived
let panel = null;
let showEnglish = false; // tapped the blurred English on the phone (this line only)
let shownLineKey = null;

// ---------------------------------------------------------------------------
// Sign-in
onAuthStateChanged(auth, (user) => {
  for (const u of unsubs) u();
  unsubs = [];
  uid = user ? user.uid : null;
  $('signin').hidden = Boolean(user);
  $('main').hidden = !user;
  $('dock').hidden = !user;
  $('foot').hidden = !user;
  if (!user) {
    $('status').textContent = '';
    return;
  }
  const fail = (e) => {
    $('status').textContent = e.code === 'PERMISSION_DENIED' ? 'Not allowed for this account' : `Error: ${e.message}`;
  };
  unsubs.push(
    onValue(ref(db, `remote/${uid}/state`), (snap) => {
      state = snap.val();
      stateAt = Date.now();
      render();
    }, fail),
    onValue(ref(db, `remote/${uid}/panel`), (snap) => {
      panel = snap.val();
      render();
    }, fail),
  );
  render();
});

$('signinBtn').addEventListener('click', async () => {
  $('signinError').textContent = '';
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    $('signinError').textContent = `Couldn't sign in: ${e.message || e}`;
  }
});
$('signout').addEventListener('click', () => signOut(auth));

// ---------------------------------------------------------------------------
// Commands
function send(type, args = {}) {
  if (!uid) return;
  navigator.vibrate?.(10);
  set(ref(db, `remote/${uid}/command`), { id: crypto.randomUUID(), type, ...args, at: serverTimestamp() }).catch((e) => {
    $('status').textContent = `Couldn't send: ${e.message}`;
  });
}

$('play').addEventListener('click', () => send('playPause'));
$('prev').addEventListener('click', () => send('prev'));
$('next').addEventListener('click', () => send('next'));
$('reveal').addEventListener('click', () => send('reveal'));
$('pClose').addEventListener('click', () => send('unpick'));
$('pAsk').addEventListener('click', () => send('ask'));
for (const b of $('pMarks').querySelectorAll('button')) {
  b.addEventListener('click', () => send('mark', { state: b.dataset.state }));
}
$('en').addEventListener('click', () => {
  showEnglish = !showEnglish;
  render();
});

// ---------------------------------------------------------------------------
// Rendering
const make = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

// Gemini's light markdown (**bold**, *italic*, "- " bullets) as DOM, never as HTML.
function appendMarkdown(el, text) {
  String(text || '')
    .trim()
    .split('\n')
    .forEach((raw, i) => {
      if (i) el.append(make('br'));
      const ln = raw.replace(/^\s*[-*]\s+/, '• ').replace(/^#+\s*/, '');
      for (const m of ln.matchAll(/\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|([^*]+|\*)/g)) {
        if (m[1]) el.append(make('b', null, m[1]));
        else if (m[2]) el.append(make('i', null, m[2]));
        else el.append(m[3]);
      }
    });
}

const connected = () => state && Date.now() - stateAt < STALE_MS;

function render() {
  const live = connected();
  const status = $('status');
  status.className = live ? 'status on' : 'status';
  status.textContent = live ? (state.playing ? 'Playing' : 'Paused') : 'Not connected';
  $('play').textContent = live && state.playing ? '⏸' : '▶';
  const line = live ? state.line : null;
  $('waiting').hidden = live;
  $('now').hidden = !live;
  $('title').textContent = (live && state.title) || '';

  if (line?.key !== shownLineKey) {
    shownLineKey = line?.key ?? null;
    showEnglish = false;
  }
  const el = $('line');
  el.textContent = '';
  for (const p of line?.parts || []) {
    if (p.br) el.append('\n');
    else if (!p.k) el.append(p.t);
    else {
      // Trailing spaces go after the button: inside it they'd be dropped.
      const [, word, space] = p.t.match(/^([\s\S]*?)(\s*)$/);
      const b = make('button', `w ${p.k === 'word' ? p.s : p.k}`, word);
      b.type = 'button';
      if (panel && panel.c === p.c && panel.i === p.i) b.classList.add('picked');
      b.addEventListener('click', () => send('pick', { c: p.c, i: p.i }));
      el.append(b, space);
    }
  }
  if (live && !line) el.append(make('span', 'muted', 'No subtitle right now.'));
  const en = $('en');
  en.textContent = line?.en || '';
  en.hidden = !line?.en;
  en.classList.toggle('blurred', Boolean(line?.hidden) && !showEnglish);
  en.title = line?.hidden ? 'Tap to show (on this phone only)' : '';

  renderPanel(live);
}

function renderPanel(live) {
  $('panel').hidden = !(live && panel);
  if (!live || !panel) return;
  $('pWord').textContent = panel.word;
  $('pForm').textContent = panel.form && panel.form !== panel.word ? panel.form : '';
  const st = $('pState');
  st.textContent = panel.kind === 'word' ? panel.state : `${panel.kind} · not counted`;
  st.className = `p-state ${panel.state || ''}`;
  $('pMarks').hidden = panel.kind !== 'word';
  for (const b of $('pMarks').querySelectorAll('button')) b.classList.toggle('on', b.dataset.state === panel.state);

  $('pAuto').hidden = !panel.auto;
  $('pAuto').textContent = panel.auto || '';

  const ai = $('pAi');
  ai.textContent = '';
  ai.hidden = !panel.ai;
  if (panel.ai) {
    ai.append(make('span', 'tag', 'AI'));
    if (panel.ai.pending) ai.append(make('span', 'muted', 'Asking Gemini…'));
    else if (panel.ai.error) ai.append(make('span', 'muted', panel.ai.error));
    else appendMarkdown(ai, panel.ai.text);
  }
  const ask = $('pAsk');
  ask.hidden = Boolean(panel.ai && !panel.ai.error);
  ask.disabled = Boolean(panel.ai?.pending);

  const grammar = $('pGrammar');
  grammar.textContent = '';
  for (const g of panel.patterns || []) {
    const box = make('div', 'grammar');
    const a = make('a', null, g.word);
    a.href = g.link;
    a.target = '_blank';
    a.rel = 'noopener';
    box.append(make('span', 'tag', 'grammar'), a, ` — ${g.def}`);
    grammar.append(box);
  }

  const dict = $('pDict');
  dict.textContent = '';
  if (panel.dict) dict.append(make('div', 'muted', panel.dict === 'pending' ? 'Looking up…' : panel.dict));
  for (const h of panel.kr || []) {
    const meta = make('div', h.posMatch ? 'meta' : 'meta other');
    meta.append(make('b', null, h.word));
    if (h.pos) meta.append(` ${h.pos}`);
    if (h.level) meta.append(make('span', 'level', h.level));
    dict.append(meta);
    const ol = make('ol', h.posMatch ? null : 'other');
    for (const s of h.senses || []) {
      const li = make('li', s.best ? 'best' : null);
      if (s.en) li.append(make('b', null, s.en));
      if (s.def) li.append(s.en ? ` — ${s.def}` : s.def);
      ol.append(li);
    }
    dict.append(ol);
  }
  if (panel.od?.length) {
    const ol = make('ol');
    for (const s of panel.od) {
      const li = make('li', s.best ? 'best' : null, s.pos && s.pos !== '품사 없음' ? `(${s.pos}) ` : '');
      li.append(make('span', s.isEnglish ? null : 'ko', s.text));
      ol.append(li);
    }
    dict.append(ol);
  }
  if (!panel.dict && !panel.kr?.length && !panel.od?.length) dict.append(make('div', 'muted', 'Not in the dictionary.'));
  $('pLink').href = panel.link;
}

// The connection dot goes grey if the extension stops sending.
setInterval(() => {
  if (uid) render();
}, 3000);

// ---------------------------------------------------------------------------
// Version check (see the github-pages-site skill). VERSION is the copy that's running;
// version.js fetched with no-store is what GitHub Pages serves now.
const APP_FILES = ['./', 'index.html', 'app.js', 'version.js', 'style.css', 'manifest.webmanifest'];
const versionBtn = $('version');
let latestVersion = null;

function formatVersion(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function setVersionState(s) {
  const labels = {
    checking: 'Checking for updates…',
    ok: `Up to date (version ${formatVersion(VERSION)})`,
    stale: `Update available: running ${formatVersion(VERSION)}, latest is ${formatVersion(latestVersion)}. Tap to update.`,
    unknown: `Couldn't check for updates (offline?). Running ${formatVersion(VERSION)}.`,
    updating: 'Updating…',
  };
  versionBtn.dataset.state = s;
  versionBtn.title = labels[s];
  versionBtn.setAttribute('aria-label', labels[s]);
  versionBtn.querySelector('span').textContent = s === 'stale' ? 'Update' : '';
}

async function checkVersion() {
  try {
    const res = await fetch(`version.js?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    latestVersion = (await res.text()).match(/VERSION = "([^"]+)"/)?.[1];
    if (!latestVersion) throw new Error('no version');
    setVersionState(latestVersion > VERSION ? 'stale' : 'ok');
  } catch {
    setVersionState('unknown');
  }
}

versionBtn.addEventListener('click', async () => {
  const s = versionBtn.dataset.state;
  if (s === 'checking' || s === 'updating') return;
  if (s !== 'stale') {
    setVersionState('checking');
    await checkVersion();
    return;
  }
  setVersionState('updating');
  await Promise.all(APP_FILES.map((f) => fetch(f, { cache: 'reload' }).catch(() => {})));
  location.reload();
});

setVersionState('checking');
checkVersion();
setInterval(checkVersion, 5 * 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkVersion();
});
window.addEventListener('online', checkVersion);
