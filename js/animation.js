// animation.js - the animation model: one lane of keyframes per zone.
//
// File format (version 3, the same per-lane format as led_timeline_zones.py, so the old
// MGEX Unicorn LED animations open as they are; their old full-frame "keyframes" files too):
//   { version: 3, title, settings: { loop, light_lead_ms },
//     lanes: [{ zone, keys: [{ time, color: [r,g,b], pct, fade, curve }] }, ... 12 lanes],
//     audio: { src, name, offset, volume } }
// Lane 10 (unicorn-mode eye) uses color[0] as brightness. Lane 11 (shield) uses color[0] as
// speed and color[1] >= 128 as reverse. A lane with no keys leaves that part as it is.

import { laneSegments } from './protocol.js';

export const LANES = [
  { name: 'Face', short: 'Face', kind: 'rgb', group: 'body' },
  { name: 'Chest', short: 'Chest', kind: 'rgb', group: 'body' },
  { name: 'Shoulders (neck)', short: 'Neck', kind: 'rgb', group: 'body' },
  { name: 'Shoulders & waist', short: 'Shoulders', kind: 'rgb', group: 'body' },
  { name: 'Arms & groin', short: 'Arms', kind: 'rgb', group: 'body' },
  { name: 'Side waist', short: 'Waist', kind: 'rgb', group: 'body' },
  { name: 'Upper legs', short: 'Legs', kind: 'rgb', group: 'body' },
  { name: 'Upper knees', short: 'Knees', kind: 'rgb', group: 'body' },
  { name: 'Lower knees', short: 'Shins', kind: 'rgb', group: 'body' },
  { name: 'Destroy eyes', short: 'Eyes', kind: 'rgb', group: 'eyes' },
  { name: 'Unicorn eye', short: 'Uni eye', kind: 'level', group: 'unicorn' },
  { name: 'Shield', short: 'Shield', kind: 'speed', group: 'shield' },
];
export const N = LANES.length;
export const BODY = [0, 1, 2, 3, 4, 5, 6, 7, 8];
export const EYES = 9, UNI_EYE = 10, SHIELD = 11;

export const CURVES = {
  linear: ['Linear', (u) => u],
  out2: ['Ease out', (u) => 1 - (1 - u) ** 2],
  out3: ['Ease out (cubic)', (u) => 1 - (1 - u) ** 3],
  out5: ['Ease out (strong)', (u) => 1 - (1 - u) ** 5],
  in3: ['Ease in', (u) => u ** 3],
  inout: ['Ease in-out', (u) => u * u * (3 - 2 * u)],
};

const clamp = (v) => Math.max(0, Math.min(255, Math.floor(v + 0.5)));
export const round3 = (t) => Math.round(t * 1000) / 1000;

export function makeKey(time, color, pct = 100, fade = false, curve = 'linear') {
  return {
    time: Math.max(0, +time || 0),
    color: [0, 1, 2].map((i) => Math.max(0, Math.min(255, (color && color[i]) | 0))),
    pct: Math.max(0, Math.min(100, pct === undefined ? 100 : +pct)),
    fade: !!fade,
    curve: CURVES[curve] ? curve : 'linear',
  };
}

// Final value sent to the Nano (brightness applied)
export function resolve(lane, k) {
  const kind = LANES[lane].kind;
  if (kind === 'speed') return [clamp((k.color[0] * k.pct) / 100), k.color[1] >= 128 ? 255 : 0, 0];
  if (kind === 'level') return [clamp((k.color[0] * k.pct) / 100), 0, 0];
  return k.color.map((c) => clamp((c * k.pct) / 100));
}

export function newAnimation(title = 'New animation') {
  return {
    version: 3,
    title,
    settings: { loop: false, light_lead_ms: 20 },
    lanes: Array.from({ length: N }, () => []),
    audio: null,
  };
}

export function sortLanes(anim) {
  for (const lane of anim.lanes) lane.sort((a, b) => a.time - b.time);
}

// Read any supported file (object already parsed from JSON).
export function fromData(data, fallbackTitle = 'Animation') {
  const a = newAnimation(data.title || fallbackTitle);
  const s = data.settings || {};
  a.settings.loop = !!s.loop;
  a.settings.light_lead_ms = +(s.light_lead_ms ?? s.wired_light_lead_ms ?? 20) || 0;
  if (Array.isArray(data.lanes)) {
    data.lanes.slice(0, N).forEach((lane, i) => {
      a.lanes[i] = (lane.keys || []).map((d) => makeKey(d.time, d.color, d.pct, d.fade, d.curve));
    });
  } else if (Array.isArray(data.keyframes)) {           // old full-frame keyframes
    for (const kd of data.keyframes) {
      (kd.zones || []).slice(0, N).forEach((z, i) => {
        a.lanes[i].push(makeKey(kd.time, z.color, z.pct, kd.fade, kd.curve));
      });
    }
  }
  if (data.audio) {
    const au = data.audio;
    const src = au.src || null;
    // old desktop files only know a local path: keep the file name so it can be picked again
    const name = au.name || (au.path || au.relative_path || src || '').split(/[\\/]/).pop() || null;
    a.audio = { src, name, offset: +au.offset || 0, volume: au.volume === undefined ? 100 : +au.volume };
  }
  sortLanes(a);
  return a;
}

export function toData(anim) {
  return {
    version: 3,
    title: anim.title,
    settings: { loop: anim.settings.loop, light_lead_ms: Math.round(anim.settings.light_lead_ms) },
    lanes: anim.lanes.map((keys, i) => ({
      zone: LANES[i].name,
      keys: keys.map((k) => ({ time: round3(k.time), color: [...k.color], pct: Math.round(k.pct * 100) / 100, fade: k.fade, curve: k.curve })),
    })),
    audio: anim.audio && (anim.audio.src || anim.audio.name)
      ? { src: anim.audio.src && !anim.audio.src.startsWith('blob:') ? anim.audio.src : null,
          name: anim.audio.name, offset: anim.audio.offset, volume: anim.audio.volume }
      : null,
  };
}

export const clone = (anim) => fromData(JSON.parse(JSON.stringify(toData(anim))), anim.title);

// Value of one lane at time t (seconds), float maths like the old desktop app.
// Returns null for an empty lane (= unchanged).
export function evalLane(lane, keys, t) {
  if (!keys.length) return null;
  if (t < keys[0].time) return [0, 0, 0];
  let j = 0;
  while (j + 1 < keys.length && keys[j + 1].time <= t) j++;
  const k = keys[j];
  const cur = resolve(lane, k);
  if (j === keys.length - 1 || !k.fade) return cur;
  const span = keys[j + 1].time - k.time;
  if (span <= 0) return cur;
  const u = CURVES[k.curve][1]((t - k.time) / span);
  const nxt = resolve(lane, keys[j + 1]);
  return cur.map((c, i) => clamp(c + (nxt[i] - c) * u));
}

export const evalAll = (anim, t) => anim.lanes.map((keys, i) => evalLane(i, keys, t));

// Segments per zone for the Nano; null = lane not used
export const toSegments = (anim) =>
  anim.lanes.map((keys, i) => (keys.length ? laneSegments(keys.map((k) => ({ ...k, color: resolve(i, k) }))) : null));

export function lastKeyTime(anim) {
  let t = 0;
  for (const lane of anim.lanes) if (lane.length) t = Math.max(t, lane[lane.length - 1].time);
  return t;
}

// A show stops this long after its last key, even if the music is longer
export const SHOW_TAIL_S = 10;

// When playback ends: SHOW_TAIL_S after the last key (an animation without keys plays its music)
export function showEnd(anim, audioLength = 0) {
  const hasKeys = anim.lanes.some((l) => l.length);
  return hasKeys ? lastKeyTime(anim) + SHOW_TAIL_S : duration(anim, audioLength);
}

// Length of the timeline in the editor: the music, or the last key plus a short hold
export function duration(anim, audioLength = 0) {
  const off = anim.audio ? anim.audio.offset : 0;
  return Math.max(lastKeyTime(anim) + 1, audioLength ? off + audioLength : 0, 1);
}
