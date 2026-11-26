// ui.js - wires the page together: connection, Live controls, Shows, Create.

import { BleLink, SimLink, bluetoothAvailable } from './ble.js';
import { Onboard } from './protocol.js';
import { ZONES } from './engine.js';
import { LANES, BODY, EYES, UNI_EYE, SHIELD, newAnimation, fromData, toData, evalAll, showEnd } from './animation.js';
import { Player } from './player.js';
import { Editor, audioPeaks } from './editor.js';
import { Preview } from './preview.js';
import { loadConfig, saveConfig, checkPin, normalize, online, DEFAULTS } from './config.js';
import { logConnect, logEnd, loadLog, clearLog, SHOW_LAST } from './log.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const OWNER = params.has('owner');            // ?owner: no automatic disconnect (for setting up)
const DEMO = params.has('demo');
const WARN_AT_S = [30, 10];                   // "time is nearly up" warnings
const SWATCHES = [[255, 0, 0], [255, 60, 0], [255, 160, 0], [255, 255, 255], [0, 255, 0], [0, 200, 255], [0, 60, 255], [170, 0, 255], [255, 0, 140], [0, 0, 0]];

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const scale = (c, pct) => c.map((v) => Math.max(0, Math.min(255, Math.floor((v * pct) / 100 + 0.5))));
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

// ------------------------------------------------------------------------------------ state
// Admin settings from the online database (null = not loaded: the Nano keeps its own)
let cfg = null;
let adminPin = (() => { try { return sessionStorage.getItem('diorama.pin'); } catch { return null; } })();
const isAdmin = () => !!adminPin;
const shieldLocked = () => !(cfg ? cfg.shieldEnabled : DEFAULTS.shieldEnabled);
let deadline = null;         // performance.now() when this visitor's time is up (null = no limit)
let warned = new Set();

// Live look. Starts as the idle look, so connecting changes nothing.
function idleLive(c) {
  const i = (c || DEFAULTS).idle;
  return { body: Array.from({ length: 9 }, () => [...i.body]), bodyPct: 100, eyes: [...i.eyes], uni: i.uni, speed: 0, reverse: false };
}
const live = store.get('diorama.live', null) || idleLive(null);
const saveLive = () => store.set('diorama.live', live);

let link = null, ob = null;
let session = null;      // {start, id: Promise<log entry id>} while connected
let endReason = null;    // why the current connection is ending (for the log)
let tab = 'live';
let lastActivity = performance.now();
let featured = [];       // [{title, description, file, data}]
let music = [];          // [{title, file}]
let current = null;      // the animation in the editor
let playing = null;      // {anim, title} while a show plays

const audio = $('#audio');
const player = new Player(audio, () => (link && link.connected ? ob : null));
const preview = new Preview($('#preview'));

function liveValues() {
  const v = live.body.map((c) => scale(c, live.bodyPct));
  v.push([...live.eyes]);
  v.push([Math.round(live.uni * 2.55), 0, 0]);
  v.push([Math.round(live.speed * 2.55), live.reverse ? 255 : 0, 0]);
  return v;
}

// What the diorama should show right now (when no show is playing)
function wanted() {
  const base = liveValues();
  if (tab === 'create' && current && $('#c-mirror').checked) {
    const ev = evalAll(current, editor.cursor);
    return base.map((b, i) => ev[i] || b);
  }
  return base;
}

// --------------------------------------------------------------------- sending the live look
// Compares what the diorama should show with what was last sent and sends only the zones that
// changed. One command at a time, so a fast slider just sends its latest value.
let sent = new Array(ZONES).fill(null);
let syncing = false;
function sync() {
  if (syncing || !ob || !link.connected || player.playing) return;
  syncing = true;
  (async () => {
    try {
      for (;;) {
        if (!link.connected || player.playing) break;
        const want = wanted();
        const diff = [];
        want.forEach((c, z) => { const s = sent[z]; if (!s || s[0] !== c[0] || s[1] !== c[1] || s[2] !== c[2]) diff.push([z, c]); });
        if (!diff.length) break;
        await ob.setNow(diff);
        diff.forEach(([z, c]) => (sent[z] = c));
      }
    } catch (e) {
      lostLink(e);
    } finally {
      syncing = false;
    }
  })();
}
const resendAll = () => { sent = new Array(ZONES).fill(null); sync(); };

// --------------------------------------------------------------------------------- connection
function setStatus(text, on = false) {
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('on', on);
}

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

async function connect() {
  if (link && link.connected) { disconnect(); return; }
  const btn = $('#connect');
  btn.disabled = true;
  try {
    if (DEMO) {
      link = new SimLink();
    } else {
      if (!canConnect()) {
        showNotice();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast(IS_IOS ? "Sorry, iPhone and iPad can't connect to the diorama. Use an Android phone or a computer." : 'This browser cannot use Bluetooth. Use Chrome or Edge.', 6000);
        return;
      }
      link = new BleLink();
      setStatus('Choose the diorama in the list…');
      await link.connect();
    }
    link.onDisconnect = () => onDisconnected();
    ob = new Onboard(link);
    setStatus('Connecting…');
    await ob.ping();
    // the admin settings go to the Nano on every connect (it only keeps them in RAM)
    const fresh = await loadConfig();
    if (fresh) { cfg = fresh; applyCfg(); }
    if (cfg) await ob.sendConfig(cfg);
    await ob.hello(isAdmin());
    startCountdown();
    setStatus(`Connected to ${link.name}`, true);
    btn.textContent = 'Disconnect';
    btn.classList.remove('primary');
    lastActivity = performance.now();
    session = { start: Date.now(), id: DEMO ? Promise.resolve(null) : logConnect(isAdmin()) };
    resendAll();
  } catch (e) {
    console.warn(e);
    const cancelled = e && e.name === 'NotFoundError' && (!link || link.stage === 'choosing the device');
    const detail = link && link.describe ? link.describe(e) : String((e && e.message) || e);
    setStatus('Not connected');
    if (link && link.disconnect) try { link.disconnect(); } catch { /* ignore */ }
    link = null; ob = null;
    if (!cancelled) {
      if (link && link.stage === 'choosing the device') {
        toast('Could not open the Bluetooth list. Check that Bluetooth is on and this browser is allowed to use it. Details at the top of the page.', 9000);
      } else {
        toast('Could not connect. If the diorama is not in the list, someone else is using it. Try again in a minute.', 6000);
      }
      const n = $('#notice');                 // keep the details on screen for troubleshooting
      n.textContent = 'Connection problem (' + detail + ')';
      n.hidden = false;
    } else {
      toast('If the diorama is not in the list, someone else is connected. Try again in a minute.', 6000);
    }
  } finally {
    btn.disabled = false;
  }
}

function disconnect(reason = 'left') {
  endReason = endReason || reason;
  player.stop();
  if (link) link.disconnect();
  onDisconnected();
}

// how long the visitor stayed and why it ended, added to their log entry
function endSession(reason) {
  if (!session) return;
  const s = session;
  session = null;
  const secs = (Date.now() - s.start) / 1000;
  s.id.then((id) => logEnd(id, secs, reason));
}
window.addEventListener('pagehide', () => endSession('closed'));

function onDisconnected() {
  if (!link && !ob) return;
  const timeUp = deadline !== null && performance.now() >= deadline - 3000;
  endSession(timeUp ? 'time' : endReason || 'lost');
  endReason = null;
  link = null; ob = null;
  deadline = null;
  if (player.playing) player.stop();
  if (timeUp) toast("Time's up! Thanks for playing. The diorama is free for the next person in a few seconds.", 8000);
  setStatus('Not connected');
  const btn = $('#connect');
  btn.textContent = 'Connect';
  btn.classList.add('primary');
  $('#stats').textContent = '';
}

function lostLink(e) {
  console.warn(e);
  if (!(deadline !== null && performance.now() >= deadline - 3000)) toast('Lost the connection to the diorama.');
  disconnect('lost');
}

function startCountdown() {
  warned = new Set();
  const limit = cfg ? cfg.timeLimitS : DEFAULTS.timeLimitS;   // offline: the Nano's power-on default
  deadline = !isAdmin() && limit ? performance.now() + limit * 1000 : null;
  updateCountdown();
}

function updateCountdown() {
  if (!link || !link.connected) return;
  const s = $('#status');
  if (deadline === null) { setStatus(`Connected to ${link.name}${isAdmin() ? ' · admin' : ''}`, true); return; }
  const left = Math.max(0, (deadline - performance.now()) / 1000);
  setStatus(`Connected · ${fmt(Math.ceil(left))} left`, true);
  s.classList.toggle('warn', left <= WARN_AT_S[0]);
  for (const w of WARN_AT_S) {
    if (left <= w && !warned.has(w)) {
      warned.add(w);
      toast(`Only ${w} seconds left with the diorama!`, 4000);
    }
  }
}

// iPhone / iPad (iPads report themselves as a Mac with a touch screen). Even Web Bluetooth
// browsers there (Bluefy) could not connect to this module, so iOS is not supported.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canConnect = () => !IS_IOS && bluetoothAvailable();

function showNotice() {
  const n = $('#notice');
  if (IS_IOS) {
    n.innerHTML = '<strong>Sorry, this doesn\'t work on iPhone or iPad.</strong> Apple devices can\'t connect to the diorama. Please use an <strong>Android</strong> phone (Chrome) or a computer with Chrome or Edge. You can still look around and try the <a href="?demo">demo</a> here.';
  } else {
    n.innerHTML = 'This browser cannot use Bluetooth. Open this page in <strong>Chrome</strong> (Android, Windows, Mac) or <strong>Edge</strong>. You can still try the <a href="?demo">demo</a>.';
  }
  n.hidden = false;
}

// keep-alive, stats and freeing the diorama for the next visitor
['pointerdown', 'keydown', 'input'].forEach((ev) => window.addEventListener(ev, () => (lastActivity = performance.now()), { passive: true }));
setInterval(async () => {
  if (!ob || !link || !link.connected) return;
  $('#stats').textContent = `rtt ${Math.round(ob.lastRtt)} ms · ${ob.commands} cmds · ${ob.errors} retries` +
    (player.playing ? ` · drift ${Math.round(ob.lastDrift)} ms · adj ${ob.adjusts}` : '');
  updateCountdown();
  if (player.playing) { lastActivity = performance.now(); return; }
  const inactivity = (cfg ? cfg.inactivityS : DEFAULTS.inactivityS) * 1000;
  if (!OWNER && !DEMO && !isAdmin() && inactivity && performance.now() - lastActivity > inactivity) {
    disconnect('idle');
    toast('Disconnected so the next person can have a go. Tap Connect to play again.', 6000);
    return;
  }
  if (!syncing && performance.now() - ob.lastContact > 1000) {
    try { await ob.ping(); } catch (e) { lostLink(e); }
  }
}, 1000);

// --------------------------------------------------------------------------------- preview loop
function frame() {
  let vals;
  if (player.playing && playing) {
    const t = player.t();
    const ev = evalAll(playing.anim, t + player.lead);
    const base = liveValues();
    vals = base.map((b, i) => ev[i] || b);
    if (tab === 'create' && playing.anim === current) editor.follow(t);
    updateNowPlaying(t);
  } else {
    vals = wanted();
  }
  if (DEMO && link && link.connected && link.colors) vals = link.colors();   // show the pretend Nano itself
  if (shieldLocked()) vals = vals.map((v, i) => (i === SHIELD ? [0, 0, 0] : v));
  preview.render(vals);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------------------------ tabs
function setTab(name) {
  tab = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === 'create') editor.draw();
  if (name === 'shows') renderMine();
  sync();
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});

// ------------------------------------------------------------------------------------ live
function swatches(el, onPick) {
  el.innerHTML = SWATCHES.map((c) => `<button class="sw" style="background:${hex(c)}" data-c="${hex(c)}" aria-label="Colour ${hex(c)}"></button>`).join('');
  el.addEventListener('click', (e) => { const b = e.target.closest('.sw'); if (b) onPick(unhex(b.dataset.c)); });
}

function renderLive() {
  $('#body-color').value = hex(live.body[0]);
  $('#body-pct').value = live.bodyPct; $('#body-pct-o').textContent = live.bodyPct + '%';
  $('#eye-color').value = hex(live.eyes);
  $('#uni').value = live.uni; $('#uni-o').textContent = live.uni + '%';
  $('#speed').value = live.speed; $('#speed-o').textContent = live.speed + '%';
  $('#reverse').checked = live.reverse;
  document.querySelectorAll('#zone-grid input').forEach((inp) => (inp.value = hex(live.body[+inp.dataset.z])));
}

function liveChanged() {
  renderLive();
  saveLive();
  if (player.playing && tab === 'live') { player.stop(); playing = null; }
  sync();
}

function setupLive() {
  $('#zone-grid').innerHTML = BODY.map((z) => `<label>${LANES[z].name}<input type="color" data-z="${z}"></label>`).join('');
  swatches(document.querySelector('.swatches[data-for=body]'), (c) => { live.body = live.body.map(() => [...c]); liveChanged(); });
  swatches(document.querySelector('.swatches[data-for=eyes]'), (c) => { live.eyes = c; liveChanged(); });
  $('#body-color').addEventListener('input', (e) => { const c = unhex(e.target.value); live.body = live.body.map(() => [...c]); liveChanged(); });
  $('#zone-grid').addEventListener('input', (e) => { const z = +e.target.dataset.z; live.body[z] = unhex(e.target.value); liveChanged(); });
  $('#eye-color').addEventListener('input', (e) => { live.eyes = unhex(e.target.value); liveChanged(); });
  $('#body-pct').addEventListener('input', (e) => { live.bodyPct = +e.target.value; liveChanged(); });
  $('#uni').addEventListener('input', (e) => { live.uni = +e.target.value; liveChanged(); });
  $('#speed').addEventListener('input', (e) => { live.speed = +e.target.value; liveChanged(); });
  $('#reverse').addEventListener('change', (e) => { live.reverse = e.target.checked; liveChanged(); });
  $('#stop-shield').addEventListener('click', () => { live.speed = 0; liveChanged(); });
  renderLive();
}

// The admin settings changed (loaded, or saved in the panel): update what visitors see
function applyCfg() {
  const locked = shieldLocked();
  $('#shield-card').classList.toggle('locked', locked);
  $('#shield-locked').hidden = !locked;
  renderFeatured();
  renderOpenSelect();
}

// ------------------------------------------------------------------------------------ admin
// Hidden: tap the logo 5 times quickly, or open the page with #admin. The PIN is checked by the
// database rules, so it never appears in this page.
let logoTaps = [];
$('.brand').addEventListener('click', () => {
  const now = performance.now();
  logoTaps = logoTaps.filter((t) => now - t < 3000).concat(now);
  if (logoTaps.length >= 5) { logoTaps = []; openAdmin(); }
});
window.addEventListener('hashchange', () => { if (location.hash === '#admin') openAdmin(); });

async function openAdmin() {
  if (isAdmin()) { showAdminTab(); return; }
  if (!online()) { toast('The admin panel needs the online database (web/js/firebase-config.js).', 6000); return; }
  const pin = (prompt('Admin PIN') || '').trim();
  if (!pin) return;
  if (!(await checkPin(pin))) { toast('Wrong PIN.'); return; }
  adminPin = pin;
  try { sessionStorage.setItem('diorama.pin', pin); } catch { /* private mode */ }
  showAdminTab();
  if (ob && link.connected) { try { await ob.hello(true); } catch (e) { lostLink(e); } }
  startCountdown();
}

function showAdminTab() {
  $('[data-tab=admin]').hidden = false;
  fillAdmin(cfg || normalize(null));
  renderFeatured();
  setTab('admin');
  refreshLog();
}

function lockAdmin() {
  adminPin = null;
  try { sessionStorage.removeItem('diorama.pin'); } catch { /* ignore */ }
  $('[data-tab=admin]').hidden = true;
  if (location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search);
  setTab('live');
  renderFeatured();
  if (ob && link.connected) ob.hello(false).then(startCountdown).catch(lostLink);
  else deadline = null;
}

function fillAdmin(c) {
  $('#a-shield').checked = c.shieldEnabled;
  $('#a-time').value = +(c.timeLimitS / 60).toFixed(2);
  $('#a-off').value = c.offTimeS;
  $('#a-idle-delay').value = c.idleDelayS;
  $('#a-inactivity').value = c.inactivityS;
  $('#a-body').value = hex(c.idle.body);
  $('#a-eyes').value = hex(c.idle.eyes);
  $('#a-uni').value = c.idle.uni; $('#a-uni-o').textContent = c.idle.uni + '%';
  $('#a-sh').value = c.idle.shield; $('#a-sh-o').textContent = c.idle.shield + '%';
  $('#a-rev').checked = c.idle.reverse;
  const shows = $('#a-shows');
  shows.innerHTML = '';
  if (!featured.length) shows.innerHTML = '<p class="hint">No featured shows.</p>';
  for (const s of featured) {
    const l = document.createElement('label');
    l.className = 'toggle';
    l.innerHTML = '<input type="checkbox"> <span></span>';
    l.querySelector('input').checked = !c.hiddenShows.includes(s.file);
    l.querySelector('input').dataset.file = s.file;
    l.querySelector('span').textContent = s.title;
    shows.append(l);
  }
  $('#a-status').textContent = online() ? '' : 'No online database set up: settings cannot be saved.';
}

function readAdmin() {
  return normalize({
    shieldEnabled: $('#a-shield').checked,
    timeLimitS: Math.round((+$('#a-time').value || 0) * 60),
    offTimeS: +$('#a-off').value,
    idleDelayS: +$('#a-idle-delay').value,
    inactivityS: +$('#a-inactivity').value,
    idle: {
      body: unhex($('#a-body').value), eyes: unhex($('#a-eyes').value),
      uni: +$('#a-uni').value, shield: +$('#a-sh').value, reverse: $('#a-rev').checked,
    },
    hiddenShows: [...document.querySelectorAll('#a-shows input')].filter((i) => !i.checked).map((i) => i.dataset.file),
  });
}

// ------------------------------------------------------------------------- connection log
const END_TEXT = { left: 'Disconnected', time: 'Time limit', idle: 'Inactive', lost: 'Lost link', closed: 'Closed page' };
const pad2 = (n) => String(n).padStart(2, '0');

async function refreshLog() {
  const box = $('#a-log');
  $('#a-log-status').textContent = 'Loading…';
  try {
    const entries = await loadLog();
    const today = new Date().toDateString();
    const nToday = entries.filter((e) => new Date(e.t).toDateString() === today && !e.admin).length;
    $('#a-log-status').textContent = entries.length
      ? `${nToday} visitor${nToday === 1 ? '' : 's'} today · ${entries.length >= SHOW_LAST ? 'latest ' + SHOW_LAST : entries.length} in total`
      : 'Nobody has connected yet.';
    box.innerHTML = '';
    let day = '';
    for (const e of entries) {
      const d = new Date(e.t);
      if (d.toDateString() !== day) {
        day = d.toDateString();
        const h = document.createElement('div');
        h.className = 'log-day';
        h.textContent = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
        box.append(h);
      }
      const row = document.createElement('div');
      row.className = 'log-row';
      const len = typeof e.len === 'number' ? fmt(e.len) : '—';
      const end = e.end ? END_TEXT[e.end] || e.end : (Date.now() - e.t < 15 * 60 * 1000 ? 'Connected?' : '');
      row.innerHTML = '<span class="log-time"></span><span class="log-dev"></span><span class="log-len"></span>';
      row.children[0].textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      row.children[1].textContent = (e.admin ? 'Admin · ' : '') + (e.dev || 'Unknown');
      row.children[2].textContent = end ? `${len} · ${end}` : len;
      box.append(row);
    }
  } catch (e) {
    $('#a-log-status').textContent = e.message;
  }
}

function setupAdmin() {
  $('#a-log-refresh').addEventListener('click', refreshLog);
  $('#a-log-clear').addEventListener('click', async () => {
    if (!confirm('Delete the whole connection log? This cannot be undone.')) return;
    try { await clearLog(adminPin); toast('Log cleared.'); } catch (e) { toast(e.message, 6000); }
    refreshLog();
  });
  $('#a-uni').addEventListener('input', (e) => ($('#a-uni-o').textContent = e.target.value + '%'));
  $('#a-sh').addEventListener('input', (e) => ($('#a-sh-o').textContent = e.target.value + '%'));
  $('#a-lock').addEventListener('click', lockAdmin);
  $('#a-save').addEventListener('click', async () => {
    const btn = $('#a-save');
    const next = readAdmin();
    btn.disabled = true;
    $('#a-status').textContent = 'Saving…';
    try {
      await saveConfig(adminPin, next);
      cfg = next;
      applyCfg();
      let msg = 'Saved. Visitors get these settings when they connect.';
      if (ob && link.connected) { await ob.sendConfig(cfg); msg = 'Saved and sent to the diorama.'; }
      $('#a-status').textContent = msg;
      toast(msg);
    } catch (e) {
      $('#a-status').textContent = e.message;
      toast(e.message, 6000);
    } finally {
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------------------------ shows
const mine = () => store.get('diorama.mine', {});

async function loadLibrary() {
  try {
    const idx = await (await fetch('shows/index.json', { cache: 'no-cache' })).json();
    featured = await Promise.all(idx.map(async (s) => {
      try {
        const data = await (await fetch('shows/' + s.file, { cache: 'no-cache' })).json();
        return { ...s, data };
      } catch { return null; }
    }));
    featured = featured.filter(Boolean);
  } catch { featured = []; }
  try { music = await (await fetch('music/index.json', { cache: 'no-cache' })).json(); } catch { music = []; }
  renderFeatured();
  renderMusicSelect();
}

function showButton(title, sub) {
  const b = document.createElement('button');
  b.className = 'show';
  b.innerHTML = '<span class="play-ico" aria-hidden="true">▶</span><span class="meta"><strong></strong><span></span></span>';
  b.querySelector('strong').textContent = title;
  b.dataset.title = title;
  b.querySelector('.meta span').textContent = sub;
  return b;
}

function describe(anim) {
  const keys = anim.lanes.reduce((n, l) => n + l.length, 0);
  const len = showEnd(anim);
  return `${fmt(len)} · ${keys} keys${anim.audio && anim.audio.name ? ' · ♪ ' + anim.audio.name : ''}`;
}

function renderFeatured() {
  const el = $('#show-list');
  el.innerHTML = '';
  if (!featured.length) { el.innerHTML = '<p class="hint">No shows yet.</p>'; return; }
  const hidden = cfg ? cfg.hiddenShows : [];
  const list = featured.filter((s) => isAdmin() || !hidden.includes(s.file));
  if (!list.length) { el.innerHTML = '<p class="hint">No shows yet.</p>'; return; }
  for (const s of list) {
    const anim = fromData(s.data, s.title);
    const b = showButton(s.title || anim.title, s.description || describe(anim));
    b.addEventListener('click', () => playShow(fromData(s.data, s.title)));
    el.append(b);
  }
}

function renderMine() {
  const el = $('#my-list');
  el.innerHTML = '';
  const all = Object.entries(mine());
  if (!all.length) { el.innerHTML = '<p class="hint">Make your own in the Create tab and press Save.</p>'; return; }
  for (const [id, data] of all) {
    const anim = fromData(data);
    const row = document.createElement('div');
    row.className = 'show-row';
    const b = showButton(anim.title, describe(anim));
    b.addEventListener('click', () => playShow(fromData(data)));
    const del = document.createElement('button');
    del.className = 'del danger'; del.textContent = '✕'; del.setAttribute('aria-label', 'Delete ' + anim.title);
    del.addEventListener('click', () => {
      if (!confirm(`Delete "${anim.title}" from this phone?`)) return;
      const m = mine(); delete m[id]; store.set('diorama.mine', m); renderMine(); renderOpenSelect();
    });
    row.append(b, del);
    el.append(row);
  }
}

// audio URL for an animation: bundled file, or the file picked on this phone this session
const localMusic = new Map();        // file name -> blob URL
function audioUrlFor(anim) {
  if (!anim.audio) return null;
  if (anim.audio.src) return anim.audio.src;
  if (anim.audio.name && localMusic.has(anim.audio.name)) return localMusic.get(anim.audio.name);
  const m = music.find((x) => x.file.split('/').pop() === anim.audio.name);
  if (m) { anim.audio.src = 'music/' + m.file; return anim.audio.src; }
  return null;
}

async function playShow(anim, from = 0) {
  anim._audioUrl = audioUrlFor(anim);
  if (anim._audioUrl) player.unlockAudio(anim._audioUrl);     // still inside the tap (iOS)
  if (!link || !link.connected) toast('Not connected: playing on the screen only. Tap Connect to light up the diorama.');
  else if (anim.audio && !anim._audioUrl) toast(`Music "${anim.audio.name}" is not on this phone; playing without it.`);
  playing = { anim, title: anim.title };
  $('#np-title').textContent = anim.title;
  $('#now-playing').hidden = false;
  try {
    await player.play(anim, from);
  } catch (e) {
    lostLink(e);
  }
}

function updateNowPlaying(t) {
  const end = player.end || 1;
  $('#np-time').textContent = `${fmt(Math.min(t, end))} / ${fmt(end)}`;
  $('#np-fill').style.width = `${Math.min(100, (t / end) * 100)}%`;
}

player.onState = (on) => {
  $('#c-stop').disabled = !on;
  if (!on) {
    $('#now-playing').hidden = true;
    playing = null;
    resendAll();       // back to the live look (or the editor cursor)
  }
};
player.onEnd = () => { playing = null; };
player.onError = (e) => { if (/stopped answering|Not connected/.test(e.message)) lostLink(e); else toast(e.message); };
$('#np-stop').addEventListener('click', () => player.stop());

// ------------------------------------------------------------------------------------ create
const editor = new Editor($('#editor'), {
  onChange: () => { saveDraft(); if (!player.playing) sync(); },
  onPreview: () => { if (!player.playing) sync(); },
  getPlayhead: () => (player.playing && playing && playing.anim === current ? player.t() : null),
});

function saveDraft() { if (current) store.set('diorama.draft', toData(current)); }

async function setCurrent(anim) {
  current = anim;
  $('#anim-title').value = anim.title;
  $('#c-loop').checked = anim.settings.loop;
  $('#c-lead').value = anim.settings.light_lead_ms;
  $('#c-offset').value = anim.audio ? anim.audio.offset : 0;
  editor.setAnimation(anim);
  await refreshMusic();
  saveDraft();
}

async function refreshMusic() {
  const sel = $('#c-music'), hint = $('#c-music-hint');
  const url = audioUrlFor(current);
  current._audioUrl = url;
  hint.hidden = true;
  if (current.audio && !url) {
    hint.textContent = `This animation uses "${current.audio.name}". Pick that file with "From phone…" to hear it.`;
    hint.hidden = false;
  }
  const src = current.audio && current.audio.src;
  if (src && ![...sel.options].some((o) => o.value === src)) {
    sel.insertBefore(new Option(current.audio.name || src, src), sel.lastElementChild);
  }
  sel.value = src || (current.audio && url ? 'local' : '');
  if (!url) { editor.setAudio(0, null); return; }
  try {
    const p = await audioPeaks(url);
    if (current._audioUrl === url) editor.setAudio(p.length, p.peaks);
  } catch (e) {
    console.warn(e);
    editor.setAudio(0, null);
    hint.textContent = 'The music file could not be loaded.';
    hint.hidden = false;
  }
}

function renderMusicSelect() {
  const sel = $('#c-music');
  sel.innerHTML = '<option value="">None</option>' +
    music.map((m) => `<option value="music/${m.file}">${m.title}</option>`).join('') +
    '<option value="local" hidden>From this phone</option>';
  if (current) refreshMusic();
}

function renderOpenSelect() {
  const sel = $('#c-open');
  const hidden = cfg && !isAdmin() ? cfg.hiddenShows : [];
  const feats = featured.map((s, i) => [s, i]).filter(([s]) => !hidden.includes(s.file));
  sel.innerHTML = '<option value="">Open…</option>' +
    '<optgroup label="Made on this phone">' + Object.entries(mine()).map(([id, d]) => `<option value="mine:${id}">${escapeHtml(d.title || id)}</option>`).join('') + '</optgroup>' +
    '<optgroup label="Featured (open a copy)">' + feats.map(([s, i]) => `<option value="feat:${i}">${escapeHtml(s.title)}</option>`).join('') + '</optgroup>';
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setupCreate() {
  $('#anim-title').addEventListener('input', (e) => { current.title = e.target.value || 'Untitled'; saveDraft(); });
  $('#c-loop').addEventListener('change', (e) => { current.settings.loop = e.target.checked; saveDraft(); });
  $('#c-lead').addEventListener('change', (e) => { current.settings.light_lead_ms = Math.max(-500, Math.min(1000, +e.target.value || 0)); saveDraft(); });
  $('#c-offset').addEventListener('change', (e) => {
    if (!current.audio) return;
    editor.pushUndo();
    current.audio.offset = Math.max(0, +e.target.value || 0);
    editor.changed();
  });
  $('#c-mirror').addEventListener('change', () => resendAll());
  $('#c-new').addEventListener('click', () => {
    if (!confirm('Start a new animation? Unsaved changes to this one are lost.')) return;
    player.stop();
    setCurrent(newAnimation('My animation'));
  });
  $('#c-save').addEventListener('click', () => {
    const m = mine();
    const id = current._id || 'a' + Date.now().toString(36);
    current._id = id;
    m[id] = toData(current);
    if (store.set('diorama.mine', m)) toast(`Saved "${current.title}" on this phone.`);
    else toast('Could not save: this browser blocks storage.');
    renderOpenSelect();
  });
  $('#c-open').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (!v) return;
    player.stop();
    if (v.startsWith('mine:')) { const id = v.slice(5); const a = fromData(mine()[id]); a._id = id; setCurrent(a); }
    else { const s = featured[+v.slice(5)]; setCurrent(fromData(s.data, s.title)); }
  });
  $('#c-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(toData(current), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (current.title || 'animation').replace(/[^\w\- ]+/g, '').trim() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#c-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const anim = fromData(JSON.parse(await f.text()), f.name.replace(/\.json$/i, ''));
      player.stop();
      await setCurrent(anim);
      toast(`Opened "${anim.title}".`);
    } catch (err) {
      toast('That file is not an animation: ' + err.message);
    }
  });
  $('#c-music').addEventListener('change', async (e) => {
    const v = e.target.value;
    editor.pushUndo();
    if (!v) current.audio = null;
    else if (v !== 'local') current.audio = { src: v, name: v.split('/').pop(), offset: current.audio ? current.audio.offset : 0, volume: 100 };
    $('#c-offset').value = current.audio ? current.audio.offset : 0;
    await refreshMusic();
    editor.changed();
  });
  $('#c-music-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const url = URL.createObjectURL(f);
    localMusic.set(f.name, url);
    editor.pushUndo();
    current.audio = { src: null, name: f.name, offset: current.audio ? current.audio.offset : 0, volume: 100 };
    await refreshMusic();
    editor.changed();
    toast('Music from this phone is used until the page is closed; pick it again next time.', 5000);
  });
  const play = (from) => {
    current._audioUrl = audioUrlFor(current);
    if (current._audioUrl) player.unlockAudio(current._audioUrl);
    playShowFromEditor(from);
  };
  $('#c-play').addEventListener('click', () => play(editor.cursor));
  $('#c-play0').addEventListener('click', () => play(0));
  $('#c-stop').addEventListener('click', () => player.stop());
}

async function playShowFromEditor(from) {
  playing = { anim: current, title: current.title };
  $('#np-title').textContent = current.title;
  $('#now-playing').hidden = false;
  $('#c-stop').disabled = false;
  try { await player.play(current, from); } catch (e) { lostLink(e); }
}

// ------------------------------------------------------------------------------------ start
async function main() {
  if (!DEMO && !canConnect()) showNotice();
  if (DEMO) { $('#demo-link').textContent = 'Leave the demo'; $('#demo-link').href = location.pathname; setStatus('Demo: tap Connect'); }
  $('#connect').addEventListener('click', connect);
  setupLive();
  setupCreate();
  setupAdmin();
  const [loaded] = await Promise.all([loadConfig(), loadLibrary()]);
  if (loaded) cfg = loaded;
  applyCfg();
  if (isAdmin()) $('[data-tab=admin]').hidden = false, fillAdmin(cfg || normalize(null));
  if (location.hash === '#admin') openAdmin();
  renderMine();
  const draft = store.get('diorama.draft', null);
  await setCurrent(draft ? fromData(draft) : (featured[0] ? fromData(featured[0].data, featured[0].title) : newAnimation('My animation')));
  requestAnimationFrame(frame);
}
main();
