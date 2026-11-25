// player.js - plays an animation: music on this phone, lights on the Nano.
//
// The timeline clock is performance.now(), gently pulled towards the music's currentTime so the
// lights follow the song. The Nano runs its own clock from the segments it was sent; the drift
// correction in protocol.js keeps it on this clock. "Light lead" (ms) makes the lights run
// slightly ahead to make up for Bluetooth / audio output delay.

import { ms } from './protocol.js';
import { toSegments, showEnd } from './animation.js';

const MUSIC_FADE_S = 2;   // the music fades out over the last seconds of a show

const sleep = (t) => new Promise((r) => setTimeout(r, t));

export class Player {
  constructor(audio, getOnboard) {
    this.audio = audio;
    this.getOnboard = getOnboard;   // () => Onboard or null (no connection: preview only)
    this.playing = false;
    this.anim = null;
    this.base = 0;                  // performance.now() at timeline 0
    this.end = 0;
    this.token = 0;
    this.audioStarted = false;
    this.onEnd = null;
    this.onError = null;
    this.onState = null;
  }

  t() { return this.playing ? (performance.now() - this.base) / 1000 : 0; }

  // Must be called from a tap (iOS only lets a page start sound from a user gesture).
  unlockAudio(url) {
    const a = this.audio;
    if (!url) return;
    if (a.dataset.url !== url) { a.src = url; a.dataset.url = url; }
    const p = a.play();
    if (p && p.then) p.then(() => { if (!this.audioStarted) a.pause(); }).catch(() => {});
  }

  async play(anim, from = 0) {
    await this.stop(false);
    const token = ++this.token;
    const ob = this.getOnboard();
    const lead = (anim.settings.light_lead_ms || 0) / 1000;
    const url = anim._audioUrl || null;
    const off = anim.audio ? anim.audio.offset || 0 : 0;
    this.anim = anim;
    this.useAudio = !!url;
    this.audioStarted = false;
    this.lead = lead;
    this.off = off;
    if (this.useAudio) {
      this.unlockAudio(url);
      this.volume = Math.max(0, Math.min(1, (anim.audio.volume ?? 100) / 100));
      this.audio.volume = this.volume;
      await waitMeta(this.audio);
    }
    if (token !== this.token) return;
    // ends 10 s after the last key, not at the end of a longer song
    this.end = showEnd(anim, this.useAudio ? this.audio.duration || 0 : 0);

    if (ob) {
      ob.posAt = null;
      await ob.load(toSegments(anim), ms(from + lead));
      if (token !== this.token) return;
    }

    this.playing = true;
    this.base = performance.now() - from * 1000;
    if (this.useAudio && from >= off && from - off < (this.audio.duration || Infinity)) {
      await this._startAudio(from - off);
      if (token !== this.token) return;
      this.base = performance.now() - from * 1000;     // the music took a moment to start
    }
    if (ob) {
      ob.posAt = (perf) => ms((perf - this.base) / 1000 + this.lead);
      await ob.setClock(true, () => ms(this.t() + this.lead));
    }
    if (this.onState) this.onState(true);
    this._run(token, ob);
  }

  async _startAudio(at) {
    const a = this.audio;
    this.audioStarted = true;
    try {
      a.currentTime = Math.max(0, at);
      await a.play();
    } catch (e) {
      this.useAudio = false;                     // play the lights without music
      if (this.onError) this.onError(new Error('The music could not start: ' + e.message));
    }
  }

  async _run(token, ob) {
    const lights = async () => {
      while (this.token === token && this.playing && ob) {
        try {
          await ob.service();
          const c = ob.correction();
          if (c) await ob.adjust(c);
        } catch (e) {
          if (this.token === token && this.onError) this.onError(e);
          return;
        }
        await sleep(15);
      }
    };
    lights();
    while (this.token === token && this.playing) {
      const t = this.t();
      if (this.useAudio) {
        const a = this.audio;
        if (!this.audioStarted && t >= this.off) this._startAudio(t - this.off);
        else if (this.audioStarted && !a.paused && !a.ended) {
          const err = this.off + a.currentTime - t;       // seconds; + = music is ahead
          if (Math.abs(err) > 0.3) this.base -= err * 1000;
          else if (Math.abs(err) > 0.02) this.base -= err * 1000 * 0.1;
          // fade the music out instead of cutting it off mid-song
          const left = this.end - t;
          try { a.volume = this.volume * Math.max(0, Math.min(1, left / MUSIC_FADE_S)); } catch { /* iOS: volume is read-only */ }
        }
      }
      if (t >= this.end) {
        if (this.anim.settings.loop) { this.play(this.anim, 0); return; }
        await this.stop();
        if (this.onEnd) this.onEnd();
        return;
      }
      await sleep(50);
    }
  }

  async stop(notify = true) {
    const was = this.playing;
    this.token++;
    this.playing = false;
    this.audioStarted = false;
    try { this.audio.pause(); } catch { /* ignore */ }
    const ob = this.getOnboard();
    if (ob) {
      ob.posAt = null;
      ob.pending = ob.pending.map(() => []);
      if (was) { try { await ob.setClock(false, () => 0); } catch { /* link gone */ } }
    }
    if (notify && was && this.onState) this.onState(false);
  }
}

function waitMeta(a) {
  if (a.readyState >= 1) return Promise.resolve();
  return new Promise((res) => {
    const done = () => { a.removeEventListener('loadedmetadata', done); a.removeEventListener('error', done); clearTimeout(t); res(); };
    const t = setTimeout(done, 4000);
    a.addEventListener('loadedmetadata', done);
    a.addEventListener('error', done);
  });
}
