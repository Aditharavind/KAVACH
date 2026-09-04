// ─── KAVACH-07 forward/rear camera simulation (three.js) ──────────────
// Procedural field-test environment: rolling scrub terrain, an unpaved
// track, rocks, vegetation and range infrastructure — rendered from the
// vehicle's mast camera and pushed through a sensor post-process pass.

import * as THREE from 'three';
import {
  terrainH, track, ensureTrack, distToTrack, hash, noise2, clamp, rad,
} from './util.js';

const HAZE = new THREE.Color(0x9fa08b);
const CELL = 36;
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const CELL_R = 7;

// stencilled hull marking, drawn once into a canvas texture
function hullPlateTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 128);
  g.fillStyle = 'rgba(20,23,18,0.82)';
  g.fillRect(6, 18, 500, 92);
  g.strokeStyle = 'rgba(196,201,184,0.5)';
  g.lineWidth = 3;
  g.strokeRect(6, 18, 500, 92);
  g.fillStyle = '#C9CEBC';
  g.font = 'bold 58px "Rajdhani", "Barlow Semi Condensed", sans-serif';
  g.textBaseline = 'middle';
  g.fillText('KAVACH-07', 26, 66);
  g.fillStyle = '#E08B36';
  g.fillRect(400, 34, 84, 12);
  g.fillStyle = 'rgba(201,206,188,0.75)';
  g.font = '24px "IBM Plex Mono", monospace';
  g.fillText('UGV', 400, 84);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class CameraSim {
  constructor(canvas) {
    this.canvas = canvas;
    // the scene is rendered into an offscreen buffer, so MSAA on the
    // default framebuffer buys nothing; the buffer is supersampled instead
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(HAZE.getHex(), 0.0027);

    this.cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.35, 900);
    this.rig = new THREE.Group();      // vehicle-fixed frame
    this.scene.add(this.rig);
    this.rig.add(this.cam);

    this.time = 0;
    this.mode = 'cam1';
    this.terrainCenter = new THREE.Vector2(1e6, 1e6);
    this.cellKey = '';
    this.roadStart = -1;

    this.#lights();
    this.#sky();
    this.#terrain();
    this.#road();
    this.#props();
    this.#hull();
    this.#dust();
    this.#post();
  }

  // ── lighting: hazy afternoon, sun low in the west ──
  #lights() {
    const sun = new THREE.DirectionalLight(0xffe4bd, 2.9);
    sun.position.set(-72, 33, 26);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -42; c.right = 42; c.top = 42; c.bottom = -42; c.near = 1; c.far = 220;
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.12;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    this.scene.add(new THREE.HemisphereLight(0x9fbdd8, 0x6b5f3c, 0.62));
    this.scene.add(new THREE.AmbientLight(0x6a6a5c, 0.22));
  }

  // ── gradient sky dome with a hazy sun ──
  #sky() {
    const g = new THREE.SphereGeometry(700, 32, 20);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: { value: new THREE.Vector3(-72, 33, 26).normalize() } },
      vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vP; uniform vec3 uSun;
        float h1(float x){ return fract(sin(x * 12.9898) * 43758.5453); }
        float n1(float x){ float i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f); return mix(h1(i), h1(i+1.0), f); }
        float ridge(float a, float sc){
          return n1(a*sc)*0.6 + n1(a*sc*2.3 + 7.0)*0.28 + n1(a*sc*5.1 + 3.0)*0.12;
        }
        void main(){
          float h = clamp(vP.y*1.55, -0.2, 1.0);
          vec3 low  = vec3(0.760, 0.744, 0.660);
          vec3 mid  = vec3(0.560, 0.618, 0.660);
          vec3 high = vec3(0.318, 0.436, 0.572);
          vec3 col = mix(low, mid, smoothstep(0.0, 0.30, h));
          col = mix(col, high, smoothstep(0.22, 0.95, h));
          float s = max(dot(normalize(vP), normalize(uSun)), 0.0);
          col += vec3(1.0,0.90,0.72) * (pow(s, 26.0)*0.50 + pow(s, 6.0)*0.09);

          // two ranges of distant hills, sunk into the afternoon haze
          float az = atan(vP.z, vP.x);
          vec3 haze = vec3(0.624, 0.628, 0.545);
          float far  = 0.004 + ridge(az, 6.0) * 0.085;
          float near = 0.001 + ridge(az + 2.1, 11.0) * 0.042;
          col = mix(col, mix(vec3(0.40,0.45,0.47), haze, 0.62), smoothstep(far + 0.0016, far - 0.0016, vP.y));
          col = mix(col, mix(vec3(0.30,0.35,0.33), haze, 0.40), smoothstep(near + 0.0012, near - 0.0012, vP.y));
          // dither, or an 8-bit gradient this wide shows banding
          col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.99,78.23))) * 43758.55) - 0.5) / 255.0;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(g, m);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  // ── recentring terrain tile ──
  #terrain() {
    const SIZE = 460, SEG = 128;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.ground.frustumCulled = false;
    this.scene.add(this.ground);
  }

  #updateTerrain(px, pz) {
    const cx = Math.round(px / 8) * 8, cz = Math.round(pz / 8) * 8;
    if (Math.abs(cx - this.terrainCenter.x) < 0.1 && Math.abs(cz - this.terrainCenter.y) < 0.1) return;
    this.terrainCenter.set(cx, cz);
    this.ground.position.set(cx, 0, cz);
    const pos = this.ground.geometry.attributes.position;
    const col = this.ground.geometry.attributes.color;
    const dry = new THREE.Color(0x9c8a5f), scrub = new THREE.Color(0x5d6b3a);
    const dust = new THREE.Color(0xb3a67e), dark = new THREE.Color(0x4a452f);
    const laterite = new THREE.Color(0x8a5f3c);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + cx, wz = pos.getZ(i) + cz;
      pos.setY(i, terrainH(wx, wz));
      // distinct ground cover rather than one averaged tone: dry ochre base
      // with scrub patches, exposed laterite and wind-blown dust
      const v = noise2(wx / 29, wz / 29) * 0.5 + 0.5;
      const w = noise2(wx / 8.5 + 40, wz / 8.5) * 0.5 + 0.5;
      const l = noise2(wx / 61 - 90, wz / 61) * 0.5 + 0.5;
      const f = noise2(wx / 2.6, wz / 2.6) * 0.5 + 0.5;
      c.copy(dry).lerp(scrub, ss(0.50, 0.80, v) * 0.92);
      c.lerp(laterite, ss(0.58, 0.84, l) * 0.75);
      c.lerp(dust, ss(0.56, 0.86, w) * 0.8);
      c.lerp(dark, ss(0.62, 0.92, 1 - v) * 0.7);
      c.multiplyScalar(0.9 + f * 0.2);          // fine grain so it never reads flat
      col.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    this.ground.geometry.computeVertexNormals();
  }

  // ── dirt track ribbon (crown, ruts, graded shoulders) ──
  #road() {
    // cross-section of a graded dirt track: shoulder, verge, rut, crown
    this.roadCols = [
      { off: -3.6, dy: -0.42, c: 0x6f6549 },
      { off: -2.05, dy: 0.01, c: 0x8e8261 },
      { off: -1.22, dy: 0.07, c: 0x9c9070 },
      { off: -0.76, dy: 0.02, c: 0x6b5d40 },
      { off: 0.0, dy: 0.10, c: 0xa2966f },
      { off: 0.76, dy: 0.02, c: 0x6b5d40 },
      { off: 1.22, dy: 0.07, c: 0x9c9070 },
      { off: 2.05, dy: 0.01, c: 0x8e8261 },
      { off: 3.6, dy: -0.42, c: 0x6f6549 },
    ];
    this.roadSegs = 108;
    const cols = this.roadCols.length, rows = this.roadSegs + 1;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows * cols * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(rows * cols * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rows * cols * 3), 3));
    const idx = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let cI = 0; cI < cols - 1; cI++) {
        const a = r * cols + cI, b = a + 1, cc = a + cols, d = cc + 1;
        idx.push(a, b, cc, b, d, cc);   // CCW seen from above, so normals point up
      }
    }
    g.setIndex(idx);
    this.road = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.road.receiveShadow = true;
    this.road.renderOrder = 1;
    this.road.frustumCulled = false;
    this.scene.add(this.road);
  }

  #updateRoad(trackIdx) {
    const start = Math.max(0, trackIdx - 22);
    if (start === this.roadStart) return;
    this.roadStart = start;
    ensureTrack(track.pts[Math.min(track.pts.length - 1, start + this.roadSegs)].s + 200);
    const pos = this.road.geometry.attributes.position;
    const col = this.road.geometry.attributes.color;
    const cols = this.roadCols;
    const tc = new THREE.Color();
    for (let r = 0; r <= this.roadSegs; r++) {
      const p = track.pts[Math.min(track.pts.length - 1, start + r)];
      const rx = Math.cos(p.th), rz = Math.sin(p.th);      // right-hand normal
      const wear = 0.80 + 0.34 * (noise2(p.s / 23, 4.5) * 0.5 + 0.5) + 0.1 * noise2(p.s / 5.5, 1.5);
      for (let cI = 0; cI < cols.length; cI++) {
        const cdef = cols[cI];
        const i = r * cols.length + cI;
        const wobble = noise2(p.s / 11 + cI * 3.3, 9.1) * 0.13;
        const vx = p.x + rx * (cdef.off + wobble), vz = p.z + rz * (cdef.off + wobble);
        // grade the surface: mostly the smoothed route profile, blended into
        // local ground so the ribbon never sinks under the terrain mesh
        const y = terrainH(vx, vz) * 0.42 + p.y * 0.58 + cdef.dy + 0.06;
        pos.setXYZ(i, vx, y, vz);
        tc.setHex(cdef.c).multiplyScalar(wear);
        col.setXYZ(i, tc.r, tc.g, tc.b);
      }
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    this.road.geometry.computeVertexNormals();
    this.road.geometry.computeBoundingSphere();
  }

  // ── instanced scatter: rocks, scrub, grass, structures, range posts ──
  #props() {
    const rock = new THREE.IcosahedronGeometry(1, 0);
    const rp = rock.attributes.position;
    for (let i = 0; i < rp.count; i++) {
      const j = 1 + 0.34 * noise2(rp.getX(i) * 3.1 + i, rp.getZ(i) * 2.7);
      rp.setXYZ(i, rp.getX(i) * j, rp.getY(i) * j * 0.72, rp.getZ(i) * j);
    }
    rock.computeVertexNormals();

    const mk = (geo, count, matOpts, shadow = true) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(matOpts), count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = shadow; m.receiveShadow = shadow;
      m.count = 0;
      this.scene.add(m);
      return m;
    };
    this.iRock = mk(rock, 620, { vertexColors: false, color: 0xffffff });
    this.iBush = mk(new THREE.IcosahedronGeometry(1, 1), 620, { color: 0xffffff, flatShading: true });
    this.iGrass = mk(new THREE.ConeGeometry(0.2, 1, 4, 1), 2200, { color: 0xffffff, flatShading: true }, false);
    this.iBox = mk(new THREE.BoxGeometry(1, 1, 1), 90, { color: 0xffffff });
    this.iTank = mk(new THREE.CylinderGeometry(1, 1, 1, 12), 60, { color: 0xffffff });
    this.iTrunk = mk(new THREE.CylinderGeometry(0.09, 0.16, 1, 6), 150, { color: 0xffffff });
    this.iCanopy = mk(new THREE.IcosahedronGeometry(1, 1), 300, { color: 0xffffff, flatShading: true });
    this.iPost = mk(new THREE.CylinderGeometry(0.055, 0.075, 1, 6), 120, { color: 0xffffff });
    this.iCap = mk(new THREE.BoxGeometry(0.22, 0.16, 0.05), 120, { color: 0xffffff });
    this.allProps = [this.iRock, this.iBush, this.iGrass, this.iBox, this.iTank,
      this.iTrunk, this.iCanopy, this.iPost, this.iCap];
    for (const m of this.allProps) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count * 3), 3);
    }
  }

  #updateProps(px, pz) {
    const cx = Math.floor(px / CELL), cz = Math.floor(pz / CELL);
    const key = `${cx},${cz}`;
    if (key === this.cellKey) return;
    this.cellKey = key;

    const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
    const E = new THREE.Euler(), S = new THREE.Vector3(), P = new THREE.Vector3();
    const C = new THREE.Color();
    const n = { rock: 0, bush: 0, grass: 0, box: 0, tank: 0, post: 0, trunk: 0, canopy: 0 };
    const put = (mesh, k, x, y, z, sx, sy, sz, ry, col, rx = 0) => {
      if (n[k] >= mesh.instanceMatrix.count) return false;
      E.set(rx, ry, 0); Q.setFromEuler(E); P.set(x, y, z); S.set(sx, sy, sz);
      M.compose(P, Q, S);
      mesh.setMatrixAt(n[k], M);
      C.setHex(col); mesh.instanceColor.setXYZ(n[k], C.r, C.g, C.b);
      n[k]++;
      return true;
    };

    for (let a = -CELL_R; a <= CELL_R; a++) {
      for (let b = -CELL_R; b <= CELL_R; b++) {
        const gx = cx + a, gz = cz + b;
        const base = { x: gx * CELL, z: gz * CELL };
        const near = Math.hypot(a, b) <= 3;

        for (let k = 0; k < 3; k++) {
          const hx = hash(gx, gz, 11 + k), hz = hash(gx, gz, 31 + k), hs = hash(gx, gz, 51 + k);
          const x = base.x + hx * CELL, z = base.z + hz * CELL;
          const d = distToTrack(x, z);
          if (d < 2.4) continue;
          const s = 0.22 + hs * hs * 1.5 * (d < 8 ? 0.5 : 1);
          put(this.iRock, 'rock', x, terrainH(x, z) + s * 0.28, z, s * (0.8 + hx * 0.6), s * 0.8, s * (0.8 + hz * 0.5),
            hs * 6.28, [0x8a8271, 0x7a7566, 0x9a8f78, 0x6d6a5c][Math.floor(hs * 4)]);
        }
        for (let k = 0; k < 3; k++) {
          const hx = hash(gx, gz, 71 + k), hz = hash(gx, gz, 91 + k), hs = hash(gx, gz, 111 + k);
          const x = base.x + hx * CELL, z = base.z + hz * CELL;
          if (distToTrack(x, z) < 3.2) continue;
          const s = 0.5 + hs * 1.05;
          put(this.iBush, 'bush', x, terrainH(x, z) + s * 0.42, z, s, s * 0.72, s, hs * 6.28,
            [0x4e5a33, 0x5d6338, 0x414c2c, 0x6a6b3c][Math.floor(hx * 4)]);
        }
        if (near) {
          for (let k = 0; k < 9; k++) {
            const hx = hash(gx, gz, 131 + k), hz = hash(gx, gz, 151 + k), hs = hash(gx, gz, 171 + k);
            const x = base.x + hx * CELL, z = base.z + hz * CELL;
            if (distToTrack(x, z) < 2.6) continue;
            const s = 0.16 + hs * 0.2;
            put(this.iGrass, 'grass', x, terrainH(x, z) + s * 0.62, z, 0.8 + hx * 0.5, s * 1.35, 0.8 + hz * 0.5,
              hs * 6.28, [0x6d7040, 0x5e6a35, 0x7a7a4a][Math.floor(hz * 3)], (hx - 0.5) * 0.22);
          }
        }
        // thorn trees, in loose groups, never on the driving surface
        for (let k = 0; k < 2; k++) {
          const hx = hash(gx, gz, 301 + k), hz = hash(gx, gz, 331 + k), hs = hash(gx, gz, 361 + k);
          if (hs < 0.42) continue;
          const x = base.x + hx * CELL, z = base.z + hz * CELL;
          if (distToTrack(x, z) < 5.5) continue;
          const y = terrainH(x, z);
          const ht = 2.6 + hs * 3.4;
          put(this.iTrunk, 'trunk', x, y + ht * 0.5, z, 1, ht, 1, hs * 6.28, 0x4b4034);
          const cw = 1.1 + hs * 1.5;
          put(this.iCanopy, 'canopy', x, y + ht * 0.94, z, cw, cw * 0.6, cw, hs * 6.28,
            [0x4a5a30, 0x556134, 0x3f4c28][Math.floor(hx * 3)]);
          put(this.iCanopy, 'canopy', x + (hx - 0.5) * 1.2, y + ht * 0.78, z + (hz - 0.5) * 1.2,
            cw * 0.72, cw * 0.5, cw * 0.72, hz * 6.28, 0x424e29);
        }
        // field infrastructure, kept well clear of the track
        const hf = hash(gx, gz, 211);
        if (hf > 0.86) {
          const x = base.x + hash(gx, gz, 213) * CELL, z = base.z + hash(gx, gz, 217) * CELL;
          if (distToTrack(x, z) > 26) {
            const y = terrainH(x, z);
            if (hf > 0.955) {
              put(this.iTank, 'tank', x, y + 3.6, z, 3.1, 7.2, 3.1, 0, 0x8d8f88);
              put(this.iBox, 'box', x, y + 0.3, z, 7, 0.6, 7, 0, 0x6f6f64);
            } else {
              const w = 5 + hash(gx, gz, 219) * 9;
              put(this.iBox, 'box', x, y + 1.5, z, w, 3, 6 + hash(gx, gz, 221) * 4, hash(gx, gz, 223) * 3, 0x767567);
            }
          }
        }
      }
    }

    // 100 m range markers along the track
    for (const p of track.pts) {
      if (Math.abs(p.s % 100) > 1) continue;
      if (Math.hypot(p.x - px, p.z - pz) > CELL * CELL_R) continue;
      const rx = Math.cos(p.th), rz = Math.sin(p.th);
      const x = p.x + rx * 3.4, z = p.z + rz * 3.4, y = terrainH(x, z);
      put(this.iPost, 'post', x, y + 0.8, z, 1, 1.6, 1, -p.th, 0xb9b5a4);
      put(this.iCap, 'post', x, y + 1.5, z, 1, 1, 1, -p.th, p.s % 500 === 0 ? 0xe08b36 : 0xd8ddd1);
    }

    this.iRock.count = n.rock; this.iBush.count = n.bush; this.iGrass.count = n.grass;
    this.iBox.count = n.box; this.iTank.count = n.tank;
    this.iTrunk.count = n.trunk; this.iCanopy.count = n.canopy;
    this.iPost.count = n.post; this.iCap.count = n.post;
    for (const m of this.allProps) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }

  // ── the KAVACH-07 hull, seen from its own cameras ──
  #hull() {
    const g = new THREE.Group();
    const graphite = new THREE.MeshPhongMaterial({ color: 0x5a6053, shininess: 16, specular: 0x2a2d24 });
    const olive = new THREE.MeshPhongMaterial({ color: 0x6b7350, shininess: 10 });
    const dark = new THREE.MeshPhongMaterial({ color: 0x3a3f36, shininess: 6 });
    const saff = new THREE.MeshPhongMaterial({ color: 0xb9762f, shininess: 20 });

    const add = (geo, mat, x, y, z, ry = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.y = ry;
      m.castShadow = true; m.receiveShadow = true;
      g.add(m); return m;
    };
    // deck plates fore and aft (visible bottom-of-frame on both cameras)
    add(new THREE.BoxGeometry(1.32, 0.14, 1.15), graphite, 0, 0.74, -1.05);
    add(new THREE.BoxGeometry(1.32, 0.14, 1.2), graphite, 0, 0.74, 0.95);
    add(new THREE.BoxGeometry(1.5, 0.5, 1.6), olive, 0, 0.5, 0);
    // track guards
    add(new THREE.BoxGeometry(0.3, 0.22, 2.5), dark, 0.72, 0.62, 0);
    add(new THREE.BoxGeometry(0.3, 0.22, 2.5), dark, -0.72, 0.62, 0);
    // stowage + electronics boxes
    add(new THREE.BoxGeometry(0.5, 0.22, 0.4), graphite, -0.35, 0.9, 0.85);
    add(new THREE.BoxGeometry(0.34, 0.18, 0.34), dark, 0.42, 0.88, 0.9);
    // identity stripe + rear marker, kept small
    add(new THREE.BoxGeometry(0.42, 0.03, 0.04), saff, 0, 0.815, -1.585);
    add(new THREE.BoxGeometry(0.14, 0.045, 0.04), saff, 0.5, 0.855, 1.52);
    // painted hull plate, read by the mast camera
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.60, 0.155),
      new THREE.MeshBasicMaterial({ map: hullPlateTexture(), transparent: true }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(0, 0.822, -1.44);
    g.add(plate);
    // mast + whip antenna
    add(new THREE.CylinderGeometry(0.05, 0.06, 0.5), dark, 0, 1.0, -0.5);
    add(new THREE.CylinderGeometry(0.012, 0.02, 1.1), dark, 0.56, 1.3, 0.3);
    this.rig.add(g);
    this.hull = g;
  }

  // ── airborne dust, wrapped around the camera ──
  #dust() {
    const N = 420, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 90;
      pos[i * 3 + 1] = Math.random() * 9;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 90;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xc9bfa4, size: 0.09, transparent: true, opacity: 0.42, depthWrite: false, sizeAttenuation: true,
    }));
    this.scene.add(this.dust);
  }

  // ── sensor post-process: vignette, scanlines, grain, thermal palette ──
  #post() {
    // plain (non-multisampled) target: multisampled targets fail to resolve
    // on some software/ANGLE drivers and hand back an empty texture
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
    });
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;   // keeps the feed's gamma correct
    this.ss = 1.25;                                       // supersample factor
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        uTime: { value: 0 },
        uThermal: { value: 0 },
        uGain: { value: 1 },
        uAspect: { value: 1.7 },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        varying vec2 vUv; uniform sampler2D tDiffuse;
        uniform float uTime, uThermal, uGain, uAspect;
        float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        // the sampler hands back linear light; the panel wants display space
        vec3 toDisplay(vec3 c){
          c = clamp(c, 0.0, 1.0);
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
        }
        vec3 thermalRamp(float t){
          vec3 c = mix(vec3(0.03,0.03,0.09), vec3(0.22,0.06,0.36), smoothstep(0.00,0.30,t));
          c = mix(c, vec3(0.72,0.16,0.18), smoothstep(0.26,0.56,t));
          c = mix(c, vec3(0.97,0.63,0.13), smoothstep(0.52,0.80,t));
          c = mix(c, vec3(1.00,0.97,0.86), smoothstep(0.78,1.00,t));
          return c;
        }
        void main(){
          vec2 uv = vUv;
          vec2 d = uv - 0.5;
          float r2 = dot(d, d);
          // a trace of lens distortion and chromatic split, as a real feed has
          vec2 duv = uv + d * r2 * 0.03;
          float ca = 0.0010 + uThermal * 0.0006;
          vec3 lin;
          lin.r = texture2D(tDiffuse, duv + d * ca).r;
          lin.g = texture2D(tDiffuse, duv).g;
          lin.b = texture2D(tDiffuse, duv - d * ca).b;
          vec3 col = toDisplay(lin);

          if (uThermal > 0.5) {
            // an LWIR imager sees heat, not brightness: open sky is the
            // coldest thing in frame, sun-baked ground the warmest, and
            // vegetation sits well below bare soil
            float lum = dot(col, vec3(0.34, 0.5, 0.16));
            float sky = smoothstep(-0.015, 0.025, col.b - col.r);   // haze is warm-hued; only sky goes cool
            float veg = smoothstep(0.01, 0.16, col.g - col.r) * (1.0 - sky);
            float t = pow(lum, 0.92) * 1.02 + (0.40 - uv.y) * 0.13;
            t = mix(t, 0.05 + lum * 0.07, sky);
            t -= veg * 0.30;
            t += (rnd(uv * 640.0 + uTime) - 0.5) * 0.05;
            t += (rnd(vec2(3.1, floor(uv.y * 240.0) + uTime)) - 0.5) * 0.02;  // line noise
            col = thermalRamp(clamp(t, 0.0, 1.0));
            col *= 0.95 + 0.05 * sin(uv.y * 620.0);
          }

          col *= uGain;
          col *= 1.0 - smoothstep(0.16, 0.80, r2) * 0.42;                      // vignette
          col *= 1.0 - 0.035 * step(1.0, mod(gl_FragCoord.y, 2.0));            // scanlines
          col += (rnd(uv * 900.0 + fract(uTime)) - 0.5) * (0.018 + uThermal * 0.030);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    quad.frustumCulled = false;          // it *is* the screen; never cull it
    this.quadScene.add(quad);
  }

  setMode(mode) { this.mode = mode; }

  resize(w, h) {
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h, false);
    const dpr = Math.min(devicePixelRatio, 1.75);
    const ss = dpr > 1.4 ? 1 : this.ss;
    this.rt.setSize(Math.floor(w * dpr * ss), Math.floor(h * dpr * ss));
    this.cam.aspect = w / h;
    this.postMat.uniforms.uAspect.value = w / h;
    this.cam.updateProjectionMatrix();
  }

  // ── per-frame update, driven entirely by the vehicle state ──
  update(v, dt) {
    this.time += dt;
    const y = terrainH(v.x, v.z);
    this.rig.position.set(v.x, y, v.z);
    this.rig.rotation.set(0, -rad(v.hdg), 0);
    // suspension: terrain attitude plus load-dependent chassis motion
    const sp = Math.abs(v.speed);
    const shake = sp > 0.2 ? 1 : 0;
    const bob = Math.sin(this.time * (5.5 + sp * 0.32)) * 0.011 * shake * (0.4 + sp / 24);
    const sway = Math.sin(this.time * 3.1) * 0.006 * shake * (0.4 + sp / 30);
    this.hull.rotation.x = rad(v.pitch * 0.6);
    this.hull.rotation.z = rad(-v.roll * 0.6);

    const rear = this.mode === 'cam2';
    const therm = this.mode === 'thermal';
    this.cam.fov = rear ? 76 : therm ? 46 : 62;
    this.cam.position.set(0, rear ? 1.28 : 1.42, rear ? 0.18 : -0.62);
    this.cam.rotation.set(
      rad(v.pitch * 0.85 + (rear ? -8 : -4.5)) + bob,
      rear ? Math.PI : 0,
      rad(-v.roll * 0.9) + sway,
    );
    this.cam.updateProjectionMatrix();

    this.#updateTerrain(v.x, v.z);
    this.#updateRoad(v.trackIdx);
    this.#updateProps(v.x, v.z);

    this.sun.position.set(v.x - 72, y + 33, v.z + 26);
    this.sun.target.position.set(v.x, y, v.z);
    this.dust.position.set(Math.round(v.x / 90) * 90, 0, Math.round(v.z / 90) * 90);
    this.sky.position.set(v.x, y + 1.3, v.z);   // eye level, so the horizon lands at vP.y = 0

    this.postMat.uniforms.uTime.value = this.time;
    this.postMat.uniforms.uThermal.value = therm ? 1 : 0;
    this.postMat.uniforms.uGain.value = therm ? 1.05 : rear ? 0.94 : 1.0;
  }

  render() {
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);
  }
}
