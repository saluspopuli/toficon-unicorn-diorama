// editor.js - touch-friendly keyframe timeline.
//
//   tap the ruler / an empty spot   move the cursor (the preview shows that moment)
//   Add key (or double-click)        add a key on the chosen lane at the cursor
//   tap a key / drag it              select it / move it in time
//   drag empty space                 scroll;  pinch or Ctrl+wheel: zoom
// The panel under the timeline edits the selected key; its values are also used for new keys.

import { LANES, N, BODY, CURVES, makeKey, round3, evalAll, evalLane, duration, lastKeyTime, sortLanes } from './animation.js';

const LABEL_W = 66, RULER_H = 24, LANE_H = 26, MUSIC_H = 34;
const SNAP = 0.05;
const KEY_HIT = 14;

const snap = (t) => round3(Math.round(t / SNAP) * SNAP);
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Editor {
  constructor(root, { onChange, onPreview, getPlayhead }) {
    this.root = root;
    this.onChange = onChange;
    this.onPreview = onPreview;
    this.getPlayhead = getPlayhead;
    this.anim = null;
    this.audioLength = 0;
    this.peaks = null;
    this.view = { t0: -0.2, pps: 60 };
    this.cursor = 0;
    this.lane = 0;
    this.sel = null;                 // {lane, key}
    this.brush = { rgb: [255, 0, 0], pct: 100, level: 100, speed: 40, reverse: false, fade: true, curve: 'linear' };
    this.target = 'lane';            // 'lane' | 'body' | 'all-rgb'
    this.undoStack = [];
    this.redoStack = [];
    this.pointers = new Map();
    this.drag = null;
    this._build();
  }

  // ------------------------------------------------------------------------------ building
  _build() {
    this.root.innerHTML = `
      <div class="tl-wrap"><canvas class="tl"></canvas></div>
      <div class="tl-tools">
        <button data-act="zoomout" title="Zoom out" aria-label="Zoom out">−</button>
        <button data-act="zoomin" title="Zoom in" aria-label="Zoom in">+</button>
        <span class="tl-time" aria-live="polite"></span>
        <span class="spacer"></span>
        <button data-act="undo" title="Undo">Undo</button>
        <button data-act="redo" title="Redo">Redo</button>
        <button data-act="add" class="primary">Add key</button>
      </div>
      <div class="key-panel">
        <div class="kp-head">
          <strong class="kp-title"></strong>
          <span class="spacer"></span>
          <button data-act="prev" aria-label="Previous key">◀</button>
          <button data-act="next" aria-label="Next key">▶</button>
          <button data-act="delete" class="danger">Delete</button>
        </div>
        <div class="kp-row kp-target">
          <label>Add to
            <select data-f="target">
              <option value="lane">This lane</option>
              <option value="body">All 9 body zones</option>
              <option value="all-rgb">Body + destroy eyes</option>
            </select>
          </label>
        </div>
        <div class="kp-row kp-rgb">
          <label>Colour <input type="color" data-f="rgb"></label>
          <div class="swatches"></div>
        </div>
        <div class="kp-row kp-rgb"><label class="grow">Brightness <input type="range" min="0" max="100" data-f="pct"></label><output data-o="pct"></output></div>
        <div class="kp-row kp-level"><label class="grow">Brightness <input type="range" min="0" max="100" data-f="level"></label><output data-o="level"></output></div>
        <div class="kp-row kp-speed"><label class="grow">Speed <input type="range" min="0" max="100" data-f="speed"></label><output data-o="speed"></output></div>
        <div class="kp-row kp-speed"><label><input type="checkbox" data-f="reverse"> Reverse</label></div>
        <div class="kp-row">
          <label><input type="checkbox" data-f="fade"> Fade to next key</label>
          <select data-f="curve">${Object.entries(CURVES).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select>
        </div>
        <div class="kp-row kp-sel"><label>Time (s) <input type="number" step="0.05" min="0" data-f="time" inputmode="decimal"></label></div>
      </div>`;
    this.canvas = this.root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.panel = this.root.querySelector('.key-panel');
    const sw = this.root.querySelector('.swatches');
    const SW = [[255, 0, 0], [255, 40, 0], [255, 140, 0], [255, 255, 255], [0, 255, 0], [0, 160, 255], [0, 0, 255], [190, 0, 255], [255, 0, 120], [0, 0, 0]];
    sw.innerHTML = SW.map((c) => `<button class="sw" style="background:${hex(c)}" data-c="${hex(c)}" aria-label="Colour ${hex(c)}"></button>`).join('');
    sw.addEventListener('click', (e) => {
      const b = e.target.closest('.sw');
      if (b) this._field('rgb', b.dataset.c);
    });

    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'zoomin') this.zoom(1.5);
      else if (act === 'zoomout') this.zoom(1 / 1.5);
      else if (act === 'add') this.addKey();
      else if (act === 'delete') this.deleteKey();
      else if (act === 'prev') this.stepKey(-1);
      else if (act === 'next') this.stepKey(1);
      else if (act === 'undo') this.undo();
      else if (act === 'redo') this.redo();
    });
    this.panel.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      this._field(f, v, e.type);
    });
    this.panel.addEventListener('change', (e) => { if (e.target.dataset.f) this._commitEdit(); });

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e, true));
    c.addEventListener('dblclick', (e) => {
      const p = this._pos(e);
      const lane = this._laneAt(p.y);
      if (lane !== null) { this.lane = lane; this.cursor = snap(Math.max(0, this._timeAt(p.x))); this.addKey(); }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, this._pos(e).x);
      else this.pan((e.deltaX || e.deltaY) / this.view.pps);
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!this.root.offsetParent || e.target.matches('input, select, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (this.sel) { e.preventDefault(); this.deleteKey(); } }
    });
    new ResizeObserver(() => this.draw()).observe(this.root.querySelector('.tl-wrap'));
  }

  // ------------------------------------------------------------------------------ model
  setAnimation(anim) {
    this.anim = anim;
    this.sel = null;
    this.cursor = 0;
    this.view.t0 = -0.2;
    this.undoStack = []; this.redoStack = [];
    this.fit();
    this.refreshPanel();
    this.draw();
    this.preview();
  }

  setAudio(length, peaks) {
    this.audioLength = length || 0;
    this.peaks = peaks || null;
    this.draw();
  }

  _snapshot() { return JSON.stringify({ lanes: this.anim.lanes, audio: this.anim.audio }); }
  _restore(s) {
    const d = JSON.parse(s);
    this.anim.lanes = d.lanes;
    if (this.anim.audio && d.audio) this.anim.audio.offset = d.audio.offset;
    this.sel = null;
    this.changed();
  }
  pushUndo() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() { if (this.undoStack.length) { this.redoStack.push(this._snapshot()); this._restore(this.undoStack.pop()); } }
  redo() { if (this.redoStack.length) { this.undoStack.push(this._snapshot()); this._restore(this.redoStack.pop()); } }

  changed(save = true) {
    sortLanes(this.anim);
    this.refreshPanel();
    this.draw();
    this.preview();
    if (save && this.onChange) this.onChange();
  }

  _keyFromBrush(lane, time) {
    const b = this.brush, kind = LANES[lane].kind;
    if (kind === 'level') return makeKey(time, [Math.round(b.level * 2.55), 0, 0], 100, b.fade, b.curve);
    if (kind === 'speed') return makeKey(time, [Math.round(b.speed * 2.55), b.reverse ? 255 : 0, 0], 100, b.fade, b.curve);
    return makeKey(time, b.rgb, b.pct, b.fade, b.curve);
  }

  _targets() {
    const kind = LANES[this.lane].kind;
    if (kind !== 'rgb' || this.target === 'lane') return [this.lane];
    return this.target === 'body' ? BODY : [...BODY, 9];
  }

  addKey() {
    if (!this.anim) return;
    this.pushUndo();
    const t = snap(Math.max(0, this.cursor));
    let selKey = null;
    for (const lane of this._targets()) {
      const keys = this.anim.lanes[lane];
      const i = keys.findIndex((k) => Math.abs(k.time - t) < 0.001);
      const k = this._keyFromBrush(lane, t);
      if (i >= 0) keys[i] = k; else keys.push(k);
      if (lane === this.lane) selKey = k;
    }
    this.sel = { lane: this.lane, key: selKey };
    this.changed();
  }

  deleteKey() {
    if (!this.sel) return;
    this.pushUndo();
    const keys = this.anim.lanes[this.sel.lane];
    const i = keys.indexOf(this.sel.key);
    if (i >= 0) keys.splice(i, 1);
    this.sel = null;
    this.changed();
  }

  stepKey(dir) {
    const keys = this.anim.lanes[this.lane];
    if (!keys.length) return;
    let k;
    if (dir > 0) k = keys.find((x) => x.time > this.cursor + 0.001) || keys[keys.length - 1];
    else k = [...keys].reverse().find((x) => x.time < this.cursor - 0.001) || keys[0];
    this.select(this.lane, k);
  }

  select(lane, key) {
    this.lane = lane;
    this.sel = key ? { lane, key } : null;
    if (key) {
      this.cursor = key.time;
      const kind = LANES[lane].kind;
      if (kind === 'rgb') { this.brush.rgb = [...key.color]; this.brush.pct = key.pct; }
      if (kind === 'level') this.brush.level = Math.round((key.color[0] * key.pct) / 255);
      if (kind === 'speed') { this.brush.speed = Math.round((key.color[0] * key.pct) / 255); this.brush.reverse = key.color[1] >= 128; }
      this.brush.fade = key.fade; this.brush.curve = key.curve;
      this._ensureVisible(key.time);
    }
    this.refreshPanel();
    this.draw();
    this.preview();
  }

  // a panel field changed: update the brush, and the selected key if there is one
  _field(f, v, evType) {
    const b = this.brush;
    if (f === 'target') { this.target = v; return; }
    if (f === 'rgb') b.rgb = unhex(v);
    else if (f === 'pct') b.pct = +v;
    else if (f === 'level') b.level = +v;
    else if (f === 'speed') b.speed = +v;
    else if (f === 'reverse') b.reverse = !!v;
    else if (f === 'fade') b.fade = !!v;
    else if (f === 'curve') b.curve = v;
    const s = this.sel;
    if (s) {
      if (!this._editing) { this.pushUndo(); this._editing = true; }
      const k = s.key;
      if (f === 'time') { k.time = Math.max(0, round3(+v || 0)); this.cursor = k.time; }
      else {
        const nk = this._keyFromBrush(s.lane, k.time);
        Object.assign(k, { color: nk.color, pct: nk.pct, fade: nk.fade, curve: nk.curve });
      }
      sortLanes(this.anim);
      this.draw();
      this.preview();
      if (evType !== 'input' || f !== 'time') this._updateOutputs();
      if (this.onChange) this.onChange();
    } else {
      this._updateOutputs();
    }
    if (f === 'rgb' && evType !== 'input') this._commitEdit();
  }

  _commitEdit() { this._editing = false; this.refreshPanel(); }

  _updateOutputs() {
    const p = this.panel, b = this.brush;
    p.querySelector('[data-o=pct]').textContent = b.pct + '%';
    p.querySelector('[data-o=level]').textContent = b.level + '%';
    p.querySelector('[data-o=speed]').textContent = b.speed + '%';
  }

  refreshPanel() {
    if (!this.anim) return;
    const p = this.panel, b = this.brush, kind = LANES[this.lane].kind;
    p.querySelector('.kp-title').textContent = (this.sel ? 'Key on ' : 'New key on ') + LANES[this.lane].name;
    p.querySelectorAll('.kp-rgb').forEach((e) => (e.hidden = kind !== 'rgb'));
    p.querySelectorAll('.kp-level').forEach((e) => (e.hidden = kind !== 'level'));
    p.querySelectorAll('.kp-speed').forEach((e) => (e.hidden = kind !== 'speed'));
    p.querySelector('.kp-target').hidden = kind !== 'rgb' || !!this.sel;
    p.querySelector('.kp-sel').hidden = !this.sel;
    p.querySelector('[data-act=delete]').disabled = !this.sel;
    const set = (f, v) => {
      const el = p.querySelector(`[data-f=${f}]`);
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
    };
    set('target', this.target);
    set('rgb', hex(b.rgb)); set('pct', b.pct); set('level', b.level); set('speed', b.speed);
    set('reverse', b.reverse); set('fade', b.fade); set('curve', b.curve);
    if (this.sel) set('time', this.sel.key.time.toFixed(2));
    this._updateOutputs();
  }

  // ------------------------------------------------------------------------------ view
  fit() {
    const w = this.canvas.clientWidth || 360;
    const len = duration(this.anim, this.audioLength);
    this.view.pps = Math.max(8, Math.min(400, (w - LABEL_W - 20) / Math.max(len, 5)));
    this.view.t0 = -0.2;
  }

  zoom(f, x) {
    const v = this.view;
    const ax = x === undefined ? LABEL_W + (this.canvas.clientWidth - LABEL_W) / 2 : x;
    const tAt = this._timeAt(ax);
    v.pps = Math.max(4, Math.min(1200, v.pps * f));
    v.t0 = tAt - (ax - LABEL_W) / v.pps;
    this._clampView();
    this.draw();
  }

  pan(dt) { this.view.t0 += dt; this._clampView(); this.draw(); }

  _clampView() {
    const len = duration(this.anim, this.audioLength);
    const vis = (this.canvas.clientWidth - LABEL_W) / this.view.pps;
    this.view.t0 = Math.max(-0.5, Math.min(this.view.t0, len - vis * 0.5));
  }

  _ensureVisible(t) {
    const vis = (this.canvas.clientWidth - LABEL_W) / this.view.pps;
    if (t < this.view.t0 || t > this.view.t0 + vis) { this.view.t0 = t - vis * 0.3; this._clampView(); }
  }

  _timeAt(x) { return this.view.t0 + (x - LABEL_W) / this.view.pps; }
  _xAt(t) { return LABEL_W + (t - this.view.t0) * this.view.pps; }
  _laneAt(y) {
    const i = Math.floor((y - RULER_H) / LANE_H);
    return i >= 0 && i < N ? i : null;
  }
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  _keyAt(p) {
    const lane = this._laneAt(p.y);
    if (lane === null || p.x < LABEL_W) return null;
    let best = null, bd = KEY_HIT;
    for (const k of this.anim.lanes[lane]) {
      const d = Math.abs(this._xAt(k.time) - p.x);
      if (d < bd) { bd = d; best = k; }
    }
    return best ? { lane, key: best } : null;
  }

  preview() {
    if (!this.anim || !this.onPreview) return;
    const ph = this.getPlayhead && this.getPlayhead();
    if (ph !== null && ph !== undefined) return;     // the player drives the preview while playing
    const t = this.cursor;
    this.onPreview(evalAll(this.anim, t), t);
    const el = this.root.querySelector('.tl-time');
    el.textContent = `${t.toFixed(2)} s`;
  }

  // ------------------------------------------------------------------------------ pointer
  _down(e) {
    if (!this.anim) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this._pos(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { type: 'pinch', dist: Math.abs(a.x - b.x) || 1, pps: this.view.pps, mid: (a.x + b.x) / 2, tMid: this._timeAt((a.x + b.x) / 2) };
      return;
    }
    if (p.y < RULER_H && p.x >= LABEL_W) { this.drag = { type: 'scrub' }; this._scrub(p.x); return; }
    const hit = this._keyAt(p);
    if (hit) {
      this.select(hit.lane, hit.key);
      this.drag = { type: 'key', hit, x0: p.x, t0: hit.key.time, moved: false };
      return;
    }
    this.drag = { type: 'pan', x0: p.x, y0: p.y, vt0: this.view.t0, moved: false };
  }

  _move(e) {
    if (!this.pointers.has(e.pointerId) || !this.drag) return;
    const p = this._pos(e);
    this.pointers.set(e.pointerId, p);
    const d = this.drag;
    if (d.type === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.abs(a.x - b.x) || 1;
      this.view.pps = Math.max(4, Math.min(1200, d.pps * dist / d.dist));
      this.view.t0 = d.tMid - (d.mid - LABEL_W) / this.view.pps;
      this._clampView();
      this.draw();
    } else if (d.type === 'scrub') {
      this._scrub(p.x);
    } else if (d.type === 'key') {
      if (!d.moved && Math.abs(p.x - d.x0) < 6) return;
      if (!d.moved) { this.pushUndo(); d.moved = true; }
      d.hit.key.time = snap(Math.max(0, d.t0 + (p.x - d.x0) / this.view.pps));
      this.cursor = d.hit.key.time;
      sortLanes(this.anim);
      this.draw();
      this.preview();
      this.refreshPanel();
    } else if (d.type === 'pan') {
      if (!d.moved && Math.abs(p.x - d.x0) < 8) return;
      d.moved = true;
      this.view.t0 = d.vt0 - (p.x - d.x0) / this.view.pps;
      this._clampView();
      this.draw();
    }
  }

  _up(e, cancel) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (this.pointers.size) return;
    this.drag = null;
    if (!d || cancel) return;
    if (d.type === 'key' && d.moved) this.changed();
    if (d.type === 'pan' && !d.moved) {
      const p = this._pos(e);
      const lane = this._laneAt(p.y);
      if (lane !== null) {
        this.lane = lane;
        this.sel = null;
        if (p.x >= LABEL_W) this.cursor = snap(Math.max(0, this._timeAt(p.x)));
        this.refreshPanel();
        this.draw();
        this.preview();
      }
    }
  }

  _scrub(x) {
    this.cursor = snap(Math.max(0, this._timeAt(x)));
    this.draw();
    this.preview();
  }

  // ------------------------------------------------------------------------------ drawing
  draw() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = RULER_H + N * LANE_H + MUSIC_H;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = {
      bg: css('--surface') || '#14161c', lane: css('--surface-2') || '#1b1e26', line: css('--line') || '#2a2e39',
      text: css('--text-2') || '#9aa1b2', accent: css('--accent') || '#ff3355', cursor: css('--cursor') || '#4cc2ff',
      sel: css('--text') || '#fff',
    };
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, w, h);
    if (!this.anim) return;
    const v = this.view;
    const tEnd = this._timeAt(w);
    const len = duration(this.anim, this.audioLength);

    // lanes
    for (let i = 0; i < N; i++) {
      const y = RULER_H + i * LANE_H;
      if (i === this.lane) { ctx.fillStyle = col.lane; ctx.fillRect(LABEL_W, y, w - LABEL_W, LANE_H); }
      ctx.fillStyle = col.line;
      ctx.fillRect(LABEL_W, y + LANE_H - 1, w - LABEL_W, 1);
      if (i === 8 || i === 9 || i === 10) ctx.fillRect(0, y + LANE_H - 1, w, 1);
    }
    // past the end
    const xe = this._xAt(len);
    if (xe < w) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(Math.max(LABEL_W, xe), RULER_H, w, h); }

    // ruler
    const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * v.pps >= 48) || 60;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let t = Math.max(0, Math.ceil(v.t0 / step) * step); t <= tEnd; t += step) {
      const x = this._xAt(t);
      if (x < LABEL_W) continue;
      ctx.fillStyle = col.line;
      ctx.fillRect(Math.round(x), RULER_H - 6, 1, h - RULER_H + 6);
      ctx.fillStyle = col.text;
      const m = Math.floor(t / 60), s = t - m * 60;
      ctx.fillText(m ? `${m}:${s.toFixed(step < 1 ? 1 : 0).padStart(step < 1 ? 4 : 2, '0')}` : `${+t.toFixed(2)}s`, x + 3, RULER_H / 2);
    }

    // values along each lane (a strip of the colour it shows) and the keys
    const sample = 3;
    for (let i = 0; i < N; i++) {
      const keys = this.anim.lanes[i];
      const y = RULER_H + i * LANE_H;
      if (keys.length) {
        const kind = LANES[i].kind;
        for (let x = Math.max(LABEL_W, this._xAt(keys[0].time)); x < w; x += sample) {
          const t = this._timeAt(x);
          if (t > len) break;
          const val = this._eval(i, t);
          ctx.fillStyle = kind === 'rgb' ? `rgb(${val})` : kind === 'level' ? `rgba(60,255,120,${val[0] / 255})` : `rgba(76,194,255,${val[0] / 255})`;
          ctx.fillRect(x, y + 8, sample, LANE_H - 16);
        }
      }
      for (const k of keys) {
        const x = this._xAt(k.time);
        if (x < LABEL_W - 8 || x > w + 8) continue;
        const isSel = this.sel && this.sel.key === k;
        ctx.save();
        ctx.translate(x, y + LANE_H / 2);
        ctx.rotate(Math.PI / 4);
        const s = isSel ? 7 : 5.5;
        const val = this._eval(i, k.time + 1e-6) || [0, 0, 0];
        ctx.fillStyle = LANES[i].kind === 'rgb' ? `rgb(${val})` : '#ddd';
        ctx.fillRect(-s, -s, s * 2, s * 2);
        ctx.lineWidth = isSel ? 2.5 : 1.2;
        ctx.strokeStyle = isSel ? col.sel : 'rgba(0,0,0,0.8)';
        ctx.strokeRect(-s, -s, s * 2, s * 2);
        ctx.restore();
      }
    }

    // music lane
    const my = RULER_H + N * LANE_H;
    ctx.fillStyle = col.lane;
    ctx.fillRect(LABEL_W, my, w - LABEL_W, MUSIC_H);
    if (this.peaks && this.audioLength) {
      const off = this.anim.audio ? this.anim.audio.offset || 0 : 0;
      const rate = this.peaks.length / this.audioLength;
      ctx.fillStyle = col.accent;
      for (let x = LABEL_W; x < w; x++) {
        const i = Math.floor((this._timeAt(x) - off) * rate);
        if (i < 0 || i >= this.peaks.length) continue;
        const a = this.peaks[i] * (MUSIC_H - 6) / 2;
        ctx.fillRect(x, my + MUSIC_H / 2 - a, 1, a * 2 || 1);
      }
    }

    // labels
    ctx.fillStyle = col.bg;
    ctx.fillRect(0, 0, LABEL_W, h);
    ctx.fillStyle = col.line;
    ctx.fillRect(LABEL_W - 1, 0, 1, h);
    ctx.font = '12px system-ui, sans-serif';
    for (let i = 0; i < N; i++) {
      const y = RULER_H + i * LANE_H;
      if (i === this.lane) { ctx.fillStyle = col.accent; ctx.fillRect(0, y + 4, 3, LANE_H - 8); }
      ctx.fillStyle = i === this.lane ? col.sel : col.text;
      ctx.fillText(LANES[i].short, 8, y + LANE_H / 2);
    }
    ctx.fillStyle = col.text;
    ctx.fillText(this.anim.audio && this.anim.audio.name ? 'Music' : 'No music', 8, my + MUSIC_H / 2);

    // cursor and playhead
    const cx = this._xAt(this.cursor);
    if (cx >= LABEL_W) {
      ctx.fillStyle = col.cursor;
      ctx.fillRect(Math.round(cx) - 1, 0, 2, h);
      ctx.beginPath(); ctx.moveTo(cx - 6, 0); ctx.lineTo(cx + 6, 0); ctx.lineTo(cx, 8); ctx.fill();
    }
    const ph = this.getPlayhead && this.getPlayhead();
    if (ph !== null && ph !== undefined) {
      const px = this._xAt(ph);
      if (px >= LABEL_W) { ctx.fillStyle = col.accent; ctx.fillRect(Math.round(px) - 1, 0, 2, h); }
    }
  }

  _eval(lane, t) {
    return evalLane(lane, this.anim.lanes[lane], t);
  }

  // keep the playhead in view while playing
  follow(t) {
    const vis = (this.canvas.clientWidth - LABEL_W) / this.view.pps;
    if (t > this.view.t0 + vis * 0.85 || t < this.view.t0) { this.view.t0 = t - vis * 0.15; this._clampView(); }
    this.draw();
    const el = this.root.querySelector('.tl-time');
    el.textContent = `${t.toFixed(2)} s`;
  }

  get lastKey() { return lastKeyTime(this.anim); }
}

// Peak envelope of a music file for the waveform lane (100 values per second).
export async function audioPeaks(url) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const buf = await (await fetch(url)).arrayBuffer();
  const ac = new AC();
  try {
    const audio = await new Promise((res, rej) => {
      const p = ac.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
    const data = audio.getChannelData(0);
    const per = Math.max(1, Math.floor(audio.sampleRate / 100));
    const peaks = new Float32Array(Math.ceil(data.length / per));
    let max = 0;
    for (let i = 0; i < peaks.length; i++) {
      let m = 0;
      for (let j = i * per, e = Math.min(data.length, j + per); j < e; j += 4) m = Math.max(m, Math.abs(data[j]));
      peaks[i] = m; max = Math.max(max, m);
    }
    if (max) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
    return { peaks, length: audio.duration };
  } finally {
    if (ac.close) ac.close();
  }
}
