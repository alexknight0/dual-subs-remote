// Phone remote for the Netflix Dual Subs extension. The extension (on the computer
// playing Netflix) mirrors what's on screen into Firebase Realtime Database
// /remote/{uid}/state and /panel; this page shows them and writes commands to
// /remote/{uid}/command, which the extension watches (src/remote.js in the extension
// repo). Only Alex's account can read or write (database.rules.json there).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {
  initializeAuth, browserLocalPersistence, browserPopupRedirectResolver,
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
// Sign-in is kept in localStorage, not Firebase's default IndexedDB: all of Alex's sites share
// one origin and so one sign-in database, and Firebase waits forever if another site's page
// blocks opening it (seen on Android 2026-11-02: blank page until site data was cleared).
const auth = initializeAuth(app, { persistence: browserLocalPersistence, popupRedirectResolver: browserPopupRedirectResolver });
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
let signedInUser = null; // Firebase user (for the Android app link)

// ---------------------------------------------------------------------------
// Sign-in
onAuthStateChanged(auth, (user) => {
  $('boot').hidden = true;
  for (const u of unsubs) u();
  unsubs = [];
  uid = user ? user.uid : null;
  signedInUser = user || null;
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
// Seek slider. The extension sends the position (t) with each state update, not every
// second, so the slider moves on from it locally while playing.
const SEEK_SETTLE_MS = 1500; // after a seek, ignore states that may predate it
let dragging = false;
let seekSent = null; // { ms, at } of the last seek from here

function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function position() {
  if (!state || state.t === null || state.t === undefined) return null;
  const since = (at) => (state.playing ? Date.now() - at : 0);
  const pos = seekSent && Date.now() - seekSent.at < SEEK_SETTLE_MS ? seekSent.ms + since(seekSent.at) : state.t + since(stateAt);
  return Math.min(pos, state.d || pos);
}

function renderSeek() {
  const d = connected() ? state.d : null;
  $('seekRow').hidden = !d;
  if (!d || dragging) return;
  const input = $('seek');
  input.max = String(d);
  const pos = position() ?? 0;
  input.value = String(pos);
  $('tNow').textContent = formatTime(pos);
  $('tEnd').textContent = formatTime(d);
}

$('seek').addEventListener('input', () => {
  dragging = true;
  $('seekRow').classList.add('dragging');
  $('tNow').textContent = formatTime(Number($('seek').value));
});
$('seek').addEventListener('change', () => {
  const ms = Number($('seek').value);
  dragging = false;
  $('seekRow').classList.remove('dragging');
  seekSent = { ms, at: Date.now() };
  send('seek', { ms });
  renderSeek();
});
setInterval(renderSeek, 500);

// ---------------------------------------------------------------------------
// Volume: Netflix's own volume and mute on the computer (state.v 0-1, state.m). Web
// pages can't use the phone's volume buttons (the browser keeps them for the phone's
// own volume), so this is an on-screen slider.
let volDragging = false;
let volSent = null; // { v, m, at }: shown until the computer confirms or it's 2 s old

function renderVolume() {
  const has = connected() && typeof state.v === 'number';
  $('volRow').hidden = !has;
  if (!has) return;
  const recent = volSent && Date.now() - volSent.at < 2000;
  const v = recent && volSent.v !== undefined ? volSent.v : state.v;
  const m = recent && volSent.m !== undefined ? volSent.m : state.m;
  if (!volDragging) $('vol').value = String(Math.round(v * 100));
  $('volPct').textContent = m ? 'muted' : `${Math.round((volDragging ? $('vol').value / 100 : v) * 100)}%`;
  $('mute').textContent = m || v === 0 ? '🔇' : '🔊';
  $('mute').setAttribute('aria-label', m ? 'Unmute' : 'Mute');
}

$('vol').addEventListener('input', () => {
  volDragging = true;
  $('volPct').textContent = `${$('vol').value}%`;
});
$('vol').addEventListener('change', () => {
  volDragging = false;
  const v = Number($('vol').value) / 100;
  volSent = { v, m: false, at: Date.now() };
  send('volume', { v });
  renderVolume();
});
$('mute').addEventListener('click', () => {
  const muted = !(volSent && Date.now() - volSent.at < 2000 ? volSent.m : state && state.m);
  volSent = { m: muted, at: Date.now() };
  send('mute', { muted });
  renderVolume();
});

// ---------------------------------------------------------------------------
// Lock screen / notification / headphone controls (Alex, 2026-11-04). Phones only show
// media controls for a page that is playing audio, so after the first tap the page plays
// a silent looping track; the Media Session API then routes play/pause and next/previous
// track (lock screen, notification shade, Bluetooth headphones) to the extension. The
// phone's volume buttons can't be used: browsers never give them to pages.
// Turned off in the footer (it takes over the phone's media controls while on).
const MEDIA_KEY = 'dualSubsRemote.mediaControls'; // '0' = off (prefixed: shared origin)
let silence = null;

// A silent 8-bit mono WAV (128 = silence), over 5 s so Chrome treats it as real media.
function silentWav(seconds = 10, rate = 8000) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // bytes per second
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const mediaOn = () => localStorage.getItem(MEDIA_KEY) !== '0';

// The lock screen's play/pause also pauses our silent track: keep it going, or the
// controls disappear.
function keepPlaying() {
  if (silence && mediaOn() && silence.paused) silence.play().catch(() => {});
}

function startMediaControls() {
  if (!mediaOn() || !uid || !('mediaSession' in navigator)) return;
  if (!silence) {
    silence = new Audio(silentWav());
    silence.loop = true;
    silence.addEventListener('pause', () => setTimeout(keepPlaying, 0));
  }
  keepPlaying(); // needs a tap first; retried on the next one
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => send('playPause'));
  ms.setActionHandler('pause', () => send('playPause'));
  ms.setActionHandler('previoustrack', () => send('prev'));
  ms.setActionHandler('nexttrack', () => send('next'));
  mediaShown = '';
  renderMediaSession();
}

function stopMediaControls() {
  const s = silence;
  silence = null; // so the pause listener doesn't restart it
  s?.pause();
  if (!('mediaSession' in navigator)) return;
  for (const a of ['play', 'pause', 'previoustrack', 'nexttrack']) navigator.mediaSession.setActionHandler(a, null);
  navigator.mediaSession.metadata = null;
}

// What the lock screen shows: the current Korean line, the episode, and play/pause.
let mediaShown = '';
function renderMediaSession() {
  if (!silence || !mediaOn() || !('mediaSession' in navigator)) return;
  const live = connected();
  const line = live && state.line ? (state.line.parts || []).map((p) => (p.br ? ' ' : p.t)).join('') || state.line.en || '' : '';
  const key = JSON.stringify([line, live && state.title, live && state.playing]);
  if (key === mediaShown) return;
  mediaShown = key;
  if (typeof MediaMetadata !== 'undefined') {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: line || (live ? '…' : 'Not connected'),
      artist: (live && state.title) || 'Dual Subs remote',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
  navigator.mediaSession.playbackState = live ? (state.playing ? 'playing' : 'paused') : 'none';
}

document.addEventListener('pointerdown', startMediaControls, { capture: true });

function renderMediaToggle() {
  $('mediaToggle').textContent = `Lock-screen controls: ${mediaOn() ? 'on' : 'off'}`;
}
$('mediaToggle').addEventListener('click', () => {
  localStorage.setItem(MEDIA_KEY, mediaOn() ? '0' : '1');
  if (mediaOn()) startMediaControls();
  else stopMediaControls();
  renderMediaToggle();
});
renderMediaToggle();

// ---------------------------------------------------------------------------
// Android app (dual-subs-volume, ~/projects/dual-subs-volume): the phone's volume buttons
// change Netflix's volume. This button hands it the sign-in (a Firebase refresh token)
// through an intent link; without the app installed, Chrome downloads the APK instead.
const APP_PACKAGE = 'io.github.alexknight0.dualsubsvolume';
const APP_APK = new URL('app/dual-subs-volume.apk', location.href).href;

function appLink(user) {
  const q = new URLSearchParams({ uid: user.uid, rt: user.refreshToken, email: user.email || '' });
  return `intent://link?${q}#Intent;scheme=dualsubs;package=${APP_PACKAGE};S.browser_fallback_url=${encodeURIComponent(APP_APK)};end`;
}

$('androidApp').hidden = !/Android/i.test(navigator.userAgent);
$('linkApp').addEventListener('click', () => {
  if (!signedInUser) return;
  $('linkApp').dataset.href = appLink(signedInUser); // (read by the test)
  location.href = $('linkApp').dataset.href;
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
  renderSeek();
  renderVolume();
  renderMediaSession();
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
// Version check: the update light is shared by Alex's Pages sites
// (github.com/alexknight0/pages-common). Loaded dynamically so the remote still works if
// jsDelivr is unreachable.
import('https://cdn.jsdelivr.net/gh/alexknight0/pages-common@1.0.0/update.js')
  .then(({ initUpdateLight }) => initUpdateLight({
    version: VERSION,
    buttons: '#version',
  }))
  .catch((e) => {
    console.warn('update light:', e);
    for (const b of document.querySelectorAll('.version')) {
      b.dataset.state = 'unknown';
      b.title = "Couldn't load the update check (offline?).";
    }
  });
