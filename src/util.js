// ─── shared math, deterministic terrain + track geometry ──────────────
// Everything on this console reads from these functions, so the 3D feed,
// the map and the autopilot always agree about the same piece of ground.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dmp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
export const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

// hash-based value noise (no assets, fully reproducible)
function h2(ix, iy) {
  let n = ix * 374761393 + iy * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}
export function hash(ix, iy, salt = 0) {
  return h2(ix + salt * 9187, iy - salt * 3121);
}
export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
}

// ─── terrain ───────────────────────────────────────────────────────────
// Rolling scrub-land, ~34 m mean elevation. World axes: +X east, -Z north.
export const GROUND_BASE = 35.95;
export function terrainH(x, z) {
  return (
    GROUND_BASE +
    5.6 * noise2(x / 175, z / 175) +
    3.1 * noise2(x / 64, z / 64) +
    1.45 * noise2(x / 24, z / 24) +
    0.46 * noise2(x / 7.2, z / 7.2) +
    0.14 * noise2(x / 2.3, z / 2.3)
  );
}
export function terrainNormalY(x, z) {
  const e = 1.2;
  const hx = terrainH(x + e, z) - terrainH(x - e, z);
  const hz = terrainH(x, z + e) - terrainH(x, z - e);
  return { gx: hx / (2 * e), gz: hz / (2 * e) };
}

// ─── the track (unpaved test route) ────────────────────────────────────
// A wandering dirt road sampled every STEP metres, starting on 084°.
export const TRACK_STEP = 4;
export const ROAD_HALF = 1.9;        // driving surface half-width, m
const START_HDG = 84;

function trackHeadingAt(s) {
  return rad(
    START_HDG +
    27 * Math.sin(s / 268) +
    12.5 * Math.sin(s / 97 + 1.7) +
    5.5 * Math.sin(s / 39 + 0.4)
  );
}

export const track = { pts: [], sMin: 0, sMax: 0 };
function pushTrackPoint(s, x, z) {
  const th = trackHeadingAt(s);
  // road grade is the terrain smoothed along the route
  let acc = 0;
  for (let k = -3; k <= 3; k++) {
    acc += terrainH(x + Math.sin(th) * k * 3.2, z - Math.cos(th) * k * 3.2);
  }
  track.pts.push({ s, x, z, th, y: acc / 7 });
}
function buildTrack(fromS, toS) {
  if (track.pts.length === 0) {
    let x = 0, z = 0, s = fromS;
    // walk backwards from origin first so there is road behind the vehicle
    const back = [];
    for (let bs = 0; bs > fromS; bs -= TRACK_STEP) {
      const th = trackHeadingAt(bs);
      x -= Math.sin(th) * TRACK_STEP;
      z += Math.cos(th) * TRACK_STEP;
      back.push({ s: bs - TRACK_STEP, x, z });
    }
    back.reverse();
    for (const b of back) pushTrackPoint(b.s, b.x, b.z);
    pushTrackPoint(0, 0, 0);
    track.sMin = back.length ? back[0].s : 0;
    track.sMax = 0;
  }
  let last = track.pts[track.pts.length - 1];
  while (track.sMax < toS) {
    const th = trackHeadingAt(last.s);
    const x = last.x + Math.sin(th) * TRACK_STEP;
    const z = last.z - Math.cos(th) * TRACK_STEP;
    pushTrackPoint(last.s + TRACK_STEP, x, z);
    last = track.pts[track.pts.length - 1];
    track.sMax = last.s;
  }
}
buildTrack(-600, 1600);
export function ensureTrack(sAhead) {
  if (sAhead + 700 > track.sMax) buildTrack(track.sMin, sAhead + 900);
}

// index of the nearest track sample to a world point (hinted linear search)
export function nearestTrack(x, z, hint = -1) {
  const pts = track.pts;
  let lo = 0, hi = pts.length - 1;
  if (hint >= 0) { lo = Math.max(0, hint - 40); hi = Math.min(pts.length - 1, hint + 40); }
  let bi = lo, bd = Infinity;
  for (let i = lo; i <= hi; i++) {
    const dx = pts[i].x - x, dz = pts[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; bi = i; }
  }
  if (hint >= 0 && (bi === lo || bi === hi) && (hi - lo) < pts.length - 1) return nearestTrack(x, z, -1);
  return { i: bi, dist: Math.sqrt(bd) };
}

// ─── geodesy (simulated survey origin, KAVACH field test range) ────────
export const ORIGIN = { lat: 10.0124, lon: 76.2972 };
export function toLatLon(x, z) {
  const north = -z, east = x;
  return {
    lat: ORIGIN.lat + north / 111320,
    lon: ORIGIN.lon + east / (111320 * Math.cos(rad(ORIGIN.lat))),
  };
}
export const fmtLat = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'N' : 'S'}`;
export const fmtLon = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? 'E' : 'W'}`;
export const hhmmss = (sec) => `${pad(sec / 3600)}:${pad((sec / 60) % 60)}:${pad(sec % 60)}`;

// IST clock, stated honestly as UTC+05:30
export function istNow() {
  const d = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
  return d;
}

// ─── track spatial index (fast "how far am I from the road" queries) ───
const GRID = 32;
const trackGrid = new Map();
let gridded = 0;
function keyOf(x, z) { return `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`; }
export function indexTrack() {
  for (; gridded < track.pts.length; gridded++) {
    const p = track.pts[gridded];
    const k = keyOf(p.x, p.z);
    let a = trackGrid.get(k);
    if (!a) trackGrid.set(k, (a = []));
    a.push(gridded);
  }
}
export function distToTrack(x, z) {
  indexTrack();
  const cx = Math.floor(x / GRID), cz = Math.floor(z / GRID);
  let best = Infinity;
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      const arr = trackGrid.get(`${cx + a},${cz + b}`);
      if (!arr) continue;
      for (const i of arr) {
        const p = track.pts[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < best) best = d;
      }
    }
  }
  return Math.sqrt(best);
}
