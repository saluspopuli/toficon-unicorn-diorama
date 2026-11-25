// preview.js - a small drawing of the diorama that shows what the lights are doing.

const ZONE_SHAPES = [
  // [zone, svg element] for the destroy-mode Unicorn, a simple front view (viewBox 0 0 200 300)
  [0, '<rect x="88" y="22" width="24" height="22" rx="6"/>'],                       // face
  [1, '<path d="M80 60h40l-4 34H84z"/>'],                                             // chest
  [2, '<rect x="70" y="50" width="12" height="10" rx="3"/><rect x="118" y="50" width="12" height="10" rx="3"/>'], // neck
  [3, '<rect x="52" y="50" width="20" height="18" rx="5"/><rect x="128" y="50" width="20" height="18" rx="5"/><rect x="82" y="100" width="36" height="8" rx="3"/>'], // shoulders & waist
  [4, '<rect x="48" y="72" width="14" height="56" rx="6"/><rect x="138" y="72" width="14" height="56" rx="6"/><path d="M92 112h16l-8 14z"/>'], // arms & groin
  [5, '<rect x="74" y="98" width="8" height="22" rx="3"/><rect x="118" y="98" width="8" height="22" rx="3"/>'], // side waist
  [6, '<rect x="78" y="128" width="16" height="44" rx="6"/><rect x="106" y="128" width="16" height="44" rx="6"/>'], // upper legs
  [7, '<rect x="77" y="176" width="18" height="12" rx="4"/><rect x="105" y="176" width="18" height="12" rx="4"/>'], // upper knees
  [8, '<rect x="76" y="192" width="20" height="58" rx="6"/><rect x="104" y="192" width="20" height="58" rx="6"/>'], // lower knees / shins
];

export class Preview {
  constructor(root) {
    this.root = root;
    this.angle = 0;
    this.speed = 0;
    this.reverse = false;
    this._last = performance.now();
    root.innerHTML = `
      <svg viewBox="0 0 420 300" role="img" aria-label="Preview of the diorama lights">
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="glow2" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="5"/></filter>
        </defs>
        <g class="pv-frame">
          <path class="pv-armor" d="M86 18h28l6 30h30l6 22-6 64-10 0-2 36-10 0 2 84h-26l-4-60-4 60H70l2-84-10 0-2-36-10 0-6-64 6-22h30z"/>
          <path class="pv-horn" d="M100 6l-14 14h28z"/>
        </g>
        <g class="pv-zones" filter="url(#glow)">
          ${ZONE_SHAPES.map(([z, s]) => `<g data-z="${z}">${s}</g>`).join('')}
          <g data-z="9"><rect x="91" y="30" width="8" height="4" rx="2"/><rect x="101" y="30" width="8" height="4" rx="2"/></g>
        </g>
        <text class="pv-label" x="100" y="280" text-anchor="middle">Destroy mode</text>

        <g class="pv-shield" transform="translate(210 150)">
          <g class="pv-shield-rot">
            <circle r="34" class="pv-shield-disc"/>
            <path d="M0 -30 L8 0 L0 30 L-8 0z" class="pv-shield-mark"/>
            <circle r="6" class="pv-shield-hub"/>
          </g>
        </g>
        <text class="pv-label" x="210" y="206" text-anchor="middle">Shield</text>

        <g transform="translate(220 0)">
          <path class="pv-armor" d="M86 18h28l6 30h30l6 22-6 64-10 0-2 36-10 0 2 84h-26l-4-60-4 60H70l2-84-10 0-2-36-10 0-6-64 6-22h30z"/>
          <path class="pv-horn-u" d="M100 2l-3 22h6z"/>
          <rect x="88" y="22" width="24" height="22" rx="6" class="pv-face"/>
          <rect class="pv-uni-glow" x="88" y="26" width="24" height="12" rx="6" filter="url(#glow2)"/>
          <rect class="pv-uni-eye" x="91" y="30" width="18" height="4" rx="2"/>
          <text class="pv-label" x="100" y="280" text-anchor="middle">Unicorn mode</text>
        </g>
      </svg>`;
    this.zones = [...root.querySelectorAll('[data-z]')];
    this.uniEye = root.querySelector('.pv-uni-eye');
    this.uniGlow = root.querySelector('.pv-uni-glow');
    this.rot = root.querySelector('.pv-shield-rot');
    const tick = () => { this._spin(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  // values: 12 entries [r,g,b] (zone 10: brightness, zone 11: speed, direction)
  render(values) {
    for (const g of this.zones) {
      const c = values[+g.dataset.z] || [0, 0, 0];
      g.style.fill = `rgb(${c[0]},${c[1]},${c[2]})`;
      g.style.opacity = Math.max(c[0], c[1], c[2]) < 4 ? 0.15 : 1;
    }
    const lvl = (values[10] || [0])[0] / 255;
    this.uniEye.style.fill = `rgba(60,255,110,${0.12 + 0.88 * lvl})`;
    this.uniGlow.style.fill = `rgba(60,255,110,${lvl * 0.9})`;
    const s = values[11] || [0, 0];
    this.speed = s[0] / 255;
    this.reverse = s[1] >= 128;
  }

  _spin() {
    const now = performance.now();
    const dt = (now - this._last) / 1000;
    this._last = now;
    // speed 255 = about 11.7 RPM on the real motor
    this.angle = (this.angle + (this.reverse ? -1 : 1) * this.speed * 70 * dt) % 360;
    this.rot.setAttribute('transform', `rotate(${this.angle.toFixed(2)})`);
  }
}
