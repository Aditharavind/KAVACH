// ─── LIVE MAP ─────────────────────────────────────────────────────────
// Canvas relief map drawn from the same terrain + track functions that
// generate the 3D feed, so the marker really is where the camera is.

import { terrainH, track, clamp, rad, toLatLon, distToTrack } from './util.js';

export const view = {
  cx: 0, cz: 0, mpp: 0.42, rot: 0,
  follow: true, northUp: true,
};
export const ZOOMS = [0.12, 0.2, 0.32, 0.52, 0.85, 1.4, 2.3, 3.8];
let zi = 3;
view.mpp = ZOOMS[zi];
export function zoom(dir) { zi = clamp(zi + dir, 0, ZOOMS.length - 1); view.mpp = ZOOMS[zi]; return view.mpp; }
export function scaleLabel() {
  const px = 76, m = px * view.mpp;
  const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  let best = nice[0];
  for (const n of nice) if (Math.abs(n - m) < Math.abs(best - m)) best = n;
  return { label: best >= 1000 ? `${best / 1000} km` : `${best} m`, px: best / view.mpp };
}

// static field furniture: service spurs and named areas
const spurs = [];
for (let k = 0; k < 3; k++) {
  const pts = [];
  const anchor = track.pts[Math.floor(track.pts.length * (0.25 + k * 0.22))];
  let x = anchor.x, z = anchor.z, th = anchor.th + (k % 2 ? 1 : -1) * 1.25;
  for (let i = 0; i < 60; i++) {
    th += Math.sin(i / 7 + k) * 0.055;
    x += Math.sin(th) * 9; z -= Math.cos(th) * 9;
    pts.push({ x, z });
  }
  spurs.push(pts);
}
const places = [
  { x: -18, z: 42, n: 'STAGING AREA', t: 'area' },
  { x: 210, z: -260, n: 'RELAY MAST R-2', t: 'node' },
  { x: -260, z: -120, n: 'QUARRY EDGE', t: 'area' },
  { x: 620, z: -520, n: 'GRADE SECTION B', t: 'area' },
  { x: 0, z: 0, n: 'CONTROL STATION', t: 'base' },
];

export class TacticalMap {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 1; this.h = 1; this.dpr = Math.min(devicePixelRatio, 2);
    this.raster = document.createElement('canvas');
    this.rctx = this.raster.getContext('2d');
    this.rKey = '';
    this.#drag();
  }

  #drag() {
    let last = null;
    this.c.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY };
      this.c.setPointerCapture(e.pointerId);
    });
    this.c.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      const cs = Math.cos(-view.rot), sn = Math.sin(-view.rot);
      view.cx -= (dx * cs - dy * sn) * view.mpp;
      view.cz -= (dx * sn + dy * cs) * view.mpp;
      view.follow = false;
      document.dispatchEvent(new CustomEvent('map:follow', { detail: false }));
    });
    const up = () => { last = null; };
    this.c.addEventListener('pointerup', up);
    this.c.addEventListener('pointercancel', up);
    this.c.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? -1 : 1); }, { passive: false });
  }

  resize(w, h) {
    if (w < 2 || h < 2) return;
    this.w = w; this.h = h;
    this.c.width = Math.floor(w * this.dpr);
    this.c.height = Math.floor(h * this.dpr);
    this.rKey = '';
  }

  toScreen(x, z) {
    const dx = (x - view.cx) / view.mpp, dz = (z - view.cz) / view.mpp;
    const cs = Math.cos(view.rot), sn = Math.sin(view.rot);
    return [this.w / 2 + dx * cs - dz * sn, this.h / 2 + dx * sn + dz * cs];
  }

  // ── hillshaded relief + contour raster, world-aligned, cached ──
  #buildRaster() {
    const span = Math.hypot(this.w, this.h) * view.mpp * 1.12;
    const px = Math.ceil(span / view.mpp);
    const step = 9;                                    // sample every 9 screen px
    const n = Math.ceil(px / step) + 1;
    if (this.raster.width !== px) { this.raster.width = px; this.raster.height = px; }
    const g = this.rctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0B0E0B';
    g.fillRect(0, 0, px, px);

    const x0 = view.cx - span / 2, z0 = view.cz - span / 2;
    const hs = new Float32Array(n * n);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const h = terrainH(x0 + i * step * view.mpp, z0 + j * step * view.mpp);
        hs[j * n + i] = h;
        if (h < lo) lo = h; if (h > hi) hi = h;
      }
    }
    // relief shading, light from the north-west
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const h = hs[j * n + i];
        const gx = hs[j * n + i + 1] - h, gz = hs[(j + 1) * n + i] - h;
        const shade = clamp(0.5 + (-gx * 0.9 - gz * 0.9) * 1.5, 0, 1);
        const elev = clamp((h - lo) / Math.max(1e-3, hi - lo), 0, 1);
        const r = 16 + shade * 26 + elev * 12;
        const gr = 20 + shade * 28 + elev * 12;
        const b = 15 + shade * 20 + elev * 8;
        g.fillStyle = `rgb(${r | 0},${gr | 0},${b | 0})`;
        g.fillRect(i * step, j * step, step + 1, step + 1);
      }
    }
    // contour lines every 2 m (marching squares on the sampled grid)
    g.lineWidth = 1;
    for (let lv = Math.ceil(lo / 2) * 2; lv <= hi; lv += 2) {
      const major = Math.abs(lv % 10) < 0.001;
      g.strokeStyle = major ? 'rgba(190,196,170,0.20)' : 'rgba(160,170,140,0.09)';
      g.beginPath();
      for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
          const a = hs[j * n + i], b = hs[j * n + i + 1], c = hs[(j + 1) * n + i + 1], d = hs[(j + 1) * n + i];
          const X = i * step, Y = j * step;
          const seg = [];
          const ip = (p, q) => (lv - p) / (q - p);
          if ((a < lv) !== (b < lv)) seg.push([X + step * ip(a, b), Y]);
          if ((b < lv) !== (c < lv)) seg.push([X + step, Y + step * ip(b, c)]);
          if ((c < lv) !== (d < lv)) seg.push([X + step * (1 - ip(c, d)), Y + step]);
          if ((d < lv) !== (a < lv)) seg.push([X, Y + step * (1 - ip(d, a))]);
          for (let s = 0; s + 1 < seg.length; s += 2) {
            g.moveTo(seg[s][0], seg[s][1]);
            g.lineTo(seg[s + 1][0], seg[s + 1][1]);
          }
        }
      }
      g.stroke();
    }
    this.rOrigin = { x: x0, z: z0, span };
  }

  #ensureRaster() {
    const key = `${Math.round(view.cx / 12)}|${Math.round(view.cz / 12)}|${view.mpp}|${this.w}|${this.h}`;
    if (key === this.rKey) return;
    this.rKey = key;
    this.#buildRaster();
  }

  draw(v) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.#ensureRaster();

    // relief blit, rotated for heading-up
    const o = this.rOrigin;
    const [ox, oy] = this.toScreen(o.x, o.z);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(view.rot);
    ctx.globalAlpha = 0.95;
    ctx.drawImage(this.raster, 0, 0, this.raster.width, this.raster.height, 0, 0, o.span / view.mpp, o.span / view.mpp);
    ctx.restore();
    ctx.globalAlpha = 1;

    this.#grid(ctx);
    this.#spurs(ctx);
    this.#track(ctx, v);
    this.#trail(ctx, v);
    this.#places(ctx);
    this.#vehicle(ctx, v);
    this.#frame(ctx);
  }

  // 100 m survey graticule with easting/northing ticks
  #grid(ctx) {
    const stepM = view.mpp > 1.6 ? 500 : view.mpp > 0.6 ? 200 : 100;
    const span = Math.hypot(this.w, this.h) * view.mpp * 0.62;
    const sx = Math.floor((view.cx - span) / stepM) * stepM;
    const sz = Math.floor((view.cz - span) / stepM) * stepM;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(149,168,95,0.09)';
    ctx.beginPath();
    for (let x = sx; x < view.cx + span; x += stepM) {
      const a = this.toScreen(x, view.cz - span), b = this.toScreen(x, view.cz + span);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    for (let z = sz; z < view.cz + span; z += stepM) {
      const a = this.toScreen(view.cx - span, z), b = this.toScreen(view.cx + span, z);
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(122,133,120,0.55)';
    ctx.font = '8px "IBM Plex Mono", monospace';
    for (let x = sx; x < view.cx + span; x += stepM) {
      const p = this.toScreen(x, view.cz);
      if (p[0] > 26 && p[0] < this.w - 26) ctx.fillText(`E${x < 0 ? '-' : '+'}${Math.abs(x)}`, p[0] + 3, this.h - 6);
    }
    for (let z = sz; z < view.cz + span; z += stepM) {
      const p = this.toScreen(view.cx, z);
      if (p[1] > 20 && p[1] < this.h - 20) ctx.fillText(`N${-z < 0 ? '-' : '+'}${Math.abs(z)}`, 6, p[1] - 3);
    }
  }

  #poly(ctx, pts) {
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      const [x, y] = this.toScreen(p.x, p.z);
      if (x < -400 || y < -400 || x > this.w + 400 || y > this.h + 400) { started = false; continue; }
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
  }

  #spurs(ctx) {
    ctx.lineCap = 'round';
    for (const s of spurs) {
      ctx.strokeStyle = 'rgba(96,88,64,0.55)';
      ctx.lineWidth = Math.max(1.2, 2.6 / view.mpp * 0.6);
      this.#poly(ctx, s); ctx.stroke();
      ctx.strokeStyle = 'rgba(140,128,92,0.22)';
      ctx.lineWidth = 1; ctx.setLineDash([4, 6]);
      this.#poly(ctx, s); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  #track(ctx, v) {
    const w = clamp(3.8 / view.mpp, 1.6, 26);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(88,80,58,0.85)';
    ctx.lineWidth = w + 2;
    this.#poly(ctx, track.pts); ctx.stroke();
    ctx.strokeStyle = 'rgba(134,120,86,0.8)';
    ctx.lineWidth = w;
    this.#poly(ctx, track.pts); ctx.stroke();
    ctx.strokeStyle = 'rgba(196,182,142,0.16)';
    ctx.lineWidth = 1; ctx.setLineDash([7, 9]);
    this.#poly(ctx, track.pts); ctx.stroke(); ctx.setLineDash([]);

    // route waypoints, emphasised in AUTO
    const auto = v.mode === 'AUTO';
    ctx.font = '8px "IBM Plex Mono", monospace';
    for (const p of track.pts) {
      if (Math.abs(p.s % 200) > 1) continue;
      const [x, y] = this.toScreen(p.x, p.z);
      if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) continue;
      const ahead = p.s > v.trackS;
      ctx.beginPath();
      ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y);
      ctx.closePath();
      ctx.strokeStyle = auto && ahead ? 'rgba(224,139,54,0.85)' : 'rgba(149,168,95,0.45)';
      ctx.lineWidth = 1.2; ctx.stroke();
      if (view.mpp < 0.9) {
        ctx.fillStyle = auto && ahead ? 'rgba(224,139,54,0.75)' : 'rgba(122,133,120,0.6)';
        ctx.fillText(`WP${String(Math.round(p.s / 200)).padStart(2, '0')}`, x + 7, y + 3);
      }
    }
  }

  #trail(ctx, v) {
    if (v.trail.length < 2) return;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // dark casing first, or the trail vanishes against the pale track
    ctx.strokeStyle = 'rgba(18,24,14,0.85)';
    ctx.lineWidth = 4.2;
    this.#poly(ctx, v.trail); ctx.stroke();
    ctx.strokeStyle = 'rgba(139,158,88,0.9)';
    ctx.lineWidth = 2.2;
    this.#poly(ctx, v.trail); ctx.stroke();
    // the last 60 fixes are the live tail
    ctx.strokeStyle = 'rgba(186,208,124,0.95)';
    ctx.lineWidth = 2;
    this.#poly(ctx, v.trail.slice(-60)); ctx.stroke();
    ctx.fillStyle = 'rgba(216,230,180,0.9)';
    for (let i = v.trail.length - 1; i >= 0; i -= 6) {
      const [x, y] = this.toScreen(v.trail[i].x, v.trail[i].z);
      if (x < 0 || y < 0 || x > this.w || y > this.h) continue;
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  #places(ctx) {
    ctx.font = '8.5px "Barlow Semi Condensed", sans-serif';
    for (const p of places) {
      const [x, y] = this.toScreen(p.x, p.z);
      if (x < -60 || y < -30 || x > this.w + 60 || y > this.h + 30) continue;
      if (p.t === 'base') {
        ctx.strokeStyle = 'rgba(126,154,168,0.8)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x - 5, y - 5, 10, 10);
        ctx.beginPath(); ctx.arc(x, y, 9, 0, 6.28); ctx.stroke();
      } else if (p.t === 'node') {
        ctx.strokeStyle = 'rgba(126,154,168,0.65)';
        ctx.beginPath(); ctx.moveTo(x, y + 5); ctx.lineTo(x - 4, y - 4); ctx.lineTo(x + 4, y - 4); ctx.closePath(); ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(122,133,120,0.35)';
        ctx.setLineDash([3, 4]);
        ctx.strokeRect(x - 26, y - 14, 52, 28);
        ctx.setLineDash([]);
      }
      ctx.fillStyle = 'rgba(176,186,168,0.75)';
      ctx.fillText(p.n, x + 9, y - 6);
    }
  }

  #vehicle(ctx, v) {
    const [x, y] = this.toScreen(v.x, v.z);
    const ang = rad(v.hdg) + view.rot;

    // GNSS accuracy disc
    const ar = Math.max(6, v.acc / view.mpp);
    ctx.beginPath(); ctx.arc(x, y, ar, 0, 6.28);
    ctx.fillStyle = 'rgba(224,139,54,0.07)'; ctx.fill();
    ctx.strokeStyle = 'rgba(224,139,54,0.32)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.stroke(); ctx.setLineDash([]);

    // heading vector, length scaled by speed
    const hl = 16 + Math.abs(v.speed) * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.sin(ang) * hl, y - Math.cos(ang) * hl);
    ctx.strokeStyle = 'rgba(224,139,54,0.7)'; ctx.lineWidth = 1.2; ctx.stroke();

    // UGV icon: hull with two tracks
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    const s = clamp(1.6 / view.mpp, 0.8, 3.4);
    ctx.scale(s, s);
    ctx.fillStyle = '#12160F';
    ctx.strokeStyle = '#E08B36'; ctx.lineWidth = 1.1 / s;
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(3.4, -3.4); ctx.lineTo(3.4, 6); ctx.lineTo(-3.4, 6); ctx.lineTo(-3.4, -3.4);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(224,139,54,0.85)';
    ctx.fillRect(-5, -4, 1.6, 9.5);
    ctx.fillRect(3.4, -4, 1.6, 9.5);
    ctx.fillStyle = '#D8DDD1';
    ctx.fillRect(-1, -3, 2, 3.2);
    ctx.restore();
  }

  #frame(ctx) {
    ctx.strokeStyle = 'rgba(48,56,41,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, this.w - 1, this.h - 1);
    // corner ticks
    ctx.strokeStyle = 'rgba(149,168,95,0.35)';
    const t = 9;
    for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [this.w, 0, -1, 1], [0, this.h, 1, -1], [this.w, this.h, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * t, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * t);
      ctx.stroke();
    }
  }
}

export function mapInfo(v) {
  const g = toLatLon(v.x, v.z);
  return { ...g, off: distToTrack(v.x, v.z) };
}
