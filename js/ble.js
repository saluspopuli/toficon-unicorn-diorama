// ble.js - the link to the diorama's Bluetooth LE serial module (sold as "HC-06").
//
// Measured behaviour of this module (MGEX Unicorn LED project, desktop/docs/BLUETOOTH.md):
//   * service FFE0; FFE1 = data from the module (notify), FFE2 = data to the module
//   * only "write without response" works, and a write may carry at most 16 bytes
//   * the pieces are spaced so the module can pass each one on to the Nano before the next
//   * one connection at a time; after a disconnect it is off the air for a few seconds

import { Engine } from './engine.js';

const SERVICE = 0xffe0;
const CHAR_RX = 0xffe1;
const CHAR_TX = 0xffe2;
const CHUNK = 16;
const UART_BAUD = 38400;          // the module <-> Nano speed (BT_BAUD in diorama.ino)
const GAP_SCALE = 0.6;
const GAP_MS = Math.max(2, (CHUNK * 10 * 1000 / UART_BAUD) * GAP_SCALE);
const REPLY_TIMEOUT_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export class BleLink {
  constructor() {
    this.device = null;
    this.rxChar = null;
    this.txChar = null;
    this.rx = [];
    this.waiter = null;
    this.onDisconnect = null;
    this.name = '';
  }

  get connected() { return !!(this.device && this.device.gatt && this.device.gatt.connected); }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE] }, { namePrefix: 'HC-' }, { namePrefix: 'Unicorn' }],
      optionalServices: [SERVICE],
    });
    this.name = this.device.name || 'Diorama';
    this.device.addEventListener('gattserverdisconnected', () => {
      if (this.onDisconnect) this.onDisconnect();
    });
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {     // the first try often fails
      try {
        const server = await this.device.gatt.connect();
        const svc = await server.getPrimaryService(SERVICE);
        this.rxChar = await svc.getCharacteristic(CHAR_RX);
        try { this.txChar = await svc.getCharacteristic(CHAR_TX); } catch { this.txChar = this.rxChar; }
        this.rxChar.addEventListener('characteristicvaluechanged', (e) => this._onData(e.target.value));
        await this.rxChar.startNotifications();
        return;
      } catch (e) {
        lastErr = e;
        await sleep(800);
      }
    }
    throw lastErr;
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }

  _onData(view) {
    for (let i = 0; i < view.byteLength; i++) this.rx.push(view.getUint8(i));
    if (this.waiter) this.waiter();
  }

  async write(data) {
    for (let i = 0; i < data.length; i += CHUNK) {
      if (i) await sleep(GAP_MS);
      const piece = data.slice(i, i + CHUNK);
      if (this.txChar.writeValueWithoutResponse) await this.txChar.writeValueWithoutResponse(piece);
      else await this.txChar.writeValue(piece);
    }
  }

  // Send a command and wait for its answer (stop-and-wait). Returns the reply or null.
  async exchange(data, replyLen, timeout = REPLY_TIMEOUT_MS) {
    if (!this.connected) throw new Error('Not connected');
    this.rx = [];
    await this.write(data);
    const end = performance.now() + timeout;
    for (;;) {
      // skip stray bytes up to the 'K' / 'E'
      while (this.rx.length && this.rx[0] !== 75 && this.rx[0] !== 69) this.rx.shift();
      if (this.rx[0] === 69) return null;                 // 'E': bad checksum
      if (this.rx.length >= replyLen) return Uint8Array.from(this.rx.slice(0, replyLen));
      const left = end - performance.now();
      if (left <= 0) return null;
      await new Promise((res) => {
        const t = setTimeout(res, left);
        this.waiter = () => { clearTimeout(t); res(); };
      });
      this.waiter = null;
    }
  }
}

// Demo mode: a pretend Nano running the same engine, so the app can be tried without hardware.
export class SimLink {
  constructor() {
    this.engine = new Engine();
    this.name = 'Demo diorama';
    this.connected = true;
    this.onDisconnect = null;
    this._last = performance.now();
    this._timer = setInterval(() => this._tick(), 5);
  }

  _tick() {
    const now = performance.now();
    const d = Math.floor(now - this._last);
    if (d > 0) { this.engine.advance(d); this._last += d; }
  }

  async connect() {}

  disconnect() {
    clearInterval(this._timer);
    this.connected = false;
    if (this.onDisconnect) this.onDisconnect();
  }

  async exchange(data) {
    await sleep(12);                                     // a little like the real link
    this._tick();
    const n = data[2];
    const body = Array.from(data.slice(3, 3 + n));
    const reply = this.engine.execute(body, performance.now());
    await sleep(8);
    return reply;
  }

  colors() { this._tick(); return this.engine.colors(); }
}
