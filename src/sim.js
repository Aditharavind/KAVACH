// ─── KAVACH-07 vehicle simulation ─────────────────────────────────────
// One integrator drives every panel: drive-train, power, thermal, GNSS,
// radio link and the 3D feed all read this object. Nothing here touches
// hardware — it is a closed numerical model of a fictional vehicle.

import {
  clamp, dmp, rad, deg, terrainH, terrainNormalY,
  nearestTrack, ensureTrack, track, toLatLon,
} from './util.js';

export const MODES = {
  MANUAL: { limit: 32, note: 'DIRECT OPERATOR CONTROL · NO PATH ASSIST', tag: 'OPERATOR' },
  ASSIST: { limit: 24, note: 'STABILITY + TRACK-CENTRING ASSIST ENGAGED', tag: 'SHARED' },
  AUTO:   { limit: 16, note: 'AUTONOMOUS TRACK FOLLOWING · ROUTE KV-4B', tag: 'AUTONOMOUS' },
};

export const PACK_WH = 2680;
const DEAD_ZONE = 0.08;

export const veh = {
  // pose
  x: 0, z: 0, hdg: 84, speed: 0, alt: 31.8, pitch: 0, roll: 0, slip: 0,
  odo: 0, trackS: 0, trackIdx: 150, offTrack: 0,
  // driver input (after mode shaping)
  steer: 0, throttle: 0, rawX: 0, rawY: 0,
  trackL: 0, trackR: 0,
  mode: 'MANUAL',
  // power
  soc: 82.4, volt: 51.8, amp: -14.2, watt: 736, regen: 0, cellDelta: 18, cycles: 412, health: 97,
  // thermal
  temps: { battery: 38, driveA: 46, driveB: 44, controller: 41, ambient: 31 },
  // link
  rssi: -61, linkPct: 98, latency: 42, loss: 0.2, up: 1.2, down: 8.6,
  // gnss
  sats: 12, hdop: 0.8, acc: 2.4, fix: '3D',
  // housekeeping
  trail: [{ x: 0, z: 0 }],
  trailLen: 0,
  t: 0,
  recBuf: 64,
  frameLat: 42,
};

let trailAcc = 0;
let gnssT = 0;
let linkT = 0;

// ─── mode shaping + autopilot ─────────────────────────────────────────
function applyDeadZone(v) {
  const a = Math.abs(v);
  if (a < DEAD_ZONE) return 0;
  return Math.sign(v) * ((a - DEAD_ZONE) / (1 - DEAD_ZONE));
}

function autopilot(dt) {
  const pts = track.pts;
  const i = veh.trackIdx;
  const look = pts[Math.min(pts.length - 1, i + 4)];
  const here = pts[i];
  // cross-track error, signed to the right of the route
  const dx = veh.x - here.x, dz = veh.z - here.z;
  const rx = Math.cos(here.th), rz = Math.sin(here.th);
  const cross = dx * rx + dz * rz;
  let hErr = deg(look.th) - veh.hdg;
  while (hErr > 180) hErr -= 360;
  while (hErr < -180) hErr += 360;
  const steer = clamp(hErr / 26 - cross / 5.5, -1, 1);
  veh.steer = dmp(veh.steer, steer, 5, dt);
  veh.throttle = dmp(veh.throttle, 0.88 - Math.abs(steer) * 0.32, 1.2, dt);
}

// ─── main step ────────────────────────────────────────────────────────
export function step(dt, input) {
  veh.t += dt;
  veh.rawX = input.x;
  veh.rawY = input.y;

  const mode = MODES[veh.mode];
  if (veh.mode === 'AUTO') {
    autopilot(dt);
  } else {
    let sx = applyDeadZone(input.x);
    let sy = applyDeadZone(input.y);
    if (veh.mode === 'ASSIST') {
      // assist smooths the stick and nudges back toward the route
      const here = track.pts[veh.trackIdx];
      const cross = (veh.x - here.x) * Math.cos(here.th) + (veh.z - here.z) * Math.sin(here.th);
      sx = clamp(sx * 0.82 - clamp(cross / 22, -0.25, 0.25), -1, 1);
      veh.steer = dmp(veh.steer, sx, 6, dt);
      veh.throttle = dmp(veh.throttle, sy, 2.6, dt);
    } else {
      veh.steer = dmp(veh.steer, sx, 11, dt);
      veh.throttle = dmp(veh.throttle, sy, 5, dt);
    }
  }

  // ── drive-train ──
  const target = veh.throttle * mode.limit;
  const rate = Math.abs(target) > Math.abs(veh.speed) ? 8.5 : 15;
  veh.speed = dmp(veh.speed, target, rate / 6, dt);
  if (Math.abs(veh.speed) < 0.05) veh.speed = 0;

  const speedFac = 0.34 + 0.66 * Math.min(1, Math.abs(veh.speed) / 17);
  const yaw = veh.steer * 44 * speedFac * (veh.speed < -0.4 ? -1 : 1);
  veh.hdg = (veh.hdg + yaw * dt + 360) % 360;

  const mps = veh.speed / 3.6;
  const th = rad(veh.hdg);
  veh.x += Math.sin(th) * mps * dt;
  veh.z -= Math.cos(th) * mps * dt;
  veh.odo += Math.abs(mps) * dt;

  // skid-steer track speeds, shown on the input monitor
  veh.trackL = clamp(veh.throttle + veh.steer * 0.7, -1, 1);
  veh.trackR = clamp(veh.throttle - veh.steer * 0.7, -1, 1);

  // ── attitude from the same terrain the camera renders ──
  veh.alt = terrainH(veh.x, veh.z);
  const g = terrainNormalY(veh.x, veh.z);
  const fx = Math.sin(th), fz = -Math.cos(th);
  const pitchT = -deg(Math.atan(g.gx * fx + g.gz * fz));
  const rollT = deg(Math.atan(g.gx * Math.cos(th) + g.gz * Math.sin(th)));
  veh.pitch = dmp(veh.pitch, pitchT, 4, dt);
  veh.roll = dmp(veh.roll, rollT, 4, dt);
  veh.slip = Math.abs(veh.steer) * Math.abs(veh.speed) * 0.021 + Math.abs(veh.roll) * 0.02;

  // ── route position ──
  ensureTrack(veh.trackS + 400);
  const nt = nearestTrack(veh.x, veh.z, veh.trackIdx);
  veh.trackIdx = nt.i;
  veh.trackS = track.pts[nt.i].s;
  veh.offTrack = nt.dist;

  // ── breadcrumb ──
  trailAcc += Math.abs(mps) * dt;
  if (trailAcc > 1.6) {
    trailAcc = 0;
    veh.trail.push({ x: veh.x, z: veh.z });
    if (veh.trail.length > 1400) veh.trail.shift();
  }
  veh.trailLen = veh.odo;

  // ── power ──
  const load = 205 + Math.abs(veh.speed) * 16.5 + Math.abs(veh.steer) * Math.abs(veh.speed) * 7.5;
  const braking = Math.abs(target) < Math.abs(veh.speed) - 1.2 && Math.abs(veh.speed) > 3;
  veh.regen = braking ? Math.min(9, Math.abs(veh.speed) * 0.32) : 0;
  veh.watt = dmp(veh.watt, load - veh.regen * 48, 2.2, dt);
  veh.volt = 44.9 + (veh.soc / 100) * 8.4 - (veh.watt / 1000) * 0.85;
  veh.amp = -veh.watt / veh.volt + veh.regen;
  // 3× accelerated discharge so the trend is visible inside a demo session
  veh.soc = clamp(veh.soc - ((veh.watt * dt) / 3600 / PACK_WH) * 100 * 3, 0, 100);
  veh.cellDelta = dmp(veh.cellDelta, 12 + Math.abs(veh.watt) / 62, 0.5, dt);

  // ── thermal ──
  const T = veh.temps;
  const duty = Math.abs(veh.watt) / 900;
  T.ambient = dmp(T.ambient, 30.5 + Math.sin(veh.t / 90) * 1.4, 0.05, dt);
  const dTarget = T.ambient + 9 + duty * 26;
  T.driveA = dmp(T.driveA, dTarget + clamp(veh.steer, 0, 1) * 5.5, 0.06, dt);
  T.driveB = dmp(T.driveB, dTarget + clamp(-veh.steer, 0, 1) * 5.5, 0.06, dt);
  T.controller = dmp(T.controller, T.ambient + 6 + duty * 15, 0.05, dt);
  T.battery = dmp(T.battery, T.ambient + 4 + duty * 12, 0.03, dt);

  // ── radio link, degrades with range from the control station at origin ──
  linkT += dt;
  const range = Math.hypot(veh.x, veh.z);
  if (linkT > 0.25) {
    linkT = 0;
    const base = -46 - 20 * Math.log10(Math.max(28, range) / 28);
    veh.rssi = dmp(veh.rssi, base + (Math.random() - 0.5) * 3.4, 1, 0.25);
    const q = clamp((veh.rssi + 96) / 44, 0, 1);
    veh.linkPct = dmp(veh.linkPct, 60 + q * 39.5, 1, 0.25);
    veh.latency = dmp(veh.latency, 22 + (1 - q) * 96 + Math.random() * 7, 1, 0.25);
    veh.loss = dmp(veh.loss, clamp((1 - q) * 3.4 + Math.random() * 0.18, 0, 12), 1, 0.25);
    veh.up = dmp(veh.up, 0.7 + q * 0.9, 1, 0.25);
    veh.down = dmp(veh.down, 3.4 + q * 6.2, 1, 0.25);
    veh.frameLat = Math.round(veh.latency * 0.92 + 4);
    veh.recBuf = clamp(veh.recBuf + (Math.random() - 0.45) * 1.6, 22, 96);
  }

  // ── GNSS ──
  gnssT += dt;
  if (gnssT > 1) {
    gnssT = 0;
    const drift = Math.round(Math.sin(veh.t / 37) * 1.6 + (Math.random() - 0.5) * 1.2);
    veh.sats = clamp(12 + drift, 9, 15);
    veh.hdop = clamp(1.55 - veh.sats * 0.06 + Math.random() * 0.1, 0.5, 1.9);
    veh.acc = clamp(veh.hdop * 2.7 + Math.random() * 0.4, 0.7, 6.5);
    veh.fix = veh.sats >= 11 ? '3D' : veh.sats >= 7 ? '3D/DGPS' : '2D';
  }

  return veh;
}

export function geo() {
  return toLatLon(veh.x, veh.z);
}
