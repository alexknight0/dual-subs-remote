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
let serverOffset = 0; // server time - this phone's time (RTDB .info/serverTimeOffset)
let panel = null;
let shownLineKey = null;
let signedInUser = null; // Firebase user (for the Android app link)
let errorText = ''; // shown under the title (showError)
let errorTimer = null;

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
  // (The dock and chips also hide while not connected: see render.)
  $('foot').hidden = !user;
  if (!user) {
    showError('');
    return;
  }
  const fail = (e) => {
    showError(e.code === 'PERMISSION_DENIED' ? 'Not allowed for this account' : `Error: ${e.message}`);
  };
  unsubs.push(
    onValue(ref(db, `remote/${uid}/state`), (snap) => {
      state = snap.val();
      stateAt = Date.now();
      if (state?.src) sources.set(state.src, Date.now());
      onAck(state?.ack);
      onStateTiming();
      render();
    }, fail),
    onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
      serverOffset = Number(snap.val()) || 0;
      render();
    }, fail),
    onValue(ref(db, `remote/${uid}/panel`), (snap) => {
      onPanel(snap.val());
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
$('signout').addEventListener('click', () => {
  setMenu(false);
  signOut(auth);
});

// ---------------------------------------------------------------------------
// Commands
// `busy`: a button (or its id) to show a spinner on until the computer acknowledges the
// command (state.ack = its id), or LOADING_MAX_MS passes (Alex, 2026-11-04).
const LOADING_MAX_MS = 6000;
const loading = new Map(); // command id -> { el, timer }

function send(type, args = {}, busy = null) {
  if (!uid) return null;
  navigator.vibrate?.(10);
  const id = crypto.randomUUID();
  const el = typeof busy === 'string' ? $(busy) : busy;
  if (el) {
    // A newer command from the same button replaces the older one's spinner.
    for (const [k, v] of loading) if (v.el === el) stopLoading(k);
    el.classList.add('loading');
    loading.set(id, { el, timer: setTimeout(() => stopLoading(id), LOADING_MAX_MS) });
  }
  sentCommands.push({ id, type, at: Date.now() });
  if (sentCommands.length > 20) sentCommands.shift();
  set(ref(db, `remote/${uid}/command`), { id, type, ...args, at: serverTimestamp() }).catch((e) => {
    stopLoading(id);
    dropLocal(id);
    showError(`Couldn't send: ${e.message}`, 5000);
  });
  return id;
}

function stopLoading(id) {
  const l = loading.get(id);
  if (!l) return;
  clearTimeout(l.timer);
  loading.delete(id);
  if (![...loading.values()].some((v) => v.el === l.el)) l.el.classList.remove('loading');
}

// The computer handles commands in order, so an ack also covers every earlier one.
function onAck(ack) {
  if (!ack || !loading.has(ack)) return;
  for (const id of [...loading.keys()]) {
    stopLoading(id);
    if (id === ack) break;
  }
}

$('play').addEventListener('click', () => {
  // Shown at once (Alex, 2026-11-07: the round trip made it feel laggy); no spinner.
  const playing = !shownPlaying();
  const id = send('playPause');
  if (id) planPlay(id, playing, 'playPause');
});
$('prev').addEventListener('click', () => planLine(send('prev', {}, 'prev'), 'start'));
$('next').addEventListener('click', () => planLine(send('next', {}, 'next'), 'start'));
$('back10').addEventListener('click', () => skip(-10000, 'back10'));
$('fwd10').addEventListener('click', () => skip(10000, 'fwd10'));
// Errors show under the title (for `ms`, or until cleared).
function showError(text, ms = 0) {
  errorText = text;
  clearTimeout(errorTimer);
  if (text && ms) errorTimer = setTimeout(() => showError(''), ms);
  $('error').textContent = text;
  $('error').hidden = !text;
}

$('pCloseBig').addEventListener('click', () => $('pClose').click());
$('pClose').addEventListener('click', () => {
  local = { pick: null, mark: null, at: Date.now() };
  panel = null;
  send('unpick');
  render();
});
$('pAsk').addEventListener('click', () => send('ask', {}, 'pAsk'));
for (const b of $('pMarks').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (!panel) return;
    // Shown straight away; the computer confirms a moment later.
    local = { ...local, mark: { word: panel.word, state: b.dataset.state }, at: Date.now() };
    panel = { ...panel, state: b.dataset.state };
    send('mark', { state: b.dataset.state });
    render();
  });
}

// Tapping a word or a mark button shows the result at once (Alex, 2026-11-04: each went
// phone -> database -> computer -> database -> phone first, ~0.8-1.5 s). For LOCAL_MS
// after a tap, answers from the computer that predate it are ignored.
const LOCAL_MS = 4000;
let local = { pick: undefined, mark: null, at: 0 }; // pick: { c, i } | null (closed here) | undefined

function pickWord(p) {
  local = { pick: { c: p.c, i: p.i }, mark: null, at: Date.now() };
  // What the phone knows already; the dictionary follows from the computer.
  panel = {
    word: p.w, form: p.t, kind: p.k, state: p.s, c: p.c, i: p.i, dict: 'pending',
    link: `https://alexknight0.github.io/korean-dict/#w=${encodeURIComponent(p.w)}`,
  };
  // (picking pauses Netflix, so the line stays up: shown at once too)
  const wasPlaying = shownPlaying();
  const id = send('pick', { c: p.c, i: p.i });
  if (id && wasPlaying) planPlay(id, false, 'pick');
  render();
}

function onPanel(value) {
  const recent = Date.now() - local.at < LOCAL_MS;
  if (recent && local.pick === null && value) return; // closed here; the close is on its way
  if (recent && local.pick && !(value && value.c === local.pick.c && value.i === local.pick.i)) return; // not the new word yet
  if (recent && local.mark && value && value.word === local.mark.word && value.state !== local.mark.state) {
    value = { ...value, state: local.mark.state }; // the mark is on its way
  }
  panel = value;
  render();
}

// The colour of a word in the line: a mark made here shows before the computer's update.
function partState(p) {
  const recent = Date.now() - local.at < LOCAL_MS;
  return recent && local.mark && local.mark.word === p.w ? local.mark.state : p.s;
}

// ---------------------------------------------------------------------------
// Where Netflix is: a clock run here between the computer's updates (it sends the
// position t with each state, not every second), so the slider, the time and the bar
// under the subtitle move on smoothly.
//  - Each state's t is taken as of when the computer sent it (state.at, its clock, which
//    like Firebase's server time is synced over the internet), not when it got here, so
//    the position doesn't lag by the trip (Alex, 2026-11-07: the bar jumped back and forth).
//  - A tap that plays, pauses, seeks or changes line changes the clock at once, without
//    waiting the ~1 s for the computer's answer (state.ack = the command's id); states
//    from before that answer are ignored for timing. A play or pause is planned for when
//    it will happen there: LAG ms after the tap, measured from the computer's ackAt.
//  - When an answer arrives, the small difference left is eased out over EASE_MS.
const SEEK_SETTLE_MS = 4000; // a tap's planned change gives up if not answered by then
const EASE_MS = 400;
const LAG_KEY = 'dualSubsRemote.lagMs';
let lagMs = Math.min(1500, Math.max(0, Number(localStorage.getItem(LAG_KEY)) || 300));
let dragging = false;
let clock = { t: null, at: 0, playing: false }; // position t (ms) at this phone's time `at`
let planned = null; // { id, kind, at, playing?, t?, line?, sent } a tap's change not answered yet
let ease = null; // { by, at }: a correction still being eased out
const sentCommands = []; // [{ id, type, at }] recent commands, oldest first

function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

// The clock without easing, at this phone's time `now`.
function clockAt(now) {
  if (clock.t === null) return null;
  let pos = clock.t;
  let from = clock.at;
  let playing = clock.playing;
  if (planned && planned.playing !== undefined && now > planned.at && planned.at > from) {
    if (playing) pos += planned.at - from;
    from = planned.at;
    playing = planned.playing;
  }
  if (playing) pos += Math.max(0, now - from);
  return pos;
}

function position(now = Date.now()) {
  let pos = clockAt(now);
  if (pos === null) return null;
  if (ease) {
    const left = 1 - (now - ease.at) / EASE_MS;
    if (left <= 0) ease = null;
    else pos += ease.by * left;
  }
  return Math.max(0, Math.min(pos, (state && state.d) || pos));
}

// Playing, as shown: what a tap here asked for until the computer answers.
function shownPlaying() {
  if (planned && planned.playing !== undefined) return planned.playing;
  return Boolean(state && state.playing);
}

// Moving now (for the bar's animation): playing, or about to be.
function clockMoving() {
  return clock.playing || Boolean(planned && planned.playing);
}

// A tap that plays or pauses: from LAG ms from now (what it takes to reach the computer).
function planPlay(id, playing, kind) {
  const now = Date.now();
  if (clock.t !== null) clock = { t: clockAt(now), at: now, playing: planned?.playing ?? clock.playing };
  planned = { id, kind, at: now + lagMs, playing, sent: now };
  render();
}

// A seek from here: there at once.
function planSeek(id, ms) {
  if (!id) return;
  const now = Date.now();
  const playing = shownPlaying();
  clock = { t: ms, at: now, playing };
  ease = null;
  planned = { id, kind: 'seek', at: now, sent: now, line: 'hide', playing: planned?.playing };
  render();
}

// ‹ / › from here: the line it goes to isn't known yet, but it starts there, so the bar
// goes back to empty at once.
function planLine(id) {
  if (!id) return;
  // (keeping a play or pause tapped just before, still on its way)
  planned = { ...(planned || {}), id, kind: 'line', sent: Date.now(), line: 'start' };
  render();
}

function dropLocal(id) {
  if (planned && planned.id === id) planned = null;
  render();
}

// A state arrived: take its timing unless a tap here hasn't been answered yet.
function onStateTiming() {
  const now = Date.now();
  if (state?.ack) measureLag(state.ack, state.ackAt);
  if (planned && !answers(state?.ack, planned.id) && now - planned.sent < SEEK_SETTLE_MS) return;
  if (!state || typeof state.t !== 'number') {
    clock = { t: null, at: 0, playing: false };
    planned = null;
    ease = null;
    return;
  }
  // (Taken as of when it was sent, if the clocks agree well enough: else when it arrived.)
  const sentAgo = typeof state.at === 'number' ? now + serverOffset - state.at : NaN;
  const at = sentAgo >= -200 && sentAgo < 3000 ? now - Math.max(0, sentAgo) : now;
  const before = position(now);
  const wasLine = planned?.line;
  clock = { t: state.t, at, playing: Boolean(state.playing) };
  planned = null;
  const after = clockAt(now);
  const by = before === null || after === null ? 0 : before - after;
  // Small differences are eased out; a real jump (a seek on the computer) isn't.
  ease = wasLine !== 'start' && Math.abs(by) > 20 && Math.abs(by) < 1500 ? { by, at: now } : null;
}

// Whether the computer's ack covers command `id` (it handles them in order).
function answers(ack, id) {
  const a = sentCommands.findIndex((c) => c.id === ack);
  const i = sentCommands.findIndex((c) => c.id === id);
  return a >= 0 && (i < 0 || a >= i);
}

// A tap's change that's had no answer for SEEK_SETTLE_MS: back to what the computer says.
function expirePlanned() {
  if (!planned || Date.now() - planned.sent < SEEK_SETTLE_MS) return;
  const kind = planned.kind;
  planned = null;
  onStateTiming();
  if (kind === 'playPause') showError("Netflix didn't answer. Try again.", 5000);
  render();
}

// How long taps take to be handled on the computer: its ackAt (≈ server time) less when
// the tap was sent (in server time), averaged, kept for next time.
function measureLag(id, ackAt) {
  const c = sentCommands.find((x) => x.id === id);
  if (!c || c.lagged || typeof ackAt !== 'number') return;
  c.lagged = true;
  const lag = ackAt - (c.at + serverOffset);
  if (!(lag >= 0 && lag < 3000)) return;
  lagMs = Math.round(lagMs * 0.5 + lag * 0.5);
  localStorage.setItem(LAG_KEY, String(lagMs));
}

// The bar under the subtitle fills from the start of what's shown (line.from) to the start
// of the next subtitle (line.next), not to the end of this one: the phone keeps a finished
// line up until the next starts (Alex, 2026-11-07). Hidden with no next subtitle. After
// ‹ / › here it's empty until the new line arrives (it starts there); after a seek here,
// hidden until then (which line it lands in isn't known yet).
let nextBarFrame = 0;
function renderNextBar() {
  cancelAnimationFrame(nextBarFrame);
  const line = connected() ? state.line : null;
  const pos = line ? position() : null; // (not before connected: render can run before this file's lets exist)
  const ok = line && typeof line.next === 'number' && typeof line.from === 'number' && line.next > line.from && pos !== null
    && planned?.line !== 'hide';
  $('nextBar').hidden = !ok;
  if (!ok) return;
  const f = planned?.line === 'start' ? 0 : Math.min(1, Math.max(0, (pos - line.from) / (line.next - line.from)));
  $('nextFill').style.transform = `scaleX(${f})`;
  if ((clockMoving() || ease) && f < 1) nextBarFrame = requestAnimationFrame(renderNextBar);
}

function renderSeek() {
  const d = connected() ? state.d : null;
  $('seekBtn').hidden = !d;
  if (!d) {
    $('seekSheet').hidden = true;
    return;
  }
  const pos = dragging ? Number($('seek').value) : position() ?? 0;
  $('seekBtn').textContent = `${formatTime(pos)} / ${formatTime(d)}`;
  if (dragging) return;
  const input = $('seek');
  input.max = String(d);
  input.value = String(pos);
  $('tNow').textContent = formatTime(pos);
  $('tEnd').textContent = formatTime(d);
}

// ±10 s buttons: the extension skips from the computer's own position (more exact than
// ours, which is extrapolated between updates); the slider shows where it should land.
function skip(ms, busy) {
  const d = state && state.d;
  const pos = position();
  const id = send('skip', { ms }, busy);
  if (pos !== null) planSeek(id, Math.max(0, Math.min(pos + ms, d || Infinity)));
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
  planSeek(send('seek', { ms }, 'seekBtn'), ms);
});
setInterval(() => {
  expirePlanned();
  renderSeek();
}, 500);

// ---------------------------------------------------------------------------
// Volume: Netflix's own volume and mute on the computer (state.v 0-1, state.m), in a row
// at the top (Alex, 2026-11-04). Web pages can't use the phone's volume buttons; the
// Android app dual-subs-volume does that.
let volDragging = false;
let volSent = null; // { v, m, at }: shown until the computer confirms or it's 2 s old

function renderVolume() {
  const has = connected() && typeof state.v === 'number';
  $('volBtn').hidden = !has;
  if (!has) {
    $('volSheet').hidden = true;
    return;
  }
  const recent = volSent && Date.now() - volSent.at < 2000;
  const v = recent && volSent.v !== undefined ? volSent.v : state.v;
  const m = recent && volSent.m !== undefined ? volSent.m : state.m;
  if (!volDragging) $('vol').value = String(Math.round(v * 100));
  $('volPct').textContent = m ? 'muted' : `${Math.round((volDragging ? $('vol').value / 100 : v) * 100)}%`;
  $('mute').textContent = m || v === 0 ? '🔇' : '🔊';
  $('volBtn').textContent = `${m || v === 0 ? '🔇' : '🔊'} ${m ? 'muted' : `${Math.round((volDragging ? $('vol').value / 100 : v) * 100)}%`}`;
  $('mute').setAttribute('aria-label', m ? 'Unmute' : 'Mute');
}

$('vol').addEventListener('input', () => {
  volDragging = true;
  $('volPct').textContent = `${$('vol').value}%`;
});

// The popups: tap a chip to open, tap outside the card or ✕ to close.
for (const [btn, sheet] of [['volBtn', 'volSheet'], ['seekBtn', 'seekSheet']]) {
  $(btn).addEventListener('click', () => {
    $(sheet).hidden = false;
    renderSeek();
    renderVolume();
  });
  $(sheet).addEventListener('click', (e) => {
    if (e.target === $(sheet) || e.target.closest('.sheet-close')) $(sheet).hidden = true;
  });
}
$('vol').addEventListener('change', () => {
  volDragging = false;
  const v = Number($('vol').value) / 100;
  volSent = { v, m: false, at: Date.now() };
  send('volume', { v }, 'volBtn');
  renderVolume();
});
$('mute').addEventListener('click', () => {
  const muted = !(volSent && Date.now() - volSent.at < 2000 ? volSent.m : state && state.m);
  volSent = { m: muted, at: Date.now() };
  send('mute', { muted }, 'mute');
  renderVolume();
});

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

$('linkApp').hidden = !/Android/i.test(navigator.userAgent);

// ⋮ menu at the top right: Volume-button app (Android) and Sign out.
function setMenu(open) {
  $('menuList').hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
}
$('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu($('menuList').hidden);
});
document.addEventListener('click', (e) => {
  if (!$('menuList').hidden && !e.target.closest('#menuList')) setMenu(false);
});
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

// Connected = the extension's last state is recent by its own timestamp (state.at, the
// computer's clock) against server time, not by when it reached this phone: the database
// hands over the last stored state on load, however old (Alex, 2026-11-04: a fresh page
// said connected for 12 s with no Netflix tab open). Both checks must hold.
const connected = () => Boolean(state) && typeof state.at === 'number'
  && Date.now() + serverOffset - state.at < STALE_MS && Date.now() - stateAt < STALE_MS;

// Netflix open in more than one tab or computer: each sends its own state (state.src =
// "<computer>:<tab>") at least every 5 s, and commands go to whichever sent last, so the
// remote flips between them. Warn while two or more have been heard within SOURCES_MS.
const SOURCES_MS = 12000;
const sources = new Map(); // src -> last heard (Date.now())

function renderMulti() {
  const now = Date.now();
  for (const [k, at] of sources) if (now - at > SOURCES_MS) sources.delete(k);
  const n = sources.size;
  const computers = new Set([...sources.keys()].map((k) => k.split(':')[0])).size;
  const el = $('multi');
  el.hidden = n < 2;
  if (n >= 2) {
    el.textContent = `Netflix is open in ${n} ${computers > 1 ? 'places (tabs or computers)' : 'tabs'}. The remote ` +
      'switches between them and may control the wrong one: close all but one.';
  }
}

function render() {
  const live = connected();
  // The buttons only make sense with Netflix on the other end.
  $('dock').hidden = !live;
  $('chips').hidden = !live;
  const playing = Boolean(live && shownPlaying());
  $('play').classList.toggle('playing', playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const line = live ? state.line : null;
  $('waiting').hidden = live;
  $('now').hidden = !live;
  $('title').textContent = (live && state.title) || '';
  $('title').hidden = !live || !state.title;
  renderMulti();

  if (line?.key !== shownLineKey) {
    shownLineKey = line?.key ?? null;
  }
  const el = $('line');
  el.textContent = '';
  for (const p of line?.parts || []) {
    if (p.br) el.append('\n');
    else if (!p.k) el.append(p.t);
    else {
      // Trailing spaces go after the button: inside it they'd be dropped.
      const [, word, space] = p.t.match(/^([\s\S]*?)(\s*)$/);
      const b = make('button', `w ${p.k === 'word' ? partState(p) : p.k}`, word);
      b.type = 'button';
      if (panel && panel.c === p.c && panel.i === p.i) b.classList.add('picked');
      b.addEventListener('click', () => pickWord(p));
      el.append(b, space);
    }
  }
  if (live && !line) el.append(make('span', 'muted', 'No subtitle right now.'));
  // The extension keeps the last line up between lines (line.past), so its words can still
  // be marked: say so, and dim it a little.
  $('pastTag').hidden = !line?.past;
  $('now').classList.toggle('past', Boolean(line?.past));
  const en = $('en');
  en.textContent = line?.en || '';
  en.hidden = !line?.en;
  // Never blurred on the phone, even when the TV blurs it (Alex, 2026-11-04).

  renderPanel(live);
  renderSeek();
  renderNextBar();
  renderVolume();
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
    if (panel.ai.pending) ai.append(make('span', 'spinner'), make('span', 'muted', 'Asking Gemini…'));
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
  if (panel.dict === 'pending') dict.append(make('span', 'spinner'), make('span', 'muted', 'Looking up…'));
  else if (panel.dict) dict.append(make('div', 'muted', panel.dict));
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
