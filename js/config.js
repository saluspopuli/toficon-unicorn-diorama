// config.js - the admin settings, kept online in a Firebase Realtime Database.
//
// Everyone can read /diorama/config. Writing needs the admin PIN, which only lives in the
// database rules (database.rules.json), never in this page: a save writes the config together
// with /diorama/writes/<PIN> = server time, and the rules only accept it when <PIN> is right.

import { DATABASE_URL, ROOT } from './firebase-config.js';

export const DEFAULTS = {
  shieldEnabled: false,
  timeLimitS: 300,          // visitor's time with the diorama (0 = no limit)
  offTimeS: 5,              // Bluetooth stays off this long after a visitor's time is up
  idleDelayS: 120,          // a finished visitor's look stays this long, then fades to idle
  inactivityS: 120,         // the page disconnects after this long without a tap (0 = never)
  idle: { body: [255, 0, 0], eyes: [0, 255, 0], uni: 100, shield: 0, reverse: false },
  hiddenShows: [],          // featured show files visitors don't see
};

export const online = () => !!DATABASE_URL;
const base = () => DATABASE_URL.replace(/\/+$/, '') + '/' + ROOT;

const rgb = (c, d) => (Array.isArray(c) && c.length === 3 ? c.map((v) => Math.max(0, Math.min(255, v | 0))) : [...d]);
const num = (v, d, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);

// Fill in anything missing or out of range
export function normalize(c) {
  c = c || {};
  const i = c.idle || {};
  const d = DEFAULTS;
  return {
    shieldEnabled: !!c.shieldEnabled,
    timeLimitS: num(c.timeLimitS, d.timeLimitS, 0, 65535),
    offTimeS: num(c.offTimeS, d.offTimeS, 1, 255),
    idleDelayS: num(c.idleDelayS, d.idleDelayS, 0, 65535),
    inactivityS: num(c.inactivityS, d.inactivityS, 0, 86400),
    idle: {
      body: rgb(i.body, d.idle.body),
      eyes: rgb(i.eyes, d.idle.eyes),
      uni: num(i.uni, d.idle.uni, 0, 100),
      shield: num(i.shield, d.idle.shield, 0, 100),
      reverse: !!i.reverse,
    },
    hiddenShows: Array.isArray(c.hiddenShows) ? c.hiddenShows.filter((s) => typeof s === 'string') : [],
  };
}

async function request(path, opts = {}, timeoutMs = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(base() + path, { ...opts, signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

// The current config, or null when it can't be loaded (offline, not set up)
export async function loadConfig() {
  if (!online()) return null;
  try {
    const r = await request('/config.json');
    if (!r.ok) return null;
    const data = await r.json();
    return normalize(data);     // nothing saved yet: the defaults
  } catch {
    return null;
  }
}

const pinPath = (pin) => '/writes/' + encodeURIComponent(pin) + '.json';

// true if the PIN is accepted by the database rules
export async function checkPin(pin) {
  if (!online() || !/^[0-9A-Za-z]{3,20}$/.test(pin)) return false;
  try {
    const r = await request(pinPath(pin), { method: 'PUT', body: JSON.stringify({ '.sv': 'timestamp' }) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function saveConfig(pin, cfg) {
  if (!online()) throw new Error('No database set up (web/js/firebase-config.js).');
  const body = { config: { ...normalize(cfg), updated: { '.sv': 'timestamp' } } };
  body['writes/' + pin] = { '.sv': 'timestamp' };
  const r = await request('.json', { method: 'PATCH', body: JSON.stringify(body) });
  if (r.status === 401 || r.status === 403) throw new Error('The database refused the save (wrong PIN or rules not set up).');
  if (!r.ok) throw new Error('Saving failed (' + r.status + ').');
}
