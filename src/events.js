// ─── SYSTEM EVENT LOG ─────────────────────────────────────────────────
// Simulated bus traffic: periodic heartbeats plus state-change events
// raised by the vehicle model.

import { istNow, pad } from './util.js';

const MAX = 90;
let host, countEl, count = 0;

export function initLog(el, counter) { host = el; countEl = counter; }

export function logEvent(msg, sev = 'info') {
  if (!host) return;
  const d = istNow();
  const row = document.createElement('div');
  row.className = `ev sev-${sev} is-new`;
  row.innerHTML = `<span class="ev-t">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span><i class="ev-d"></i><span class="ev-m"></span>`;
  row.querySelector('.ev-m').textContent = msg;
  host.prepend(row);
  while (host.children.length > MAX) host.lastChild.remove();
  count++;
  if (countEl) countEl.textContent = `${count} REC`;
}

const HEARTBEAT = [
  ['TELEMETRY PACKET RX', 'info'],
  ['SENSOR BUS HEARTBEAT', 'info'],
  ['GNSS POSITION UPDATED', 'note'],
  ['DRIVE SYSTEM NOMINAL', 'ok'],
  ['VIDEO STREAM ACTIVE', 'info'],
  ['IMU CALIBRATION STABLE', 'info'],
  ['DATA LOGGER FLUSH 4 MB', 'info'],
  ['THERMAL SWEEP COMPLETE', 'ok'],
  ['ODOMETRY FUSION LOCKED', 'note'],
  ['LIDAR SCAN 12 Hz OK', 'info'],
];

let hb = 0, hbT = 0;
const seen = {
  moving: false, lowBat: false, hotDrive: false, weakLink: false,
  offTrack: false, satLoss: false, wp: -1,
};

export function tickEvents(v, dt) {
  hbT += dt;
  if (hbT > 2.6 + Math.random() * 2.4) {
    hbT = 0;
    const [m, s] = HEARTBEAT[hb % HEARTBEAT.length];
    hb++;
    logEvent(m, s);
  }

  const moving = Math.abs(v.speed) > 0.6;
  if (moving !== seen.moving) {
    seen.moving = moving;
    logEvent(moving
      ? `DRIVE ENGAGED · ${v.speed > 0 ? 'FORWARD' : 'REVERSE'} · ${v.mode}`
      : 'VEHICLE STATIONARY · DRIVE IDLE', moving ? 'ok' : 'note');
  }

  const wp = Math.floor(v.trackS / 200);
  if (seen.wp < 0) seen.wp = wp;
  else if (wp !== seen.wp) {
    seen.wp = wp;
    logEvent(`WAYPOINT WP${String(Math.abs(wp)).padStart(2, '0')} PASSED · ${(v.odo / 1000).toFixed(2)} KM`, 'note');
  }

  const lowBat = v.soc < 25;
  if (lowBat !== seen.lowBat) { seen.lowBat = lowBat; logEvent(lowBat ? `BATTERY BELOW 25% · ${v.soc.toFixed(0)}% REMAINING` : 'BATTERY STATE RECOVERED', lowBat ? 'warn' : 'ok'); }

  const hot = Math.max(v.temps.driveA, v.temps.driveB) > 68;
  if (hot !== seen.hotDrive) { seen.hotDrive = hot; logEvent(hot ? 'DRIVE TEMPERATURE ELEVATED · DERATE ADVISED' : 'DRIVE TEMPERATURE NORMALISED', hot ? 'warn' : 'ok'); }

  const weak = v.linkPct < 78;
  if (weak !== seen.weakLink) { seen.weakLink = weak; logEvent(weak ? `DATA LINK DEGRADED · ${v.linkPct.toFixed(0)}% · ${v.rssi.toFixed(0)} dBm` : 'DATA LINK RESTORED', weak ? 'warn' : 'ok'); }

  const off = v.offTrack > 14;
  if (off !== seen.offTrack) { seen.offTrack = off; logEvent(off ? `OFF-TRACK ${v.offTrack.toFixed(0)} M · TERRAIN MODE` : 'TRACK RE-ACQUIRED', off ? 'warn' : 'ok'); }

  const sl = v.sats < 10;
  if (sl !== seen.satLoss) { seen.satLoss = sl; logEvent(sl ? `GNSS DEGRADED · ${v.sats} SAT · HDOP ${v.hdop.toFixed(1)}` : `GNSS FIX ${v.fix} · ${v.sats} SAT`, sl ? 'warn' : 'ok'); }
}
