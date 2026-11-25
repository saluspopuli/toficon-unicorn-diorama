// protocol.js - the phone side of diorama.ino. A port of onboard.py from the MGEX Unicorn LED
// project: turn each lane into fade segments, and keep the Nano's small per-zone queues filled
// while it plays them by itself.
//
// Segments tile time without gaps: segment i fades the zone from the colour segment i-1 ended on
// to its target, between the end of segment i-1 and its own end. Curve "step" shows the target
// for the whole segment (a hold or a jump).

import { ZONES, QUEUE, REPLY_LEN, CURVE, CURVE_BASE, CMD } from './engine.js';

export const FOREVER = 0xffffff;
export const RECORDS_PER_COMMAND = 8;   // 1 + 1 + 8*7 = 58 body bytes = the Nano's limit
export const CMD_CONFIG = 5, CMD_HELLO = 6;  // handled by diorama.ino itself, not the engine
const OFF = [0, 0, 0];

export const ms = (seconds) => Math.round(seconds * 1000);
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// ----------------------------------------------------------------------- timeline -> segments
// keys: [{time (s), color: [r,g,b] already resolved, fade, curve}] sorted by time.
// Plays like evalLane(): off before the first key, a fade runs from a key to the next, the
// last key holds.
export function laneSegments(keys) {
  const segs = [];
  let t = 0, color = OFF;
  const add = (end, col, curve) => {
    const last = segs[segs.length - 1];
    if (curve === CURVE.step && last && last.curve === CURVE.step && same(last.color, col) && last.end === t) {
      last.end = end;                                  // extend the hold
    } else {
      segs.push({ start: t, end, color: col, curve });
    }
    t = end; color = col;
  };
  keys.forEach((k, j) => {
    const tj = ms(k.time);
    const cj = k.color.map((c) => c | 0);
    const isLast = j === keys.length - 1;
    if (tj > t) add(tj, color, CURVE.step);            // before the first key: off
    const nxt = isLast ? FOREVER : ms(keys[j + 1].time);
    const cn = isLast ? null : keys[j + 1].color.map((c) => c | 0);
    if (k.fade && !isLast && nxt > tj && !same(cn, cj)) {
      if (!same(color, cj)) add(tj, cj, CURVE.step);   // jump to this key's colour
      add(nxt, cn, CURVE[k.curve] ?? CURVE.linear);
    } else {
      add(nxt, cj, CURVE.step);
    }
  });
  return segs;
}

// {baseT, baseColor, rest} to start a lane at posMs
export function planStart(segs, posMs) {
  let prev = OFF;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.end > posMs) return { baseT: s.start, baseColor: prev, rest: segs.slice(i) };
    prev = s.color;
  }
  return { baseT: posMs, baseColor: prev, rest: [] };
}

export function record(zone, curve, t, color) {
  t = Math.min(Math.max(Math.trunc(t), 0), FOREVER);
  return [(zone << 4) | curve, t & 255, (t >> 8) & 255, t >> 16, color[0] & 255, color[1] & 255, color[2] & 255];
}

export const segmentRecord = (zone, seg) => record(zone, seg.curve, seg.end, seg.color);
export const baseRecord = (zone, color) => record(zone, CURVE_BASE, 0, color);

export function frameCommand(body) {
  let sum = 0;
  for (const b of body) sum += b;
  return Uint8Array.from([0xaa, 0x7e, body.length, ...body, sum & 255]);
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ------------------------------------------------------------------------ talking to the Nano
// link: anything with  async exchange(Uint8Array, replyLen) -> Uint8Array | null
export class Onboard {
  constructor(link, attempts = 4) {
    this.link = link;
    this.attempts = attempts;
    this.seq = Date.now() % 255;
    this.free = new Array(ZONES).fill(QUEUE);
    this.pending = Array.from({ length: ZONES }, () => []);
    this.nanoPos = 0;
    this.minRtt = null;
    this.lastRtt = 0;
    this.lastContact = 0;
    this.commands = 0;
    this.errors = 0;
    this.posAt = null;      // performance.now() -> expected Nano position in ms (set by the player)
    this.ref = null;
    this.samples = [];
    this.skip = 0;
    this.adjusts = 0;
    this.lastDrift = 0;
    this._chain = Promise.resolve();
  }

  // One command at a time (stop-and-wait); callers may overlap, they are queued.
  command(typ, payload = []) {
    const run = () => this._command(typ, payload);
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  async _command(typ, payload) {
    this.seq = (this.seq % 255) + 1;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const data = typeof payload === 'function' ? payload() : payload;
      const body = [typ, this.seq, ...data];
      const t0 = performance.now();
      const reply = await this.link.exchange(frameCommand(body), REPLY_LEN);
      const t1 = performance.now();
      if (reply && reply[0] === 75 && reply.length >= REPLY_LEN) {
        this.commands++;
        this.lastRtt = t1 - t0;
        this.minRtt = this.minRtt === null ? this.lastRtt : Math.min(this.minRtt, this.lastRtt);
        this.lastContact = t1;
        this.nanoPos = (reply[1] | (reply[2] << 8) | (reply[3] << 16) | (reply[4] << 24)) >>> 0;
        this.free = Array.from(reply.slice(5, 5 + ZONES));
        if (typ === CMD.REC || typ === CMD.PING) this._driftSample(t0, t1);
        return reply;
      }
      this.errors++;
    }
    throw new Error('The diorama stopped answering.');
  }

  // Start/stop the Nano clock. posFn() -> position in ms, evaluated right before sending.
  async setClock(running, posFn) {
    await this.command(CMD.CLOCK, () => {
      const p = Math.max(0, Math.trunc(posFn())) >>> 0;
      return [running ? 1 : 0, p & 255, (p >>> 8) & 255, (p >>> 16) & 255, (p >>> 24) & 255];
    });
    this.ref = null; this.samples = []; this.skip = 2;
  }

  async adjust(deltaMs) {
    const d = Math.max(-30000, Math.min(30000, Math.trunc(deltaMs))) & 0xffff;
    await this.command(CMD.ADJ, [d & 255, d >> 8]);
    this.adjusts++;
  }

  ping() { return this.command(CMD.PING); }

  // Admin config (see diorama.ino, type 5). Lives in the Nano's RAM until it resets.
  sendConfig(cfg) {
    const pct = (p) => Math.max(0, Math.min(255, Math.round((p || 0) * 2.55)));
    const u16 = (v) => { v = Math.max(0, Math.min(65535, Math.round(v || 0))); return [v & 255, v >> 8]; };
    return this.command(CMD_CONFIG, [
      cfg.shieldEnabled ? 1 : 0,
      ...u16(cfg.timeLimitS),
      Math.max(1, Math.min(255, Math.round(cfg.offTimeS || 5))),
      ...u16(cfg.idleDelayS),
      ...cfg.idle.body, ...cfg.idle.eyes,
      pct(cfg.idle.uni), pct(cfg.idle.shield), cfg.idle.reverse ? 255 : 0,
    ]);
  }

  // Starts the visitor's session on the Nano; admin = no time limit (type 6).
  hello(admin) { return this.command(CMD_HELLO, [admin ? 1 : 0]); }

  // Send BASE records: the zones show these values at once, their queues are emptied.
  // values: Map/array of [zone, [r,g,b]]
  async setNow(entries) {
    const recs = entries.map(([z, c]) => baseRecord(z, c));
    for (const [z] of entries) this.pending[z] = [];
    for (let i = 0; i < recs.length; i += RECORDS_PER_COMMAND) {
      await this.command(CMD.REC, recs.slice(i, i + RECORDS_PER_COMMAND).flat());
    }
  }

  // Stop the clock, set every zone to its look at posMs and queue what comes next.
  // lanes[z] = segments, or null to leave that zone as it is.
  async load(lanes, posMs) {
    await this.setClock(false, () => posMs);
    const recs = [];
    for (let z = 0; z < ZONES; z++) {
      const segs = lanes[z];
      if (!segs) { this.pending[z] = []; continue; }
      const { baseT, baseColor, rest } = planStart(segs, posMs);
      this.pending[z] = rest.slice();
      recs.push(record(z, CURVE_BASE, baseT, baseColor));
    }
    for (let i = 0; i < recs.length; i += RECORDS_PER_COMMAND) {
      await this.command(CMD.REC, recs.slice(i, i + RECORDS_PER_COMMAND).flat());
    }
    this.free = new Array(ZONES).fill(QUEUE);
    while (await this.fill()) { /* top up every queue */ }
  }

  // Send the next segments to zones with free queue slots (earliest first).
  async fill() {
    const free = [...this.free];
    const idx = new Array(ZONES).fill(0);
    const recs = [];
    while (recs.length < RECORDS_PER_COMMAND) {
      let best = null;
      for (let z = 0; z < ZONES; z++) {
        if (free[z] > 0 && idx[z] < this.pending[z].length) {
          const end = this.pending[z][idx[z]].end;
          if (best === null || end < best[0]) best = [end, z];
        }
      }
      if (best === null) break;
      const z = best[1];
      recs.push(segmentRecord(z, this.pending[z][idx[z]]));
      idx[z]++;
      free[z]--;
    }
    if (!recs.length) return false;
    await this.command(CMD.REC, recs.flat());
    for (let z = 0; z < ZONES; z++) this.pending[z].splice(0, idx[z]);
    return true;
  }

  // One round of upkeep while playing.
  async service(busyEvery = 40, idleEvery = 300) {
    if (await this.fill()) return;
    const every = this.remaining() ? busyEvery : idleEvery;
    if (performance.now() - this.lastContact >= every) await this.ping();
  }

  remaining() { return this.pending.reduce((n, p) => n + p.length, 0); }

  // The reply says where the Nano clock is. Compare with where it should be. Only quick
  // replies count (a slow reply's position is already old).
  _driftSample(t0, t1) {
    if (!this.posAt) return;
    if (t1 - t0 > this.minRtt * 2 + 10) return;
    if (this.skip) { this.skip--; return; }
    const sample = this.nanoPos - this.posAt((t0 + t1) / 2);
    if (this.ref === null) {
      this.samples.push(sample);
      if (this.samples.length >= 4) { this.ref = median(this.samples); this.samples = []; }
      return;
    }
    this.samples.push(sample - this.ref);
    this.samples = this.samples.slice(-3);
    this.lastDrift = median(this.samples);
  }

  // ADJ delta in ms if the clocks have drifted apart by more than threshold, else 0.
  correction(threshold = 4) {
    if (this.ref === null || this.samples.length < 3) return 0;
    const d = median(this.samples);
    if (Math.abs(d) <= threshold) return 0;
    this.samples = []; this.skip = 1;
    return -d;
  }
}
