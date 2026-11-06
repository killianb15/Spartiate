import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// =====================================================================
//  Utilitaires
// =====================================================================
const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAng = (a, b, t) => a + wrap(b - a) * t;
const TAU = Math.PI * 2;
const S = 1.5;            // échelle des décors (1 tuile Kenney = 1.5 unités)
const FIGHT_R = 7;        // rayon de la zone de combat
const CAM_R = 9.2;        // la caméra reste à l'intérieur des murs
const ROUND_TIME = 60;
const v1 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();

// En ligne : l'hôte simule tout, et enregistre les effets (sons, particules, animations…)
// pour que l'invité les rejoue à l'identique.
const net = { ws: null, role: null, me: 0, live: false, mute: false, ev: [], code: '', urls: [], peer: false, peerKind: null, presses: [] };
function rec(k, a) { if (net.live && net.role === 'host' && !net.mute) net.ev.push([k, a]); }

// =====================================================================
//  Modèles
// =====================================================================
const A = 'assets/arena/Models/GLB format/';
const D = 'assets/dungeon/Models/GLB format/';
const FILES = {
  soldier: A + 'character-soldier.glb', human: D + 'character-human.glb', orc: D + 'character-orc.glb',
  sword: D + 'weapon-sword.glb', shield: D + 'shield-round.glb',
  a_floor: A + 'floor.glb', a_floorD: A + 'floor-detail.glb', a_wall: A + 'wall.glb', a_wallGate: A + 'wall-gate.glb',
  a_column: A + 'column.glb', a_columnD: A + 'column-damaged.glb', a_banner: A + 'banner.glb', a_block: A + 'block.glb',
  a_statue: A + 'statue.glb', a_tree: A + 'tree.glb', a_trophy: A + 'trophy.glb', a_rack: A + 'weapon-rack.glb',
  a_bricks: A + 'bricks.glb',
  d_floor: D + 'floor.glb', d_floorD: D + 'floor-detail.glb', d_wall: D + 'wall.glb', d_wallOpen: D + 'wall-opening.glb',
  d_gate: D + 'gate.glb', d_barrel: D + 'barrel.glb', d_chest: D + 'chest.glb', d_coin: D + 'coin.glb', d_trap: D + 'trap.glb',
  d_column: D + 'column.glb', d_wood: D + 'wood-structure.glb', d_support: D + 'wood-support.glb', d_rocks: D + 'rocks.glb',
  d_stones: D + 'stones.glb', d_banner: D + 'banner.glb', d_pot: D + 'pot.glb',
};
const G = {};

function inst(key, s = S) {
  const o = SkeletonUtils.clone(G[key].scene);
  o.scale.setScalar(s);
  o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  return o;
}

const CHARS = { soldier: 'Gladiateur', human: 'Mirmillon', orc: 'Orc' };

// =====================================================================
//  Rendu
// =====================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 260);
camera.position.set(0, 3, 9);
const camLook = new THREE.Vector3(0, 1, 0);
const world = new THREE.Group();
scene.add(world);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// =====================================================================
//  Sons (synthétisés)
// =====================================================================
let AC = null, master = null, noiseBuf = null, soundOn = true;
function ac() {
  if (!AC) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain(); master.gain.value = 0.45; master.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate * 3, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (AC.state === 'suspended') AC.resume();
}
function tone(f, dur, { type = 'sine', vol = 0.3, to = null, delay = 0, attack = 0.005 } = {}) {
  if (!soundOn || !AC) return;
  const t0 = AC.currentTime + delay;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
}
function noise(dur, { freq = 1000, q = 1, type = 'bandpass', vol = 0.3, to = null, delay = 0, attack = 0.005 } = {}) {
  if (!soundOn || !AC) return;
  const t0 = AC.currentTime + delay;
  const s = AC.createBufferSource(); s.buffer = noiseBuf;
  const fl = AC.createBiquadFilter(); fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(freq, t0);
  if (to) fl.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = AC.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(fl).connect(g).connect(master);
  s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + 0.05);
}
const sfx = {
  swing: () => noise(0.16, { freq: 900, to: 3200, q: 1.5, vol: 0.22 }),
  heavy: () => noise(0.32, { freq: 300, to: 1400, q: 1, vol: 0.3 }),
  hit: () => { noise(0.14, { freq: 700, type: 'lowpass', vol: 0.7 }); tone(150, 0.16, { type: 'square', vol: 0.16, to: 55 }); },
  clang: () => { tone(1250, 0.35, { type: 'triangle', vol: 0.18 }); tone(1870, 0.25, { type: 'triangle', vol: 0.1 }); noise(0.06, { freq: 4200, vol: 0.25 }); },
  parry: () => { tone(1600, 0.55, { vol: 0.2 }); tone(2400, 0.5, { vol: 0.12, delay: 0.02 }); tone(800, 0.12, { type: 'triangle', vol: 0.2 }); },
  brk: () => { noise(0.4, { freq: 320, type: 'lowpass', vol: 0.8 }); tone(90, 0.3, { type: 'sawtooth', vol: 0.18, to: 40 }); tone(700, 0.22, { type: 'square', vol: 0.07, to: 180 }); },
  jump: () => tone(260, 0.12, { type: 'triangle', vol: 0.1, to: 480 }),
  land: () => noise(0.1, { freq: 260, type: 'lowpass', vol: 0.25 }),
  dodge: () => noise(0.18, { freq: 1800, to: 600, q: 1.2, vol: 0.15 }),
  roll: () => { noise(0.3, { freq: 500, to: 1600, q: 0.8, vol: 0.22 }); noise(0.15, { freq: 240, type: 'lowpass', vol: 0.2, delay: 0.3 }); },
  ko: () => { tone(220, 0.9, { type: 'sawtooth', vol: 0.14, to: 55 }); noise(0.6, { freq: 200, type: 'lowpass', vol: 0.6 }); },
  gong: () => { tone(196, 2.2, { vol: 0.25 }); tone(294, 1.8, { vol: 0.1 }); tone(392, 1.2, { vol: 0.05 }); noise(0.3, { freq: 2500, vol: 0.05 }); },
  cheer: (v = 1) => { noise(1.7, { freq: 1100, q: 0.6, vol: 0.13 * v, attack: 0.3 }); noise(1.5, { freq: 2300, q: 0.8, vol: 0.06 * v, attack: 0.25 }); },
  thunder: (d) => { noise(3, { freq: 160, type: 'lowpass', vol: 0.9, attack: 0.05, delay: d }); noise(0.5, { freq: 900, type: 'lowpass', vol: 0.4, delay: d }); },
  coin: () => { tone(1320, 0.12, { type: 'square', vol: 0.05 }); tone(1760, 0.2, { type: 'square', vol: 0.05, delay: 0.07 }); },
};
for (const k of Object.keys(sfx)) { const f = sfx[k]; sfx[k] = (...a) => { rec('sfx', [k, ...a]); f(...a); }; }

// =====================================================================
//  Particules, anneaux, textes
// =====================================================================
const PMAX = 900;
const pMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), PMAX);
pMesh.frustumCulled = false;
pMesh.setColorAt(0, new THREE.Color());
pMesh.count = 0;
scene.add(pMesh);
const parts = [];
const dummy = new THREE.Object3D();

// o.dir : direction privilégiée {x, z}
function emit(x, y, z, n, o = {}) {
  rec('emit', [x, y, z, n, o]);
  const colors = Array.isArray(o.color) ? o.color : [o.color ?? 0xffffff];
  for (let i = 0; i < n; i++) {
    if (parts.length >= PMAX) parts.shift();
    const sp = o.speed ?? 3, a = Math.random() * TAU, life = (o.life ?? 0.6) * rand(0.6, 1);
    const dx = o.dir ? o.dir.x * sp * 0.8 : 0, dz = o.dir ? o.dir.z * sp * 0.8 : 0;
    parts.push({
      x: x + rand(-1, 1) * (o.spread ?? 0), y: y + rand(-1, 1) * (o.spread ?? 0), z: z + rand(-1, 1) * (o.spread ?? 0),
      vx: Math.cos(a) * sp * rand(0.2, 1) + dx,
      vy: (o.up ?? 2) * rand(0.4, 1.2),
      vz: Math.sin(a) * sp * rand(0.2, 1) + dz,
      life, max: life, size: (o.size ?? 0.08) * rand(0.6, 1.3), grav: o.grav ?? 9, drag: o.drag ?? 0,
      col: new THREE.Color(pick(colors)), rot: rand(0, 6), spin: rand(-8, 8),
    });
  }
}
function updateParticles(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    p.vy -= p.grav * dt;
    const dr = Math.exp(-p.drag * dt);
    p.vx *= dr; p.vz *= dr; if (p.grav < 3) p.vy *= dr;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.rot += p.spin * dt;
    if (p.y < 0.03 && p.grav > 0) { p.y = 0.03; p.vy *= -0.3; p.vx *= 0.5; p.vz *= 0.5; p.spin *= 0.5; }
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(p.rot, p.rot * 0.7, 0);
    dummy.scale.setScalar(p.size * Math.min(1, (p.life / p.max) * 2.5));
    dummy.updateMatrix();
    pMesh.setMatrixAt(i, dummy.matrix);
    pMesh.setColorAt(i, p.col);
  }
  pMesh.count = parts.length;
  pMesh.instanceMatrix.needsUpdate = true;
  pMesh.instanceColor.needsUpdate = true;
}

const ringGeo = new THREE.RingGeometry(0.82, 1, 48);
const rings = [];
// anneau d'onde de choc ; face à la caméra sauf s'il est posé au sol
function ring(x, y, z, color, maxS = 1.6, life = 0.35, flat = false, opacity = 1) {
  rec('ring', [x, y, z, color, maxS, life, flat, opacity]);
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
  m.position.set(x, y, z);
  if (flat) m.rotation.x = -Math.PI / 2;
  else m.quaternion.copy(camera.quaternion);
  scene.add(m);
  rings.push({ m, t: 0, life, maxS, op: opacity });
}
function updateRings(dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt;
    const k = r.t / r.life;
    if (k >= 1) { scene.remove(r.m); r.m.material.dispose(); rings.splice(i, 1); continue; }
    r.m.scale.setScalar(0.1 + r.maxS * (1 - (1 - k) * (1 - k)));
    r.m.material.opacity = (1 - k) * r.op;
  }
}

function pop(text, x, y, z, cls = '') {
  rec('pop', [text, x, y, z, cls]);
  const d = document.createElement('div');
  d.className = 'pop ' + cls;
  d.textContent = text;
  const v = v1.set(x, y, z).project(camera);
  d.style.left = ((v.x + 1) / 2 * innerWidth) + 'px';
  d.style.top = ((1 - v.y) / 2 * innerHeight) + 'px';
  $('pops').appendChild(d);
  setTimeout(() => d.remove(), 1000);
}
let annT = 0;
function announce(text, cls = '', dur = 1.2) {
  rec('announce', [text, cls, dur]);
  const a = $('announce');
  a.textContent = text;
  a.className = '';
  void a.offsetWidth;
  a.style.animationDuration = dur + 's';
  a.className = 'show ' + cls;
  clearTimeout(annT);
  annT = setTimeout(() => { a.className = ''; }, dur * 1000);
}
let flashV = 0;
function screenFlash(v) { flashV = Math.max(flashV, v); }

// =====================================================================
//  Arènes : aides
// =====================================================================
let updaters = [];
let crowd = null;
let arenaHooks = {};
let curArena = null;

function P(key, x, y, z, ry = 0, s = S, parent = world) {
  const o = inst(key, s);
  o.position.set(x, y, z);
  o.rotation.y = ry;
  parent.add(o);
  return o;
}
// objet posé sur un cercle de rayon r à l'angle a, tourné vers le centre
function PR(key, r, a, y = 0, s = S, turn = 0) {
  return P(key, Math.sin(a) * r, y, Math.cos(a) * r, a + Math.PI + turn, s);
}
function skyTex(stops) {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256);
  stops.forEach(([p, col]) => gr.addColorStop(p, col));
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function lights(sky, gnd, hi, sunC, si, pos) {
  const hemi = new THREE.HemisphereLight(sky, gnd, hi);
  world.add(hemi);
  const sun = new THREE.DirectionalLight(sunC, si);
  sun.position.set(...pos);
  sun.castShadow = true;
  const c = sun.shadow.camera;
  c.left = -16; c.right = 16; c.top = 16; c.bottom = -16; c.near = 0.5; c.far = 80;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  world.add(sun, sun.target);
  return { hemi, sun };
}
function ground(color) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), new THREE.MeshStandardMaterial({ color, roughness: 1 }));
  m.rotation.x = -Math.PI / 2; m.position.y = -0.02; m.receiveShadow = true;
  world.add(m);
}
// dallage rond (ou carré) centré sur l'arène
function tiles(a, b, chance, R, square = false) {
  for (let x = -10.5; x <= 10.51; x += S)
    for (let z = -10.5; z <= 10.51; z += S) {
      if (square ? (Math.abs(x) > R || Math.abs(z) > R) : Math.hypot(x, z) > R + 0.8) continue;
      P(Math.random() < chance ? b : a, x, 0, z, ((Math.random() * 4) | 0) * Math.PI / 2);
    }
}
function sway(o, amp, freq, axis = 'z') {
  const base = o.rotation[axis], ph = rand(0, 10);
  updaters.push((dt, t) => { o.rotation[axis] = base + Math.sin(t * freq + ph) * amp + Math.sin(t * freq * 2.3 + ph) * amp * 0.3; });
}
function animProp(key, x, y, z, ry, s, clip, ts = 1) {
  const o = P(key, x, y, z, ry, s);
  const mx = new THREE.AnimationMixer(o);
  const act = mx.clipAction(THREE.AnimationClip.findByName(G[key].animations, clip));
  act.timeScale = ts;
  act.play();
  mx.update(rand(0, 2));
  updaters.push((dt) => mx.update(dt));
  return { o, act };
}

const flameGeo = new THREE.ConeGeometry(1, 1, 7);
flameGeo.translate(0, 0.5, 0);
const flameMats = [0xff4a1c, 0xff9a2e, 0xffe27a].map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.92, toneMapped: false }));
function fire(parent, x, y, z, s = 1, lightI = 9) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const cones = flameMats.map((m, i) => {
    const c = new THREE.Mesh(flameGeo, m);
    c.scale.set(0.17 * s * (1 - i * 0.27), 0.45 * s * (1 - i * 0.22), 0.17 * s * (1 - i * 0.27));
    g.add(c);
    return c;
  });
  const base = cones.map((c) => c.scale.clone());
  let light = null;
  if (lightI > 0) {
    light = new THREE.PointLight(0xff8a3a, lightI, 9 * s, 1.4);
    light.position.y = 0.4 * s;
    g.add(light);
  }
  let emberT = 0;
  const ph = rand(0, 10);
  updaters.push((dt, t) => {
    cones.forEach((c, i) => {
      const f = 1 + Math.sin(t * (13 + i * 4) + ph + i) * 0.16 + Math.sin(t * 27 + i * 2) * 0.08;
      c.scale.set(base[i].x * (1.5 - f * 0.5), base[i].y * f, base[i].z * (1.5 - f * 0.5));
      c.rotation.y = t * (2 + i);
      c.position.x = Math.sin(t * 9 + i) * 0.015 * s;
    });
    if (light) light.intensity = lightI * (0.82 + Math.sin(t * 17 + ph) * 0.1 + Math.random() * 0.14);
    emberT -= dt;
    if (emberT < 0) {
      emberT = rand(0.08, 0.3);
      g.getWorldPosition(v1);
      emit(v1.x, v1.y + 0.3 * s, v1.z, 1, { color: [0xffa040, 0xffd060], speed: 0.4, up: 1.6, size: 0.045, life: 1.3, grav: -0.4, spread: 0.1 * s });
    }
  });
  return g;
}
const ironMat = new THREE.MeshStandardMaterial({ color: 0x3a3230, metalness: 0.6, roughness: 0.5 });
const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b4426, roughness: 0.9 });
function brazier(x, z, baseKey = 'a_columnD', baseS = 1.1, lightI = 10) {
  const h = (baseKey === 'd_barrel' ? 0.48 : 0.72) * baseS;
  P(baseKey, x, 0, z, 0, baseS);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.2, 0.2, 10), ironMat);
  bowl.position.set(x, h + 0.08, z); bowl.castShadow = true;
  world.add(bowl);
  fire(world, x, h + 0.16, z, 1.2, lightI);
}
// torche murale tournée vers ry
function torch(x, y, z, ry, lightI = 8) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  world.add(g);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.03, 0.5, 6), woodMat);
  stick.rotation.x = 0.35; g.add(stick);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.06, 0.1, 8), ironMat);
  cup.position.set(0, 0.24, 0.09); g.add(cup);
  fire(g, 0, 0.27, 0.09, 0.75, lightI);
}

// ---------- Foule ----------
class Crowd {
  constructor() { this.list = []; this.ambT = 0; }
  add(x, y, z, kinds, base = 'idle', s = 1.25, ry = 0) {
    const k = pick(kinds);
    const o = P(k, x, y, z, ry + rand(-0.25, 0.25), s);
    const mx = new THREE.AnimationMixer(o);
    const acts = {};
    for (const n of ['idle', 'emote-yes', 'sit']) acts[n] = mx.clipAction(THREE.AnimationClip.findByName(G[k].animations, n));
    acts[base].play();
    acts[base].time = rand(0, 1.3);
    const sp = { o, mx, acts, cur: base, base, baseY: y, ex: 0, ph: rand(0, 6), sit: base === 'sit' };
    this.list.push(sp);
    return sp;
  }
  // spectateur au rayon r, angle a, qui regarde le centre
  addR(r, a, y, kinds, base = 'idle', s = 1.25) {
    return this.add(Math.sin(a) * r, y, Math.cos(a) * r, kinds, base, s, a + Math.PI);
  }
  cheer(a) {
    for (const s of this.list) s.ex = Math.min(1.4, s.ex + a * rand(0.3, 1.1));
  }
  update(dt, t) {
    this.ambT -= dt;
    if (this.ambT < 0 && this.list.length) { this.ambT = rand(0.1, 0.4); pick(this.list).ex += 0.6; }
    for (const s of this.list) {
      s.ex = Math.max(0, s.ex - dt * 0.45);
      const want = s.ex > 0.4 ? 'emote-yes' : s.base;
      if (want !== s.cur) {
        const a = s.acts[want];
        a.reset().play();
        s.acts[s.cur].crossFadeTo(a, 0.2, false);
        s.cur = want;
      }
      s.mx.update(dt * (1 + s.ex * 0.4));
      const jump = s.sit && s.ex < 0.4 ? 0 : Math.abs(Math.sin(t * 8 + s.ph)) * 0.24 * Math.min(1, Math.max(0, s.ex - 0.3) * 1.6);
      s.o.position.y = s.baseY + jump;
    }
  }
  confetti(colors) {
    for (let i = 0; i < 40; i++) {
      const s = pick(this.list);
      if (!s) return;
      const p = s.o.position;
      const inward = { x: -p.x / (Math.hypot(p.x, p.z) || 1), z: -p.z / (Math.hypot(p.x, p.z) || 1) };
      emit(p.x, p.y + 1.5, p.z, 3, { color: colors, speed: 1.4, up: 3.5, size: 0.09, life: 3.4, grav: 1.6, drag: 0.7, spread: 0.2, dir: inward });
    }
  }
}
function newCrowd() {
  crowd = new Crowd();
  updaters.push((dt, t) => crowd.update(dt, t));
}

// ---------- Oiseaux / nuages ----------
function birds(count, color, y0, y1) {
  const wingGeo = new THREE.PlaneGeometry(0.42, 0.14);
  wingGeo.translate(0.21, 0, 0);
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  for (let i = 0; i < count; i++) {
    const b = new THREE.Group();
    const l = new THREE.Mesh(wingGeo, mat), r = new THREE.Mesh(wingGeo, mat);
    l.rotation.x = r.rotation.x = -Math.PI / 2;
    r.scale.x = -1;
    const wl = new THREE.Group(); wl.add(l);
    const wr = new THREE.Group(); wr.add(r);
    b.add(wl, wr);
    world.add(b);
    // les oiseaux tournent en cercle au-dessus de l'arène
    const st = { r: rand(14, 24), a: rand(0, TAU), y: rand(y0, y1), sp: rand(0.12, 0.22) * pick([-1, 1]), ph: rand(0, 6) };
    updaters.push((dt, t) => {
      st.a += st.sp * dt;
      b.position.set(Math.sin(st.a) * st.r, st.y + Math.sin(t * 1.5 + st.ph) * 0.4, Math.cos(st.a) * st.r);
      b.rotation.y = st.a + (st.sp > 0 ? Math.PI / 2 : -Math.PI / 2) - Math.PI / 2;
      const f = Math.sin(t * 11 + st.ph) * 0.7;
      wl.rotation.x = f; wr.rotation.x = f;
      wl.rotation.z = f * 0.6; wr.rotation.z = -f * 0.6;
    });
  }
}
function clouds(n, color, y0, y1) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
  const geo = new THREE.IcosahedronGeometry(1, 0);
  for (let i = 0; i < n; i++) {
    const g = new THREE.Group();
    for (let k = 0; k < 4; k++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(k * 1.5 - 2.2 + rand(-0.4, 0.4), rand(-0.3, 0.5), rand(-0.5, 0.5));
      m.scale.set(rand(1.2, 2), rand(0.8, 1.3), rand(1, 1.4));
      g.add(m);
    }
    const st = { a: rand(0, TAU), r: rand(35, 55), y: rand(y0, y1) };
    world.add(g);
    updaters.push((dt) => {
      st.a += dt * 0.008;
      g.position.set(Math.sin(st.a) * st.r, st.y, Math.cos(st.a) * st.r);
      g.rotation.y = st.a;
    });
  }
}

// ---------- Colisée rond : mur circulaire + gradins tout autour ----------
const WALL_R = 10;
const GATES = [Math.PI / 2, -Math.PI / 2];
const isGate = (a, n) => GATES.some((g) => Math.abs(wrap(a - g)) < Math.PI / n);
function roundArena(kinds, rows, density) {
  const n = Math.round(TAU * WALL_R / 1.5);
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU;
    const w = PR(isGate(a, n) ? 'a_wallGate' : 'a_wall', WALL_R, a);
    w.scale.x = S * 1.06;
  }
  newCrowd();
  for (let r = 0; r < rows; r++) {
    const rad = WALL_R + 1.3 + r * 1.25, top = 1.15 + r * 0.7;
    const nb = Math.ceil(TAU * rad / 1.5);
    for (let i = 0; i < nb; i++) {
      const b = PR('a_block', rad, i / nb * TAU, 0, 1);
      b.scale.set(1.62, top / 0.5, 1.3);
    }
    const ns = Math.floor(TAU * rad / 0.95);
    for (let i = 0; i < ns; i++) {
      if (Math.random() > density) continue;
      crowd.addR(rad + rand(-0.15, 0.15), i / ns * TAU + rand(-0.03, 0.03), top, kinds);
    }
  }
}

// =====================================================================
//  Arène 1 : le Colisée (jour)
// =====================================================================
function buildColisee() {
  scene.background = skyTex([[0, '#3d8ee0'], [0.55, '#8fc4ee'], [1, '#f7e2bd']]);
  scene.fog = new THREE.Fog(0xf3dcb8, 30, 90);
  lights(0xdff1ff, 0xc89060, 1.35, 0xfff0d2, 2.8, [8, 14, 7]);
  ground(0xd9ad74);
  tiles('a_floor', 'a_floorD', 0.22, 9.6);
  roundArena(['soldier', 'human', 'orc', 'human', 'soldier'], 3, 0.55);

  // colonnes + bannières tout autour
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * TAU;
    if (GATES.some((g) => Math.abs(wrap(a - g)) < 0.1)) continue;
    PR('a_column', 9.15, a);
    sway(PR('a_banner', 9.15, a, 1.5), 0.07, 2.1);
  }
  // statues de part et d'autre des portes
  for (const g of GATES) for (const d of [-0.2, 0.2]) PR('a_statue', 8.9, g + d, 0, 1.6);
  PR('a_rack', 8.8, 0.25, 0, 1.4);
  PR('a_rack', 8.8, Math.PI + 0.25, 0, 1.4);
  const ped = PR('a_block', 8.8, -0.25, 0, 1); ped.scale.set(0.8, 1, 0.8);
  const trophy = PR('a_trophy', 8.8, -0.25, 0.5, 1.3);
  updaters.push((dt, t) => { trophy.rotation.y = t * 0.8; });
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2;
    brazier(Math.sin(a) * 8.3, Math.cos(a) * 8.3, 'a_columnD', 1.1, 7);
  }
  clouds(14, 0xffffff, 12, 20);
  birds(7, 0x2b2b35, 9, 14);
  arenaHooks.ko = () => crowd.confetti([0xff5a5a, 0xffffff, 0xffd34a, 0xff9ad0]);
}

// =====================================================================
//  Arène 2 : le Donjon (salle carrée)
// =====================================================================
function buildDonjon() {
  scene.background = skyTex([[0, '#050409'], [1, '#1c1726']]);
  scene.fog = new THREE.Fog(0x120f19, 16, 40);
  lights(0x7070b0, 0x1a1010, 0.6, 0x8090ff, 0.5, [-5, 14, 5]);
  ground(0x2a2630);
  tiles('d_floor', 'd_floorD', 0.3, 9.75, true);
  newCrowd();

  // 4 côtés : rempart (spectateurs dessus), corniche, grand mur
  for (let side = 0; side < 4; side++) {
    const ang = side * Math.PI / 2;           // direction du mur depuis le centre
    const ox = Math.sin(ang), oz = Math.cos(ang); // vers l'extérieur
    const tx = Math.cos(ang), tz = -Math.sin(ang); // le long du mur
    const at = (d, t) => [ox * d + tx * t, oz * d + tz * t];
    for (let t = -10.5; t <= 10.51; t += S) {
      let [x, z] = at(10.5, t);
      const w = P(Math.abs(t) < 0.1 ? 'd_wallOpen' : 'd_wall', x, 0, z, ang + Math.PI);
      w.scale.y = S;
      [x, z] = at(12, t); P('d_wall', x, 0, z, ang).scale.y = 2.15;
      [x, z] = at(13.5, t); P('d_wall', x, 0, z, ang).scale.y = 3.3;
    }
    for (let t = -9.5; t <= 9.5; t += rand(1.0, 1.5)) {
      if (Math.abs(t) < 1) continue;
      const [x, z] = at(10.6, t);
      crowd.add(x, 1.65, z, ['orc', 'orc', 'human'], 'idle', 1.25, ang + Math.PI);
    }
    for (let t = -10.5; t <= 10.5; t += rand(0.85, 1.25)) {
      const [x, z] = at(12, t);
      crowd.add(x, 2.36, z, ['orc', 'orc', 'human', 'soldier'], 'idle', 1.25, ang + Math.PI);
    }
    // herse animée au centre du mur
    { const [x, z] = at(9.8, 0); animProp('d_gate', x, 0, z, ang + Math.PI, 2.0, 'open-close', rand(0.25, 0.35)); }
    // torches et bannières sur la face intérieure
    for (const t of [-4.5, 4.5]) { const [x, z] = at(9.62, t); torch(x, 1.1, z, ang + Math.PI, 7); }
    for (const t of [-2.25, 2.25, -7.5, 7.5]) {
      const [x, z] = at(10.5, t);
      sway(P('d_banner', x, 0.1, z, ang + Math.PI), 0.04, 1.4, 'x');
    }
  }

  // coins
  P('d_wood', -8.4, 0, -8.4, 0.2);
  P('d_wood', 8.4, 0, 8.4, 1.2);
  P('d_support', 8.6, 0, -6.5, Math.PI / 2);
  P('d_support', -8.6, 0, 6.5, Math.PI / 2);
  P('d_barrel', 8.6, 0, -8.4); P('d_barrel', 8.0, 0, -8.9, 1); P('d_barrel', 8.3, 0.72, -8.6, 2, 1.3);
  P('d_pot', -8.6, 0, 8.6, 0.6); P('d_pot', -8.0, 0, 8.9, 2.1, 1.2);
  P('d_rocks', -8.8, 0, -6.3, 0.3); P('d_stones', 6.4, 0, 8.8, 1.2);
  brazier(-7.2, -7.2, 'd_barrel', 1.3, 0);
  brazier(7.2, 7.2, 'd_barrel', 1.3, 0);
  brazier(7.2, -7.2, 'd_barrel', 1.3, 0);
  brazier(-7.2, 7.2, 'd_barrel', 1.3, 0);

  // coffre qui s'ouvre et crache des pièces
  const ch = animProp('d_chest', -8.3, 0, -3.5, Math.PI / 2, S, 'open-close', 0.45);
  let prevT = 0;
  const coins = [];
  updaters.push((dt) => {
    const t = ch.act.time;
    if (prevT < 0.25 && t >= 0.25) {
      for (let i = 0; i < 3; i++) {
        const c = P('d_coin', -8.1, 0.3, -3.5, 0, 0.55);
        coins.push({ c, vx: rand(0.4, 1.6), vy: rand(3.5, 5), vz: rand(-0.8, 0.8), life: 3 });
      }
      sfx.coin();
    }
    prevT = t;
    for (let i = coins.length - 1; i >= 0; i--) {
      const k = coins[i];
      k.life -= dt; k.vy -= 14 * dt;
      k.c.position.x += k.vx * dt; k.c.position.y += k.vy * dt; k.c.position.z += k.vz * dt;
      k.c.rotation.y += 9 * dt;
      if (k.c.position.y < 0) { k.c.position.y = 0; k.vy *= -0.4; k.vx *= 0.6; k.vz *= 0.6; }
      if (k.life < 0.5) k.c.scale.setScalar(0.55 * Math.max(0.01, k.life * 2));
      if (k.life <= 0) { world.remove(k.c); coins.splice(i, 1); }
    }
  });

  // pièges à pics le long des murs
  for (const [x, z] of [[-6, -8.6], [-3.4, -8.7], [3.4, 8.7], [8.7, 3.2], [-8.7, 2.6]]) {
    const tr = animProp('d_trap', x, 0, z, 0, 1.2, 'show-hide', rand(0.3, 0.4));
    let pt = 0;
    updaters.push(() => {
      const t = tr.act.time;
      if (t < pt) emit(x, 0.15, z, 6, { color: [0x8a8090, 0x5a5260], speed: 1.2, up: 1.5, size: 0.07, life: 0.6, grav: 4 });
      pt = t;
    });
  }

  // poussière dans la lumière
  const N = 380, pos = new Float32Array(N * 3), seed = [];
  for (let i = 0; i < N; i++) seed.push([rand(-9.5, 9.5), rand(0, 4), rand(-9.5, 9.5), rand(0, 6)]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const motes = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffd9a0, size: 0.05, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  motes.frustumCulled = false;
  world.add(motes);
  updaters.push((dt, t) => {
    for (let i = 0; i < N; i++) {
      const s = seed[i];
      s[1] += dt * 0.08; if (s[1] > 4) s[1] = 0;
      pos[i * 3] = s[0] + Math.sin(t * 0.3 + s[3]) * 0.4;
      pos[i * 3 + 1] = s[1];
      pos[i * 3 + 2] = s[2] + Math.cos(t * 0.25 + s[3]) * 0.3;
    }
    geo.attributes.position.needsUpdate = true;
  });
  arenaHooks.ko = () => crowd.confetti([0xffd34a, 0xffc020, 0xfff0a0]);
}

// =====================================================================
//  Arène 3 : le Bosquet sacré (clairière au coucher de soleil)
// =====================================================================
function buildBosquet() {
  scene.background = skyTex([[0, '#25265a'], [0.45, '#b4587a'], [0.8, '#ff9a5a'], [1, '#ffd08a']]);
  scene.fog = new THREE.Fog(0xe7956c, 20, 60);
  const sunPos = [-12, 7, 5];
  lights(0xffc9a0, 0x3e5a2e, 0.95, 0xffa860, 3.0, sunPos);
  ground(0x5d7f3e);
  tiles('a_floor', 'a_floorD', 0.3, 7.6);

  // soleil + collines tout autour
  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(5, 32), new THREE.MeshBasicMaterial({ color: 0xffe0a0, fog: false, toneMapped: false }));
  sunDisc.position.set(-75, 22, 31);
  sunDisc.lookAt(0, 0, 0);
  world.add(sunDisc);
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x4a5a6a, flatShading: true, roughness: 1 });
  for (let i = 0; i < 18; i++) {
    const a = i / 18 * TAU + rand(-0.1, 0.1), r = rand(45, 58);
    const h = new THREE.Mesh(new THREE.ConeGeometry(rand(8, 13), rand(6, 13), 5), hillMat);
    h.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
    world.add(h);
  }

  // herbes qui ondulent
  const NT = 420;
  const tuft = new THREE.InstancedMesh(new THREE.ConeGeometry(0.05, 0.28, 4), new THREE.MeshStandardMaterial({ color: 0x7fa64a }), NT);
  const tufts = [];
  for (let i = 0; i < NT; i++) { const a = rand(0, TAU), r = rand(8.1, 16); tufts.push([Math.sin(a) * r, Math.cos(a) * r, rand(0, 6)]); }
  world.add(tuft);
  updaters.push((dt, t) => {
    tufts.forEach(([x, z, ph], i) => {
      dummy.position.set(x, 0.12, z);
      dummy.rotation.set(0, ph, Math.sin(t * 2 + ph + x * 0.3) * 0.25);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      tuft.setMatrixAt(i, dummy.matrix);
    });
    tuft.instanceMatrix.needsUpdate = true;
  });

  // forêt en anneau
  for (let i = 0; i < 75; i++) {
    const a = rand(0, TAU), r = i < 25 ? rand(10.2, 12) : rand(12, 26);
    sway(P('a_tree', Math.sin(a) * r, 0, Math.cos(a) * r, rand(0, 6), rand(1.5, 2.6)), 0.035, rand(1, 1.6));
  }

  // ruines en cercle
  PR('a_block', 9.2, Math.PI, 0, S);
  PR('a_statue', 9.2, Math.PI, 0.75, 1.7);
  const ruins = [['a_column', 0.6], ['a_columnD', 1.2], ['a_column', 2.0], ['a_columnD', 2.6], ['a_column', -0.6], ['a_columnD', -1.3], ['a_column', -2.1], ['a_columnD', -2.6]];
  const sitters = [];
  for (const [k, a] of ruins) {
    PR(k, 9.2, a, 0, k === 'a_column' ? S * 1.4 : S);
    if (k === 'a_columnD') sitters.push(a);
  }
  for (const a of [0.2, 1.6, -1.7, 2.9]) PR('a_bricks', 8.6, a, 0, 1.2, rand(0, 3));

  newCrowd();
  for (const a of sitters) crowd.addR(9.2, a, 1.08, ['human', 'soldier', 'orc'], 'sit', 1.15);
  for (let i = 0; i < 16; i++) crowd.addR(rand(10.4, 12.5), rand(0, TAU), 0, ['human', 'soldier', 'orc'], 'idle', 1.2);

  // feuilles qui tombent
  const leafGeo = new THREE.PlaneGeometry(0.13, 0.08);
  const leafMats = [0xe8742a, 0xd94a2a, 0xf2b33a, 0x9ab84a].map((c) => new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide }));
  const leaves = [];
  const spawn = (m, top) => { const a = rand(0, TAU), r = rand(0, 12); m.position.set(Math.sin(a) * r, top ? rand(6, 8) : rand(0, 7), Math.cos(a) * r); };
  for (let i = 0; i < 140; i++) {
    const m = new THREE.Mesh(leafGeo, pick(leafMats));
    spawn(m, false);
    world.add(m);
    leaves.push({ m, ph: rand(0, 6), sp: rand(0.4, 0.8), rest: 0 });
  }
  updaters.push((dt, t) => {
    for (const l of leaves) {
      if (l.m.position.y <= 0.02) {
        l.rest += dt;
        if (l.rest > 2) { l.rest = 0; spawn(l.m, true); }
        continue;
      }
      l.m.position.y -= l.sp * dt;
      l.m.position.x += (Math.sin(t * 1.3 + l.ph) * 0.6 + 0.35) * dt;
      l.m.position.z += Math.cos(t * 1.1 + l.ph) * 0.2 * dt;
      l.m.rotation.set(t * 2 + l.ph, t * 1.3 + l.ph, Math.sin(t * 3 + l.ph));
      if (l.m.position.y <= 0.02) { l.m.position.y = 0.02; l.m.rotation.set(-Math.PI / 2, 0, l.ph); }
    }
  });

  // lucioles
  const ffGeo = new THREE.SphereGeometry(0.035, 6, 4);
  const ffMat = new THREE.MeshBasicMaterial({ color: 0xe2ff7a, toneMapped: false });
  const ffs = [];
  for (let i = 0; i < 70; i++) {
    const m = new THREE.Mesh(ffGeo, ffMat);
    world.add(m);
    const a = rand(0, TAU), r = rand(2, 13);
    ffs.push({ m, c: [Math.sin(a) * r, rand(0.4, 3), Math.cos(a) * r], ph: rand(0, 20), r: rand(0.3, 0.9) });
  }
  updaters.push((dt, t) => {
    for (const f of ffs) {
      f.m.position.set(f.c[0] + Math.sin(t * 0.5 + f.ph) * f.r, f.c[1] + Math.sin(t * 0.8 + f.ph * 2) * 0.3, f.c[2] + Math.cos(t * 0.4 + f.ph) * f.r);
      f.m.scale.setScalar(0.4 + Math.max(0, Math.sin(t * 2 + f.ph)) * 1.2);
    }
  });
  birds(5, 0x2a1a2a, 8, 13);
  arenaHooks.ko = () => {
    for (let i = 0; i < 60; i++) {
      const a = rand(0, TAU), r = rand(0, 8);
      emit(Math.sin(a) * r, rand(4, 6), Math.cos(a) * r, 1, { color: [0xff9ad0, 0xffffff, 0xffc0e0], speed: 0.6, up: 0.2, size: 0.09, life: 4, grav: 0.7, drag: 0.5 });
    }
  };
}

// =====================================================================
//  Arène 4 : l'Orage (nuit, pluie)
// =====================================================================
function buildOrage() {
  const bgNormal = skyTex([[0, '#04060d'], [1, '#1d2944']]);
  const bgFlash = skyTex([[0, '#5a6a9a'], [1, '#aab8e0']]);
  scene.background = bgNormal;
  scene.fog = new THREE.Fog(0x0f1626, 14, 45);
  const L = lights(0x7f8fc0, 0x151520, 0.6, 0x9fb4ff, 0.9, [5, 14, 6]);
  ground(0x34343c);
  tiles('a_floor', 'a_floorD', 0.35, 9.6);
  roundArena(['soldier', 'human', 'orc'], 2, 0.4);

  for (let k = 0; k < 12; k++) {
    const a = k / 12 * TAU;
    if (GATES.some((g) => Math.abs(wrap(a - g)) < 0.1)) continue;
    const broken = k % 3 === 1;
    PR(broken ? 'a_columnD' : 'a_column', 9.15, a);
    if (!broken) {
      const bn = PR('a_banner', 9.15, a, 1.5);
      sway(bn, 0.2, 4.2);
      sway(bn, 0.08, 3.1, 'x');
    }
  }
  for (const a of [0.9, 2.4, -2.2]) PR('a_bricks', 8.7, a, 0, 1.3, rand(0, 3));
  PR('a_statue', 8.9, Math.PI / 2 + 0.2, 0, 1.6);
  PR('a_statue', 8.9, -Math.PI / 2 - 0.2, 0, 1.6);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2;
    brazier(Math.sin(a) * 8.3, Math.cos(a) * 8.3, 'a_columnD', 1.1, 4);
  }
  for (const g of GATES) for (const d of [-0.12, 0.12]) {
    const a = g + d;
    torch(Math.sin(a) * 9.5, 1.0, Math.cos(a) * 9.5, a + Math.PI, 3);
  }

  // flaques
  const puddleMat = new THREE.MeshStandardMaterial({ color: 0x1c2a44, metalness: 0.7, roughness: 0.08, transparent: true, opacity: 0.75 });
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(rand(0.35, 0.85), 20), puddleMat);
    const a = rand(0, TAU), r = rand(0, 8.5);
    m.rotation.x = -Math.PI / 2; m.scale.y = rand(0.6, 1);
    m.position.set(Math.sin(a) * r, 0.012 + i * 0.0005, Math.cos(a) * r);
    m.receiveShadow = true;
    world.add(m);
  }

  // pluie (suit la caméra)
  const N = 2400, pos = new Float32Array(N * 6), drops = [];
  for (let i = 0; i < N; i++) drops.push([rand(-14, 14), rand(0, 13), rand(-14, 14), rand(15, 21)]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const rain = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xa9c0ff, transparent: true, opacity: 0.42 }));
  rain.frustumCulled = false;
  world.add(rain);
  const wind = 3;
  updaters.push((dt) => {
    const cx = camLook.x, cz = camLook.z;
    for (let i = 0; i < N; i++) {
      const d = drops[i];
      d[1] -= d[3] * dt; d[0] += wind * dt;
      if (d[1] < 0) {
        const wx = cx + d[0], wz = cz + d[2];
        if (Math.random() < 0.02 && Math.hypot(wx, wz) < 9.3) ring(wx, 0.03, wz, 0xbcd0ff, 0.35, 0.5, true, 0.5);
        d[0] = rand(-16, 14); d[1] = rand(11, 13); d[2] = rand(-14, 14);
      }
      const k = i * 6;
      pos[k] = cx + d[0]; pos[k + 1] = d[1]; pos[k + 2] = cz + d[2];
      pos[k + 3] = cx + d[0] - wind * 0.025; pos[k + 4] = d[1] + 0.42; pos[k + 5] = cz + d[2];
    }
    geo.attributes.position.needsUpdate = true;
  });

  // éclairs
  const boltMat = new THREE.LineBasicMaterial({ color: 0xeef3ff, toneMapped: false, fog: false });
  const bolt = new THREE.Line(new THREE.BufferGeometry(), boltMat);
  bolt.visible = false;
  world.add(bolt);
  let next = rand(3, 6), seq = -1;
  const baseHemi = L.hemi.intensity;
  updaters.push((dt) => {
    next -= dt;
    if (next < 0 && seq < 0) {
      seq = 0;
      next = rand(5, 11);
      // l'éclair tombe derrière ce que regarde la caméra
      const fwd = v1.subVectors(camLook, camera.position).setY(0).normalize();
      const side = rand(-25, 25);
      const pts = [];
      let x = fwd.x * 40 - fwd.z * side, z = fwd.z * 40 + fwd.x * side, y = 26;
      while (y > 2) { pts.push(new THREE.Vector3(x, y, z)); x += rand(-2.5, 2.5); z += rand(-2.5, 2.5); y -= rand(1.4, 3); }
      bolt.geometry.dispose();
      bolt.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      sfx.thunder(rand(0.3, 1.0));
      if (crowd) crowd.cheer(0.3);
    }
    if (seq >= 0) {
      seq += dt;
      const on = (seq < 0.07) || (seq > 0.13 && seq < 0.18) || (seq > 0.26 && seq < 0.4);
      bolt.visible = on;
      L.hemi.intensity = on ? 3.4 : baseHemi;
      scene.background = on ? bgFlash : bgNormal;
      if (on) screenFlash(0.25);
      if (seq > 0.45) { seq = -1; bolt.visible = false; L.hemi.intensity = baseHemi; scene.background = bgNormal; }
    }
  });
  arenaHooks.ko = () => crowd.confetti([0xffffff, 0xa9c0ff]);
}

const ARENAS = {
  colisee: { name: 'Le Colisée', desc: 'Sable chaud et foule en délire', build: buildColisee, sw: 'linear-gradient(180deg,#5aa0e6,#f3d9a8 70%,#d9ad74)' },
  donjon: { name: 'Le Donjon', desc: 'Torches, pièges et orcs', build: buildDonjon, sw: 'linear-gradient(180deg,#0b0911,#3a2c4a 70%,#ff8a3a)' },
  bosquet: { name: 'Le Bosquet sacré', desc: 'Ruines au soleil couchant', build: buildBosquet, sw: 'linear-gradient(180deg,#2c2a5e,#ff9a5a 70%,#5d7f3e)' },
  orage: { name: "L'Arène de l'orage", desc: 'Pluie battante et éclairs', build: buildOrage, sw: 'linear-gradient(180deg,#04060d,#2a3a60 70%,#a9c0ff)' },
};

function buildArena(id) {
  world.clear();
  updaters = [];
  crowd = null;
  arenaHooks = {};
  scene.fog = null;
  ARENAS[id].build();
  curArena = id;
}

// =====================================================================
//  Combattants
// =====================================================================
const ATK = { start: 0.13, end: 0.26, chain: 0.27, dur: 0.42, track: 0.09 };
const BRK = { start: 0.34, end: 0.47, dur: 0.8 };
const PAR = { win: 0.2, dur: 0.42 };
const ROLL = { dur: 0.48, inv0: 0.03, inv1: 0.36, speed: 7.5 };
// endurance : chaque action en consomme, elle remonte quand on souffle un peu
const STA = { regen: 30, delay: 0.7, atk: 9, brk: 22, roll: 28, jump: 12, par: 10, tired: 15 };
const HIT_W = 0.72;   // demi-largeur de la zone touchée : un pas de côté suffit pour esquiver
const qBlock = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -1.2, -0.35));
const ringFoot = new THREE.RingGeometry(0.42, 0.56, 36).rotateX(-Math.PI / 2);
const starGeo = new THREE.OctahedronGeometry(0.075);
const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14a, toneMapped: false });

class Fighter {
  constructor(idx, kind) {
    this.idx = idx;
    this.kind = kind;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.pivot = new THREE.Group();
    this.pivot.position.y = 0.65;
    this.root.add(this.pivot);
    this.model = inst(kind, 1.6);
    this.model.position.y = -0.65;
    this.pivot.add(this.model);
    this.mats = [];
    this.model.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); this.mats.push(o.material); } });
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const c of G[kind].animations) this.actions[c.name] = this.mixer.clipAction(c);
    this.armL = this.model.getObjectByName('arm-left');
    this.armR = this.model.getObjectByName('arm-right');
    this.torso = this.model.getObjectByName('torso');

    this.sword = inst('sword', 0.9);
    this.sword.position.set(-0.25, 0, 0.02);
    this.sword.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.65, 0, 0.76));
    this.armR.add(this.sword);
    this.shield = inst('shield', 0.8);
    this.shieldMats = [];
    this.shield.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); this.shieldMats.push(o.material); } });
    this.shield.position.set(0.24, 0, 0.07);
    this.armL.add(this.shield);

    this.ring = new THREE.Mesh(ringFoot, new THREE.MeshBasicMaterial({ color: idx ? 0x4aa3ff : 0xff5a4a, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false }));
    scene.add(this.ring);
    this.stars = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(starGeo, starMat);
      s.position.set(Math.cos(i * 2.09) * 0.33, 0, Math.sin(i * 2.09) * 0.33);
      this.stars.add(s);
    }
    this.stars.position.y = 1.6;
    this.root.add(this.stars);
    this.flashCol = new THREE.Color(1, 1, 1);
    this.cur = null;
    this.reset(idx ? 2.6 : -2.6, 0, idx ? -Math.PI / 2 : Math.PI / 2);
  }
  dispose() { scene.remove(this.root, this.ring); }
  get fx() { return Math.sin(this.yaw); }
  get fz() { return Math.cos(this.yaw); }

  reset(x, z, yaw) {
    rec('reset', [this.idx, x, z, yaw]);
    Object.assign(this, {
      x, z, y: 0, vx: 0, vz: 0, vy: 0, yaw, vyaw: yaw, hp: 100, guard: 100, state: 'idle', stateT: 0, dur: 0,
      sta: 100, staT: 9, staFail: 0, hitDone: false, airAtk: false, airAtkT: 0, flash: 0, shieldGlow: 0, bw: 0, flinch: 0, guardT: 9, dustT: 0, combo: 0, brkSfx: false,
    });
    this.stars.visible = false;
    this.model.rotation.set(0, yaw, 0);
    this.pivot.quaternion.identity();
    this.mixer.stopAllAction();
    this.cur = null;
    this.play('idle', { fade: 0 });
    this.mixer.update(rand(0, 1));
  }
  play(name, o = {}) {
    rec('play', [this.idx, name, o]);
    const a = this.actions[name];
    if (!a) return;
    const ts = o.ts ?? 1;
    if (this.cur === a && !o.restart) { a.timeScale = ts; return; }
    const prev = this.cur;
    a.reset();
    a.timeScale = ts;
    a.setLoop(o.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = o.loop === false;
    if (ts < 0) a.time = a.getClip().duration;
    a.play();
    if (prev && prev !== a && (o.fade ?? 0.12) > 0) prev.crossFadeTo(a, o.fade ?? 0.12, false);
    else if (prev && prev !== a) prev.stop();
    this.cur = a;
  }
  setState(s, dur = 0) { this.state = s; this.stateT = 0; this.dur = dur; }
  toIdle() { this.setState('idle'); this.play('idle', { fade: 0.15 }); }
  startAttack(chain = false) {
    this.combo = chain ? this.combo + 1 : 1;
    this.setState('attack');
    this.hitDone = false;
    this.play(this.combo === 2 ? 'attack-melee-left' : 'attack-melee-right', { loop: false, restart: true, fade: 0.05 });
    sfx.swing();
  }
  startBreak() {
    this.setState('brk');
    this.hitDone = false;
    this.brkSfx = false;
    this.play('attack-kick-right', { loop: false, restart: true, ts: 0.62, fade: 0.08 });
  }
  startParry() {
    this.setState('parry');
    this.shieldGlow = 1;
    this.play('idle', { fade: 0.05 });
  }
  doJump(mx, mz) {
    this.setState('air');
    this.vy = 8.2;
    this.vx = mx * 3.3; this.vz = mz * 3.3;
    this.airAtk = false;
    this.play('jump', { loop: false, fade: 0.06 });
    sfx.jump();
    emit(this.x, 0.05, this.z, 6, { color: [0xc8a070, 0xa88050], speed: 1.4, up: 0.8, size: 0.08, life: 0.5, grav: 3 });
  }
  canRoll() { return this.sta >= STA.roll; }
  spend(cost) {
    if (this.sta < cost) {
      if (this.staFail <= 0) pop('ÉPUISÉ', this.x, this.y + 1.8, this.z, 'miss');
      this.staFail = 0.5;
      return false;
    }
    this.sta -= cost; this.staT = 0;
    return true;
  }
  startRoll(mx, mz) {
    let dx = mx, dz = mz;
    if (Math.hypot(dx, dz) < 0.1) { dx = -this.fx; dz = -this.fz; }   // sans direction : roulade en arrière
    const n = Math.hypot(dx, dz);
    this.rollDir = { x: dx / n, z: dz / n };
    this.setState('roll');
    this.flinch = 0; this.airAtk = false;
    this.play('crouch', { fade: 0.05 });
    sfx.roll();
    emit(this.x, 0.05, this.z, 7, { color: [0xc8a070, 0xa88050], speed: 1.6, up: 0.8, size: 0.08, life: 0.5, grav: 3 });
  }
  stun(d) {
    this.setState('stun', d);
    this.airAtk = false;
    this.stars.visible = true;
    this.play('emote-no', { ts: 0.55, fade: 0.08 });
  }
  die() {
    this.setState('dead');
    this.airAtk = false;
    this.stars.visible = false;
    this.play('die', { loop: false, fade: 0.06 });
  }
  win() { this.setState('win'); this.play('emote-yes', { fade: 0.2 }); }

  update(dt, inp, opp, canAct) {
    this.stateT += dt;
    const st = this.state;
    const mx = canAct ? inp.mx : 0, mz = canAct ? inp.mz : 0;
    const moving = Math.hypot(mx, mz) > 0.1;
    const grounded = this.y <= 0;
    const toOpp = Math.atan2(opp.x - this.x, opp.z - this.z);
    const dOpp = Math.hypot(opp.x - this.x, opp.z - this.z);
    // verrouillage : on fait toujours face à l'adversaire, sauf pendant un coup déjà lancé
    const track = (st === 'idle' || st === 'walk' || st === 'block' || st === 'air' || st === 'parry' || (st === 'attack' && this.stateT < ATK.track));
    if (track && dOpp > 0.05) this.yaw = lerpAng(this.yaw, toOpp, Math.min(1, dt * 20));
    let visYaw = this.yaw;

    switch (st) {
      case 'idle': case 'walk': case 'block': {
        if (!canAct) { this.vx = this.vz = 0; if (st !== 'idle') this.toIdle(); break; }
        if (inp.take('roll') && this.spend(STA.roll)) { this.startRoll(mx, mz); break; }
        if (inp.take('brk') && this.spend(STA.brk)) { this.startBreak(); break; }
        if (inp.take('atk') && this.spend(STA.atk)) { this.startAttack(); break; }
        if (inp.take('par') && this.spend(STA.par)) { this.startParry(); break; }
        if (inp.take('jump') && this.spend(STA.jump)) { this.doJump(mx, mz); break; }
        if (inp.blk) {
          if (st !== 'block') { this.setState('block'); this.play('idle', { ts: 0.5 }); }
          this.vx = mx * 1.1; this.vz = mz * 1.1;
          break;
        }
        const spd = this.sta < STA.tired ? 2.5 : 3.4;
        this.vx = mx * spd; this.vz = mz * spd;
        if (moving) {
          if (st !== 'walk') this.setState('walk');
          const fwd = mx * this.fx + mz * this.fz;
          const back = fwd < -0.35;
          this.play('walk', { ts: back ? -1.05 : 1.25 });
          // le corps s'oriente un peu dans le sens du pas de côté
          const k = back ? -0.35 : 0.35;
          visYaw = Math.atan2(this.fx + mx * k, this.fz + mz * k);
          this.dustT -= dt;
          if (this.dustT < 0) { this.dustT = 0.22; emit(this.x, 0.05, this.z, 1, { color: 0xc8a070, speed: 0.6, up: 0.6, size: 0.07, life: 0.45, grav: 2 }); }
        } else if (st !== 'idle') this.toIdle();
        break;
      }
      case 'attack': {
        const t = this.stateT;
        if (t > 0.06 && t < 0.2) { this.vx = this.fx * 2.6; this.vz = this.fz * 2.6; }
        else { const k = Math.exp(-dt * 12); this.vx *= k; this.vz *= k; }
        if (canAct && t > ATK.chain && this.combo < 3 && inp.take('atk') && this.spend(STA.atk)) { this.yaw = toOpp; this.startAttack(true); break; }
        if (canAct && t > ATK.end && inp.take('roll') && this.spend(STA.roll)) { this.startRoll(mx, mz); break; }
        if (t >= ATK.dur) { this.combo = 0; this.toIdle(); }
        break;
      }
      case 'brk': {
        const t = this.stateT;
        if (t > 0.26 && t < 0.42) { this.vx = this.fx * 3.2; this.vz = this.fz * 3.2; }
        else { const k = Math.exp(-dt * 12); this.vx *= k; this.vz *= k; }
        if (t < BRK.start) { this.flashCol.setRGB(1, 0.42, 0.05); this.flash = Math.max(this.flash, 0.35 + 0.3 * Math.sin(t * 45)); }
        if (!this.brkSfx && t > 0.26) { this.brkSfx = true; sfx.heavy(); }
        if (t >= BRK.dur) this.toIdle();
        break;
      }
      case 'parry': {
        const k = Math.exp(-dt * 12); this.vx *= k; this.vz *= k;
        if (this.stateT >= PAR.dur) this.toIdle();
        break;
      }
      case 'hit': {
        const k = Math.exp(-dt * 7); this.vx *= k; this.vz *= k;
        // on peut se sortir d'un enchaînement par une roulade
        if (canAct && grounded && this.stateT > 0.1 && inp.take('roll') && this.spend(STA.roll)) { this.startRoll(mx, mz); break; }
        if (this.stateT >= this.dur && grounded) this.toIdle();
        break;
      }
      case 'roll': {
        const t = this.stateT, sp = ROLL.speed * (1 - 0.75 * t / ROLL.dur);
        this.vx = this.rollDir.x * sp; this.vz = this.rollDir.z * sp;
        this.dustT -= dt;
        if (this.dustT < 0) { this.dustT = 0.06; emit(this.x, 0.05, this.z, 1, { color: 0xc8a070, speed: 0.5, up: 0.5, size: 0.08, life: 0.4, grav: 2 }); }
        if (t >= ROLL.dur) this.toIdle();
        break;
      }
      case 'stun': {
        const k = Math.exp(-dt * 7); this.vx *= k; this.vz *= k;
        if (this.stateT >= this.dur && grounded) { this.stars.visible = false; this.toIdle(); }
        break;
      }
      case 'air':
        if (canAct) {
          const k = Math.min(1, dt * 3);
          this.vx += (mx * 3.3 - this.vx) * k;
          this.vz += (mz * 3.3 - this.vz) * k;
          if (!this.airAtk && inp.take('atk') && this.spend(STA.atk)) {
            this.airAtk = true; this.airAtkT = 0; this.hitDone = false;
            this.play('attack-melee-right', { loop: false, restart: true, fade: 0.04 });
            sfx.swing();
          }
        }
        if (this.airAtk) this.airAtkT += dt;
        else if (this.vy < 0 && this.cur !== this.actions.fall) this.play('fall', { fade: 0.15 });
        break;
      case 'dead': {
        const k = Math.exp(-dt * 5); this.vx *= k; this.vz *= k;
        break;
      }
    }
    this.visTarget = visYaw;

    if (this.state === 'air' || this.y > 0) {
      this.vy -= 24 * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0; this.vy = 0;
        emit(this.x, 0.05, this.z, 8, { color: [0xc8a070, 0xa88050], speed: 1.8, up: 0.7, size: 0.08, life: 0.5, grav: 3 });
        if (this.state === 'air') { this.airAtk = false; sfx.land(); this.toIdle(); }
      }
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    const r = Math.hypot(this.x, this.z);
    if (r > FIGHT_R) { this.x *= FIGHT_R / r; this.z *= FIGHT_R / r; }

    this.guardT += dt;
    if (this.state !== 'block' && this.guardT > 0.9) this.guard = Math.min(100, this.guard + 24 * dt);
    this.staT += dt;
    this.staFail = Math.max(0, this.staFail - dt);
    if (this.staT > STA.delay && this.state !== 'roll') this.sta = Math.min(100, this.sta + STA.regen * dt * (this.state === 'block' ? 0.5 : 1));
  }

  pose(dt, T) {
    const wantB = (this.state === 'block' || this.state === 'parry') ? 1 : 0;
    this.bw += (wantB - this.bw) * Math.min(1, dt * (this.state === 'parry' ? 32 : 16));
    if (this.bw > 0.01) this.armL.quaternion.slerp(qBlock, this.bw);
    if (this.flinch > 0) { this.torso.rotateX(-0.55 * this.flinch); this.flinch = Math.max(0, this.flinch - dt * 4); }

    this.vyaw = lerpAng(this.vyaw, this.visTarget ?? this.yaw, Math.min(1, dt * 14));
    this.model.rotation.y = this.vyaw;
    this.model.rotation.z = this.state === 'stun' ? Math.sin(T * 7) * 0.1 : 0;
    if (this.state === 'roll') {
      const k = Math.min(1, this.stateT / (ROLL.dur * 0.85));
      v1.set(this.rollDir.z, 0, -this.rollDir.x);
      this.pivot.quaternion.setFromAxisAngle(v1, (1 - (1 - k) * (1 - k)) * TAU);
    } else this.pivot.quaternion.identity();
    this.root.position.set(this.x, this.y, this.z);
    this.root.updateMatrixWorld(true);
    this.armL.getWorldQuaternion(q1);
    this.model.getWorldQuaternion(q2);
    this.shield.quaternion.copy(q1.invert().multiply(q2));

    this.flash = Math.max(0, this.flash - dt * 4);
    for (const m of this.mats) m.emissive.copy(this.flashCol).multiplyScalar(this.flash);
    this.shieldGlow = Math.max(0, this.shieldGlow - dt * 3);
    const bg = this.state === 'block' ? 0.12 : 0;
    for (const m of this.shieldMats) m.emissive.setRGB(0.5 * this.shieldGlow + bg * 0.4, 0.8 * this.shieldGlow + bg * 0.7, this.shieldGlow + bg);

    this.stars.rotation.y = T * 5;
    this.ring.position.set(this.x, 0.03, this.z);
    this.ring.material.opacity = this.state === 'dead' ? 0 : 0.75 - Math.min(0.5, this.y * 0.25);
  }
}

// =====================================================================
//  Entrées
// =====================================================================
class Input {
  constructor() { this.buf = { atk: 0, par: 0, brk: 0, jump: 0, roll: 0 }; this.clear(); }
  peek(a) { return this.buf[a] > 0; }
  press(a) { this.buf[a] = 0.18; }
  take(a) { if (this.buf[a] > 0) { this.buf[a] = 0; return true; } return false; }
  tick(dt) { for (const k in this.buf) this.buf[k] = Math.max(0, this.buf[k] - dt); }
  clear() { for (const k in this.buf) this.buf[k] = 0; this.l = this.r = this.u = this.d = this.blk = false; this.mx = this.mz = 0; }
}

const KEYSETS = [
  { l: ['KeyA'], r: ['KeyD'], u: ['KeyW'], d: ['KeyS'], jump: ['Space'], atk: ['KeyF'], blk: ['KeyG'], par: ['KeyH'], brk: ['KeyR'], roll: ['KeyE', 'ShiftLeft'] },
  { l: ['ArrowLeft'], r: ['ArrowRight'], u: ['ArrowUp'], d: ['ArrowDown'], jump: ['KeyO', 'Numpad0'], atk: ['KeyK', 'Numpad1'], blk: ['KeyL', 'Numpad2'], par: ['Semicolon', 'Numpad3'], brk: ['KeyI', 'Numpad4'], roll: ['KeyJ', 'Numpad5'] },
];
const HELD = ['l', 'r', 'u', 'd', 'blk'];
let bindings = new Map();   // code -> [[joueur, action], ...]
function setupBindings(mode, me = 0) {
  bindings = new Map();
  KEYSETS.forEach((set, i) => {
    const player = mode === 'duo' ? i : me;
    for (const [act, codes] of Object.entries(set))
      for (const c of codes) {
        if (!bindings.has(c)) bindings.set(c, []);
        bindings.get(c).push([player, act]);
      }
  });
}
const down = new Set();
const inputs = [new Input(), new Input()];

// étiquettes des touches selon la disposition réelle du clavier (AZERTY par défaut)
let layout = null;
const AZERTY = { KeyA: 'Q', KeyW: 'Z', KeyQ: 'A', KeyZ: 'W', Semicolon: 'M' };
const SPECIAL = { Space: 'Espace', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Numpad0: 'Pavé 0', Numpad1: 'Pavé 1', Numpad2: 'Pavé 2', Numpad3: 'Pavé 3', Numpad4: 'Pavé 4', Numpad5: 'Pavé 5', ShiftLeft: 'Maj' };
function lab(code) {
  if (SPECIAL[code]) return SPECIAL[code];
  const k = layout?.get(code);
  if (k) return k.toUpperCase();
  return AZERTY[code] ?? code.replace('Key', '');
}
const kb = (code) => `<kbd>${lab(code)}</kbd>`;
function controlsHTML(mode, compact) {
  const a = KEYSETS[0], b = KEYSETS[1];
  if (mode !== 'duo') {
    const rows = [
      `<b>Se déplacer</b> ${kb(a.u[0])}${kb(a.l[0])}${kb(a.d[0])}${kb(a.r[0])} ou flèches · <b>Sauter</b> ${kb('Space')} · <b>Roulade</b> ${kb(b.roll[0])} ou ${kb('ShiftLeft')}`,
      `<b>Attaquer</b> ${kb(b.atk[0])} · <b>Bloquer</b> ${kb(b.blk[0])} (maintenir) · <b>Parer</b> ${kb(b.par[0])} · <b>Briser la garde</b> ${kb(b.brk[0])}`,
    ];
    if (!compact) rows.push(`<span>(ou ${kb(a.atk[0])} ${kb(a.blk[0])} ${kb(a.par[0])} ${kb(a.brk[0])} ${kb(a.roll[0])} de la main gauche)</span>`);
    return rows.map((r) => `<div class="row">${r}</div>`).join('');
  }
  const p = (s, n) => `<b style="color:${n ? '#a8d4ff' : '#ffb3a8'}">J${n + 1}</b> ${kb(s.u[0])}${kb(s.l[0])}${kb(s.d[0])}${kb(s.r[0])} saut ${kb(s.jump[0])} · att. ${kb(s.atk[0])} · bloc ${kb(s.blk[0])} · parer ${kb(s.par[0])} · briser ${kb(s.brk[0])} · roulade ${kb(s.roll[0])}`;
  return `<div class="row">${p(a, 0)}</div><div class="row">${p(b, 1)}</div>`;
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (bindings.has(e.code) || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.code === 'Escape') { togglePause(); return; }
  if (e.repeat) return;
  down.add(e.code);
  const b = bindings.get(e.code);
  if (b && !game.paused) for (const [pl, act] of b) if (act in inputs[pl].buf) {
    inputs[pl].press(act);
    if (net.live && net.role === 'guest') net.presses.push(act);
  }
});
addEventListener('keyup', (e) => down.delete(e.code));
addEventListener('blur', () => down.clear());

// déplacements relatifs à la caméra : ← → le long de l'écran, ↑ ↓ en profondeur (pas de côté)
function readHeld() {
  const human = (pl) => net.live ? pl === net.me : !(pl === 1 && ai) && !(pl === 0 && ai0);
  inputs.forEach((inp, pl) => { if (human(pl)) for (const k of HELD) inp[k] = false; });
  if (!game.paused) for (const code of down) {
    const b = bindings.get(code);
    if (!b) continue;
    for (const [pl, act] of b) if (human(pl) && HELD.includes(act)) inputs[pl][act] = true;
  }
  const rx = Math.cos(camAng), rz = -Math.sin(camAng);   // droite de l'écran
  const fx = -Math.sin(camAng), fz = -Math.cos(camAng);  // vers le fond de l'écran
  inputs.forEach((inp, pl) => {
    if (!human(pl)) return;
    const h = (inp.r ? 1 : 0) - (inp.l ? 1 : 0), v = (inp.u ? 1 : 0) - (inp.d ? 1 : 0);
    let mx = rx * h + fx * v, mz = rz * h + fz * v;
    const n = Math.hypot(mx, mz);
    if (n > 1) { mx /= n; mz /= n; }
    inp.mx = mx; inp.mz = mz;
  });
}

// =====================================================================
//  IA
// =====================================================================
const AIL = [
  { react: 0.42, block: 0.28, parry: 0.05, dodge: 0.1, aggr: 0.3, brk: 0.3, roll: 0.12 },
  { react: 0.26, block: 0.42, parry: 0.16, dodge: 0.18, aggr: 0.45, brk: 0.5, roll: 0.3 },
  { react: 0.15, block: 0.48, parry: 0.3, dodge: 0.2, aggr: 0.6, brk: 0.72, roll: 0.45 },
];
class AI {
  constructor(me, opp, lv) { this.me = me; this.opp = opp; this.L = AIL[lv]; this.think = 0.4; this.blkT = 0; this.move = null; this.moveT = 0; this.sd = 1; }
  roll(inp, ux, uz) {
    this.sd = Math.random() < 0.5 ? 1 : -1;
    const side = Math.random() < 0.6;
    this.go(side ? 'side' : 'out', 0.2);
    inp.mx = side ? -uz * this.sd : -ux; inp.mz = side ? ux * this.sd : -uz;
    inp.press('roll');
  }
  go(kind, t) { this.move = kind; this.moveT = t; if (kind === 'side' && Math.random() < 0.5) this.sd = -this.sd; }
  update(dt, inp) {
    const me = this.me, o = this.opp, L = this.L;
    this.think -= dt; this.blkT -= dt; this.moveT -= dt;
    if (this.moveT <= 0) this.move = null;
    const dx = o.x - me.x, dz = o.z - me.z, dist = Math.hypot(dx, dz) || 0.001;
    const ux = dx / dist, uz = dz / dist;
    let mx = 0, mz = 0;
    if (this.move === 'in') { mx = ux; mz = uz; }
    else if (this.move === 'out') { mx = -ux; mz = -uz; }
    else if (this.move === 'side') { mx = -uz * this.sd; mz = ux * this.sd; }
    // près du bord : on tourne au lieu de reculer dans le mur
    const r = Math.hypot(me.x, me.z);
    if (r > FIGHT_R - 0.8 && (mx * me.x + mz * me.z) > 0) { mx = -uz * this.sd; mz = ux * this.sd; }
    inp.mx = mx; inp.mz = mz;
    inp.blk = this.blkT > 0;
    if (this.think > 0) return;
    this.think = L.react * rand(0.7, 1.3);
    const p = Math.random();
    // prise dans un enchaînement : roulade sur le côté ou en arrière
    if (me.state === 'hit' && me.canRoll() && p < L.roll) { this.roll(inp, ux, uz); return; }
    if (!['idle', 'walk', 'block', 'air', 'attack'].includes(me.state)) return;
    if (me.state === 'air') { if (dist < 1.6 && p < 0.6) inp.press('atk'); return; }
    const threat = (o.state === 'attack' && o.stateT < 0.17) || (o.state === 'air' && o.airAtk && o.airAtkT < 0.15);
    if (threat && dist < 2.0) {
      if (p < L.parry) inp.press('par');
      else if (p < L.parry + L.block) this.blkT = 0.45;
      else if (p < L.parry + L.block + L.dodge) this.go('side', 0.35);
      else if (p < L.parry + L.block + L.dodge + 0.1) this.go('out', 0.3);
      return;
    }
    if (o.state === 'brk' && o.stateT < BRK.start && dist < 2.0) {
      if (p < L.roll * 0.5 && me.canRoll()) this.roll(inp, ux, uz);
      else if (p < L.block * 0.6) inp.press('jump');
      else if (p < L.block) this.go('side', 0.45);
      else if (p < L.block + 0.25 && dist < 1.4) inp.press('atk');
      else this.blkT = 0.4;
      return;
    }
    if ((o.state === 'stun' || o.state === 'hit') && dist < 1.8) { if (dist > 1.3) this.go('in', 0.15); inp.press('atk'); return; }
    if (o.state === 'block' && dist < 1.5 && p < L.brk) { inp.press('brk'); return; }
    if (dist > 1.45) {
      this.go(Math.random() < 0.25 ? 'side' : 'in', rand(0.2, 0.5));
      if (p < 0.05) inp.press('jump');
      return;
    }
    if (dist < 0.85 && p < 0.2) { this.go('out', rand(0.15, 0.3)); return; }
    if (p < L.aggr) { inp.press(Math.random() < 0.78 ? 'atk' : 'brk'); return; }
    if (p < L.aggr + 0.15) { this.blkT = rand(0.3, 0.7); return; }
    if (p < L.aggr + 0.3) this.go('side', rand(0.3, 0.6));
    else if (p < L.aggr + 0.38) this.go('out', rand(0.2, 0.4));
  }
}

// =====================================================================
//  Résolution des coups
// =====================================================================
function crowdCheer(a) { rec('cheer', [a]); if (crowd) crowd.cheer(a); }

function resolve(att, def) {
  if (def.state === 'dead' || att.hitDone) return;
  if (def.state === 'roll' && def.stateT > ROLL.inv0 && def.stateT < ROLL.inv1) return;  // invincible pendant la roulade
  let kind = null;
  const t = att.stateT;
  if (att.state === 'attack' && t >= ATK.start && t <= ATK.end) kind = 'light';
  else if (att.state === 'brk' && t >= BRK.start && t <= BRK.end) kind = 'brk';
  else if (att.state === 'air' && att.airAtk && att.airAtkT >= 0.08 && att.airAtkT <= 0.32) kind = 'air';
  if (!kind) return;
  const fx = att.fx, fz = att.fz;
  const dx = def.x - att.x, dz = def.z - att.z, dy = def.y - att.y;
  const along = dx * fx + dz * fz, lateral = Math.abs(dx * fz - dz * fx);
  if (along < -0.25 || along > (kind === 'brk' ? 1.3 : 1.45)) return;
  if (kind === 'air' ? (dy > 0.6 || dy < -1.7) : Math.abs(dy) > 0.9) return;
  const reach = Math.min(Math.max(along, 0.3), 0.75);
  const cx = att.x + fx * reach, cy = Math.max(att.y, def.y) + 0.85, cz = att.z + fz * reach;
  if (lateral > HIT_W) {
    // le coup passe à côté : esquive par un pas de côté (seulement si on était à portée)
    if (along > 0.2 && lateral < HIT_W + 0.8) { att.hitDone = true; pop('ESQUIVE', def.x, def.y + 1.8, def.z, 'miss'); sfx.dodge(); }
    return;
  }
  att.hitDone = true;
  const facingOk = def.fx * fx + def.fz * fz < -0.2;

  if (kind === 'brk') {
    if (def.y > 0.35) { pop('ESQUIVE', def.x, def.y + 1.8, def.z, 'miss'); sfx.dodge(); return; }
    if (def.state === 'block' || def.state === 'parry') { guardBreak(att, def, cx, cy, cz, 6); return; }
    damage(att, def, 14, 5.5, 0.45, cx, cy, cz);
    return;
  }
  if (def.state === 'parry' && def.stateT <= PAR.win && facingOk) { parried(att, def, cx, cy, cz); return; }
  if (def.state === 'block' && facingOk) { blocked(att, def, kind === 'air' ? 34 : 22, cx, cy, cz); return; }
  damage(att, def, kind === 'air' ? 11 : 9, 3.2, 0.3, cx, cy, cz);
}

function push(f, dirF, speed) { f.vx = dirF.fx * speed; f.vz = dirF.fz * speed; }

function damage(att, def, dmg, knock, dur, cx, cy, cz) {
  if (def.state === 'stun') dmg = Math.round(dmg * 1.25);
  def.hp = Math.max(0, def.hp - dmg);
  def.flashCol.setRGB(1, 1, 1); def.flash = 1; def.flinch = 1;
  push(def, att, knock);
  def.airAtk = false;
  emit(cx, cy, cz, 16, { color: [0xffffff, 0xffe27a, 0xff6a4a], speed: 4, up: 3, size: 0.09, life: 0.45, dir: { x: att.fx, z: att.fz }, grav: 9 });
  ring(cx, cy, cz, 0xffffff, 0.9, 0.18);
  pop(`-${dmg}`, def.x, def.y + 1.75, def.z, 'dmg');
  sfx.hit();
  game.shake = Math.max(game.shake, 0.12);
  crowdCheer(0.35 + dmg / 30);
  if (def.hp <= 0) {
    def.die();
    push(def, att, 5);
    game.hitstop = 0.22;
    endRound(att.idx, 'K.O. !');
    return;
  }
  game.hitstop = 0.07;
  if (def.state === 'stun') def.dur = Math.max(def.dur, def.stateT + 0.35);
  else { def.setState('hit', dur); def.play('idle', { fade: 0.05 }); }
}

function blocked(att, def, cost, cx, cy, cz) {
  def.guard -= cost; def.guardT = 0;
  push(def, att, 2.4); push(att, att, -1.4);
  def.flinch = 0.35; def.shieldGlow = 0.6;
  emit(cx, cy, cz, 12, { color: [0xffe27a, 0xffffff, 0xffb02e], speed: 5, up: 2.5, size: 0.06, life: 0.35, dir: { x: -att.fx, z: -att.fz }, grav: 12 });
  sfx.clang();
  game.hitstop = 0.05;
  game.shake = Math.max(game.shake, 0.06);
  if (def.guard <= 0) guardBreak(att, def, cx, cy, cz, 0);
  else crowdCheer(0.15);
}

function guardBreak(att, def, cx, cy, cz, dmg) {
  def.guard = 0; def.guardT = 0;
  def.hp = Math.max(0, def.hp - dmg);
  push(def, att, 4);
  def.flashCol.setRGB(1, 0.55, 0.1); def.flash = 1;
  emit(cx, cy, cz, 22, { color: [0x6fc3ff, 0xffffff, 0xffb04a], speed: 5, up: 3.5, size: 0.1, life: 0.7, dir: { x: att.fx, z: att.fz }, grav: 10 });
  ring(cx, cy, cz, 0xffb04a, 2, 0.4);
  pop('GARDE BRISÉE !', def.x, def.y + 2.0, def.z, 'brk');
  sfx.brk();
  game.hitstop = 0.13;
  game.shake = Math.max(game.shake, 0.25);
  crowdCheer(0.8);
  if (def.hp <= 0) { def.die(); endRound(att.idx, 'K.O. !'); return; }
  def.stun(1.15);
}

function parried(att, def, cx, cy, cz) {
  att.stun(0.95);
  push(att, att, -2.6);
  def.toIdle();
  def.guard = Math.min(100, def.guard + 20);
  def.shieldGlow = 1.5;
  emit(cx, cy, cz, 20, { color: [0x8fd8ff, 0xffffff], speed: 4.5, up: 2.5, size: 0.08, life: 0.5, grav: 4 });
  ring(cx, cy, cz, 0x8fd8ff, 2.4, 0.45);
  ring(cx, cy, cz, 0xffffff, 1.2, 0.25);
  pop('PARADE !', def.x, def.y + 2.0, def.z, 'parry');
  sfx.parry();
  game.hitstop = 0.14;
  game.slow = 0.4; game.slowT = 0.35;
  game.shake = Math.max(game.shake, 0.1);
  crowdCheer(0.7);
}

// =====================================================================
//  Déroulement du match
// =====================================================================
const game = { phase: 'loading', round: 1, wins: [0, 0], timer: ROUND_TIME, t: 0, slow: 1, slowT: 0, hitstop: 0, shake: 0, paused: false, roundWinner: -1, flags: {} };
let F = [];
let ai = null;
let ai0 = null;
const DEMO = new URLSearchParams(location.search).has('demo');
addEventListener('error', (e) => { document.body.dataset.err = e.message; });
const cfg = { mode: 'solo', diff: '1', p1: 'soldier', p2: 'orc', arena: 'colisee' };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('spartiate-cfg') || '{}')); } catch (e) { /* stockage indisponible */ }
const qsArena = new URLSearchParams(location.search).get('arena');
if (qsArena) cfg.arena = qsArena;
if (!ARENAS[cfg.arena]) cfg.arena = 'colisee';

let match = null;           // réglages du combat en cours (en ligne : choisis par l'hôte)

function makeFighters(p1 = cfg.p1, p2 = cfg.p2) {
  F.forEach((f) => f.dispose());
  F = [new Fighter(0, p1), new Fighter(1, p2)];
}
// aperçu du menu : en ligne, on montre le personnage choisi par l'adversaire
function menuFighters() {
  const peer = cfg.mode === 'online' && net.peerKind;
  if (!peer) makeFighters();
  else if (net.role === 'guest') makeFighters(peer, cfg.p1);
  else makeFighters(cfg.p1, peer);
  placeStart(1.4);
}
function placeStart(gap) {
  F[0].reset(-gap, 0, Math.PI / 2);
  F[1].reset(gap, 0, -Math.PI / 2);
  camAng = 0;
}

function startMatch(m = { mode: cfg.mode, p1: cfg.p1, p2: cfg.p2, arena: cfg.arena }) {
  match = m;
  net.live = m.mode === 'online';
  net.ev = []; net.presses = [];
  ac();
  game.paused = false;
  ['menu', 'result', 'pause'].forEach((id) => $(id).classList.add('hidden'));
  $('hud').classList.remove('hidden');
  $('help').classList.remove('hidden');
  $('help').innerHTML = controlsHTML(m.mode, true);
  setupBindings(m.mode, net.live ? net.me : 0);
  if (curArena !== m.arena) buildArena(m.arena);
  makeFighters(m.p1, m.p2);
  ai = m.mode === 'solo' ? new AI(F[1], F[0], +cfg.diff) : null;
  ai0 = DEMO && !net.live ? new AI(F[0], F[1], 2) : null;
  const tags = { solo: [' (Toi)', ' (IA)'], duo: [' (J1)', ' (J2)'], online: net.me ? [' (Hôte)', ' (Toi)'] : [' (Toi)', ' (Invité)'] }[m.mode];
  $('n1').textContent = CHARS[m.p1] + tags[0];
  $('n2').textContent = CHARS[m.p2] + tags[1];
  game.wins = [0, 0];
  game.round = 1;
  if (net.live && net.role === 'guest') {
    // l'invité ne simule rien : il affiche l'état envoyé par l'hôte
    Object.assign(game, { phase: 'intro', t: 0, flags: {}, timer: ROUND_TIME, slow: 1, slowT: 0, hitstop: 0 });
    inputs.forEach((i) => i.clear());
    placeStart(2.6);
    $('fade').classList.remove('on');
    $('roundLbl').textContent = 'ROUND 1 / 3';
  } else startRound();
  snapCamera();
}

function startRound() {
  placeStart(2.6);
  game.phase = 'intro';
  game.t = 0;
  game.flags = {};
  game.timer = ROUND_TIME;
  game.slow = 1; game.slowT = 0; game.hitstop = 0;
  inputs.forEach((i) => i.clear());
  if (ai) { ai.blkT = 0; ai.move = null; ai.think = 0.4; }
  if (ai0) { ai0.blkT = 0; ai0.move = null; ai0.think = 0.4; }
  if (game.round > 1) snapCamera();
  $('fade').classList.remove('on');
  $('roundLbl').textContent = `ROUND ${game.round} / 3`;
  announce(game.round === 3 ? 'ROUND FINAL' : `ROUND ${game.round}`, '', 1.25);
  sfx.gong();
}

function endRound(winner, text) {
  if (game.phase !== 'fight') return;
  game.phase = 'ko';
  game.t = 0;
  game.flags = {};
  game.roundWinner = winner;
  if (winner >= 0) game.wins[winner]++;
  announce(text, 'ko', 1.8);
  if (text === 'K.O. !') { sfx.ko(); game.slow = 0.25; game.slowT = 1.1; arenaHooks.ko?.(); }
  sfx.cheer(1.2);
  crowdCheer(1.4);
}

function endMatch() {
  game.phase = 'end';
  const [a, b] = game.wins;
  const n1 = CHARS[match.p1], n2 = CHARS[match.p2];
  const me = net.live ? net.me : 0;
  const guest = net.live && net.role === 'guest';
  let title;
  if (a === b) title = 'ÉGALITÉ';
  else if (match.mode !== 'duo') title = game.wins[me] > game.wins[1 - me] ? 'VICTOIRE !' : 'DÉFAITE…';
  else title = a > b ? 'JOUEUR 1 GAGNE !' : 'JOUEUR 2 GAGNE !';
  $('resTitle').textContent = title;
  $('resSub').textContent = `${n1}  ${a} – ${b}  ${n2}  ·  ${ARENAS[match.arena].name}` + (guest ? '  ·  l’hôte peut lancer la revanche' : '');
  $('againBtn').classList.toggle('hidden', guest);
  $('result').classList.remove('hidden');
  $('help').classList.add('hidden');
}

// remote : c'est l'adversaire qui a quitté le combat, inutile de le prévenir
function toMenu(remote = false) {
  if (net.live && !remote) netSend({ t: 'menu' });
  net.live = false;
  game.phase = 'menu';
  game.paused = false;
  ['hud', 'help', 'result', 'pause'].forEach((id) => $(id).classList.add('hidden'));
  $('fade').classList.remove('on');
  $('menu').classList.remove('hidden');
  if (curArena !== cfg.arena) buildArena(cfg.arena);
  menuFighters();
  refreshMenu();
}

function togglePause() {
  if (!['intro', 'fight', 'ko'].includes(game.phase)) return;
  game.paused = !game.paused;
  $('pauseTxt').textContent = net.live ? 'En ligne, le combat continue pendant la pause !' : 'Échap pour reprendre';
  $('pause').classList.toggle('hidden', !game.paused);
  if (game.paused) down.clear();
}

function updateGame(dt, rdt) {
  if (!F.length) return;
  if (net.live && net.role === 'guest') { guestUpdate(dt); return; }
  const ph = game.phase;
  game.t += rdt;
  if (game.slowT > 0) { game.slowT -= rdt; if (game.slowT <= 0) game.slow = 1; }

  if (ph === 'fight' || ph === 'intro') {
    readHeld();
    if (ai) ai.update(dt, inputs[1]);
    if (ai0) ai0.update(dt, inputs[0]);
  }
  inputs.forEach((i) => i.tick(dt));
  const canAct = ph === 'fight';
  F[0].update(dt, inputs[0], F[1], canAct);
  F[1].update(dt, inputs[1], F[0], canAct);

  // les combattants ne se traversent pas au sol
  if (F[0].state !== 'dead' && F[1].state !== 'dead' && Math.abs(F[0].y - F[1].y) < 1.0) {
    const dx = F[1].x - F[0].x, dz = F[1].z - F[0].z, d = Math.hypot(dx, dz), ov = 0.9 - d;
    if (ov > 0) {
      const nx = d > 0.001 ? dx / d : F[0].fx, nz = d > 0.001 ? dz / d : F[0].fz;
      F[0].x -= nx * ov / 2; F[0].z -= nz * ov / 2;
      F[1].x += nx * ov / 2; F[1].z += nz * ov / 2;
    }
  }

  if (ph === 'fight') {
    resolve(F[0], F[1]);
    resolve(F[1], F[0]);
    game.timer -= dt;
    if (game.phase === 'fight' && game.timer <= 0) {
      game.timer = 0;
      const [h0, h1] = [F[0].hp, F[1].hp];
      endRound(h0 === h1 ? -1 : (h0 > h1 ? 0 : 1), h0 === h1 ? 'ÉGALITÉ' : 'TEMPS !');
    }
  } else if (ph === 'intro') {
    if (game.t > 1.25 && !game.flags.go) { game.flags.go = true; announce('COMBATTEZ !', '', 0.9); crowdCheer(0.9); sfx.cheer(0.8); }
    if (game.t > 1.55) game.phase = 'fight';
  } else if (ph === 'ko') {
    if (game.t > 1.4 && !game.flags.pose) {
      game.flags.pose = true;
      const w = game.roundWinner;
      if (w >= 0 && F[w].state !== 'dead') F[w].win();
      if (w < 0) F.forEach((f) => { if (f.state !== 'dead') f.toIdle(); });
    }
    if (game.t > 3.4 && !game.flags.fade) { game.flags.fade = true; $('fade').classList.add('on'); }
    if (game.t > 3.75) {
      if (game.wins[0] >= 2 || game.wins[1] >= 2 || game.round >= 3) { $('fade').classList.remove('on'); endMatch(); }
      else { game.round++; startRound(); }
    }
  }

  for (const f of F) { f.mixer.update(dt); f.pose(dt, clockT); }
}

// =====================================================================
//  HUD
// =====================================================================
function updateHud() {
  if (game.phase === 'menu' || !F.length) return;
  F.forEach((f, i) => {
    const n = i + 1;
    const hp = Math.max(0, f.hp);
    $('h' + n).style.width = hp + '%';
    $('h' + n).classList.toggle('low', hp < 30);
    $('t' + n).style.width = hp + '%';
    $('g' + n).style.width = Math.max(0, f.guard) + '%';
    $('g' + n).classList.toggle('low', f.guard < 30);
    $('s' + n).style.width = Math.max(0, f.sta) + '%';
    $('s' + n).classList.toggle('low', f.sta < STA.tired);
    $('s' + n).classList.toggle('fail', f.staFail > 0);
    [...$('w' + n).children].forEach((pip, k) => pip.classList.toggle('on', game.wins[i] > k));
  });
  const tm = Math.ceil(game.timer);
  $('timer').textContent = tm;
  $('timer').classList.toggle('low', tm <= 10);
}

// =====================================================================
//  Caméra : toujours de profil par rapport aux deux combattants,
//  elle tourne autour d'eux quand ils se décalent en profondeur.
// =====================================================================
let camAng = 0;               // angle de la caméra autour du point milieu
const camPos = new THREE.Vector3();
const camTgt = new THREE.Vector3();
function camGoal(dt) {
  if (game.phase === 'menu' || game.phase === 'loading') {
    camAng += dt * 0.12;
    camPos.set(Math.sin(camAng) * 8.6, 3.4, Math.cos(camAng) * 8.6);
    camTgt.set(0, 1.0, 0);
    return;
  }
  const mx = (F[0].x + F[1].x) / 2, mz = (F[0].z + F[1].z) / 2;
  const ux = F[1].x - F[0].x, uz = F[1].z - F[0].z, sep = Math.hypot(ux, uz);
  if (sep > 0.3) {
    // perpendiculaire à l'axe des combattants, du même côté que la caméra actuelle
    let nx = -uz / sep, nz = ux / sep;
    if (nx * Math.sin(camAng) + nz * Math.cos(camAng) < 0) { nx = -nx; nz = -nz; }
    camAng = lerpAng(camAng, Math.atan2(nx, nz), Math.min(1, dt * 3.5));
  }
  const maxY = Math.max(F[0].y, F[1].y);
  let dist = 5.6 + Math.max(0, sep - 2.4) * 0.65;
  let tx = mx, tz = mz;
  if (game.phase === 'ko' && game.roundWinner >= 0 && game.t < 3.3) {
    const l = F[1 - game.roundWinner];
    dist = 4.4; tx = (l.x + mx) / 2; tz = (l.z + mz) / 2;
  }
  if (game.phase === 'end') dist = 5.2;
  let px = tx + Math.sin(camAng) * dist, pz = tz + Math.cos(camAng) * dist;
  let lift = 0;
  const r = Math.hypot(px, pz);
  if (r > CAM_R) { px *= CAM_R / r; pz *= CAM_R / r; lift = (r - CAM_R) * 0.45; }
  camTgt.set(tx, 0.95 + maxY * 0.25, tz);
  camPos.set(px, 2.2 + maxY * 0.2 + lift, pz);
}
function snapCamera() {
  rec('snap', []);
  camGoal(0);
  camera.position.copy(camPos);
  camLook.copy(camTgt);
  camera.lookAt(camLook);
}
function updateCamera(dt) {
  camGoal(dt);
  const k = 1 - Math.exp(-dt * 5);
  camera.position.lerp(camPos, k);
  camLook.lerp(camTgt, k);
  if (game.shake > 0.001) {
    camera.position.x += rand(-1, 1) * game.shake;
    camera.position.y += rand(-1, 1) * game.shake;
    game.shake *= Math.exp(-dt * 9);
  }
  camera.lookAt(camLook);
}

// =====================================================================
//  Boucle
// =====================================================================
let last = performance.now(), clockT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rdt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.phase === 'loading') return;
  if (!game.paused || net.live) step(rdt);
  if (net.live && net.role === 'host') sendSnap();
  renderer.render(scene, camera);
}
function step(rdt) {
  clockT += rdt;
  let dt = rdt * game.slow;
  if (game.hitstop > 0) { game.hitstop -= rdt; dt = 0; }
  updateGame(dt, rdt);
  net.mute = true;     // le décor s'anime de son côté chez chacun
  for (const u of updaters) u(rdt, clockT);
  net.mute = false;
  updateParticles(rdt);
  updateRings(rdt);
  flashV = Math.max(0, flashV - rdt * 3);
  $('flash').style.opacity = flashV;
  updateCamera(rdt);
  updateHud();
}

// =====================================================================
//  Menu
// =====================================================================
function saveCfg() { try { localStorage.setItem('spartiate-cfg', JSON.stringify(cfg)); } catch (e) { /* ignoré */ } }
function refreshMenu() {
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.val === String(cfg[seg.dataset.key])));
  });
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('on', c.dataset.val === cfg.arena));
  const online = cfg.mode === 'online';
  $('diffSec').classList.toggle('hidden', cfg.mode !== 'solo');
  $('netSec').classList.toggle('hidden', !online);
  $('p2Sec').classList.toggle('hidden', online);
  $('arenaSec').classList.toggle('hidden', online && net.role === 'guest');
  $('p1Lbl').textContent = online ? 'Ton personnage' : 'Joueur 1';
  refreshGo();
  $('p2Lbl').textContent = cfg.mode === 'solo' ? 'Adversaire (IA)' : 'Joueur 2';
  $('keysMenu').innerHTML = controlsHTML(cfg.mode, false) +
    `<div class="row" style="margin-top:8px"><b>Astuces :</b> l'arène est en 3D : bouge dans toutes les directions, la caméra tourne autour du combat · un <b>pas de côté</b> (${lab('KeyW')} / ${lab('KeyS')}) fait rater les coups lents · le blocage use ta garde · la <b>parade</b> au bon moment étourdit l'attaquant · <b>briser la garde</b> traverse blocage et parade, mais on l'esquive en <b>sautant</b>, en se décalant ou en frappant en premier · pris dans un enchaînement ? fais une <b>roulade</b> (invincible pendant la rotation) · la <b>barre verte</b> est ton endurance : attaques, roulades, sauts et parades en consomment, laisse-la remonter · Échap = pause</div>`;
}
function setupMenu() {
  const cards = $('arenaCards');
  for (const [id, a] of Object.entries(ARENAS)) {
    const b = document.createElement('button');
    b.className = 'card';
    b.dataset.val = id;
    b.innerHTML = `<div class="sw" style="background:${a.sw}"></div><b>${a.name}</b><span>${a.desc}</span>`;
    b.onclick = () => { cfg.arena = id; saveCfg(); refreshMenu(); buildArena(id); };
    cards.appendChild(b);
  }
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const key = seg.dataset.key;
        cfg[key] = b.dataset.val;
        saveCfg();
        if (key === 'mode' && cfg.mode !== 'online' && net.ws) { netClose(); netInfo('Partie en ligne quittée.'); }
        if (key === 'p1') netSend({ t: 'hello', kind: cfg.p1 });
        refreshMenu();
        if (key === 'p1' || key === 'p2' || key === 'mode') menuFighters();
      };
    });
  });
  $('go').onclick = () => (cfg.mode === 'online' ? netStart() : startMatch());
  $('againBtn').onclick = () => (match?.mode === 'online' ? netStart() : startMatch());
  $('menuBtn').onclick = () => toMenu();
  $('resumeBtn').onclick = togglePause;
  $('quitBtn').onclick = () => toMenu();
  $('hostBtn').onclick = () => { netInfo('Création de la partie…'); netConnect({ t: 'create' }); };
  $('joinBtn').onclick = () => {
    const code = $('codeIn').value.trim().toUpperCase();
    if (!code) { netInfo('Entre le code donné par ton ami.'); return; }
    netInfo('Connexion…');
    netConnect({ t: 'join', code });
  };
  $('codeIn').onkeydown = (e) => { if (e.key === 'Enter') $('joinBtn').click(); };
  $('soundBtn').onclick = () => { soundOn = !soundOn; $('soundBtn').textContent = 'Son : ' + (soundOn ? 'activé' : 'coupé'); };
  refreshMenu();
}

// =====================================================================
//  En ligne (réseau local) : serveur.py relaie les messages entre l'hôte
//  (joueur 1, qui fait tourner le combat) et l'invité (joueur 2).
// =====================================================================
function netInfo(html) { $('netInfo').innerHTML = html; }
function netSend(m) { if (net.ws?.readyState === 1) net.ws.send(JSON.stringify(m)); }
function netClose() {
  const ws = net.ws;
  Object.assign(net, { ws: null, role: null, me: 0, peer: false, peerKind: null });
  if (ws) ws.close();
}
function netConnect(first) {
  netClose();
  ac();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  net.ws = ws;
  let opened = false;
  ws.onopen = () => { opened = true; ws.send(JSON.stringify(first)); };
  ws.onmessage = (e) => { if (net.ws === ws) netMsg(JSON.parse(e.data)); };
  ws.onclose = () => {
    if (net.ws !== ws) return;
    const wasLive = net.live;
    netClose();
    if (wasLive) toMenu(true);
    netInfo(opened ? 'Connexion perdue avec le serveur.'
      : 'Impossible de joindre le serveur de jeu. Lance le jeu avec <b>jouer.bat</b> sur le PC qui crée la partie.');
    refreshMenu();
  };
}
function hostInfo() {
  const urls = net.urls.map((u) => `<b>${u}</b>`).join(' ou ');
  return `Code de la partie : <span class="code">${net.code}</span><br>Ton ami (sur le même Wi-Fi) ouvre ${urls || 'l’adresse de ce PC'} dans son navigateur, choisit « En ligne » et entre ce code.`;
}
function refreshGo() {
  let txt = 'COMBATTRE', ok = true;
  if (cfg.mode === 'online') {
    if (net.role === 'host') { ok = net.peer; if (!ok) txt = 'En attente d’un adversaire…'; }
    else { ok = false; txt = net.role === 'guest' ? 'L’hôte va lancer le combat…' : 'Crée ou rejoins une partie'; }
  }
  $('go').textContent = txt;
  $('go').disabled = !ok;
}
function netStart() {
  if (net.role !== 'host' || !net.peer) return;
  const m = { mode: 'online', p1: cfg.p1, p2: net.peerKind || 'soldier', arena: cfg.arena };
  netSend({ t: 'start', ...m });
  startMatch(m);
}

// hôte → invité : état du combat + effets survenus depuis le dernier envoi
function sendSnap() {
  const g = game;
  netSend({
    t: 's',
    g: { phase: g.phase, round: g.round, wins: g.wins, timer: g.timer, t: g.t, slow: g.slow, hitstop: g.hitstop, shake: g.shake, roundWinner: g.roundWinner, flags: g.flags },
    f: F.map((f) => ({
      v: { x: f.x, y: f.y, z: f.z, yaw: f.yaw, visTarget: f.visTarget, state: f.state, stateT: f.stateT, dur: f.dur, hp: f.hp, guard: f.guard,
        sta: f.sta, staFail: f.staFail, flash: f.flash, shieldGlow: f.shieldGlow, flinch: f.flinch, rollDir: f.rollDir },
      st: f.stars.visible, fc: f.flashCol.toArray(),
    })),
    e: net.ev,
  });
  net.ev = [];
}
const EV = {
  sfx: (k, ...a) => sfx[k]?.(...a),
  emit, ring, pop, announce,
  cheer: crowdCheer,
  play: (i, name, o) => F[i]?.play(name, o),
  reset: (i, x, z, yaw) => F[i]?.reset(x, z, yaw),
};
function applySnap(m) {
  const prev = game.phase;
  let snap = false;
  for (const [k, a] of m.e) {
    if (k === 'snap') snap = true;
    else if (Object.hasOwn(EV, k)) EV[k](...a);
  }
  Object.assign(game, m.g);
  m.f.forEach((s, i) => {
    const f = F[i];
    if (!f) return;
    Object.assign(f, s.v);
    f.stars.visible = s.st;
    f.flashCol.fromArray(s.fc);
  });
  if (snap) snapCamera();
  if (game.phase === 'end' && prev !== 'end') endMatch();
  $('fade').classList.toggle('on', game.phase === 'ko' && !!game.flags.fade);
  $('roundLbl').textContent = `ROUND ${game.round} / 3`;
}
// invité : on envoie ses commandes, on anime ce que l'hôte a calculé
function guestUpdate(dt) {
  readHeld();
  const inp = inputs[1];
  netSend({ t: 'in', mx: inp.mx, mz: inp.mz, blk: inp.blk, p: net.presses });
  net.presses = [];
  for (const f of F) { f.stateT += dt; f.mixer.update(dt); f.pose(dt, clockT); }
}
function remoteInput(m) {
  const inp = inputs[1];
  let mx = +m.mx || 0, mz = +m.mz || 0;
  const n = Math.hypot(mx, mz);
  if (n > 1) { mx /= n; mz /= n; }
  inp.mx = mx; inp.mz = mz;
  inp.blk = !!m.blk;
  if (Array.isArray(m.p)) for (const a of m.p) if (Object.hasOwn(inp.buf, a)) inp.press(a);
}
function netMsg(m) {
  if (m.t === 's') { if (net.live && net.role === 'guest') applySnap(m); return; }
  if (m.t === 'in') { if (net.live && net.role === 'host') remoteInput(m); return; }
  switch (m.t) {
    case 'created':
      Object.assign(net, { role: 'host', me: 0, code: m.code, urls: m.urls || [] });
      netInfo(hostInfo() + '<br>En attente d’un adversaire…');
      break;
    case 'joined':
      Object.assign(net, { role: 'guest', me: 1, code: m.code, peer: true });
      netSend({ t: 'hello', kind: cfg.p1 });
      netInfo(`Connecté à la partie <b>${m.code}</b> ! L’hôte choisit l’arène et lance le combat.`);
      break;
    case 'peer':
      net.peer = true;
      netSend({ t: 'hello', kind: cfg.p1 });
      netInfo(`Un adversaire a rejoint la partie <b>${net.code}</b> ! Choisis l’arène puis clique sur COMBATTRE.`);
      break;
    case 'hello':
      net.peerKind = CHARS[m.kind] ? m.kind : 'soldier';
      if (game.phase === 'menu') menuFighters();
      break;
    case 'start':
      if (net.role === 'guest' && CHARS[m.p1] && CHARS[m.p2] && ARENAS[m.arena])
        startMatch({ mode: 'online', p1: m.p1, p2: m.p2, arena: m.arena });
      break;
    case 'menu':
      if (!net.live) break;
      toMenu(true);
      netInfo('L’adversaire est revenu au menu.' + (net.role === 'host' ? ' Clique sur COMBATTRE pour relancer.' : ''));
      break;
    case 'bye':
      if (net.live) toMenu(true);
      if (net.role === 'host') {
        Object.assign(net, { peer: false, peerKind: null });
        if (game.phase === 'menu') menuFighters();
        netInfo('L’adversaire a quitté la partie.<br>' + hostInfo());
      } else {
        netClose();
        if (game.phase === 'menu') menuFighters();
        netInfo('L’hôte a fermé la partie.');
      }
      break;
    case 'error':
      netClose();
      netInfo(m.msg);
      break;
  }
  refreshMenu();
}

// =====================================================================
//  Démarrage
// =====================================================================
async function boot() {
  try { layout = await navigator.keyboard?.getLayoutMap?.(); } catch (e) { layout = null; }
  const loader = new GLTFLoader();
  const keys = Object.keys(FILES);
  let done = 0;
  try {
    await Promise.all(keys.map((k) => loader.loadAsync(encodeURI(FILES[k])).then((g) => {
      G[k] = g;
      $('lp').style.width = (++done / keys.length * 100) + '%';
    })));
  } catch (err) {
    const e = $('lerr');
    e.classList.remove('hidden');
    e.innerHTML = location.protocol === 'file:'
      ? 'Le jeu doit être lancé via un petit serveur local.<br>Double-clique sur <b>jouer.bat</b> dans le dossier du jeu.'
      : 'Impossible de charger les modèles : ' + (err?.message || err);
    console.error(err);
    return;
  }
  setupMenu();
  buildArena(cfg.arena);
  $('loading').classList.add('hidden');
  toMenu();
  if (new URLSearchParams(location.search).has('fight') || DEMO) startMatch();
  const sim = +new URLSearchParams(location.search).get('sim');
  for (let i = 0; i < sim * 60; i++) step(1 / 60);
}
requestAnimationFrame(frame);
boot();
