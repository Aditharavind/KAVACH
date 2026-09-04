// ─── panel binding ────────────────────────────────────────────────────
// Builds the repeating readouts once, then pushes vehicle state into the
// DOM at a fixed 10 Hz so the console stays legible rather than jittery.

import { pad, hhmmss, istNow, clamp, fmtLat, fmtLon } from './util.js';
import { MODES, PACK_WH, geo } from './sim.js';
import { view, scaleLabel } from './map.js';

const F = {};
document.querySelectorAll('[data-v]').forEach((el) => { F[el.dataset.v] = el; });
const W = {};
document.querySelectorAll('[data-w]').forEach((el) => { W[el.dataset.w] = el; });
const set = (k, v) => { const e = F[k]; if (e && e.textContent !== v) e.textContent = v; };

const THERM = [
  ['Battery', 'battery', 55],
  ['Drive A', 'driveA', 85],
  ['Drive B', 'driveB', 85],
  ['Controller', 'controller', 75],
  ['Ambient', 'ambient', 50],
];
const SUBS = [
  ['DRIVE', 'DRV-A2'], ['POWER', 'PWR-14S'], ['IMU', 'IMU-9X'],
  ['GNSS', 'GNS-N4'], ['SENSOR BUS', 'SBS-CAN'], ['DATA LOGGER', 'LOG-SSD'],
];
const SENSORS = [
  ['LIDAR 32-BEAM', 'l'], ['STEREO CAMERA', 's'], ['THERMAL CAMERA', 't'],
  ['IMU-A / IMU-B', 'i'], ['WHEEL ODOMETRY', 'w'], ['RF DATA LINK', 'r'],
  ['DATA LOGGER', 'd'], ['POWER MONITOR', 'p'],
];

export class Panels {
  constructor() {
    this.start = performance.now();
    this.rows = {};

    const th = document.querySelector('[data-v-list="therm"]');
    for (const [label, key, max] of THERM) {
      const r = document.createElement('div');
      r.className = 'th-row';
      r.innerHTML = `<span class="k">${label}</span><span class="th-track"><i></i><u style="left:${(max / 100) * 100}%"></u></span><span class="v">--</span>`;
      th.appendChild(r);
      this.rows[key] = { bar: r.querySelector('i'), val: r.querySelector('.v'), max };
    }

    const su = document.querySelector('[data-v-list="subs"]');
    this.subs = SUBS.map(([n, code]) => {
      const r = document.createElement('div');
      r.className = 'sub-row';
      r.innerHTML = `<span class="k">${n}</span><span class="s"><i class="dot dot-live"></i><b>OK</b></span><span class="code">${code}</span>`;
      su.appendChild(r);
      return { el: r, state: r.querySelector('b'), name: n };
    });

    const rs = document.querySelector('[data-v-list="rssiBars"]');
    this.rssiBars = [];
    for (let i = 0; i < 26; i++) {
      const b = document.createElement('i');
      rs.appendChild(b);
      this.rssiBars.push(b);
    }
    this.rssiHist = new Array(26).fill(0.6);

    const sl = document.querySelector('[data-v-list="sensors"]');
    this.sensors = SENSORS.map(([n]) => {
      const r = document.createElement('div');
      r.className = 'sn';
      r.innerHTML = `<span class="sn-k">${n}</span><span class="sn-b"><i style="width:60%"></i></span><span class="sn-s">ONLINE</span>`;
      sl.appendChild(r);
      return { el: r, bar: r.querySelector('i'), state: r.querySelector('.sn-s') };
    });
  }

  update(v, cam) {
    const d = istNow();
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    set('sysTime', `${clock} IST`);
    set('sessTime', hhmmss((performance.now() - this.start) / 1000));

    // ── header ──
    const linkOk = v.linkPct > 78;
    set('linkState', linkOk ? 'ACTIVE' : 'DEGRADED');
    if (F.linkState) F.linkState.style.color = linkOk ? '' : 'var(--warn)';
    set('satHdr', `${v.sats} SAT`);
    set('linkPctHdr', `${v.linkPct.toFixed(0)}%`);

    // ── power ──
    set('soc', v.soc.toFixed(0));
    if (W.socBar) {
      W.socBar.style.width = `${v.soc}%`;
      const p = W.socBar.parentElement;
      p.classList.toggle('is-low', v.soc < 30 && v.soc >= 15);
      p.classList.toggle('is-crit', v.soc < 15);
    }
    set('packHealth', `HEALTH ${v.health}%`);
    set('packCycles', `CYC ${v.cycles}`);
    set('packTag', `LI-ION 14S · ${(PACK_WH / 1000).toFixed(2)} kWh`);
    set('volt', `${v.volt.toFixed(1)} V`);
    set('amp', `${v.amp.toFixed(1)} A`);
    set('watt', `${v.watt.toFixed(0)} W`);
    const hrs = (PACK_WH * (v.soc / 100)) / Math.max(90, v.watt);
    set('runtime', `${pad(hrs)}:${pad((hrs % 1) * 60)}`);
    set('cellDelta', `${v.cellDelta.toFixed(0)} mV`);
    if (W.cellBar) W.cellBar.style.width = `${clamp(100 - v.cellDelta * 1.6, 20, 100)}%`;
    set('regen', `${v.regen.toFixed(1)} A`);
    if (W.regenBar) W.regenBar.style.width = `${clamp(v.regen * 10, 2, 100)}%`;

    // ── thermal ──
    let hottest = 0;
    for (const [, key] of THERM) {
      const t = v.temps[key], r = this.rows[key];
      hottest = Math.max(hottest, key === 'ambient' ? 0 : t);
      r.bar.style.width = `${clamp((t / 95) * 100, 2, 100)}%`;
      const cls = t > r.max ? 'crit' : t > r.max - 12 ? 'warn' : 'ok';
      r.bar.className = `t-${cls}`;
      r.val.className = `v v-${cls}`;
      r.val.textContent = `${t.toFixed(1)}°C`;
    }
    set('thermTag', hottest > 73 ? 'ELEVATED' : hottest > 62 ? 'RISING' : 'NOMINAL');

    // ── navigation ──
    set('hdg', `${pad(v.hdg, 3)}°`);
    set('spd', `${Math.abs(v.speed).toFixed(1)} km/h`);
    set('alt', `${v.alt.toFixed(1)} m`);
    set('odo', `${(v.odo / 1000).toFixed(2)} km`);
    set('pitch', `${v.pitch >= 0 ? '+' : ''}${v.pitch.toFixed(1)}°`);
    set('roll', `${v.roll >= 0 ? '+' : ''}${v.roll.toFixed(1)}°`);
    set('slip', `${v.slip.toFixed(1)}%`);
    const ah = document.getElementById('ahHorizon');
    if (ah) ah.setAttribute('transform', `rotate(${(-v.roll).toFixed(2)} 60 30) translate(0 ${(v.pitch * 1.5).toFixed(2)})`);

    set('sats', `${v.sats}`);
    set('hdop', v.hdop.toFixed(1));
    set('acc', `±${v.acc.toFixed(1)} m`);
    set('fixTag', `${v.fix} FIX / ${v.acc < 2 ? 'RTK-FLOAT' : 'SBAS'}`);

    // ── comms ──
    set('rssi', `${v.rssi.toFixed(0)} dBm`);
    set('linkPct', `${v.linkPct.toFixed(0)}%`);
    set('latency', `${v.latency.toFixed(0)} ms`);
    set('loss', `${v.loss.toFixed(1)}%`);
    set('up', `${v.up.toFixed(1)} Mb/s`);
    set('down', `${v.down.toFixed(1)} Mb/s`);
    this.rssiHist.shift();
    this.rssiHist.push(clamp((v.rssi + 96) / 50, 0.06, 1));
    this.rssiBars.forEach((b, i) => {
      b.style.height = `${this.rssiHist[i] * 100}%`;
      b.classList.toggle('hot', this.rssiHist[i] > 0.7);
    });

    // ── subsystems ──
    const faults = {
      DRIVE: Math.max(v.temps.driveA, v.temps.driveB) > 73,
      POWER: v.soc < 20,
      IMU: Math.abs(v.roll) > 14,
      GNSS: v.sats < 10,
      'SENSOR BUS': v.loss > 2.4,
      'DATA LOGGER': false,
    };
    let ok = 0;
    for (const s of this.subs) {
      const bad = faults[s.name];
      s.el.classList.toggle('is-warn', !!bad);
      s.state.textContent = bad ? 'CHECK' : 'OK';
      if (!bad) ok++;
    }
    set('subsTag', `${ok} / ${this.subs.length} OK`);

    // ── sensors ──
    const loads = [
      0.42 + Math.abs(v.speed) / 60, 0.5 + Math.abs(v.steer) * 0.2, 0.34,
      0.6, clamp(Math.abs(v.speed) / 34, 0.05, 1), clamp(v.linkPct / 100, 0, 1),
      clamp(v.recBuf / 100, 0, 1), clamp(v.watt / 1100, 0, 1),
    ];
    let online = 0;
    this.sensors.forEach((s, i) => {
      const warn = (i === 5 && v.linkPct < 78) || (i === 2 && v.temps.controller > 70);
      s.bar.style.width = `${clamp(loads[i] * 100, 4, 100)}%`;
      s.state.textContent = warn ? 'DEGRADED' : 'ONLINE';
      s.el.classList.toggle('is-warn', warn);
      if (!warn) online++;
    });
    set('sensTag', `${online} ONLINE`);

    // ── camera overlay ──
    const CAMS = {
      cam1: ['FRONT CAMERA', 'CAM 01', '1080P', '30 FPS', 'EFL 4.2mm f/1.8'],
      cam2: ['REAR CAMERA', 'CAM 02', '720P', '30 FPS', 'EFL 2.8mm f/2.0'],
      thermal: ['THERMAL IMAGER', 'THM 01', '640×480', '9 FPS', 'LWIR 8–14 µm'],
      map: ['NAVIGATION MAP', 'MAP', 'VECTOR', '20 FPS', 'GNSS + ODOMETRY'],
    };
    const [cn, ci, cr, cf, cl] = CAMS[cam] || CAMS.cam1;
    set('camName', cn); set('camId', ci); set('camRes', cr); set('camFps', cf); set('camLens', cl);
    set('camLive', cam === 'map' ? 'RENDER' : 'LIVE');
    set('vidLink', `${v.linkPct.toFixed(0)}%`);
    set('recBuf', `${v.recBuf.toFixed(0)}%`);
    set('frameLat', `${v.frameLat} ms`);
    set('camTime', `${clock} IST`);
    set('camHdg', `${pad(v.hdg, 3)}°`);
    set('camSpd', `${Math.abs(v.speed).toFixed(1)} KM/H`);
    set('camTemp', `${v.temps.controller.toFixed(0)}°C`);
    set('camFix', v.fix);

    // ── map readouts ──
    const g = geo();
    set('lat', fmtLat(g.lat));
    set('lon', fmtLon(g.lon));
    set('mapHdg', `${pad(v.hdg, 3)}°`);
    set('mapAcc', `±${v.acc.toFixed(1)} m`);
    set('mapSpd', `${Math.abs(v.speed).toFixed(1)} km/h`);
    set('mapTrack', `${(v.odo / 1000).toFixed(2)} km`);
    const sc = scaleLabel();
    set('mapScale', sc.label);
    const sb = document.querySelector('.scale-bar');
    if (sb) sb.style.width = `${sc.px.toFixed(0)}px`;
    const rose = document.getElementById('roseSpin');
    if (rose) rose.setAttribute('transform', `rotate(${((view.rot * 180) / Math.PI).toFixed(1)} 22 22)`);
    set('mapSector', `SECTOR 4 · FIELD TEST RANGE · ${v.offTrack < 6 ? 'ON TRACK' : `OFF TRACK ${v.offTrack.toFixed(0)} M`}`);

    // ── controller ──
    set('stickX', (v.rawX >= 0 ? '+' : '') + v.rawX.toFixed(2));
    set('stickY', (v.rawY >= 0 ? '+' : '') + v.rawY.toFixed(2));
    const mag = Math.hypot(v.rawX, v.rawY);
    let cmd = 'NEUTRAL';
    if (v.mode === 'AUTO') cmd = 'AUTONOMOUS';
    else if (mag > 0.08) {
      const fwd = v.rawY > 0.18 ? 'FORWARD' : v.rawY < -0.18 ? 'REVERSE' : '';
      const lr = v.rawX > 0.18 ? 'RIGHT' : v.rawX < -0.18 ? 'LEFT' : '';
      cmd = [fwd, lr].filter(Boolean).join(' · ') || 'HOLD';
    }
    set('command', cmd);
    if (F.command) F.command.classList.toggle('is-act', cmd !== 'NEUTRAL');
    set('inputState', cmd === 'NEUTRAL' ? 'NEUTRAL' : 'ACTIVE');
    set('modeTag', MODES[v.mode].tag);
    set('modeNote', MODES[v.mode].note);
    set('spdLimit', `${MODES[v.mode].limit} KM/H`);
    set('ctlLink', linkOk ? 'ACTIVE' : 'DEGRADED');
    const bar = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      const w = Math.abs(val) * 50;
      el.style.width = `${w}%`;
      el.style.left = val >= 0 ? '50%' : `${50 - w}%`;
      el.style.background = Math.abs(val) > 0.75 ? 'var(--saffron)' : 'var(--olive)';
    };
    bar('barSteer', v.steer); bar('barThr', v.throttle);
    bar('barTL', v.trackL); bar('barTR', v.trackR);

    // ── at-a-glance card (tabbed layouts) ──
    const hotDrive = Math.max(v.temps.driveA, v.temps.driveB);
    set('gSpd', Math.abs(v.speed).toFixed(1));
    set('gHdg', pad(v.hdg, 3));
    set('gSoc', v.soc.toFixed(0));
    set('gTemp', hotDrive.toFixed(0));
    set('gLink', v.linkPct.toFixed(0));
    set('gSats', `${v.sats}`);
    const warnGl = { gSoc: v.soc < 25, gTemp: hotDrive > 68, gLink: v.linkPct < 78, gSats: v.sats < 10 };
    for (const [k, bad] of Object.entries(warnGl)) F[k]?.parentElement.classList.toggle('is-warn', bad);
    set('glanceTag', Object.values(warnGl).some(Boolean) ? 'CHECK' : 'NOMINAL');
    if (F.glanceTag) F.glanceTag.style.color = Object.values(warnGl).some(Boolean) ? 'var(--warn)' : '';

    set('footState', `KAVACH-07 · ${v.mode} · ${linkOk ? 'LINK ACTIVE' : 'LINK DEGRADED'} · ${(v.odo / 1000).toFixed(2)} KM · SOC ${v.soc.toFixed(0)}%`);
  }
}
