// ─── virtual controller ───────────────────────────────────────────────
// Pointer + touch + keyboard. Output is normalised [-1,1] and spring-
// returns to neutral on release. It drives the on-screen model only.

import { clamp } from './util.js';

export class Joystick {
  constructor(base, knob, trace) {
    this.base = base; this.knob = knob; this.trace = trace;
    this.x = 0; this.y = 0;
    this.active = false;
    this.keys = new Set();

    const set = (ev) => {
      const r = base.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (ev.clientX - (r.left + R)) / (R * 0.78);
      let dy = (ev.clientY - (r.top + R)) / (R * 0.78);
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this.x = clamp(dx, -1, 1);
      this.y = clamp(-dy, -1, 1);
    };

    base.addEventListener('pointerdown', (e) => {
      this.active = true;
      base.setPointerCapture(e.pointerId);
      base.classList.add('is-live');
      set(e);
      e.preventDefault();
    });
    base.addEventListener('pointermove', (e) => { if (this.active) set(e); });
    const release = () => { this.active = false; base.classList.remove('is-live'); };
    base.addEventListener('pointerup', release);
    base.addEventListener('pointercancel', release);
    base.addEventListener('lostpointercapture', release);

    const KEYMAP = {
      ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
      ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    };
    base.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.code === 'Space') { this.center(); e.preventDefault(); return; }
      const k = KEYMAP[e.code];
      if (!k) return;
      this.keys.add(k); e.preventDefault();
    });
    base.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) this.keys.delete(k); });
    base.addEventListener('blur', () => this.keys.clear());
  }

  center() { this.x = 0; this.y = 0; this.keys.clear(); this.active = false; }

  update(dt) {
    if (!this.active) {
      if (this.keys.size) {
        const tx = (this.keys.has('right') ? 1 : 0) - (this.keys.has('left') ? 1 : 0);
        const ty = (this.keys.has('up') ? 1 : 0) - (this.keys.has('down') ? 1 : 0);
        this.x += (tx - this.x) * Math.min(1, dt * 6);
        this.y += (ty - this.y) * Math.min(1, dt * 5);
        this.base.classList.add('is-live');
      } else {
        // sprung return to neutral
        const k = Math.min(1, dt * 11);
        this.x += (0 - this.x) * k;
        this.y += (0 - this.y) * k;
        if (Math.abs(this.x) < 0.004) this.x = 0;
        if (Math.abs(this.y) < 0.004) this.y = 0;
        if (!this.x && !this.y) this.base.classList.remove('is-live');
      }
    }
    const R = this.base.clientWidth / 2;
    const px = this.x * R * 0.62, py = -this.y * R * 0.62;
    this.knob.style.transform = `translate(${px.toFixed(2)}px, ${py.toFixed(2)}px)`;
    this.trace.style.setProperty('--kx', `${50 + this.x * 31}%`);
    this.trace.style.setProperty('--ky', `${50 - this.y * 31}%`);
    return { x: this.x, y: this.y };
  }
}
