// engine.js - JavaScript copy of firmware/diorama/onboard_engine.h.
// Same integer maths, so the on-screen preview and the demo mode show exactly what the Nano
// shows. tests/test_protocol.mjs checks it against the real C++ engine.

export const ZONES = 12;
export const QUEUE = 8;
export const REPLY_LEN = 1 + 4 + ZONES;
export const CURVE = { step: 0, linear: 1, out2: 2, out3: 3, out5: 4, in3: 5, inout: 6 };
export const CURVE_BASE = 15;
export const CMD = { REC: 1, CLOCK: 2, ADJ: 3, PING: 4 };
const FOREVER24 = 0xffffff;
const FOREVER32 = 0xffffffff;

export function easeCurve(curve, u) {
  const v = 1024 - u;
  switch (curve) {
    case CURVE.out2: return 1024 - Math.floor((v * v) / 1024);
    case CURVE.out3: return 1024 - Math.floor((Math.floor((v * v) / 1024) * v) / 1024);
    case CURVE.out5: {
      let p = Math.floor((v * v) / 1024);
      p = Math.floor((p * p) / 1024);
      p = Math.floor((p * v) / 1024);
      return 1024 - p;
    }
    case CURVE.in3: {
      const p = Math.floor((u * u) / 1024);
      return Math.floor((p * u) / 1024);
    }
    case CURVE.inout: {
      const p = Math.floor((u * u) / 1024);
      return Math.floor((p * (3072 - 2 * u)) / 1024);
    }
    default: return u;
  }
}

export function mix(a, b, f) {
  const d = b - a;
  // C integer division truncates towards zero
  const v = a + Math.trunc((d * f + (d >= 0 ? 512 : -512)) / 1024);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function newZone() {
  return { q: [], tStart: 0, fr: 0, fg: 0, fb: 0 };
}

export class Engine {
  constructor() { this.reset(); }

  reset() {
    this.z = Array.from({ length: ZONES }, newZone);
    this.posMs = 0;
    this.running = false;
    this.lastSeq = 0;
    this.lastCmdMs = 0;
    this.dirty = false;
  }

  advance(ms) { if (this.running) this.posMs = (this.posMs + ms) >>> 0; }

  zoneColor(i) {
    const s = this.z[i];
    while (s.q.length && this.posMs >= s.q[0].tEnd) {
      const d = s.q.shift();
      s.fr = d.r; s.fg = d.g; s.fb = d.b;
      s.tStart = d.tEnd;
    }
    if (!s.q.length || this.posMs < s.tStart) return [s.fr, s.fg, s.fb];
    const g = s.q[0];
    if (g.curve === CURVE.step) return [g.r, g.g, g.b];
    const span = g.tEnd - s.tStart;
    // C: uint16_t u = ((posMs - tStart) * 1024UL) / span  (32-bit unsigned product)
    const u = Math.floor((((this.posMs - s.tStart) * 1024) % 0x100000000) / span) & 0xffff;
    const f = easeCurve(g.curve, u);
    return [mix(s.fr, g.r, f), mix(s.fg, g.g, f), mix(s.fb, g.b, f)];
  }

  colors() {
    const out = [];
    for (let i = 0; i < ZONES; i++) out.push(this.zoneColor(i));
    return out;
  }

  record(r, off = 0) {
    const zone = r[off] >> 4, curve = r[off] & 15;
    if (zone >= ZONES) return;
    const t = r[off + 1] | (r[off + 2] << 8) | (r[off + 3] << 16);
    const s = this.z[zone];
    if (curve === CURVE_BASE) {
      s.q = [];
      s.tStart = t;
      s.fr = r[off + 4]; s.fg = r[off + 5]; s.fb = r[off + 6];
      return;
    }
    if (s.q.length >= QUEUE || curve > CURVE.inout) return;
    s.q.push({ tEnd: t === FOREVER24 ? FOREVER32 : t, r: r[off + 4], g: r[off + 5], b: r[off + 6], curve });
  }

  // b = command body (type, seq, payload). Returns the REPLY_LEN byte answer.
  execute(b, wallMs) {
    const len = b.length;
    if (len >= 2) {
      const seq = b[1];
      if (wallMs - this.lastCmdMs > 1500) this.lastSeq = 0;
      this.lastCmdMs = wallMs;
      const dup = seq === this.lastSeq;
      this.lastSeq = seq;
      if (!dup) {
        switch (b[0]) {
          case CMD.REC:
            for (let i = 2; i + 7 <= len; i += 7) this.record(b, i);
            break;
          case CMD.CLOCK:
            if (len >= 7) {
              this.running = b[2] !== 0;
              this.posMs = (b[3] | (b[4] << 8) | (b[5] << 16) | (b[6] << 24)) >>> 0;
            }
            break;
          case CMD.ADJ:
            if (len >= 4) {
              let d = b[2] | (b[3] << 8);
              if (d >= 0x8000) d -= 0x10000;
              if (d < 0 && -d > this.posMs) this.posMs = 0;
              else this.posMs += d;
            }
            break;
          default: break;
        }
        this.dirty = true;
      }
    }
    const p = this.posMs;
    const reply = new Uint8Array(REPLY_LEN);
    reply[0] = 75; // 'K'
    reply[1] = p & 255; reply[2] = (p >>> 8) & 255; reply[3] = (p >>> 16) & 255; reply[4] = (p >>> 24) & 255;
    for (let i = 0; i < ZONES; i++) reply[5 + i] = QUEUE - this.z[i].q.length;
    return reply;
  }
}
