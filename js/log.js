// log.js - a connection log in the Firebase database (/diorama/log), shown in the admin panel.
//
// Each connection adds one entry: { t: server time, dev: "model, OS, browser", admin }. When the
// visitor leaves, the page adds { len: seconds connected, end: why it ended } to that entry.
// The rules let anyone add an entry and fill in len/end once, but not change or delete
// anything; clearing the log needs the admin PIN. The log is publicly readable (it holds no
// names, only times and phone types).

import { DATABASE_URL, ROOT } from './firebase-config.js';

const base = () => DATABASE_URL.replace(/\/+$/, '') + '/' + ROOT;
export const SHOW_LAST = 300;        // the admin panel shows this many latest entries

// "Samsung SM-S918B, Android 14, Chrome 131" (the model is only known on Android Chrome)
export async function deviceInfo() {
  const ua = navigator.userAgent;
  let model = '', os = '', browser = '';
  try {
    const d = navigator.userAgentData;
    if (d && d.getHighEntropyValues) {
      const h = await d.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']);
      model = h.model || '';
      const v = (h.platformVersion || '').split('.')[0];
      os = h.platform ? h.platform + (v && h.platform === 'Android' ? ' ' + v : '') : '';
      const b = (h.fullVersionList || h.brands || []).find((x) => !/Not.?A.?Brand|Chromium/i.test(x.brand));
      if (b) browser = b.brand.replace('Google ', '') + ' ' + b.version.split('.')[0];
    }
  } catch { /* fall back to the user agent */ }
  if (!os) {
    const m = ua.match(/Android [\d.]+|iPhone OS [\d_]+|iPad|Windows NT [\d.]+|Mac OS X [\d_]+|CrOS|Linux/);
    os = m ? m[0].replace(/_/g, '.').replace('Windows NT 10.0', 'Windows') : '';
  }
  if (!browser) {
    const m = ua.match(/(Edg|SamsungBrowser|OPR|Firefox|Chrome|Version)\/(\d+)/);
    const names = { Edg: 'Edge', OPR: 'Opera', Version: 'Safari', SamsungBrowser: 'Samsung Internet' };
    if (m) browser = (names[m[1]] || m[1]) + ' ' + m[2];
  }
  return [model, os, browser].filter(Boolean).join(', ').slice(0, 100) || 'Unknown';
}

// Adds an entry; returns its id, or null when the database can't be reached
export async function logConnect(admin) {
  if (!DATABASE_URL) return null;
  try {
    const dev = await deviceInfo();
    const r = await fetch(base() + '/log.json', {
      method: 'POST',
      body: JSON.stringify({ t: { '.sv': 'timestamp' }, dev, admin: !!admin }),
    });
    if (!r.ok) return null;
    return (await r.json()).name || null;
  } catch {
    return null;
  }
}

// Fills in how long the visitor stayed. keepalive: it still goes out while the page closes.
export function logEnd(id, seconds, end) {
  if (!DATABASE_URL || !id) return;
  try {
    fetch(base() + '/log/' + id + '.json', {
      method: 'PATCH',
      keepalive: true,
      body: JSON.stringify({ len: Math.max(0, Math.min(99999, Math.round(seconds))), end }),
    }).catch(() => {});
  } catch { /* ignore */ }
}

// Latest entries, newest first
export async function loadLog() {
  const r = await fetch(base() + `/log.json?orderBy="$key"&limitToLast=${SHOW_LAST}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('Could not load the log (' + r.status + ').');
  const data = (await r.json()) || {};
  return Object.entries(data).map(([id, e]) => ({ id, ...e })).sort((a, b) => (b.t || 0) - (a.t || 0));
}

export async function clearLog(pin) {
  const body = { log: null };
  body['writes/' + pin] = { '.sv': 'timestamp' };
  const r = await fetch(base() + '.json', { method: 'PATCH', body: JSON.stringify(body) });
  if (!r.ok) throw new Error('The database refused to clear the log (' + r.status + ').');
}
