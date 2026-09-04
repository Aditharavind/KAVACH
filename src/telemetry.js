// ─── LIVE TELEMETRY strip ─────────────────────────────────────────────
// Five 60-second engineering traces, sampled at 5 Hz off the vehicle model.

const WINDOW = 60, RATE = 5, N = WINDOW * RATE;

const CHANNELS = [
  { k: 'battery', label: 'BATTERY', unit: '%', dp: 1, color: '#95A85F', get: (v) => v.soc, span: 1.6 },
  { k: 'temp', label: 'DRIVE TEMP', unit: '°C', dp: 1, color: '#D9A63F', get: (v) => Math.max(v.temps.driveA, v.temps.driveB), span: 6 },
  { k: 'speed', label: 'SPEED', unit: 'km/h', dp: 1, color: '#E08B36', get: (v) => v.speed, fixed: [-14, 34] },
  { k: 'rssi', label: 'SIGNAL', unit: 'dBm', dp: 0, color: '#7E9AA8', get: (v) => v.rssi, fixed: [-96, -40] },
  { k: 'power', label: 'POWER', unit: 'W', dp: 0, color: '#8FA0B8', get: (v) => v.watt, fixed: [0, 1150] },
];

export class Telemetry {
  constructor(host) {
    this.dpr = Math.min(devicePixelRatio, 2);
    this.acc = 0;
    this.ch = CHANNELS.map((c) => {
      const card = document.createElement('div');
      card.className = 'gcard';
      card.innerHTML = `
        <div class="g-hd"><span class="g-k">${c.label}</span><span class="g-v"><b data-out>--</b><span class="g-u">${c.unit}</span></span></div>
        <div class="g-canvas"><canvas></canvas></div>
        <div class="g-ft"><span data-lo>--</span><span>60 s</span><span data-hi>--</span></div>`;
      host.appendChild(card);
      return {
        ...c, card,
        canvas: card.querySelector('canvas'),
        ctx: card.querySelector('canvas').getContext('2d'),
        out: card.querySelector('[data-out]'),
        lo: card.querySelector('[data-lo]'),
        hi: card.querySelector('[data-hi]'),
        buf: new Float32Array(N).fill(NaN),
        n: 0,
      };
    });
    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
  }

  resize() {
    for (const c of this.ch) {
      const r = c.canvas.parentElement.getBoundingClientRect();
      c.w = Math.max(2, r.width); c.h = Math.max(2, r.height);
      c.canvas.width = Math.floor(c.w * this.dpr);
      c.canvas.height = Math.floor(c.h * this.dpr);
    }
  }

  sample(v, dt) {
    this.acc += dt;
    while (this.acc >= 1 / RATE) {
      this.acc -= 1 / RATE;
      for (const c of this.ch) {
        c.buf.copyWithin(0, 1);
        c.buf[N - 1] = c.get(v);
        c.n = Math.min(N, c.n + 1);
      }
    }
  }

  draw() {
    for (const c of this.ch) {
      const { ctx, w, h } = c;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      let lo, hi;
      if (c.fixed) { [lo, hi] = c.fixed; }
      else {
        lo = Infinity; hi = -Infinity;
        for (let i = 0; i < N; i++) {
          const y = c.buf[i];
          if (Number.isNaN(y)) continue;
          if (y < lo) lo = y; if (y > hi) hi = y;
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        const mid = (lo + hi) / 2, half = Math.max(c.span / 2, (hi - lo) / 2 * 1.35);
        lo = mid - half; hi = mid + half;
      }
      const yOf = (val) => h - 2 - ((val - lo) / (hi - lo)) * (h - 4);

      ctx.strokeStyle = 'rgba(149,168,95,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k <= 3; k++) { const y = (h / 4) * k; ctx.moveTo(0, y); ctx.lineTo(w, y); }
      for (let k = 1; k <= 3; k++) { const x = (w / 4) * k; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      ctx.stroke();

      const xOf = (i) => (i / (N - 1)) * w;
      let first = -1;
      for (let i = 0; i < N; i++) if (!Number.isNaN(c.buf[i])) { first = i; break; }
      if (first < 0) continue;

      // area under the trace
      ctx.beginPath();
      ctx.moveTo(xOf(first), h);
      for (let i = first; i < N; i++) ctx.lineTo(xOf(i), yOf(c.buf[i]));
      ctx.lineTo(xOf(N - 1), h);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, c.color + '38');
      grad.addColorStop(1, c.color + '00');
      ctx.fillStyle = grad; ctx.fill();

      ctx.beginPath();
      for (let i = first; i < N; i++) {
        const x = xOf(i), y = yOf(c.buf[i]);
        i === first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = c.color; ctx.lineWidth = 1.1; ctx.stroke();

      const last = c.buf[N - 1];
      if (!Number.isNaN(last)) {
        const y = yOf(last);
        ctx.strokeStyle = c.color + '55';
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.fillStyle = c.color;
        ctx.beginPath(); ctx.arc(w - 2, y, 2, 0, 6.28); ctx.fill();
        c.out.textContent = last.toFixed(c.dp);
      }
      c.lo.textContent = lo.toFixed(c.dp === 0 ? 0 : 1);
      c.hi.textContent = hi.toFixed(c.dp === 0 ? 0 : 1);
    }
  }
}
