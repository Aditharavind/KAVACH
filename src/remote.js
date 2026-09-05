// ─── external telemetry ingest ────────────────────────────────────────
// Subscribes to the Python ingest API (api/kavach_api.py) over Server-Sent
// Events. Any field that arrives overrides the local simulation for as long
// as it keeps arriving; when the feed goes quiet the console falls back to
// simulating that field again, so a partial feed is always safe.

import { clamp } from './util.js';

export const TTL = 12;          // seconds a pushed value stays authoritative

export const remote = {
  url: '',
  status: 'offline',            // offline | connecting | live | error
  packets: 0,
  lastAt: 0,
  source: null,
  fields: new Map(),            // name -> { v, t }
  control: null,                // { steer, throttle, t }
  pendingMode: null,
  pendingEvents: [],
};

let es = null;
let retry = null;
let retryDelay = 2000;

const KEY = 'kavach.api';

export function defaultApiUrl() {
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q.replace(/\/$/, '');
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved.replace(/\/$/, '');
  } catch { /* private browsing */ }
  const host = location.hostname || '127.0.0.1';
  return `http://${host}:8000`;
}

function setStatus(s) {
  if (remote.status === s) return;
  remote.status = s;
  document.dispatchEvent(new CustomEvent('kavach:api', { detail: s }));
}

export function connectRemote(url = remote.url || defaultApiUrl()) {
  disconnectRemote();
  remote.url = url.replace(/\/$/, '');
  try { localStorage.setItem(KEY, remote.url); } catch { /* private browsing */ }
  setStatus('connecting');

  try {
    es = new EventSource(`${remote.url}/api/stream`);
  } catch {
    setStatus('error');
    return;
  }

  es.addEventListener('open', () => { retryDelay = 2000; setStatus('live'); });

  es.addEventListener('hello', (e) => {
    setStatus('live');
    remote.packets++;
    remote.lastAt = performance.now() / 1000;
    // adopt whatever the service already holds, so a late-joining console
    // is immediately consistent with one that has been listening for hours
    try {
      const hello = JSON.parse(e.data);
      const st = hello.state || {};
      // only adopt retained values that are still inside their lifetime;
      // replaying a producer that stopped an hour ago would be a lie
      if (hello.age !== null && hello.age !== undefined && hello.age <= TTL) {
        if (st.telemetry) ingestTelemetry(st.telemetry);
        if (st.control && Object.keys(st.control).length) ingestControl(st.control);
        if (st.source) remote.source = st.source;
      }
    } catch { /* malformed hello is not fatal */ }
  });

  es.addEventListener('telemetry', (e) => wrap(e, (d) => ingestTelemetry(d)));
  es.addEventListener('control', (e) => wrap(e, (d) => ingestControl(d)));
  es.addEventListener('event', (e) => wrap(e, (d) => {
    if (d.message) remote.pendingEvents.push({ message: String(d.message), severity: d.severity || 'info' });
  }));
  es.addEventListener('reset', () => releaseRemote(false));

  es.addEventListener('error', () => {
    setStatus('error');
    if (es) { es.close(); es = null; }
    clearTimeout(retry);
    retry = setTimeout(() => connectRemote(remote.url), retryDelay);
    retryDelay = Math.min(retryDelay * 1.6, 20000);      // back off, keep trying
  });
}

function wrap(e, fn) {
  let frame;
  try { frame = JSON.parse(e.data); } catch { return; }
  remote.packets++;
  remote.lastAt = performance.now() / 1000;
  setStatus('live');
  fn(frame.data || {});
}

const NUMERIC = new Set(['speed', 'heading', 'soc', 'volt', 'amp', 'watt', 'rssi', 'linkPct',
  'latency', 'loss', 'sats', 'hdop', 'acc', 'pitch', 'roll', 'lat', 'lon', 'odo']);
const TEMPS = new Set(['battery', 'driveA', 'driveB', 'controller', 'ambient']);

function stamp(name, value) {
  remote.fields.set(name, { v: value, t: performance.now() / 1000 });
}

function ingestTelemetry(d) {
  for (const [k, val] of Object.entries(d)) {
    if (NUMERIC.has(k) && Number.isFinite(+val)) stamp(k, +val);
    else if (k === 'temps' && val && typeof val === 'object') {
      for (const [tk, tv] of Object.entries(val)) {
        if (TEMPS.has(tk) && Number.isFinite(+tv)) stamp(`temps.${tk}`, +tv);
      }
    } else if (k === 'source') remote.source = String(val).slice(0, 24);
    else if (k === 'mode') remote.pendingMode = String(val).toUpperCase();
  }
}

function ingestControl(d) {
  const now = performance.now() / 1000;
  const prev = remote.control || { steer: 0, throttle: 0 };
  remote.control = {
    steer: Number.isFinite(+d.steer) ? clamp(+d.steer, -1, 1) : prev.steer,
    throttle: Number.isFinite(+d.throttle) ? clamp(+d.throttle, -1, 1) : prev.throttle,
    t: now,
  };
  if (d.mode) remote.pendingMode = String(d.mode).toUpperCase();
}

export function disconnectRemote() {
  clearTimeout(retry);
  if (es) { es.close(); es = null; }
  setStatus('offline');
}

/** Drop every override; the local simulation resumes control of all fields. */
export function releaseRemote(log = true) {
  remote.fields.clear();
  remote.control = null;
  remote.source = null;
  if (log) remote.pendingEvents.push({ message: 'EXTERNAL OVERRIDES RELEASED · LOCAL SIM', severity: 'note' });
}

/** Fields still inside their time-to-live, i.e. currently authoritative. */
export function activeFields() {
  const now = performance.now() / 1000;
  const live = [];
  for (const [k, entry] of remote.fields) {
    if (now - entry.t <= TTL) live.push(k);
    else remote.fields.delete(k);
  }
  return live;
}

export function fresh(name) {
  const entry = remote.fields.get(name);
  if (!entry) return null;
  return (performance.now() / 1000 - entry.t <= TTL) ? entry.v : null;
}

export function controlFresh() {
  if (!remote.control) return null;
  return (performance.now() / 1000 - remote.control.t <= TTL) ? remote.control : null;
}

export function lastRxAge() {
  return remote.lastAt ? performance.now() / 1000 - remote.lastAt : Infinity;
}
