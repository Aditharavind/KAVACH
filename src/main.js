// ─── KAVACH GROUND CONTROL STATION ────────────────────────────────────
// Prototype operator console. Every value on screen originates in the
// local simulation in sim.js — there is no vehicle and no network link.

import './style.css';
import { CameraSim } from './scene.js';
import { TacticalMap, view, zoom } from './map.js';
import { Telemetry } from './telemetry.js';
import { Joystick } from './joystick.js';
import { Panels } from './ui.js';
import { initLog, logEvent, tickEvents } from './events.js';
import { step, veh, MODES } from './sim.js';
import { rad } from './util.js';
import { applyTheme, storedTheme, THEMES } from './theme.js';
import {
  remote, connectRemote, disconnectRemote, releaseRemote,
  defaultApiUrl, activeFields, lastRxAge,
} from './remote.js';

// theme first: the canvases read their palette at construction time
applyTheme(storedTheme());

// ── build ──
const camStage = document.getElementById('camStage');
const sim = new CameraSim(document.getElementById('gl'));
const map = new TacticalMap(document.getElementById('map'));
const mapBig = new TacticalMap(document.getElementById('mapBig'));
const tel = new Telemetry(document.getElementById('graphs'));
const stick = new Joystick(
  document.getElementById('stick'),
  document.getElementById('knob'),
  document.getElementById('stickTrace'),
);
const panels = new Panels();
initLog(document.getElementById('log'), document.querySelector('[data-v="evtCount"]'));

let camMode = 'cam1';

// ── national flag: 24-spoke Ashoka Chakra, drawn to proportion ──
(() => {
  const g = document.getElementById('chakra');
  if (!g) return;
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', (Math.cos(a) * 0.62).toFixed(3));
    line.setAttribute('y1', (Math.sin(a) * 0.62).toFixed(3));
    line.setAttribute('x2', (Math.cos(a) * 3.3).toFixed(3));
    line.setAttribute('y2', (Math.sin(a) * 3.3).toFixed(3));
    line.setAttribute('class', 'chakra-spoke');
    g.appendChild(line);
  }
})();

// ── theme switch ──
document.querySelectorAll('.tsw').forEach((b) => {
  b.classList.toggle('is-on', b.dataset.theme === storedTheme());
  b.addEventListener('click', () => {
    const name = applyTheme(b.dataset.theme);
    document.querySelectorAll('.tsw').forEach((o) => o.classList.toggle('is-on', o.dataset.theme === name));
    logEvent(`CONSOLE THEME → ${THEMES[name].label}`, 'note');
  });
});

// ── external ingest wiring ──
const apiUrlEl = document.getElementById('apiUrl');
const apiBtn = document.getElementById('apiConnect');
apiUrlEl.value = defaultApiUrl();

function apiButtonState() {
  const live = remote.status === 'live' || remote.status === 'connecting';
  apiBtn.textContent = live ? 'UNLINK' : 'LINK';
  apiBtn.classList.toggle('is-on', live);
}
apiBtn.addEventListener('click', () => {
  if (remote.status === 'offline') {
    connectRemote(apiUrlEl.value.trim() || defaultApiUrl());
    logEvent(`INGEST LINK REQUESTED · ${remote.url}`, 'note');
  } else {
    disconnectRemote();
    releaseRemote();
    logEvent('INGEST LINK CLOSED · LOCAL SIM', 'warn');
  }
  apiButtonState();
});
apiUrlEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') apiBtn.click(); });
document.addEventListener('kavach:api', (e) => {
  apiButtonState();
  if (e.detail === 'live') logEvent(`EXTERNAL TELEMETRY LINK LIVE · ${remote.url}`, 'ok');
  if (e.detail === 'error') logEvent('INGEST STREAM INTERRUPTED · RETRYING', 'warn');
});
document.getElementById('apiRelease').addEventListener('click', () => {
  releaseRemote();
  // clear the service's retained state too, so a reconnect starts clean
  if (remote.url) {
    fetch(`${remote.url}/api/reset`, { method: 'POST' }).catch(() => { /* service may be down */ });
  }
  logEvent('EXTERNAL OVERRIDES RELEASED · LOCAL SIM IN CONTROL', 'note');
});
// try the default endpoint once at boot; it fails quietly when nothing is listening
connectRemote(defaultApiUrl());
apiButtonState();

// ── camera feed tabs ──
document.querySelectorAll('.ctab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.ctab').forEach((o) => {
      const on = o === b;
      o.classList.toggle('is-on', on);
      o.setAttribute('aria-selected', String(on));
    });
    camMode = b.dataset.cam;
    camStage.classList.toggle('show-map', camMode === 'map');
    if (camMode !== 'map') sim.setMode(camMode);
    sizeAll();
    const names = { cam1: 'FRONT CAMERA (CAM 01)', cam2: 'REAR CAMERA (CAM 02)', thermal: 'THERMAL IMAGER (LWIR)', map: 'NAVIGATION MAP' };
    logEvent(`OPERATOR VIEW → ${names[camMode]}`, 'note');
  });
});

// ── map controls ──
const btn = (k) => document.querySelector(`[data-map="${k}"]`);
btn('zin').addEventListener('click', () => { zoom(1); logEvent(`MAP SCALE ${view.mpp.toFixed(2)} m/px`, 'info'); });
btn('zout').addEventListener('click', () => { zoom(-1); logEvent(`MAP SCALE ${view.mpp.toFixed(2)} m/px`, 'info'); });
btn('center').addEventListener('click', () => {
  view.cx = veh.x; view.cz = veh.z;
  logEvent('MAP RECENTRED ON KAVACH-07', 'note');
});
btn('northup').addEventListener('click', () => {
  view.northUp = !view.northUp;
  btn('northup').classList.toggle('is-on', view.northUp);
  btn('northup').setAttribute('aria-pressed', String(view.northUp));
  btn('northup').textContent = view.northUp ? 'NORTH UP' : 'HEADING UP';
  logEvent(`MAP ORIENTATION ${view.northUp ? 'NORTH UP' : 'HEADING UP'}`, 'note');
});
btn('follow').addEventListener('click', () => setFollow(!view.follow));
function setFollow(on) {
  view.follow = on;
  btn('follow').classList.toggle('is-on', on);
  btn('follow').setAttribute('aria-pressed', String(on));
  logEvent(`MAP FOLLOW ${on ? 'ENGAGED' : 'RELEASED'}`, 'note');
}
document.addEventListener('map:follow', (e) => {
  view.follow = e.detail;
  btn('follow').classList.toggle('is-on', e.detail);
  btn('follow').setAttribute('aria-pressed', String(e.detail));
});

// ── control mode ──
document.querySelectorAll('.mode').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach((o) => o.classList.toggle('is-on', o === b));
    veh.mode = b.dataset.mode;
    stick.center();
    logEvent(`CONTROL MODE → ${veh.mode} · LIMIT ${MODES[veh.mode].limit} KM/H`, 'warn');
  });
});
document.getElementById('centerInput').addEventListener('click', () => {
  stick.center();
  logEvent('CONTROL INPUT CENTRED · NEUTRAL', 'ok');
});

// ── health rail tabs (narrow layouts) ──
document.querySelectorAll('.rtab').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.rtab').forEach((o) => {
      const on = o === b;
      o.classList.toggle('is-on', on);
      o.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('#railL .sec').forEach((s) => {
      s.classList.toggle('is-on', s.dataset.sec === b.dataset.sec);
    });
  });
});

// ── sizing ──
function sizeAll() {
  const c = camStage.getBoundingClientRect();
  sim.resize(c.width, c.height);
  mapBig.resize(c.width, c.height);
  const m = document.getElementById('mapStage').getBoundingClientRect();
  map.resize(m.width, m.height);
  tel.resize();
}
new ResizeObserver(sizeAll).observe(camStage);
new ResizeObserver(sizeAll).observe(document.getElementById('mapStage'));
addEventListener('resize', sizeAll);
sizeAll();

// ── boot sequence in the event log ──
[
  ['KAVACH GCS 0.7.0 · SIMULATION BUILD', 'note'],
  ['NO REAL VEHICLE CONNECTION · TELEMETRY SYNTHETIC', 'warn'],
  ['POWER BUS 51.8 V · PACK 82%', 'ok'],
  ['IMU-A / IMU-B ALIGNED · BIAS NOMINAL', 'ok'],
  ['GNSS LOCK · 12 SAT · NAVIC + GPS', 'ok'],
  ['MESH LINK ESTABLISHED · -61 dBm', 'ok'],
  ['VIDEO STREAM ACTIVE · CAM 01 1080P30', 'ok'],
  ['KAVACH-07 READY · MANUAL CONTROL', 'note'],
].forEach(([m, s], i) => setTimeout(() => logEvent(m, s), 120 * i));

// ── main loop ──
let last = performance.now();
let uiAcc = 0, mapAcc = 0, telAcc = 0;
let frames = 0, fps = 0, fpsT = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frames++; fpsT += dt;
  if (fpsT > 1) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }

  const input = stick.update(dt);
  const v = step(dt, input);
  tickEvents(v, dt);

  // events pushed through the API, and any mode it asked for
  while (remote.pendingEvents.length) {
    const ev = remote.pendingEvents.shift();
    logEvent(ev.message, ev.severity);
  }
  if (remote.pendingMode) {
    const want = remote.pendingMode;
    remote.pendingMode = null;
    if (MODES[want] && want !== veh.mode) {
      veh.mode = want;
      document.querySelectorAll('.mode').forEach((o) => o.classList.toggle('is-on', o.dataset.mode === want));
      logEvent(`CONTROL MODE → ${want} · COMMANDED BY API`, 'warn');
    }
  }

  if (view.follow) { view.cx = v.x; view.cz = v.z; }
  view.rot = view.northUp ? 0 : -rad(v.hdg);

  if (camMode !== 'map') {
    sim.update(v, dt);
    sim.render();
  }

  tel.sample(v, dt);

  mapAcc += dt;
  if (mapAcc > 1 / 22) {
    mapAcc = 0;
    map.draw(v);
    if (camMode === 'map') mapBig.draw(v);
  }
  telAcc += dt;
  if (telAcc > 1 / 8) { telAcc = 0; tel.draw(); }
  uiAcc += dt;
  if (uiAcc > 1 / 10) {
    uiAcc = 0;
    panels.update(v, camMode, { fields: activeFields(), age: lastRxAge(), url: apiUrlEl.value });
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// console handle for inspecting the simulation while it runs
window.KAVACH = {
  veh, view, sim, map, remote,
  setTheme: applyTheme,
  diag: () => ({ fps, camMode, mode: veh.mode, speed: +veh.speed.toFixed(2), soc: +veh.soc.toFixed(2), odo: +veh.odo.toFixed(1) }),
};
window.__diag = window.KAVACH.diag;

// keyboard shortcuts for the operator console
addEventListener('keydown', (e) => {
  if (e.target.closest('#stick')) return;
  const k = e.key.toLowerCase();
  if (k === 'c') document.getElementById('centerInput').click();
  if (k === 'f') setFollow(!view.follow);
  if (k === 'n') btn('northup').click();
  if (k === '1' || k === '2' || k === '3' || k === '4') {
    const tabs = document.querySelectorAll('.ctab');
    tabs[Number(k) - 1]?.click();
  }
});
