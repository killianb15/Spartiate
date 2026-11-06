import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Sim, DT, PRESS, NEUTRAL, quant, BRK, ROLL, STA } from './sim.js';
import { AI } from './ai.js';
import { Rollback } from './rollback.js';
import { Link } from './net.js';

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
const CAM_R = 9.2;        // la caméra reste à l'intérieur des murs
const v1 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();

// En ligne : les deux navigateurs font tourner la même simulation (sim.js) et s'échangent
// leurs touches ; rollback.js corrige les prédictions. Voir net.js pour le transport.
const net = { ws: null, link: null, role: null, me: 0, live: false, code: '', urls: [], peer: false, peerKind: null };

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
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
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
  constructor() { this.list = []; this.ambT = 0; this.tick = 0; this.owed = [0, 0]; }
  add(x, y, z, kinds, base = 'idle', s = 1.25, ry = 0) {
    const k = pick(kinds);
    const o = P(k, x, y, z, ry + rand(-0.25, 0.25), s);
    o.traverse((m) => { if (m.isMesh) m.castShadow = false; });   // la foule est loin : ses ombres ne se voient pas et coûtent un dessin de plus par spectateur
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
    // squelettes : une moitié des spectateurs par image, donc 30 Hz chacun (invisible de loin, deux fois moins de calcul)
    this.tick ^= 1;
    this.owed[0] += dt; this.owed[1] += dt;
    const step = this.owed[this.tick];      // temps écoulé depuis la dernière mise à jour de cette moitié
    this.owed[this.tick] = 0;
    for (let i = 0; i < this.list.length; i++) {
      const s = this.list[i];
      if ((i & 1) !== this.tick) { s.o.position.y = s.baseY + this.jumpOf(s, t); continue; }
      s.ex = Math.max(0, s.ex - step * 0.45);
      const want = s.ex > 0.4 ? 'emote-yes' : s.base;
      if (want !== s.cur) {
        const a = s.acts[want];
        a.reset().play();
        s.acts[s.cur].crossFadeTo(a, 0.2, false);
        s.cur = want;
      }
      s.mx.update(step * (1 + s.ex * 0.4));
      s.o.position.y = s.baseY + this.jumpOf(s, t);
    }
  }
  jumpOf(s, t) { return s.sit && s.ex < 0.4 ? 0 : Math.abs(Math.sin(t * 8 + s.ph)) * 0.24 * Math.min(1, Math.max(0, s.ex - 0.3) * 1.6); }
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
const qBlock = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -1.2, -0.35));
const ringFoot = new THREE.RingGeometry(0.42, 0.56, 36).rotateX(-Math.PI / 2);
const starGeo = new THREE.OctahedronGeometry(0.075);
const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14a, toneMapped: false });

// Vue d'un combattant : modèle 3D, animations et effets visuels. Tout ce qui touche au
// gameplay est dans sim.js ; ici on ne fait que LIRE l'état de la simulation (sf).
class FighterView {
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
    this.stars.visible = false;
    this.root.add(this.stars);
    this.flashCol = new THREE.Color(1, 1, 1);
    this.cur = null;
    this.flash = 0; this.shieldGlow = 0; this.bw = 0; this.flinch = 0; this.vyaw = 0;
    this.seenReset = -1; this.seenAnim = '';
    this.px = this.py = this.pz = 0;       // position à l'image de simulation précédente (interpolation)
    this.rx = this.ry = this.rz = 0;       // position affichée
    this.snapPos = true;
  }
  dispose() { scene.remove(this.root, this.ring); }

  // à appeler avant chaque image de simulation
  capture(sf) { this.px = sf.x; this.py = sf.y; this.pz = sf.z; }

  applyReset(sf) {
    this.model.rotation.set(0, sf.yaw, 0);
    this.pivot.quaternion.identity();
    this.mixer.stopAllAction();
    this.cur = null;
    this.flash = this.flinch = this.shieldGlow = 0;
    this.vyaw = sf.yaw;
    this.stars.visible = false;
    this.snapPos = true;
    this.play('idle', { fade: 0 });
    this.mixer.update(rand(0, 1));
  }
  play(name, o = {}) {
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
  // effets visuels déclenchés par la simulation (événements 'fx')
  fx(kind) {
    switch (kind) {
      case 'hit': this.flashCol.setRGB(1, 1, 1); this.flash = 1; this.flinch = 1; break;
      case 'gbreak': this.flashCol.setRGB(1, 0.55, 0.1); this.flash = 1; break;
      case 'blocked': this.flinch = 0.35; this.shieldGlow = 0.6; break;
      case 'parried': this.shieldGlow = 1.5; break;
      case 'parryUp': this.shieldGlow = 1; break;
      case 'noFlinch': this.flinch = 0; break;
    }
  }

  // sf : état de simulation de ce combattant ; dt : durée « de jeu » écoulée (ralenti/arrêt sur image inclus)
  render(sf, dt, T, alpha) {
    if (sf.resetN !== this.seenReset) { this.seenReset = sf.resetN; this.applyReset(sf); this.seenAnim = ''; }
    const key = sf.animN + '|' + sf.anim + '|' + sf.animTs;
    if (key !== this.seenAnim) {
      this.seenAnim = key;
      this.play(sf.anim, { ts: sf.animTs, loop: sf.animLoop, restart: sf.animRestart, fade: sf.animFade });
    }
    if (this.snapPos) { this.px = sf.x; this.py = sf.y; this.pz = sf.z; this.snapPos = false; }
    this.rx = this.px + (sf.x - this.px) * alpha;
    this.ry = this.py + (sf.y - this.py) * alpha;
    this.rz = this.pz + (sf.z - this.pz) * alpha;
    this.stars.visible = sf.state === 'stun';
    if (sf.state === 'brk' && sf.stateT < BRK.start) {
      this.flashCol.setRGB(1, 0.42, 0.05);
      this.flash = Math.max(this.flash, 0.35 + 0.3 * Math.sin(sf.stateT * 45));
    }
    this.mixer.update(dt);
    this.pose(sf, dt, T);
  }

  pose(sf, dt, T) {
    const st = sf.state;
    const wantB = (st === 'block' || st === 'parry') ? 1 : 0;
    this.bw += (wantB - this.bw) * Math.min(1, dt * (st === 'parry' ? 32 : 16));
    if (this.bw > 0.01) this.armL.quaternion.slerp(qBlock, this.bw);
    if (this.flinch > 0) { this.torso.rotateX(-0.55 * this.flinch); this.flinch = Math.max(0, this.flinch - dt * 4); }

    this.vyaw = lerpAng(this.vyaw, sf.visTarget, Math.min(1, dt * 14));
    this.model.rotation.y = this.vyaw;
    this.model.rotation.z = st === 'stun' ? Math.sin(T * 7) * 0.1 : 0;
    if (st === 'roll') {
      const k = Math.min(1, sf.stateT / (ROLL.dur * 0.85));
      v1.set(sf.rdz, 0, -sf.rdx);
      this.pivot.quaternion.setFromAxisAngle(v1, (1 - (1 - k) * (1 - k)) * TAU);
    } else this.pivot.quaternion.identity();
    this.root.position.set(this.rx, this.ry, this.rz);
    this.root.updateMatrixWorld(true);
    this.armL.getWorldQuaternion(q1);
    this.model.getWorldQuaternion(q2);
    this.shield.quaternion.copy(q1.invert().multiply(q2));

    this.flash = Math.max(0, this.flash - dt * 4);
    for (const m of this.mats) m.emissive.copy(this.flashCol).multiplyScalar(this.flash);
    this.shieldGlow = Math.max(0, this.shieldGlow - dt * 3);
    const bg = st === 'block' ? 0.12 : 0;
    for (const m of this.shieldMats) m.emissive.setRGB(0.5 * this.shieldGlow + bg * 0.4, 0.8 * this.shieldGlow + bg * 0.7, this.shieldGlow + bg);

    this.stars.rotation.y = T * 5;
    this.ring.position.set(this.rx, 0.03, this.rz);
    this.ring.material.opacity = st === 'dead' ? 0 : 0.75 - Math.min(0.5, this.ry * 0.25);
  }
}

// =====================================================================
//  Entrées
// =====================================================================
// Touches maintenues et touches pressées depuis la dernière image de simulation
const held = [{}, {}];
const pending = [0, 0];   // bits PRESS

// Chaque action a 2 emplacements de touche (null = vide). En solo et en ligne,
// les deux jeux de touches contrôlent le même personnage.
const DEFAULT_KEYSETS = [
  { l: ['KeyA', null], r: ['KeyD', null], u: ['KeyW', null], d: ['KeyS', null], jump: ['Space', null], atk: ['KeyF', null], blk: ['KeyG', null], par: ['KeyH', null], brk: ['KeyR', null], roll: ['KeyE', 'ShiftLeft'] },
  { l: ['ArrowLeft', null], r: ['ArrowRight', null], u: ['ArrowUp', null], d: ['ArrowDown', null], jump: ['KeyO', 'Numpad0'], atk: ['KeyK', 'Numpad1'], blk: ['KeyL', 'Numpad2'], par: ['Semicolon', 'Numpad3'], brk: ['KeyI', 'Numpad4'], roll: ['KeyJ', 'Numpad5'] },
];
const ACTIONS = [
  ['u', 'Haut (pas vers le fond)'], ['d', 'Bas (pas vers l\'avant)'], ['l', 'Gauche'], ['r', 'Droite'],
  ['jump', 'Sauter'], ['atk', 'Attaquer'], ['blk', 'Bloquer (maintenir)'], ['par', 'Parer'],
  ['brk', 'Briser la garde'], ['roll', 'Roulade'],
];
const KEYS_STORE = 'spartiate-touches';
const RESERVED = ['Escape'];   // Échap = pause, non configurable
const cloneKeys = (sets) => sets.map((set) => Object.fromEntries(Object.entries(set).map(([a, c]) => [a, [...c]])));
function loadKeys() {
  const sets = cloneKeys(DEFAULT_KEYSETS);
  try {
    const saved = JSON.parse(localStorage.getItem(KEYS_STORE) || 'null');
    if (Array.isArray(saved)) sets.forEach((set, i) => {
      for (const act in set) {
        const c = saved[i]?.[act];
        if (Array.isArray(c)) set[act] = [0, 1].map((k) => (typeof c[k] === 'string' && !RESERVED.includes(c[k]) ? c[k] : null));
      }
    });
  } catch (e) { /* stockage indisponible ou corrompu : touches par défaut */ }
  return sets;
}
function saveKeys() { try { localStorage.setItem(KEYS_STORE, JSON.stringify(KEYSETS)); } catch (e) { /* ignoré */ } }
let KEYSETS = loadKeys();
const key1 = (set, act) => set[act].find(Boolean);   // première touche définie
const HELD = ['l', 'r', 'u', 'd', 'blk'];
let bindings = new Map();   // code -> [[joueur, action], ...]
function setupBindings(mode, me = 0) {
  bindings = new Map();
  KEYSETS.forEach((set, i) => {
    const player = mode === 'duo' ? i : me;
    for (const [act, codes] of Object.entries(set))
      for (const c of codes) {
        if (!c) continue;
        if (!bindings.has(c)) bindings.set(c, []);
        bindings.get(c).push([player, act]);
      }
  });
}
const down = new Set();

// étiquettes des touches selon la disposition réelle du clavier (AZERTY par défaut)
let layout = null;
const AZERTY = { KeyA: 'Q', KeyW: 'Z', KeyQ: 'A', KeyZ: 'W', Semicolon: 'M' };
const SPECIAL = {
  Space: 'Espace', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  ShiftLeft: 'Maj', ShiftRight: 'Maj droite', ControlLeft: 'Ctrl', ControlRight: 'Ctrl droite',
  AltLeft: 'Alt', AltRight: 'Alt Gr', MetaLeft: 'Win', MetaRight: 'Win droite', ContextMenu: 'Menu',
  Enter: 'Entrée', NumpadEnter: 'Pavé Entrée', Tab: 'Tab', Backspace: 'Retour', CapsLock: 'Verr. Maj',
  Insert: 'Inser', Delete: 'Suppr', Home: 'Début', End: 'Fin', PageUp: 'Page ↑', PageDown: 'Page ↓',
  NumpadAdd: 'Pavé +', NumpadSubtract: 'Pavé −', NumpadMultiply: 'Pavé ×', NumpadDivide: 'Pavé /', NumpadDecimal: 'Pavé .',
};
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
function lab(code) {
  if (!code) return '—';
  if (SPECIAL[code]) return SPECIAL[code];
  if (/^Numpad\d$/.test(code)) return 'Pavé ' + code.slice(6);
  const k = layout?.get(code);
  if (k) return k.toUpperCase();
  return AZERTY[code] ?? code.replace(/^(Key|Digit)/, '');
}
const kb = (code) => `<kbd>${esc(lab(code))}</kbd>`;
function controlsHTML(mode, compact) {
  const a = KEYSETS[0], b = KEYSETS[1];
  if (mode !== 'duo') {
    // une action : touche du jeu 2 (main droite), sinon du jeu 1
    const one = (act) => kb(key1(b, act) ?? key1(a, act));
    const move = (s) => ['u', 'l', 'd', 'r'].map((act) => kb(key1(s, act))).join('');
    const rows = [
      `<b>Se déplacer</b> ${move(a)} ou ${move(b)} · <b>Sauter</b> ${kb(key1(a, 'jump') ?? key1(b, 'jump'))} · <b>Roulade</b> ${one('roll')}`,
      `<b>Attaquer</b> ${one('atk')} · <b>Bloquer</b> ${one('blk')} (maintenir) · <b>Parer</b> ${one('par')} · <b>Briser la garde</b> ${one('brk')}`,
    ];
    if (!compact) rows.push(`<span>(ou ${['atk', 'blk', 'par', 'brk', 'roll'].map((act) => kb(key1(a, act))).join(' ')} de la main gauche)</span>`);
    return rows.map((r) => `<div class="row">${r}</div>`).join('');
  }
  const p = (s, n) => `<b style="color:${n ? '#a8d4ff' : '#ffb3a8'}">J${n + 1}</b> ${['u', 'l', 'd', 'r'].map((act) => kb(key1(s, act))).join('')} saut ${kb(key1(s, 'jump'))} · att. ${kb(key1(s, 'atk'))} · bloc ${kb(key1(s, 'blk'))} · parer ${kb(key1(s, 'par'))} · briser ${kb(key1(s, 'brk'))} · roulade ${kb(key1(s, 'roll'))}`;
  return `<div class="row">${p(a, 0)}</div><div class="row">${p(b, 1)}</div>`;
}

addEventListener('keydown', (e) => {
  if (keysEditorKey(e)) return;
  if (e.target instanceof HTMLInputElement) return;
  if (bindings.has(e.code) || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.code === 'Escape') { togglePause(); return; }
  if (e.repeat) return;
  down.add(e.code);
  const b = bindings.get(e.code);
  if (b && !game.paused) for (const [pl, act] of b) if (act in PRESS) pending[pl] |= PRESS[act];
});
addEventListener('keyup', (e) => down.delete(e.code));
addEventListener('blur', () => down.clear());

// déplacements relatifs à la caméra : ← → le long de l'écran, ↑ ↓ en profondeur (pas de côté)
// Entrée d'un joueur pour la prochaine image de simulation (déplacement quantifié, identique chez les deux joueurs)
function localInput(pl) {
  const h = held[pl];
  for (const k of HELD) h[k] = false;
  if (!game.paused) for (const code of down) {
    const b = bindings.get(code);
    if (!b) continue;
    for (const [p, act] of b) if (p === pl && HELD.includes(act)) h[act] = true;
  }
  const rx = Math.cos(camAng), rz = -Math.sin(camAng);   // droite de l'écran
  const fx = -Math.sin(camAng), fz = -Math.cos(camAng);  // vers le fond de l'écran
  const hh = (h.r ? 1 : 0) - (h.l ? 1 : 0), v = (h.u ? 1 : 0) - (h.d ? 1 : 0);
  let mx = rx * hh + fx * v, mz = rz * hh + fz * v;
  const n = Math.hypot(mx, mz);
  if (n > 1) { mx /= n; mz /= n; }
  const press = pending[pl];
  pending[pl] = 0;
  return { mx: quant(mx), mz: quant(mz), blk: !!h.blk, press };
}

// =====================================================================
//  Déroulement du match
// =====================================================================
let sim = new Sim(1);          // simulation du combat (remplacée à chaque match)
let rb = null;                 // rollback réseau (en ligne uniquement)
// État de la partie côté interface ; le reste est lu dans la simulation (sim.g)
const game = {
  loading: true, paused: false, shake: 0,
  get phase() { return this.loading ? 'loading' : sim.g.phase; },
  get round() { return sim.g.round; },
  get wins() { return sim.wins; },
  get timer() { return sim.g.timer; },
  get t() { return sim.g.t; },
  get roundWinner() { return sim.g.roundWinner; },
};
let F = [];                    // vues des combattants
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
  F = [new FighterView(0, p1), new FighterView(1, p2)];
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
  sim.placeStart(gap);
  camAng = 0;
}

// Ce que la simulation veut faire voir/entendre (elle-même ne touche ni au son ni à l'affichage)
function playEvents(evs) {
  for (const e of evs) {
    switch (e[0]) {
      case 'sfx': sfx[e[1]]?.(...e.slice(2)); break;
      case 'emit': emit(e[1], e[2], e[3], e[4], e[5]); break;
      case 'ring': ring(e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]); break;
      case 'pop': pop(e[1], e[2], e[3], e[4], e[5]); break;
      case 'announce': announce(e[1], e[2], e[3]); break;
      case 'cheer': crowd?.cheer(e[1]); break;
      case 'fx': F[e[1]]?.fx(e[2]); break;
      case 'shake': game.shake = Math.max(game.shake, e[1]); break;
      case 'ko': arenaHooks.ko?.(); break;
      case 'round':
        ai?.reset(); ai0?.reset();
        camAng = 0;
        if (e[1] > 1) snapCamera();
        $('roundLbl').textContent = `ROUND ${e[1]} / 3`;
        break;
      case 'end': endMatch(); break;
    }
  }
}

function startMatch(m = { mode: cfg.mode, p1: cfg.p1, p2: cfg.p2, arena: cfg.arena }) {
  match = m;
  net.live = m.mode === 'online';
  ac();
  game.paused = false;
  ['menu', 'result', 'pause'].forEach((id) => $(id).classList.add('hidden'));
  $('hud').classList.remove('hidden');
  $('help').classList.remove('hidden');
  $('help').innerHTML = controlsHTML(m.mode, true);
  setupBindings(m.mode, net.live ? net.me : 0);
  if (curArena !== m.arena) buildArena(m.arena);
  const seed = (m.seed ?? Math.random() * 4294967296) >>> 0;
  sim = new Sim(seed);
  makeFighters(m.p1, m.p2);
  ai = m.mode === 'solo' ? new AI(sim, 1, +cfg.diff, seed ^ 0x9e3779b9) : null;
  ai0 = DEMO && !net.live ? new AI(sim, 0, 2, seed ^ 0x85ebca6b) : null;
  const tags = { solo: [' (Toi)', ' (IA)'], duo: [' (J1)', ' (J2)'], online: net.me ? [' (Hôte)', ' (Toi)'] : [' (Toi)', ' (Invité)'] }[m.mode];
  $('n1').textContent = CHARS[m.p1] + tags[0];
  $('n2').textContent = CHARS[m.p2] + tags[1];
  $('fade').classList.remove('on');
  pending[0] = pending[1] = 0;
  sim.startMatch();
  playEvents(sim.ev);
  sim.ev.length = 0;
  rb = net.live ? new Rollback(sim, {
    me: net.me,
    send: (msg, reliable) => (net.link ? net.link.send(msg, reliable) : netSend(msg)),
    onDesync: (d) => console.warn('Désynchronisation détectée à l\'image', d.frame, d.me === 0 ? '(resynchronisation envoyée)' : ''),
  }) : null;
  acc = 0;
  snapCamera();
}

function endMatch() {
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
  rb = null;
  sim.g.phase = 'menu';
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

// Une image de simulation (1/60 s). Retourne false si on doit attendre l'adversaire (en ligne).
function simTick() {
  for (let i = 0; i < 2; i++) F[i]?.capture(sim.f[i]);
  if (rb) {
    if (!rb.tick(localInput(net.me))) return false;
    playEvents(rb.takeEvents());
    return true;
  }
  const ph = sim.g.phase;
  let i0 = NEUTRAL, i1 = NEUTRAL;
  if (ph === 'fight' || ph === 'intro') {
    const dt = sim.effectiveDt();
    i0 = ai0 ? ai0.update(dt) : localInput(0);
    i1 = ai ? ai.update(dt) : (match?.mode === 'duo' ? localInput(1) : NEUTRAL);
  } else if (ph !== 'menu') { pending[0] = pending[1] = 0; }
  sim.step(i0, i1);
  playEvents(sim.ev);
  sim.ev.length = 0;
  return true;
}

// =====================================================================
//  HUD
// =====================================================================
function updateHud() {
  if (game.phase === 'menu' || !F.length) return;
  sim.f.forEach((f, i) => {
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
  const mx = (F[0].rx + F[1].rx) / 2, mz = (F[0].rz + F[1].rz) / 2;
  const ux = F[1].rx - F[0].rx, uz = F[1].rz - F[0].rz, sep = Math.hypot(ux, uz);
  if (sep > 0.3) {
    // perpendiculaire à l'axe des combattants, du même côté que la caméra actuelle
    let nx = -uz / sep, nz = ux / sep;
    if (nx * Math.sin(camAng) + nz * Math.cos(camAng) < 0) { nx = -nx; nz = -nz; }
    camAng = lerpAng(camAng, Math.atan2(nx, nz), Math.min(1, dt * 3.5));
  }
  const maxY = Math.max(F[0].ry, F[1].ry);
  let dist = 5.6 + Math.max(0, sep - 2.4) * 0.65;
  let tx = mx, tz = mz;
  if (game.phase === 'ko' && game.roundWinner >= 0 && game.t < 3.3) {
    const l = F[1 - game.roundWinner];
    dist = 4.4; tx = (l.rx + mx) / 2; tz = (l.rz + mz) / 2;
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
let last = performance.now(), clockT = 0, acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000;
  const rdt = Math.min(0.05, raw);
  last = now;
  if (game.phase === 'loading') return;
  adaptResolution(raw);
  if (!game.paused || net.live) step(rdt);
  renderer.render(scene, camera);
}

// Résolution dynamique : si la machine peine, on baisse la définition du rendu (jamais celle du jeu) ;
// si elle a de la marge pendant un moment, on la remonte.
let pixelRatio = Math.min(devicePixelRatio, 1.5), resAvg = 16, resN = 0, resGood = 0;
const maxPixelRatio = pixelRatio;
function adaptResolution(raw) {
  resAvg += (Math.min(raw, 0.1) * 1000 - resAvg) * 0.06;
  if (++resN % 90) return;
  let pr = pixelRatio;
  if (resAvg > 20) { pr = Math.max(0.6, pr - 0.25); resGood = 0; }      // sous ~50 images/s : on baisse la définition
  else if (resAvg < 17.5 && ++resGood >= 4) { pr = Math.min(maxPixelRatio, pr + 0.25); resGood = 0; }
  if (pr !== pixelRatio) { pixelRatio = pr; renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight); }
}

// Boucle à pas fixe : la simulation avance par images de 1/60 s quel que soit l'écran (60, 144 Hz…),
// l'affichage interpole entre deux images de simulation.
function step(rdt) {
  clockT += rdt;
  acc = Math.min(acc + rdt, 0.1);
  let n = 0;
  while (acc >= DT && n < 6) {
    if (!simTick()) break;       // en ligne : on attend l'adversaire (le temps non simulé est conservé)
    acc -= DT; n++;
  }
  const g = sim.g, alpha = Math.min(1, acc / DT);
  const animDt = g.hitstop > 0 ? 0 : rdt * g.slow;
  F.forEach((f, i) => f.render(sim.f[i], animDt, clockT, alpha));
  for (const u of updaters) u(rdt, clockT);
  updateParticles(rdt);
  updateRings(rdt);
  flashV = Math.max(0, flashV - rdt * 3);
  $('flash').style.opacity = flashV;
  updateCamera(rdt);
  updateHud();
  syncUi();
}

// éléments d'interface qui suivent l'état de la simulation (écrits seulement quand ils changent)
let uiFade = false, uiNet = '';
function syncUi() {
  const fade = game.phase === 'ko' && sim.g.flagFade;
  if (fade !== uiFade) { uiFade = fade; $('fade').classList.toggle('on', fade); }
  const txt = rb ? `${net.link?.state === 'rtc' ? 'direct' : 'relais'} · ↺ ${rb.stats.rollbacks}` : '';
  if (txt !== uiNet) { uiNet = txt; $('netStat').textContent = txt; }
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
    `<div class="row" style="margin-top:8px"><b>Astuces :</b> l'arène est en 3D : bouge dans toutes les directions, la caméra tourne autour du combat · un <b>pas de côté</b> (${esc(lab(key1(KEYSETS[0], 'u')))} / ${esc(lab(key1(KEYSETS[0], 'd')))}) fait rater les coups lents · le blocage use ta garde · la <b>parade</b> au bon moment étourdit l'attaquant · <b>briser la garde</b> traverse blocage et parade, mais on l'esquive en <b>sautant</b>, en se décalant ou en frappant en premier · pris dans un enchaînement ? fais une <b>roulade</b> (invincible pendant la rotation) · la <b>barre verte</b> est ton endurance : attaques, roulades, sauts et parades en consomment, laisse-la remonter · Échap = pause</div>`;
}
// ---------- Configuration des touches ----------
const KEYS_HINT = 'Clique sur une case puis appuie sur la touche voulue. <kbd>Suppr</kbd> vide la case, <kbd>Échap</kbd> annule.';
let keyCapture = null;   // { set, act, slot } pendant qu'on attend une touche
function keysTable() {
  const head = ['Joueur 1', 'Joueur 2'].map((n, i) => `<th colspan="2" class="kp${i + 1}">${n}</th>`).join('');
  const rows = ACTIONS.map(([act, name]) => `<tr><td class="kact">${name}</td>${[0, 1].map((set) => [0, 1].map((slot) => {
    const waiting = keyCapture && keyCapture.set === set && keyCapture.act === act && keyCapture.slot === slot;
    const code = KEYSETS[set][act][slot];
    return `<td><button class="kslot${waiting ? ' wait' : ''}${code ? '' : ' empty'}" data-set="${set}" data-act="${act}" data-slot="${slot}">${waiting ? '…' : esc(lab(code))}</button></td>`;
  }).join('')).join('')}</tr>`).join('');
  $('kTable').innerHTML = `<thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody>`;
  $('kTable').querySelectorAll('.kslot').forEach((b) => {
    b.onclick = () => {
      keyCapture = { set: +b.dataset.set, act: b.dataset.act, slot: +b.dataset.slot };
      $('kHint').innerHTML = `Appuie sur la touche pour <b>${ACTIONS.find(([a]) => a === keyCapture.act)[1]}</b> (joueur ${keyCapture.set + 1})…`;
      keysTable();
    };
  });
}
function openKeysEditor() {
  keyCapture = null;
  $('kHint').innerHTML = KEYS_HINT;
  $('kNote').textContent = cfg.mode === 'duo' ? '' : 'En solo et en ligne, les touches des deux joueurs contrôlent ton personnage.';
  keysTable();
  $('keysOv').classList.remove('hidden');
}
function closeKeysEditor() {
  keyCapture = null;
  $('keysOv').classList.add('hidden');
}
function keysChanged(msg) {
  saveKeys();
  if (match) {
    setupBindings(match.mode, net.live ? net.me : 0);
    $('help').innerHTML = controlsHTML(match.mode, true);
  }
  refreshMenu();
  keyCapture = null;
  $('kHint').innerHTML = msg || KEYS_HINT;
  keysTable();
}
// Appelée en premier par le gestionnaire clavier : true si l'éditeur a pris la touche.
function keysEditorKey(e) {
  if ($('keysOv').classList.contains('hidden')) return false;
  e.preventDefault();
  if (e.repeat) return true;
  if (!keyCapture) { if (e.code === 'Escape') closeKeysEditor(); return true; }
  const { set, act, slot } = keyCapture;
  if (e.code === 'Escape') { keyCapture = null; $('kHint').innerHTML = KEYS_HINT; keysTable(); return true; }
  if (e.code === 'Delete' || e.code === 'Backspace') { KEYSETS[set][act][slot] = null; keysChanged(); return true; }
  // une touche ne sert qu'à une seule action : on la retire d'ailleurs
  let moved = '';
  KEYSETS.forEach((s, i) => { for (const a in s) s[a] = s[a].map((c, k) => {
    if (c !== e.code || (i === set && a === act && k === slot)) return c;
    moved = ` (retirée de « ${ACTIONS.find(([x]) => x === a)[1]} », joueur ${i + 1})`;
    return null;
  }); });
  KEYSETS[set][act][slot] = e.code;
  keysChanged(`${kb(e.code)} → ${ACTIONS.find(([x]) => x === act)[1]}, joueur ${set + 1}${moved}`);
  return true;
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
  $('keysBtn').onclick = openKeysEditor;
  $('pauseKeysBtn').onclick = openKeysEditor;
  $('kDone').onclick = closeKeysEditor;
  $('kReset').onclick = () => { KEYSETS = cloneKeys(DEFAULT_KEYSETS); keysChanged('Touches par défaut rétablies.'); };
  $('soundBtn').onclick = () => { soundOn = !soundOn; $('soundBtn').textContent = 'Son : ' + (soundOn ? 'activé' : 'coupé'); };
  refreshMenu();
}

// =====================================================================
//  En ligne : serveur.py met les deux joueurs en relation (code à 4 lettres) et relaie les
//  messages ; ensuite les deux navigateurs font tourner la MÊME simulation et ne s'échangent
//  que leurs touches (rollback.js), de préférence en direct (WebRTC, net.js).
// =====================================================================
function netInfo(html) { $('netInfo').innerHTML = html; }
function netSend(m) { if (net.ws?.readyState === 1) net.ws.send(JSON.stringify(m)); }
function netClose() {
  const ws = net.ws;
  net.link?.close();
  Object.assign(net, { ws: null, link: null, role: null, me: 0, peer: false, peerKind: null });
  rb = null;
  if (ws) ws.close();
}
// liaison directe avec l'adversaire (créée dès que les deux joueurs sont dans la partie)
function netLink() {
  net.link?.close();
  net.link = new Link({
    initiator: net.role === 'host',
    wsSend: netSend,
    onMessage: (m) => netMsg(m),
  });
}
function netConnect(first) {
  netClose();
  ac();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  net.ws = ws;
  let opened = false;
  ws.onopen = () => { opened = true; ws.send(JSON.stringify(first)); };
  ws.onmessage = (e) => {
    if (net.ws !== ws) return;
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m && typeof m === 'object') netMsg(m);
  };
  ws.onclose = () => {
    if (net.ws !== ws) return;
    const wasLive = net.live;
    netClose();
    if (wasLive) toMenu(true);
    netInfo(opened ? 'Connexion perdue avec le serveur.'
      : 'Impossible de joindre le serveur de jeu. Lance le jeu avec <b>jouer.bat</b> (Windows) ou <b>jouer.sh</b> (Linux) sur le PC qui crée la partie.');
    refreshMenu();
  };
}
function hostInfo() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const urls = (local ? net.urls : [location.origin]).map((u) => `<b>${esc(u)}</b>`).join(' ou ');
  return `Code de la partie : <span class="code">${esc(net.code)}</span><br>Ton ami ouvre ${urls || 'l’adresse de ce PC'} dans son navigateur, choisit « En ligne » et entre ce code.`;
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
  const m = { mode: 'online', p1: cfg.p1, p2: net.peerKind || 'soldier', arena: cfg.arena, seed: (Math.random() * 4294967296) >>> 0 };
  netSend({ t: 'start', ...m });
  startMatch(m);
}
function netMsg(m) {
  if (m.t === 'ri' || m.t === 'rs') { if (rb) rb.receive(m); return; }
  if (m.t === 'rtc') { net.link?.signal(m); return; }
  switch (m.t) {
    case 'created':
      Object.assign(net, { role: 'host', me: 0, code: String(m.code ?? ''), urls: Array.isArray(m.urls) ? m.urls.map(String) : [] });
      netInfo(hostInfo() + '<br>En attente d’un adversaire…');
      break;
    case 'joined':
      Object.assign(net, { role: 'guest', me: 1, code: String(m.code ?? ''), peer: true });
      netSend({ t: 'hello', kind: cfg.p1 });
      netLink();
      netInfo(`Connecté à la partie <b>${esc(m.code)}</b> ! L’hôte choisit l’arène et lance le combat.`);
      break;
    case 'peer':
      net.peer = true;
      netSend({ t: 'hello', kind: cfg.p1 });
      netLink();
      netInfo(`Un adversaire a rejoint la partie <b>${esc(net.code)}</b> ! Choisis l’arène puis clique sur COMBATTRE.`);
      break;
    case 'hello':
      net.peerKind = CHARS[m.kind] ? m.kind : 'soldier';
      if (game.phase === 'menu') menuFighters();
      break;
    case 'start':
      if (net.role === 'guest' && CHARS[m.p1] && CHARS[m.p2] && ARENAS[m.arena])
        startMatch({ mode: 'online', p1: m.p1, p2: m.p2, arena: m.arena, seed: Number.isFinite(+m.seed) ? +m.seed : 1 });
      break;
    case 'menu':
      if (!net.live) break;
      toMenu(true);
      netInfo('L’adversaire est revenu au menu.' + (net.role === 'host' ? ' Clique sur COMBATTRE pour relancer.' : ''));
      break;
    case 'bye':
      if (net.live) toMenu(true);
      net.link?.close(); net.link = null;
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
      netInfo(esc(m.msg));
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
      ? 'Le jeu doit être lancé via un petit serveur local.<br>Double-clique sur <b>jouer.bat</b> (Windows) ou lance <b>./jouer.sh</b> (Linux) dans le dossier du jeu.'
      : 'Impossible de charger les modèles : ' + (err?.message || err);
    console.error(err);
    return;
  }
  setupMenu();
  buildArena(cfg.arena);
  game.loading = false;
  $('loading').classList.add('hidden');
  toMenu();
  if (new URLSearchParams(location.search).has('fight') || DEMO) startMatch();
  const warm = +new URLSearchParams(location.search).get('sim');
  for (let i = 0; i < warm * 60; i++) step(DT);
}
requestAnimationFrame(frame);
boot();

// Accès de débogage et de test (uniquement avec ?debug dans l'adresse)
if (new URLSearchParams(location.search).has('debug')) {
  window.__game = { renderer, scene, get sim() { return sim; }, get rb() { return rb; }, get net() { return net; }, game, cfg, get F() { return F; }, startMatch, netStart };
}
