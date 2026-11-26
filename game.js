import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Sim, DT, PRESS, NEUTRAL, quant, ATK, BRK, ROLL, STA, SHOT, FIRE, CAST, WEAPONS, defaultWeapon, windupOf } from './sim.js';
const AR = 'assets/archer/';
import { AI } from './ai.js';
import { Rollback } from './rollback.js';
import { Link } from './net.js';
import { DungeonSim, BOONS, HEROES, FOES, BOSS, ROOM_R, ROOM_T, TILE, PLAT_H, TRAP, trapUp, trapPhase, pickInput, padStand, PAD_R, MERCHANT, WEAPON_IDS, HERO_IDS, FIRST_HERO, shopInput, biomeOf } from './dungeon.js';

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
// hall : salon ouvert depuis la salle d'armes (listé sur le serveur) ; halls : salons des autres, à rejoindre
const net = { ws: null, link: null, role: null, me: 0, live: false, code: '', urls: [], peer: false, peerKind: null, peerWpn: null, peerName: '', peerUnlocked: [], hall: false, halls: [] };

// =====================================================================
//  Modèles
// =====================================================================
const A = 'assets/arena/Models/GLB format/';
const D = 'assets/dungeon/Models/GLB format/';
const K = 'assets/characters/';   // personnages et arc du pack Kenney Mini Characters
const FILES = {
  knight: K + 'character-knight.glb', zombie: K + 'character-zombie.glb', robot: K + 'character-robot.glb',
  bow: 'assets/weapons/weapon-bow.glb',   // l'arc de l'archère, généré par tools/blender/archer.py
  spear: D + 'weapon-spear.glb', tower: D + 'shield-rectangle.glb',
  axe: 'assets/weapons/weapon-axe.glb', hammer: 'assets/weapons/weapon-hammer.glb',   // générés par tools/blender/weapons.py
  staff: 'assets/weapons/weapon-staff.glb', tome: 'assets/weapons/weapon-tome.glb', glove: 'assets/weapons/weapon-glove.glb',
  dog: 'assets/summons/dog.glb',   // chien invoqué par le grimoire, généré par tools/blender/dog.py
  cerbere: 'assets/summons/cerbere.glb',   // boss à trois têtes, généré par tools/blender/cerbere.py
  merchant: 'assets/npc/merchant.glb', stall: 'assets/npc/stall.glb',   // marchand d'armes et son étal (tools/blender/merchant.py)
  soldier: A + 'character-soldier.glb', human: D + 'character-human.glb', orc: D + 'character-orc.glb',
  archer: AR + 'archer.glb', arrow: AR + 'arrow.glb',   // générés par tools/archer-asset.html
  sword: D + 'weapon-sword.glb', shield: D + 'shield-round.glb',
  a_floor: A + 'floor.glb', a_floorD: A + 'floor-detail.glb', a_wall: A + 'wall.glb', a_wallGate: A + 'wall-gate.glb',
  a_column: A + 'column.glb', a_columnD: A + 'column-damaged.glb', a_banner: A + 'banner.glb', a_block: A + 'block.glb',
  a_statue: A + 'statue.glb', a_tree: A + 'tree.glb', a_trophy: A + 'trophy.glb', a_rack: A + 'weapon-rack.glb',
  a_bricks: A + 'bricks.glb',
  d_floor: D + 'floor.glb', d_floorD: D + 'floor-detail.glb', d_wall: D + 'wall.glb', d_wallOpen: D + 'wall-opening.glb',
  d_gate: D + 'gate.glb', d_barrel: D + 'barrel.glb', d_chest: D + 'chest.glb', d_coin: D + 'coin.glb', d_trap: D + 'trap.glb',
  d_column: D + 'column.glb', d_wood: D + 'wood-structure.glb', d_support: D + 'wood-support.glb', d_rocks: D + 'rocks.glb',
  d_stones: D + 'stones.glb', d_banner: D + 'banner.glb', d_pot: D + 'pot.glb', d_wallHalf: D + 'wall-half.glb', d_stairs: D + 'stairs.glb',
};
// décors des biomes du donjon, générés par tools/blender/biomes.py (clé : 'b_' + nom du fichier)
for (const n of ['mine-wall', 'mine-wall-ore', 'mine-low', 'mine-portal', 'mine-floor', 'mine-floor-stones', 'minecart', 'crystals',
  'mine-pillar', 'lantern', 'ruin-wall', 'ruin-wall-broken', 'ruin-low', 'ruin-portal', 'grass-floor', 'grass-floor-flowers', 'bush',
  'basalt-wall', 'basalt-low', 'basalt-portal', 'basalt-floor', 'basalt-floor-cracks', 'lava', 'anvil', 'obsidian', 'lava-rocks'])
  FILES['b_' + n] = 'assets/biomes/' + n + '.glb';
const G = {};

function inst(key, s = S) {
  const o = SkeletonUtils.clone(G[key].scene);
  o.scale.setScalar(s);
  // les dalles de sol et de lave, à plat, ne projettent d'ombre sur rien : autant de moins à dessiner
  const cast = !key.includes('floor') && key !== 'b_lava';
  o.traverse((m) => { if (m.isMesh) { m.castShadow = cast; m.receiveShadow = true; } });
  return o;
}

// ---------- Mémoire du GPU ----------
// Ressources partagées (modèles chargés, formes et matériaux communs) : jamais libérées. Tout le reste
// de ce qui est construit pour une salle ou une arène (sol, ciel, braseros, étiquettes, carte d'ombre
// du soleil…) est libéré quand on en change : sans cela, chaque salle laissait ses tampons et textures
// sur la carte graphique (fuite qui grossit tout au long d'une partie).
const KEEP = new WeakSet();
function keep(...xs) { for (const x of xs.flat()) KEEP.add(x); }
function texturesOf(m, out) { for (const k in m) { const v = m[k]; if (v && v.isTexture && !KEEP.has(v)) out.add(v); } }
// libère ce que contient root (sauf les ressources partagées)
function disposeTree(root) {
  const geos = new Set(), mats = new Set(), texs = new Set();
  root.traverse((o) => {
    if (o.geometry && !KEEP.has(o.geometry)) geos.add(o.geometry);
    if (o.material) for (const m of [].concat(o.material)) if (!KEEP.has(m)) mats.add(m);
    if (o.isLight || o.isInstancedMesh) o.dispose();       // carte d'ombre du soleil, tampons d'instances
    if (o.isSkinnedMesh) o.skeleton.dispose();             // texture des os (une par personnage animé)
  });
  for (const m of mats) { texturesOf(m, texs); m.dispose(); }
  for (const g of geos) g.dispose();
  for (const t of texs) t.dispose();
}
// on change de salle ou d'arène : on vide le monde et on libère ce qui lui appartenait
function clearWorld() {
  disposeTree(world);
  world.clear();
  if (scene.background?.isTexture && !KEEP.has(scene.background)) scene.background.dispose();
  scene.background = null;
}
// Le nombre de lumières fait partie des shaders de three.js : chaque nouveau nombre les fait tous
// recompiler (saccade en entrant dans la salle). On complète donc par des lumières éteintes jusqu'au
// multiple de 4 suivant : quelques variantes seulement, compilées une fois pour toutes.
function padLights() {
  let n = 0;
  world.traverseVisible((o) => { if (o.isPointLight) n++; });   // (une lumière masquée ne compte pas)
  for (let k = n; k < Math.max(4, Math.ceil(n / 4) * 4); k++) { const l = new THREE.PointLight(0x000000, 0, 1); l.position.y = -50; world.add(l); }
}

const CHARS = { soldier: 'Gladiateur', human: 'Mirmillon', orc: 'Orc', archer: 'Archer', knight: 'Chevalier', zombie: 'Zombie', robot: 'Automate' };

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
  bow: () => { noise(0.12, { freq: 2400, to: 900, q: 2, vol: 0.18 }); tone(180, 0.12, { type: 'triangle', vol: 0.12, to: 110 }); },
  thunk: () => { noise(0.08, { freq: 500, type: 'lowpass', vol: 0.35 }); tone(240, 0.08, { type: 'square', vol: 0.05, to: 120 }); },
  fireball: () => { noise(0.45, { freq: 260, to: 900, q: 0.8, vol: 0.32 }); tone(110, 0.3, { type: 'sawtooth', vol: 0.06, to: 220 }); },
  boom: () => { noise(0.7, { freq: 240, type: 'lowpass', vol: 0.9 }); tone(70, 0.5, { type: 'sawtooth', vol: 0.2, to: 30 }); noise(0.25, { freq: 1800, vol: 0.15 }); },
  spell: () => { tone(330, 0.6, { type: 'triangle', vol: 0.08, to: 660 }); tone(495, 0.5, { type: 'sine', vol: 0.06, to: 990, delay: 0.05 }); noise(0.5, { freq: 3000, q: 2, vol: 0.05, attack: 0.2 }); },
  bark: () => { noise(0.07, { freq: 900, q: 3, vol: 0.4 }); tone(420, 0.08, { type: 'square', vol: 0.08, to: 300 }); noise(0.07, { freq: 950, q: 3, vol: 0.35, delay: 0.14 }); tone(430, 0.08, { type: 'square', vol: 0.07, to: 310, delay: 0.14 }); },
  whine: () => tone(900, 0.4, { type: 'triangle', vol: 0.08, to: 420 }),
  tick: () => tone(880, 0.05, { type: 'triangle', vol: 0.06 }),
  coin: () => { tone(1320, 0.12, { type: 'square', vol: 0.05 }); tone(1760, 0.2, { type: 'square', vol: 0.05, delay: 0.07 }); },
  // colosse : retombée du saut, rugissement de rage, jet de vapeur avant la charge
  quake: () => { noise(1.1, { freq: 140, type: 'lowpass', vol: 1 }); tone(48, 0.9, { type: 'sawtooth', vol: 0.25, to: 22 }); noise(0.3, { freq: 900, type: 'lowpass', vol: 0.4 }); },
  roar: () => { tone(80, 1.3, { type: 'sawtooth', vol: 0.2, to: 55, attack: 0.15 }); tone(122, 1.1, { type: 'square', vol: 0.06, to: 70, attack: 0.15 }); noise(1.2, { freq: 420, q: 0.7, vol: 0.35, attack: 0.2 }); },
  growl: () => { tone(70, 0.9, { type: 'sawtooth', vol: 0.16, to: 52, attack: 0.1 }); tone(105, 0.8, { type: 'sawtooth', vol: 0.1, to: 80, attack: 0.1, delay: 0.08 }); noise(0.8, { freq: 300, q: 0.8, vol: 0.25, attack: 0.15 }); },
  flame: () => { noise(1.5, { freq: 700, to: 300, q: 0.6, vol: 0.4, attack: 0.08 }); noise(1.2, { freq: 2600, q: 0.7, vol: 0.12, attack: 0.1 }); tone(60, 0.8, { type: 'sawtooth', vol: 0.08 }); },
  steam: () => { noise(0.6, { freq: 4200, to: 2000, q: 0.8, vol: 0.16, attack: 0.05 }); tone(70, 0.35, { type: 'square', vol: 0.08 }); },
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
const pCol = new THREE.Color();
let pOld = 0;              // réserve pleine : la prochaine particule remplace celle-ci (tour à tour)

// o.dir : direction privilégiée {x, z}
function emit(x, y, z, n, o = {}) {
  const colors = Array.isArray(o.color) ? o.color : [o.color ?? 0xffffff];
  for (let i = 0; i < n; i++) {
    const sp = o.speed ?? 3, a = Math.random() * TAU, life = (o.life ?? 0.6) * rand(0.6, 1);
    const dx = o.dir ? o.dir.x * sp * 0.8 : 0, dz = o.dir ? o.dir.z * sp * 0.8 : 0;
    const p = {
      x: x + rand(-1, 1) * (o.spread ?? 0), y: y + rand(-1, 1) * (o.spread ?? 0), z: z + rand(-1, 1) * (o.spread ?? 0),
      vx: Math.cos(a) * sp * rand(0.2, 1) + dx,
      vy: (o.up ?? 2) * rand(0.4, 1.2),
      vz: Math.sin(a) * sp * rand(0.2, 1) + dz,
      life, max: life, size: (o.size ?? 0.08) * rand(0.6, 1.3), grav: o.grav ?? 9, drag: o.drag ?? 0,
      col: pick(colors), rot: rand(0, 6), spin: rand(-8, 8),
    };
    if (parts.length < PMAX) parts.push(p);
    else { parts[pOld] = p; pOld = (pOld + 1) % PMAX; }
  }
}
function updateParticles(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    // retrait par échange avec la dernière (l'ordre n'a pas d'importance)
    if (p.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
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
    pMesh.setColorAt(i, pCol.setHex(p.col));
  }
  pMesh.count = parts.length;
  pMesh.instanceMatrix.needsUpdate = true;
  pMesh.instanceColor.needsUpdate = true;
}

const ringGeo = new THREE.RingGeometry(0.82, 1, 48);
const rings = [];          // anneaux en cours
const ringPool = [];       // anneaux libres, réutilisés (pas de matériau créé puis détruit à chaque coup)
// anneau d'onde de choc ; face à la caméra sauf s'il est posé au sol
function ring(x, y, z, color, maxS = 1.6, life = 0.35, flat = false, opacity = 1) {
  let m = ringPool.pop();
  if (!m) {
    m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    scene.add(m);
  }
  m.visible = true;
  m.material.color.set(color);
  m.material.opacity = opacity;
  m.position.set(x, y, z);
  if (flat) m.quaternion.setFromAxisAngle(AXIS_X, -Math.PI / 2);
  else m.quaternion.copy(camera.quaternion);
  m.scale.setScalar(0.1);
  rings.push({ m, t: 0, life, maxS, op: opacity });
}
const AXIS_X = new THREE.Vector3(1, 0, 0);
function updateRings(dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt;
    const k = r.t / r.life;
    if (k >= 1) { r.m.visible = false; ringPool.push(r.m); rings[i] = rings[rings.length - 1]; rings.pop(); continue; }
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
// Dalles plates et immobiles (sol, lave…) : au lieu d'un objet par dalle, elles sont regroupées par
// modèle en une seule InstancedMesh (un appel de dessin par modèle au lieu d'un par dalle) ; posées
// au ras du sol, elles ne projettent pas d'ombre. flushTiles() les crée en fin de construction.
const tileBatch = new Map();
const mTile = new THREE.Matrix4(), qTile = new THREE.Quaternion(), sTile = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
function PT(key, x, y, z, ry = 0, s = S) {
  if (!tileBatch.has(key)) tileBatch.set(key, []);
  qTile.setFromAxisAngle(UP, ry);
  tileBatch.get(key).push(new THREE.Matrix4().compose(v1.set(x, y, z), qTile, sTile.setScalar(s)));
}
function flushTiles() {
  for (const [key, list] of tileBatch) {
    const root = G[key].scene;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, mTile.multiplyMatrices(m, o.matrixWorld)));
      im.receiveShadow = true;
      world.add(im);
    });
  }
  tileBatch.clear();
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
      PT(Math.random() < chance ? b : a, x, 0, z, ((Math.random() * 4) | 0) * Math.PI / 2);
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
keep(flameGeo, flameMats, ironMat, woodMat);
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
  clearWorld();
  updaters = [];
  for (const id of ['talk', 'shop']) $(id).classList.add('hidden');   // marchand (salle d'armes)
  crowd = null;
  arenaHooks = {};
  scene.fog = null;
  ARENAS[id].build();
  flushTiles();
  padLights();
  curArena = id;
}

// =====================================================================
//  Combattants
// =====================================================================
const qBlock = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -1.2, -0.35));

// ---------- Orientation de l'arme pendant les coups ----------
// Les animations Kenney font tourner le bras sur lui-même pendant la frappe : une arme fixée à la
// main pointerait vers l'arrière au moment de l'impact. Pendant un coup, l'arme est donc orientée
// ici le long d'un arc propre (repère du personnage : +z devant, +y haut, -x côté main droite),
// le tranchant (axe +x de l'arme) en premier ; elle reste tenue par la main.
const smooth = (a, b, t) => { const k = clamp((t - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
const mUp = new THREE.Vector3(), mFwd = new THREE.Vector3(), mEdge = new THREE.Vector3(), mSide = new THREE.Vector3();
const mBasis = new THREE.Matrix4(), qSwing = new THREE.Quaternion(), qArmW = new THREE.Quaternion(), qModelW = new THREE.Quaternion();
// direction de la pointe (dir) et du tranchant (edge) pour l'arc : angle a mesuré depuis la verticale vers l'avant
function chop(a, out, edge) {
  out.set(-0.22, Math.cos(a), Math.sin(a)).normalize();
  edge.set(0, -Math.sin(a), Math.cos(a));           // sens du mouvement
}
// balayage horizontal de droite à gauche : angle b depuis l'avant vers la droite
function sweep(b, out, edge) {
  out.set(-Math.sin(b), 0.18, Math.cos(b)).normalize();
  edge.set(Math.cos(b), 0, Math.sin(b));
}
// renvoie [poids, tenue] du coup en cours (poids 0 : la tenue de repos suffit)
function swingPose(sf, wpn) {
  let t, kind;
  if (sf.state === 'shoot' && wpn === 'staff') {
    // incantation : le sceptre se lève, puis pointe vers la cible quand la boule de feu part
    const t = sf.stateT;
    chop(-0.25 + smooth(0.12, FIRE.rel + 0.02, t) * 1.55, mFwd, mEdge);
    return smooth(0, 0.08, t) * (1 - smooth(0.45, FIRE.dur, t));
  }
  let left = false;      // 2e coup : animation du bras gauche, le bras droit recule ensuite derrière le corps
  if (sf.state === 'attack') { t = sf.stateT; left = sf.combo === 2; kind = wpn === 'spear' ? 'thrust' : left ? 'sweep' : 'chop'; }
  else if (sf.state === 'air' && sf.airAtk && sf.airAtkT < 1) { t = sf.airAtkT + 0.05; kind = wpn === 'spear' ? 'thrust' : 'chop'; }
  else return 0;
  // armé (0 → 0.1 s), coup (0.1 → 0.24 s, fenêtre de touche 0.13 → 0.26 s), retour (0.3 → 0.42 s) ;
  // au 2e coup, tout se joue plus tôt (le bras droit repart en arrière après 0.2 s)
  const w = smooth(0, 0.07, t) * (1 - (left ? smooth(0.2, 0.3, t) : smooth(0.3, 0.42, t)));
  const k = left ? smooth(0.06, 0.2, t) : smooth(0.08, 0.24, t);
  if (kind === 'chop') chop(-0.55 + k * 2.45, mFwd, mEdge);          // de derrière la tête jusqu'à l'avant, vers le bas
  else if (kind === 'sweep') sweep(1.5 - k * 1.85, mFwd, mEdge);     // de la droite jusqu'un peu à gauche de l'avant
  else { mFwd.set(-0.08, -0.12 + 0.3 * (1 - k), 1).normalize(); mEdge.set(0, 1, 0); }   // estoc droit devant
  return w;
}
const ringFoot = new THREE.RingGeometry(0.42, 0.56, 36).rotateX(-Math.PI / 2);
const starGeo = new THREE.OctahedronGeometry(0.075);
const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14a, toneMapped: false });
keep(ringFoot, starGeo, starMat);

// Vue d'un combattant : modèle 3D, animations et effets visuels. Tout ce qui touche au
// gameplay est dans sim.js ; ici on ne fait que LIRE l'état de la simulation (sf).
// Armes tenues en main : épée (ou lance) dans la main droite, bouclier (ou arc) dans la gauche.
// L'arc joue le rôle du bouclier : il reste droit et brille à la parade.
const SWORD_DIR = new THREE.Vector3(0.65, 0, 0.76).normalize();
const HAND = new THREE.Vector3(-0.25, 0, 0.02);    // main droite, dans le repère du bras
// back : la main tient l'arme à cette distance de son origine (le long du manche)
function heldWeapon(key, s, back = 0) {
  const o = inst(key, s);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), SWORD_DIR);
  o.position.copy(HAND).addScaledVector(SWORD_DIR, -back);
  o.userData.back = back;
  return o;
}
// l'arc de l'archère, pour les autres personnages : poignée à l'origine, branches vers +z,
// flèche encochée 'nocked' incluse
const bowGroup = () => inst('bow', 1);
// orbe du sceptre : matière lumineuse (sa couleur varie avec l'incantation)
const orbColor = new THREE.Color(1, 0.5, 0.15);
function glowOrb(staff) {
  const orb = staff.getObjectByName('orb');
  if (orb) orb.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: orbColor.clone(), toneMapped: false }); });
  return orb;
}
// rune du grimoire / pierre du collier des chiens : matière lumineuse violette
const runeColor = new THREE.Color(0.75, 0.45, 1);
function glowNode(obj, name, color) {
  const n = obj.getObjectByName(name);
  if (n) n.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: color.clone(), toneMapped: false }); });
  return n;
}
// Gants de boxe (tools/blender/gloves.py) : le modèle est le gant gauche (jointures vers l'avant,
// manchette vers le bas, pouce vers le milieu du corps) ; miroir (x → -x) pour la main droite.
function gloveModel(right, s) {
  const g = inst('glove', s);
  if (right) g.scale.x = -s;
  return g;
}
function equipModel(v, kind, wpn) {
  const builtIn = v.model.getObjectByName('bow');    // l'archère a son arc dans le modèle
  if (builtIn) builtIn.visible = wpn === 'bow';
  v.sword = v.glove = null;
  if (wpn === 'gloves') {
    // un gant à chaque main, redressés à chaque image ; le gauche joue le rôle du bouclier (lueur au blocage)
    v.shield = gloveModel(false, 1.05);
    v.shield.position.set(0.28, 0, 0.03);
    v.armL.add(v.shield);
    v.glove = gloveModel(true, 1.05);
    v.glove.position.set(-0.28, 0, 0.03);
    v.armR.add(v.glove);
    return;
  }
  if (wpn === 'tome') {
    // grimoire dans la main gauche, tenu comme un bouclier (reste droit, brille à la parade)
    v.shield = inst('tome', 1.0);
    v.shield.position.set(0.24, 0, 0.07);
    v.armL.add(v.shield);
    v.rune = glowNode(v.shield, 'rune', runeColor);
    return;
  }
  if (wpn === 'bow') {
    v.shield = builtIn ?? bowGroup();
    if (!builtIn) { v.shield.position.set(0.255, 0, 0.05); v.armL.add(v.shield); }
    v.nocked = v.shield.getObjectByName('nocked');   // flèche encochée, visible pendant la visée
    v.nocked.visible = false;
    return;
  }
  v.sword = wpn === 'spear' ? heldWeapon('spear', 1.45, 0.3) : wpn === 'staff' ? heldWeapon('staff', 1.0, 0.08)
    : wpn === 'axe' || wpn === 'hammer' ? heldWeapon(wpn, 0.9) : heldWeapon('sword', 0.9);
  v.armR.add(v.sword);
  v.swordQ = v.sword.quaternion.clone();     // tenue de repos (dans le repère du bras)
  v.swordP = v.sword.position.clone();
  if (wpn === 'hammer' || wpn === 'staff') { v.shield = new THREE.Group(); v.armL.add(v.shield); }   // pas de bouclier
  if (wpn === 'staff') v.orb = glowOrb(v.sword);
  if (wpn === 'hammer' || wpn === 'staff') return;
  v.shield = inst(wpn === 'tower' ? 'tower' : 'shield', wpn === 'tower' ? 1.1 : 0.8);
  v.shield.position.set(0.24, wpn === 'tower' ? -0.2 : 0, 0.07);
  v.armL.add(v.shield);
}

class FighterView {
  constructor(idx, kind, wpn = defaultWeapon(kind)) {
    this.idx = idx;
    this.kind = kind;
    this.wpn = wpn;
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

    equipModel(this, kind, wpn);
    this.shieldMats = [];
    // (les pièces lumineuses, comme la rune du grimoire, n'ont pas de couleur émissive : on les laisse)
    this.shield.traverse((o) => { if (o.isMesh && o.material.emissive) { o.material = o.material.clone(); this.shieldMats.push(o.material); } });

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
    this.glowCol = new THREE.Color(1, 0.3, 0.05);    // lueur permanente (rage du colosse) ajoutée au flash
    this.glow = 0;
    this.cur = null;
    this.flash = 0; this.shieldGlow = 0; this.bw = 0; this.flinch = 0; this.vyaw = 0;
    this.seenReset = -1; this.seenAnim = '';
    this.px = this.py = this.pz = 0;       // position à l'image de simulation précédente (interpolation)
    this.rx = this.ry = this.rz = 0;       // position affichée
    this.snapPos = true;
  }
  // retire la vue et libère ce qui lui est propre (matériaux clonés, squelette, barre de vie, anneau)
  dispose() {
    scene.remove(this.root, this.ring);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    disposeTree(this.root); disposeTree(this.ring);
  }
  setSize(k) { this.root.scale.setScalar(k); this.ring.scale.setScalar(k); }
  // petite barre de vie au-dessus de la tête (ennemis du donjon)
  addHpBar(color) {
    const g = new THREE.Group();
    g.position.y = 2.05;
    const mk = (w, h, c, o, z) => {
      const geo = new THREE.PlaneGeometry(w, h);
      geo.translate(w / 2, 0, 0);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthTest: false, toneMapped: false }));
      m.position.set(-w / 2, 0, z);
      m.renderOrder = 10;
      g.add(m);
      return m;
    };
    mk(0.82, 0.11, 0x000000, 0.65, 0);
    this.hpFill = mk(0.76, 0.06, color, 1, 0.001);
    this.hpBar = g;
    this.root.add(g);
  }

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
    if (this.nocked) this.nocked.visible = sf.state === 'shoot' && sf.stateT < SHOT.rel;
    if (this.rune) {
      const c = sf.state === 'shoot' ? 1.2 + 2.5 * Math.min(1, sf.stateT / CAST.rel) : 0.8 + 0.2 * Math.sin(T * 3);
      this.rune.traverse((o) => { if (o.isMesh) o.material.color.copy(runeColor).multiplyScalar(c); });
      if (sf.state === 'shoot' && sf.stateT < CAST.rel && Math.random() < 0.5) {
        this.rune.getWorldPosition(v1);
        emit(v1.x, v1.y, v1.z, 1, { color: [0xb98aff, 0xffffff], speed: 0.6, up: 1.2, size: 0.05, life: 0.5, grav: -1 });
      }
    }
    if (this.orb) {
      const c = sf.state === 'shoot' ? (sf.stateT < FIRE.rel ? 1 + 2.2 * sf.stateT / FIRE.rel : 1.2) : 0.85 + 0.15 * Math.sin(T * 4);
      this.orb.traverse((o) => { if (o.isMesh) o.material.color.copy(orbColor).multiplyScalar(c); });
      this.orb.scale.setScalar(sf.state === 'shoot' && sf.stateT < FIRE.rel ? 1 + 0.5 * sf.stateT / FIRE.rel : 1);
    }
    if (this.hpBar) {
      this.hpBar.visible = sf.state !== 'dead';
      this.hpBar.quaternion.copy(camera.quaternion);
      this.hpFill.scale.x = Math.max(0.001, sf.hp / sf.maxHp);
    }
    // colosse : il rougeoie en préparant une attaque spéciale, et brûle une fois enragé
    if (sf.sp !== undefined && sf.state !== 'dead') {
      const wind = sf.sp && sf.sp !== 'roar' && sf.spA === 0 ? 0.45 + 0.35 * Math.sin(T * 28) : 0;
      this.glow = Math.max(wind, sf.rage ? 0.09 + 0.05 * Math.sin(T * 5) : 0);
      if (sf.rage && Math.random() < 0.35) {
        const s = sf.size ?? 1;
        emit(this.rx + rand(-0.4, 0.4) * s, this.ry + rand(0.4, 1.4) * s, this.rz + rand(-0.4, 0.4) * s, 1, { color: [0xff9a2e, 0xffe27a, 0xff4a1c], speed: 0.4, up: 1.8, size: 0.06, life: 0.6, grav: -1.5 });
      }
    } else this.glow = 0;
  }

  // arme dans l'axe du coup (voir swingPose)
  swing(sf) {
    const w = swingPose(sf, this.wpn);
    this.sword.quaternion.copy(this.swordQ);
    this.sword.position.copy(this.swordP);
    if (w <= 0.001) return;
    // base de l'arme dans le repère du personnage : y = pointe, x = tranchant
    mUp.copy(mFwd);
    mEdge.addScaledVector(mUp, -mEdge.dot(mUp)).normalize();
    mSide.crossVectors(mEdge, mUp);
    mBasis.makeBasis(mEdge, mUp, mSide);
    qSwing.setFromRotationMatrix(mBasis);
    // repère du personnage -> repère du bras droit
    this.model.getWorldQuaternion(qModelW);
    this.armR.getWorldQuaternion(qArmW);
    qSwing.premultiply(qModelW).premultiply(qArmW.invert());
    this.sword.quaternion.slerp(qSwing, w);
    // la main garde sa prise : l'origine de l'arme recule le long de la nouvelle direction ;
    // pour la lance, poussée vers l'avant pendant l'estoc
    mUp.applyQuaternion(qModelW).applyQuaternion(qArmW);
    const back = this.sword.userData.back || 0;
    const push = this.wpn === 'spear' ? 0.12 * Math.sin(Math.PI * clamp(((sf.state === 'air' ? sf.airAtkT : sf.stateT) - 0.08) / 0.22, 0, 1)) : 0;
    v1.copy(HAND).addScaledVector(mUp, push - back);
    this.sword.position.lerp(v1, w);
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
    if (this.glove) { this.armR.getWorldQuaternion(q1); this.glove.quaternion.copy(q1.invert().multiply(q2)); }
    if (this.sword) this.swing(sf);

    this.flash = Math.max(0, this.flash - dt * 4);
    for (const m of this.mats) {
      m.emissive.copy(this.flashCol).multiplyScalar(this.flash);
      if (this.glow > 0) { m.emissive.r += this.glowCol.r * this.glow; m.emissive.g += this.glowCol.g * this.glow; m.emissive.b += this.glowCol.b * this.glow; }
    }
    this.shieldGlow = Math.max(0, this.shieldGlow - dt * 3);
    const bg = st === 'block' ? 0.12 : 0;
    for (const m of this.shieldMats) m.emissive.setRGB(0.5 * this.shieldGlow + bg * 0.4, 0.8 * this.shieldGlow + bg * 0.7, this.shieldGlow + bg);

    this.stars.rotation.y = T * 5;
    const gy = sim.groundY(sf);
    this.ring.position.set(this.rx, gy + 0.03, this.rz);
    this.ring.material.opacity = st === 'dead' ? 0 : 0.75 - Math.min(0.5, (this.ry - gy) * 0.25);
  }
}

// ---------- Chien invoqué : pièces articulées animées ici (pas de squelette) ----------
// Même interface que FighterView (capture, render, fx, dispose, setSize, addHpBar).
const DOG_S = 1.6;            // même échelle que les personnages
const hellGlow = new THREE.Color(1, 0.28, 0.08);    // yeux de Cerbère, pierre des chiens des enfers
// flamme de Cerbère : cône ouvert, pointe sur la gueule, ouverture vers +z (longueur 1, mise à l'échelle)
const jetGeo = new THREE.ConeGeometry(0.5, 1, 12, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
const jetCoreGeo = new THREE.ConeGeometry(0.22, 0.75, 10, 1, true).translate(0, -0.375, 0).rotateX(-Math.PI / 2);
const jetMat = new THREE.MeshBasicMaterial({ color: 0xff6a1c, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
const jetCoreMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
keep(jetGeo, jetCoreGeo, jetMat, jetCoreMat);
// key : 'dog' (chien du grimoire, ou chien des enfers dans le camp ennemi) ou 'cerbere' (trois têtes,
// tools/blender/cerbere.py) ; glow : couleur de la pierre du collier ou des yeux
class DogView {
  constructor(idx, key = 'dog', glow = runeColor) {
    this.idx = idx;
    this.kind = key === 'cerbere' ? 'cerbere' : 'dog'; this.wpn = key === 'cerbere' ? 'fangs' : 'bite';
    this.root = new THREE.Group();
    scene.add(this.root);
    this.model = inst(key, DOG_S);
    this.root.add(this.model);
    const n = (k) => this.model.getObjectByName(k);
    this.body = n('body'); this.tail = n('tail');
    this.heads = key === 'cerbere' ? ['head-l', 'head-c', 'head-r'].map(n) : [n('head')];
    this.legs = ['leg-fl', 'leg-br', 'leg-fr', 'leg-bl'].map(n);      // diagonales qui avancent ensemble
    this.bodyY = this.body.position.y;
    this.mats = [];
    this.model.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); this.mats.push(o.material); } });
    this.glowCol = glow;
    if (key === 'cerbere') {
      // gerbes de flammes (une par gueule) pendant le souffle de feu, tournées avec le corps
      this.fireG = new THREE.Group();
      this.root.add(this.fireG);
      this.jets = [-0.32, 0, 0.32].map((a) => {
        const j = new THREE.Group();
        j.position.set(Math.sin(a) * 0.52, 0.42, Math.cos(a) * 0.52);
        j.rotation.y = a;
        j.add(new THREE.Mesh(jetGeo, jetMat), new THREE.Mesh(jetCoreGeo, jetCoreMat));
        this.fireG.add(j);
        return j;
      });
      this.fireG.visible = false;
      this.fireK = 0;
    }
    this.gems = (key === 'cerbere' ? ['eyes-l', 'eyes-c', 'eyes-r'] : ['glow']).map((k) => glowNode(this.model, k, glow)).filter(Boolean);
    this.ring = new THREE.Mesh(ringFoot, new THREE.MeshBasicMaterial({ color: 0xa070ff, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }));
    scene.add(this.ring);
    this.flash = 0; this.flinch = 0; this.vyaw = 0; this.phase = 0; this.spawn = 0; this.deadT = 0;
    this.flashCol = new THREE.Color(1, 1, 1);
    this.px = this.py = this.pz = 0; this.rx = this.ry = this.rz = 0;
    this.snapPos = true; this.seenReset = -1;
  }
  dispose() { scene.remove(this.root, this.ring); disposeTree(this.root); disposeTree(this.ring); }
  setSize(k) { this.root.scale.setScalar(k); this.ring.scale.setScalar(k); }
  capture(sf) { this.px = sf.x; this.py = sf.y; this.pz = sf.z; }
  fx(kind) {
    if (kind === 'hit') { this.flashCol.setRGB(1, 1, 1); this.flash = 1; this.flinch = 1; }
    else if (kind === 'gbreak') { this.flashCol.setRGB(1, 0.55, 0.1); this.flash = 1; }
    else if (kind === 'blocked') this.flinch = 0.4;
  }
  render(sf, dt, T, alpha) {
    if (sf.resetN !== this.seenReset) { this.seenReset = sf.resetN; this.vyaw = sf.yaw; this.snapPos = true; }
    if (this.snapPos) { this.px = sf.x; this.py = sf.y; this.pz = sf.z; this.snapPos = false; }
    this.rx = this.px + (sf.x - this.px) * alpha;
    this.ry = this.py + (sf.y - this.py) * alpha;
    this.rz = this.pz + (sf.z - this.pz) * alpha;
    this.vyaw = lerpAng(this.vyaw, sf.visTarget, Math.min(1, dt * 14));
    const st = sf.state, t = sf.stateT;
    // apparition : le chien grandit en tournoyant
    this.spawn = Math.min(1, this.spawn + dt * 3.5);
    const grow = this.spawn < 1 ? Math.sin(this.spawn * Math.PI * 0.5) * (1 + 0.25 * Math.sin(this.spawn * Math.PI)) : 1;
    this.model.scale.setScalar(DOG_S * Math.max(0.01, grow));
    // trot : vitesse au sol (Cerbère court aussi pendant sa charge)
    const sp = Math.hypot(sf.vx, sf.vz), spc = st === 'special' ? sf.sp : '';
    const moving = (st === 'walk' || st === 'idle' || (spc === 'charge' && sf.spA === 1)) && sp > 0.3;
    this.phase += dt * (moving ? 6 + sp * 2.2 : 0);
    const swing = moving ? Math.sin(this.phase) * Math.min(0.7, 0.25 + sp * 0.12) : 0;
    this.legs.forEach((l, k) => { l.rotation.x = (k < 2 ? swing : -swing); });
    let bob = moving ? Math.abs(Math.sin(this.phase)) * 0.02 : 0, pitch = 0, roll = 0, headX = 0, lunge = 0;
    const W = st === 'attack' ? windupOf(sf) : 0;
    if (st === 'attack' && t < W) {
      // morsure préparée (Cerbère) : il se ramasse, gueules en arrière, avant de se lancer
      const k = Math.min(1, t / Math.min(W, 0.2));
      headX = -0.45 * k; pitch = -0.14 * k; bob = -0.05 * k; lunge = -0.06 * k;
    } else if (st === 'attack' || (st === 'air' && sf.airAtk)) {
      // morsure : la tête plonge vers l'avant, le corps suit
      const k = Math.sin(Math.PI * Math.min(1, (st === 'air' ? sf.airAtkT : t - W) / ATK.dur));
      headX = 0.55 * k; lunge = 0.12 * k; pitch = 0.18 * k;
    } else if (st === 'brk') {
      // bond : arrière-train baissé puis saut en avant
      const k = Math.min(1, t / BRK.dur);
      pitch = k < 0.4 ? -0.35 * k / 0.4 : -0.35 + 0.6 * (k - 0.4) / 0.6;
      bob = k > 0.35 && k < 0.6 ? 0.08 : 0;
    } else if (st === 'block' || st === 'parry') { bob = -0.035; headX = -0.2; }
    else if (st === 'air') { this.legs.forEach((l, k) => { l.rotation.x = k < 2 ? -0.6 : 0.6; }); }
    else if (st === 'roll') roll = Math.min(1, t / (ROLL.dur * 0.85)) * TAU;
    else if (st === 'stun') roll = Math.sin(T * 9) * 0.15;
    else if (spc === 'slam') {
      // bond : tassé pour sauter, pattes tendues en l'air, aplati à l'atterrissage
      if (sf.spA === 0) { bob = -0.05; pitch = -0.12; } else if (sf.spA === 1) this.legs.forEach((l, k) => { l.rotation.x = k < 2 ? -0.7 : 0.7; });
      else bob = -0.04;
    } else if (spc === 'charge' && sf.spA === 0) { pitch = 0.12; this.legs[0].rotation.x = Math.sin(T * 18) * 0.6; }   // il gratte le sol
    if (this.flinch > 0) { pitch -= 0.3 * this.flinch; this.flinch = Math.max(0, this.flinch - dt * 4); }
    // chute
    if (st === 'dead') {
      this.deadT += dt;
      const k = Math.min(1, this.deadT * 3);
      this.model.rotation.set(0, this.vyaw, k * Math.PI / 2);
      this.model.position.y = -Math.max(0, this.deadT - 0.8) * 0.4;
      this.root.visible = this.deadT < 2;
    } else {
      this.deadT = 0;
      this.root.visible = true;
      this.model.rotation.set(pitch, this.vyaw, roll, 'YXZ');
      this.model.position.y = 0;
    }
    this.body.position.y = this.bodyY + bob;
    this.body.position.z = lunge;
    // têtes : celle qui mord plonge (Cerbère : une tête par coup de l'enchaînement), les autres vivent leur vie ;
    // souffle de feu : elles se dressent puis crachent ; rugissement : tête levée
    const biter = this.heads.length > 1 ? (Math.max(1, sf.combo) - 1) % 3 : 0;
    this.heads.forEach((h, k) => {
      let x = (k === biter ? headX : headX * 0.25) + (moving ? Math.sin(this.phase * 2 + k) * 0.05 : Math.sin(T * 2 + k * 1.7) * 0.05);
      if (spc === 'fire') x = sf.spA === 0 ? -0.5 : 0.18 + Math.sin(T * 30 + k) * 0.04;
      else if (spc === 'roar') x = -0.7;
      h.rotation.x = x;
      if (this.heads.length > 1) h.rotation.y = Math.sin(T * 1.3 + k * 2.1) * 0.12;
    });
    this.tail.rotation.z = Math.sin(T * (st === 'idle' || st === 'walk' ? 14 : 5)) * 0.5;
    this.root.position.set(this.rx, this.ry, this.rz);
    this.flash = Math.max(0, this.flash - dt * 4);
    for (const m of this.mats) if (m.emissive) m.emissive.copy(this.flashCol).multiplyScalar(this.flash);
    if (this.fireG) {
      const on = spc === 'fire' && sf.spA === 1;
      this.fireK = on ? Math.min(1, this.fireK + dt * 7) : Math.max(0, this.fireK - dt * 5);
      this.fireG.visible = this.fireK > 0.01;
      this.fireG.rotation.y = this.vyaw;
      this.jets.forEach((j, k) => {
        const f = 1 + 0.12 * Math.sin(T * 40 + k * 2.3);
        j.scale.set(f, f, this.fireK * (0.9 + 0.1 * Math.sin(T * 23 + k)) * BOSS.fire.R / FOES.cerbere.size);
      });
    }
    // les yeux de Cerbère flambent quand il prépare une attaque ou qu'il est enragé
    const hot = (spc && sf.spA === 0) || (st === 'attack' && t < W) ? 2.2 + Math.sin(T * 28) : sf.rage ? 1.6 : 0;
    for (const gm of this.gems) gm.traverse((o) => { if (o.isMesh) o.material.color.copy(this.glowCol).multiplyScalar(1 + hot + 0.6 * Math.sin(T * 5)); });
    if (this.hpBar) {
      this.hpBar.visible = st !== 'dead';
      this.hpBar.quaternion.copy(camera.quaternion);
      this.hpFill.scale.x = Math.max(0.001, sf.hp / sf.maxHp);
    }
    const gy = sim.groundY(sf);
    this.ring.position.set(this.rx, gy + 0.03, this.rz);
    this.ring.material.opacity = st === 'dead' ? 0 : 0.6;
  }
}

DogView.prototype.addHpBar = FighterView.prototype.addHpBar;   // petite barre de vie au-dessus de la tête

// ---------- Flèches en vol (lues dans sim.pr) ----------
const arrowViews = [];
let arrowTrail = 0;
const vA = new THREE.Vector3();
// boule de feu : cœur clair et halo orange, en additif
const fbCore = new THREE.IcosahedronGeometry(0.12, 0), fbHalo = new THREE.IcosahedronGeometry(0.22, 1);
const fbCoreMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0, toneMapped: false });
const fbHaloMat = new THREE.MeshBasicMaterial({ color: 0xff6a1c, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
const fireViews = [];
function fireballView() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(fbCore, fbCoreMat), new THREE.Mesh(fbHalo, fbHaloMat));
  scene.add(g);
  return g;
}
const NONE = [], arrowList = [], fireList = [];
function syncArrows(alpha) {
  const all = game.phase === 'menu' ? NONE : sim.pr;
  arrowList.length = fireList.length = 0;
  for (const a of all) (a.k === 1 ? fireList : arrowList).push(a);
  const list = arrowList, fire = fireList;
  while (fireViews.length < fire.length) fireViews.push(fireballView());
  fireViews.forEach((o, i) => {
    const a = fire[i];
    o.visible = !!a;
    if (!a) return;
    o.position.set(a.x + a.vx * DT * (alpha - 1), a.y + a.vy * DT * (alpha - 1), a.z + a.vz * DT * (alpha - 1));
    o.rotation.set(clockT * 7, clockT * 5, 0);
    o.children[1].scale.setScalar(1 + 0.15 * Math.sin(clockT * 30 + i));
    emit(o.position.x, o.position.y, o.position.z, 2, { color: [0xffe27a, 0xff9a2e, 0xff4a1c], speed: 0.4, up: 0.6, size: 0.07, life: 0.35, grav: -1.5 });
  });
  while (arrowViews.length < list.length) { const o = inst('arrow', 1.25); scene.add(o); arrowViews.push(o); }
  arrowViews.forEach((o, i) => {
    const a = list[i];
    o.visible = !!a;
    if (!a) return;
    // position interpolée entre deux images de simulation, pointe dans le sens du vol
    o.position.set(a.x + a.vx * DT * (alpha - 1), a.y + a.vy * DT * (alpha - 1), a.z + a.vz * DT * (alpha - 1));
    o.lookAt(vA.set(o.position.x + a.vx, o.position.y + a.vy, o.position.z + a.vz));
    // traînée légère derrière la flèche
    if ((arrowTrail = (arrowTrail + 1) % 2) === 0) emit(o.position.x, o.position.y, o.position.z, 1, { color: [0xfff3d0, 0xffffff], speed: 0.1, up: 0.1, size: 0.035, life: 0.25, grav: 0 });
  });
}

// =====================================================================
//  Entrées
// =====================================================================
// Touches maintenues et touches pressées depuis la dernière image de simulation
const held = [{}, {}];
const pending = [0, 0];   // bits PRESS
const tapped = [new Set(), new Set()];   // touches tenues enfoncées depuis la dernière image (une tape brève compte, même à faible fps)

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
  if (!$('reward').classList.contains('hidden')) {
    const k = rewardKey(e.code);
    if (k) { e.preventDefault(); pickBoon(k[0], k[1]); }
    if (e.code !== 'Escape') return;
  }
  // chez le marchand : touches 1 à 9 = prendre directement cette arme
  const dg = /^Digit([1-9])$/.exec(e.code), sh = localShopper();
  if (dg && sh >= 0 && !game.paused) { e.preventDefault(); shopReq[sh] = +dg[1] - 1; return; }
  if (bindings.has(e.code) || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.code === 'Escape') { togglePause(); return; }
  if (e.repeat) return;
  down.add(e.code);
  const b = bindings.get(e.code);
  if (b && !game.paused) for (const [pl, act] of b) { if (act in PRESS) pending[pl] |= PRESS[act]; else tapped[pl].add(act); }
});
addEventListener('keyup', (e) => down.delete(e.code));
// F2 : panneau de débogage du donjon (hors ligne)
addEventListener('keydown', (e) => { if (e.code === 'F2') { e.preventDefault(); toggleDebug(); } });
addEventListener('blur', () => down.clear());

// déplacements relatifs à la caméra : ← → le long de l'écran, ↑ ↓ en profondeur (pas de côté)
// Entrée d'un joueur pour la prochaine image de simulation (déplacement quantifié, identique chez les deux joueurs)
function localInput(pl) {
  if (sim instanceof DungeonSim && sim.g.phase === 'reward' && pickReq[pl] >= 0) { pending[pl] = 0; return pickInput(pickReq[pl]); }
  if (sim instanceof DungeonSim && sim.g.phase === 'hub' && shopReq[pl] >= 0) { const n = shopReq[pl]; shopReq[pl] = -1; pending[pl] = 0; return shopInput(n); }
  const h = held[pl];
  for (const k of HELD) h[k] = false;
  if (!game.paused) for (const code of down) {
    const b = bindings.get(code);
    if (!b) continue;
    for (const [p, act] of b) if (p === pl && HELD.includes(act)) h[act] = true;
  }
  if (!game.paused) for (const act of tapped[pl]) h[act] = true;
  tapped[pl].clear();
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
const cfg = { game: 'arena', mode: 'solo', diff: '1', p1: 'soldier', p2: 'orc', arena: 'colisee' };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('spartiate-cfg') || '{}')); } catch (e) { /* stockage indisponible */ }
const qsArena = new URLSearchParams(location.search).get('arena');
if (qsArena) cfg.arena = qsArena;
if (!ARENAS[cfg.arena]) cfg.arena = 'colisee';
if (new URLSearchParams(location.search).has('dungeon')) cfg.game = 'dungeon';
if (cfg.game !== 'dungeon') cfg.game = 'arena';

let match = null;           // réglages du combat en cours (en ligne : choisis par l'hôte)

function makeFighters(p1 = cfg.p1, p2 = cfg.p2) {
  F.forEach((f) => f.dispose());
  F = [new FighterView(0, p1), new FighterView(1, p2)];
}
// aperçu du menu : en ligne, on montre le personnage choisi par l'adversaire
function menuFighters() {
  if (sim instanceof DungeonSim) return;
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
  ['menu', 'result', 'pause', 'reward'].forEach((id) => $(id).classList.add('hidden'));
  $('hud').classList.remove('hidden', 'dng', 'solo');
  $('againBtn').textContent = 'Revanche';
  $('help').classList.remove('hidden');
  $('help').innerHTML = controlsHTML(m.mode, true);
  setupBindings(m.mode, net.live ? net.me : 0);
  if (curArena !== m.arena) buildArena(m.arena);
  const seed = (m.seed ?? Math.random() * 4294967296) >>> 0;
  sim = new Sim(seed, [m.p1, m.p2]);
  makeFighters(m.p1, m.p2);
  ai = m.mode === 'solo' ? new AI(sim, 1, +cfg.diff, seed ^ 0x9e3779b9) : null;
  ai0 = DEMO && !net.live ? new AI(sim, 0, 2, seed ^ 0x85ebca6b) : null;
  const tag = (i, other) => ` (${i === net.me ? myName() || 'Toi' : net.peerName || other})`;
  const tags = { solo: [` (${myName() || 'Toi'})`, ' (IA)'], duo: [' (J1)', ' (J2)'], online: [tag(0, 'Hôte'), tag(1, 'Invité')] }[m.mode];
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
  $('resDefis').innerHTML = '';
  if (match?.game === 'dungeon') { endDungeon(); return; }
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
  if (match?.game === 'dungeon' && !remote && net.ws) { if (net.live) netInfo('Partie en ligne quittée.'); netClose(); }
  else if (net.live && !remote) netSend({ t: 'menu' });
  net.live = false;
  rb = null;
  sim.g.phase = 'menu';
  game.paused = false;
  ['hud', 'help', 'result', 'pause', 'reward'].forEach((id) => $(id).classList.add('hidden'));
  $('fade').classList.remove('on');
  $('menu').classList.remove('hidden');
  menuScene();
  refreshMenu();
}
// décor et personnages derrière le menu, selon le jeu choisi
function menuScene() {
  if (cfg.game === 'dungeon') { dungeonPreview(); return; }
  if (sim instanceof DungeonSim) sim = new Sim(1);
  if (curArena !== cfg.arena) buildArena(cfg.arena);
  menuFighters();
}

function togglePause() {
  if (!['intro', 'fight', 'ko', 'clear', 'exit', 'dead', 'hub'].includes(game.phase)) return;
  game.paused = !game.paused;
  $('pauseTxt').textContent = net.live ? 'En ligne, le combat continue pendant la pause !' : 'Échap pour reprendre';
  $('pause').classList.toggle('hidden', !game.paused);
  if (game.paused) down.clear();
}

// Une image de simulation (1/60 s). Retourne false si on doit attendre l'adversaire (en ligne).
function simTick() {
  F.forEach((v, i) => sim.f[i] && v.capture(sim.f[i]));
  if (sim instanceof DungeonSim && !rb) {
    sim.step(localInput(0), sim.g.np > 1 ? localInput(1) : NEUTRAL);
    playEvents(sim.ev);
    sim.ev.length = 0;
    return true;
  }
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
  if (sim instanceof DungeonSim) { dungeonHud(); return; }
  sim.f.forEach((f, i) => {
    const n = i + 1;
    const hp = Math.max(0, f.hp);
    setW('h' + n, hp);
    setCls('h' + n, 'low', hp < 30);
    setW('t' + n, hp);
    setW('g' + n, Math.max(0, f.guard));
    setCls('g' + n, 'low', f.guard < 30);
    setW('s' + n, Math.max(0, f.sta));
    setCls('s' + n, 'low', f.sta < STA.tired);
    setCls('s' + n, 'fail', f.staFail > 0);
    if (uiTxt['w' + n] !== game.wins[i]) { uiTxt['w' + n] = game.wins[i]; [...$('w' + n).children].forEach((pip, k) => pip.classList.toggle('on', game.wins[i] > k)); }
  });
  const tm = Math.ceil(game.timer);
  setTxt('timer', String(tm));
  setCls('timer', 'low', tm <= 10);
}

// =====================================================================
//  Caméra : toujours de profil par rapport aux deux combattants,
//  elle tourne autour d'eux quand ils se décalent en profondeur.
// =====================================================================
let camAng = 0;               // angle de la caméra autour du point milieu
const camPos = new THREE.Vector3();
const camTgt = new THREE.Vector3();
function camGoal(dt) {
  if (sim instanceof DungeonSim && game.phase !== 'loading') { dungeonCam(dt); return; }
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
let pixelRatio = Math.min(devicePixelRatio, 2), resAvg = 16, resN = 0, resGood = 0;
const maxPixelRatio = pixelRatio;
function adaptResolution(raw) {
  resAvg += (Math.min(raw, 0.1) * 1000 - resAvg) * 0.06;
  if (++resN % 90) return;
  let pr = pixelRatio;
  if (resAvg > 26) { pr = Math.max(0.7, pr - 0.25); resGood = 0; }
  else if (resAvg < 19 && ++resGood >= 4) { pr = Math.min(maxPixelRatio, pr + 0.25); resGood = 0; }
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
  if (sim instanceof DungeonSim && game.phase !== 'menu') dungeonSync();
  lobbySync();
  syncArrows(alpha);
  F.forEach((f, i) => sim.f[i] && f.render(sim.f[i], animDt, clockT, alpha));
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
  const fade = sim instanceof DungeonSim ? game.phase === 'exit' : game.phase === 'ko' && sim.g.flagFade;
  if (fade !== uiFade) { uiFade = fade; $('fade').classList.toggle('on', fade); }
  const txt = rb ? `${net.link?.state === 'rtc' ? 'direct' : 'relais'} · ↺ ${rb.stats.rollbacks}` : '';
  if (txt !== uiNet) { uiNet = txt; $('netStat').textContent = txt; }
}

// =====================================================================
//  Donjon (rogue-like) : affichage. Toute la logique est dans dungeon.js.
//  L'affichage suit l'ÉTAT de la simulation (salle, porte, coffre, pièges) plutôt que ses
//  événements : en ligne, le rollback peut revenir en arrière, l'image se recale seule.
// =====================================================================
const dng = { room: -1, gateOpen: false, chest: 0, gate: null, spawnChest: null, openChest: null, traps: [] };
const pickReq = [-1, -1];            // bénédiction choisie à l'écran, envoyée comme entrée
const DNG_REC = 'spartiate-donjon-record';
const ISO = Math.PI / 4;             // caméra en diagonale au-dessus de la salle (vue isométrique)
const HERO_COL = [0xff5a4a, 0x4aa3ff];
function dungeonRecord() { try { return +localStorage.getItem(DNG_REC) || 0; } catch (e) { return 0; } }
const clipOf = (key, name) => THREE.AnimationClip.findByName(G[key].animations, name);
function playOnce(mixer, key, name) {
  const a = mixer.clipAction(clipOf(key, name));
  a.setLoop(THREE.LoopOnce, 1);
  a.clampWhenFinished = true;
  a.reset().play();
  return a;
}
// héros joués sur cette machine
function localHeroes() {
  if (!(sim instanceof DungeonSim)) return [];
  if (match?.mode === 'online') return [net.me];
  return sim.g.np > 1 ? [0, 1] : [0];
}

// Les deux murs du fond (z = -R et x = -R) sont hauts ; les deux murs côté caméra
// sont bas pour ne pas cacher l'action. La sortie est toujours dans un mur du fond.
const SIDES = [
  { id: '+z', ang: 0, far: false }, { id: '+x', ang: Math.PI / 2, far: false },
  { id: '-z', ang: Math.PI, far: true }, { id: '-x', ang: -Math.PI / 2, far: true },
];

// lanterne murale des mines (le mur est derrière, la lanterne pend vers ry)
function wallLantern(x, z, ry, lightI) {
  P('b_lantern', x, 1.3, z, ry);
  const l = new THREE.PointLight(0xffc070, lightI, 9, 1.4);
  l.position.set(x + Math.sin(ry) * 0.35, 1.55, z + Math.cos(ry) * 0.35);
  world.add(l);
  const ph = rand(0, 10);
  updaters.push((dt, t) => { l.intensity = lightI * (0.9 + Math.sin(t * 3 + ph) * 0.05 + Math.sin(t * 11 + ph) * 0.04); });
}
// au-delà des murs : jardin (ruines) ou champ de lave (forge). On voit surtout les côtés bas (+x, +z) ;
// derrière les murs du fond, seulement ce qui dépasse (arbres), au-delà du couloir de la sortie.
function outsideDecor(kind, D, exit = 'z') {
  const far = D + TILE * 3;
  // couloir derrière la porte de sortie (mur -z ou -x) : on n'y met rien
  const corridor = (x, z) => (exit === 'z' ? Math.abs(x) < TILE * 1.6 && z < -D + 0.2 : Math.abs(z) < TILE * 1.6 && x < -D + 0.2);
  const out = (x, z) => Math.max(Math.abs(x), Math.abs(z)) > D + 0.2;
  const seen = (x, z) => (x > D + 0.2 || z > D + 0.2) || Math.min(x, z) < -far;     // côtés bas, ou derrière le couloir
  if (kind === 'lava') {
    const R = D + TILE * 5;
    for (let x = -R; x <= R + 0.01; x += TILE)
      for (let z = -R; z <= R + 0.01; z += TILE) {
        if (!out(x, z) || !(x > D + 0.2 || z > D + 0.2)) continue;
        const rim = Math.max(x, z) < D + TILE + 0.2;           // une rangée de dalles le long du muret
        PT(rim || Math.random() < 0.2 ? 'b_basalt-floor' : 'b_lava', x, 0, z, rot4());
      }
    for (const [x, z] of [[D + 3, -3], [D + 3, 3], [-3, D + 3], [3, D + 3], [D + 3, D + 3]]) {
      const l = new THREE.PointLight(0xff5a1a, 7, 11, 1.4);
      l.position.set(x, 0.6, z);
      world.add(l);
    }
    // bulles qui éclatent à la surface de la lave
    let bubT = 0;
    updaters.push((dt) => {
      bubT -= dt;
      if (bubT > 0) return;
      bubT = rand(0.15, 0.4);
      const a = rand(0, 1) < 0.5, u = rand(D + TILE * 1.6, D + TILE * 4.5), v = rand(-D, D + TILE * 4);
      emit(a ? u : v, 0.0, a ? v : u, 3, { color: [0xff9a2e, 0xffe27a], speed: 0.6, up: 2.2, size: 0.06, life: 0.6, grav: 6 });
    });
  } else if (kind === 'meadow') {
    // prairie : herbe et fleurs au pied des murs (deux rangées de dalles : ~500 triangles chacune), puis
    // le sol vert et des touffes instanciées ; arbres, buissons et rochers, collines au loin
    const R = D + TILE * 2;
    for (let x = -R; x <= R + 0.01; x += TILE)
      for (let z = -R; z <= R + 0.01; z += TILE) {
        if (!out(x, z) || corridor(x, z)) continue;
        PT(Math.random() < 0.2 ? 'b_grass-floor-flowers' : 'b_grass-floor', x, 0, z, rot4());
      }
    let trees = 0;
    const spot = (r0, r1) => {
      for (let tries = 0; tries < 20; tries++) {
        const x = rand(-r1, r1), z = rand(-r1, r1), m = Math.max(Math.abs(x), Math.abs(z));
        if (m > r0 && !corridor(x, z) && !(exit === 'z' ? Math.abs(x) < 3 && z < -D : Math.abs(z) < 3 && x < -D)) return [x, z];
      }
      return null;
    };
    for (let i = 0; i < 40 && trees < 26; i++) {
      const p = spot(D + 1.8, D + 12);
      if (!p || !seen(p[0], p[1])) continue;
      trees++;
      sway(P('a_tree', p[0], 0, p[1], rand(0, TAU), S * rand(1.0, 1.7)), 0.03, rand(1, 1.6));
    }
    for (let i = 0; i < 16; i++) { const p = spot(D + 0.9, D + 9); if (p) P('b_bush', p[0], 0, p[1], rand(0, TAU), S * rand(0.8, 1.35)); }
    for (let i = 0; i < 8; i++) { const p = spot(D + 1.2, D + 9); if (p) P('d_rocks', p[0], 0, p[1], rand(0, TAU), S * rand(0.7, 1.1)); }
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x5f8a4a, flatShading: true, roughness: 1 });
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * TAU + rand(-0.1, 0.1), r = rand(30, 40);
      const h = new THREE.Mesh(new THREE.ConeGeometry(rand(7, 11), rand(4, 9), 5), hillMat);
      h.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
      world.add(h);
    }
    // touffes d'herbe qui ondulent (une seule forme instanciée)
    const NT = 900, tufts = [];
    const tuft = new THREE.InstancedMesh(new THREE.ConeGeometry(0.05, 0.28, 4), new THREE.MeshStandardMaterial({ color: 0x7fa64a }), NT);
    for (let i = 0; i < NT; i++) { const p = spot(D + 0.3, D + 14) ?? [D + 2, D + 2]; tufts.push([p[0], p[1], rand(0, 6)]); }
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
    // fleurs des prés (immobiles, une forme instanciée, couleurs variées)
    const NF = 260, flowers = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.07, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }), NF);
    const fc = [0xfff1a0, 0xffffff, 0xff9ac8, 0xc8a0ff, 0xffc04a].map((c) => new THREE.Color(c));
    for (let i = 0; i < NF; i++) {
      const p = spot(D + 0.4, D + 12) ?? [D + 2, D + 2];
      dummy.position.set(p[0], 0.1, p[1]);
      dummy.rotation.set(0, rand(0, TAU), 0);
      dummy.scale.setScalar(rand(0.7, 1.3));
      dummy.updateMatrix();
      flowers.setMatrixAt(i, dummy.matrix);
      flowers.setColorAt(i, fc[(Math.random() * fc.length) | 0]);
    }
    world.add(flowers);
  } else if (kind === 'garden') {
    for (let i = 0; i < 26; i++) {
      const x = rand(-D - 8, D + 8), z = rand(-D - 8, D + 8);
      if (Math.max(Math.abs(x), Math.abs(z)) < D + 1.4 || !seen(x, z)) continue;
      const r = Math.random();
      if (r < 0.55) P('a_tree', x, 0, z, rand(0, TAU), S * rand(0.95, 1.45));
      else if (r < 0.85) P('b_bush', x, 0, z, rand(0, TAU), S * rand(0.8, 1.3));
      else P('a_columnD', x, 0, z, rot4(), S * rand(0.9, 1.2));
    }
  }
}
// antre de Cerbère : flammes aux quatre colonnes, brasiers dans les coins, ossements au sol
function lairDecor() {
  for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) fire(world, x, 1.55, z, 0.8, 4);
  for (const [x, z] of [[5.6, 5.6]]) brazier(x, z, 'a_columnD', 1.1, 6);
  const bone = new THREE.MeshStandardMaterial({ color: 0xd8cdb0, roughness: 0.9 });
  const shaft = new THREE.CylinderGeometry(0.035, 0.035, 0.42, 6).rotateZ(Math.PI / 2), knob = new THREE.SphereGeometry(0.06, 6, 4);
  for (let i = 0; i < 14; i++) {
    const a = rand(0, TAU), r = rand(4.2, 6.2), g = new THREE.Group();
    g.add(new THREE.Mesh(shaft, bone));
    for (const s of [-1, 1]) for (const d of [-0.04, 0.04]) { const k = new THREE.Mesh(knob, bone); k.position.set(s * 0.21, 0, d); g.add(k); }
    g.position.set(Math.sin(a) * r, 0.05, Math.cos(a) * r);
    g.rotation.y = rand(0, TAU);
    world.add(g);
  }
}
// ---------- Biomes (un par tranche de 5 salles, voir biomeOf dans dungeon.js) ----------
// Pièces : [clé, échelle y absolue] (null = pas d'étirement : les modèles générés ont déjà la bonne
// hauteur) ; block : [clé, hauteur du modèle] pour les estrades. Couleurs : [début, fin de la tranche].
// Obstacles : mêmes emplacements et collisions dans tous les biomes (dungeon.js), seul l'habillage change.
const BIOME = {
  crypt: {
    name: 'LES CRYPTES', floor: ['d_floor', 'd_floorD'], detail: 0.25,
    wall: ['d_wall', 2.25], wallAlt: null, low: ['d_wallHalf', 0.55], open: ['d_wallOpen', 2.475], block: ['d_wall', 1.1],
    obs: { column: ['d_column', 1.15, true], barrel: ['d_barrel', 1.2], rocks: ['d_rocks', 0.95] },
    bg: [0x2c2636, 0x0c0a12], sky: [0xfff1dc, 0x8a88b8], gnd: [0x6a5040, 0x2a1c1a], hi: [1.3, 1.0], sun: [0xffe2b0, 0xa8b0ff], si: [1.6, 1.0],
    ground: [0x1c1820, 0x0a080c], fog: [24, 46], wallLight: 'torch', banners: true, brazier: 'd_barrel', lantern: 1,
    motes: { color: 0xffd9a0, up: 0.08, size: 0.05 },
  },
  mine: {
    name: 'LES MINES DE CRISTAL', floor: ['b_mine-floor', 'b_mine-floor-stones'], detail: 0.3,
    wall: ['b_mine-wall', null], wallAlt: ['b_mine-wall-ore', 0.22], low: ['b_mine-low', null], open: ['b_mine-portal', null], block: ['b_mine-low', 0.55],
    obs: { column: ['b_mine-pillar', 1, true], barrel: ['b_minecart', 1, true], rocks: ['b_crystals', 1] },
    bg: [0x1c1820, 0x07060a], sky: [0xffe0b8, 0x7a88c8], gnd: [0x5a4030, 0x1a1210], hi: [1.15, 0.85], sun: [0xffd8a0, 0x9ab0ff], si: [1.3, 0.8],
    ground: [0x17120f, 0x080605], fog: [22, 42], wallLight: 'lantern', banners: false, brazier: 'd_barrel', lantern: 1.1,
    motes: { color: 0x9ad0ff, up: 0.05, size: 0.045 }, glowObs: { rocks: 0x6aa8ff },
  },
  ruins: {
    name: 'LES RUINES ENVAHIES', floor: ['a_floor', 'a_floorD', 'b_grass-floor', 'b_grass-floor-flowers'], detail: 0.25, grass: 0.45,
    wall: ['b_ruin-wall', null], wallAlt: ['b_ruin-wall-broken', 0.4], low: ['b_ruin-low', null], open: ['b_ruin-portal', null], block: ['a_block', 0.5],
    obs: { column: ['a_columnD', 1.15, true], barrel: ['a_bricks', 1.2], rocks: ['b_bush', 1] },
    sky: [0xfff4e0, 0xffc8a0], gnd: [0x5a7040, 0x3a3a30], hi: [1.5, 1.2], sun: [0xfff0d0, 0xffb070], si: [2.2, 1.7],
    skyTex: [[0, '#4a8fd8'], [0.6, '#a8d0ee'], [1, '#f4e2c0']], skyTexEnd: [[0, '#3a3a78'], [0.5, '#c06a70'], [1, '#ffc080']],
    bg: [0xf4e2c0, 0xffc080], ground: [0x5e8a48, 0x4a6a3a], fog: [30, 70], wallLight: null, banners: false, brazier: 'a_columnD', lantern: 0.3,
    motes: { color: 0xe8f0a0, up: 0.03, size: 0.04 }, outside: 'garden',
  },
  forge: {
    name: 'LA FORGE VOLCANIQUE', floor: ['b_basalt-floor', 'b_basalt-floor-cracks'], detail: 0.35,
    wall: ['b_basalt-wall', null], wallAlt: null, low: ['b_basalt-low', null], open: ['b_basalt-portal', null], block: ['b_basalt-low', 0.55],
    obs: { column: ['b_obsidian', 1, true], barrel: ['b_anvil', 1, true], rocks: ['b_lava-rocks', 1] },
    bg: [0x2a0e08, 0x120404], sky: [0xffb080, 0xff7a50], gnd: [0x601a08, 0x300a04], hi: [1.0, 0.85], sun: [0xffa070, 0xff7050], si: [1.2, 0.9],
    ground: [0x140806, 0x0a0403], fog: [22, 44], wallLight: 'torch', banners: true, brazier: 'a_columnD', lantern: 0.8,
    motes: { color: 0xff8a3a, up: 0.45, size: 0.06 }, glowObs: { rocks: 0xff6a2a, column: 0xff6a2a }, outside: 'lava',
  },
};
// salle d'armes : murs des cryptes, mais en plein air, au milieu d'une prairie (verdure au-delà des murs)
BIOME.hub = {
  ...BIOME.crypt, name: "LA SALLE D'ARMES",
  skyTex: [[0, '#4f93dc'], [0.6, '#a9d3ef'], [1, '#efe6c6']], skyTexEnd: [[0, '#4f93dc'], [0.6, '#a9d3ef'], [1, '#efe6c6']],
  bg: [0xefe6c6, 0xefe6c6], sky: [0xfff4e0, 0xfff4e0], gnd: [0x5a7040, 0x5a7040], hi: [1.45, 1.45], sun: [0xfff0d0, 0xfff0d0], si: [2.1, 2.1],
  ground: [0x5e8a48, 0x5e8a48], fog: [36, 90], lantern: 0.5, motes: { color: 0xe8f0a0, up: 0.03, size: 0.04 }, outside: 'meadow',
};
// antre de Cerbère (salle dédiée, room.lair) : basalte, lave tout autour, lueurs rouges
BIOME.lair = {
  ...BIOME.forge, name: "L'ANTRE DE CERBÈRE",
  bg: [0x1a0404, 0x1a0404], sky: [0xff7050, 0xff7050], gnd: [0x701008, 0x701008], hi: [0.9, 0.9], sun: [0xff6040, 0xff6040], si: [1.0, 1.0],
  ground: [0x0e0302, 0x0e0302], fog: [20, 40], lantern: 0.9, motes: { color: 0xff5a20, up: 0.6, size: 0.07 },
};
const rot4 = () => ((Math.random() * 4) | 0) * Math.PI / 2;

// n : numéro de la salle. Chaque biome s'assombrit un peu au fil de sa tranche ; salle du boss en rouge.
function buildDungeonRoom(room, n) {
  clearWorld();
  updaters = [];
  for (const id of ['talk', 'shop']) $(id).classList.add('hidden');   // marchand (salle d'armes)
  crowd = null;
  arenaHooks = {};
  curArena = 'dungeon';
  Object.assign(dng, { gateOpen: false, chest: 0, gate: null, spawnChest: null, openChest: null, traps: [] });
  const boss = room.boss;
  dng.biome = room.hub ? 'hub' : room.lair ? 'lair' : biomeOf(n);
  const B = BIOME[dng.biome];
  const k = clamp(((Math.max(n, 1) - 1) % 5) / 4, 0, 1) * (boss ? 1 : 0.85);   // 0 : début de la tranche … 1 : salle du boss
  const red = boss ? 0.45 : 0;                                                   // teinte rouge de la salle du boss
  const col = ([a, b], tint) => new THREE.Color(a).lerp(new THREE.Color(b), k).lerp(new THREE.Color(tint ?? 0x000000), tint === undefined ? 0 : red);
  const num = ([a, b]) => a + (b - a) * k;
  const bg = col(B.bg, 0x2a0606);
  if (B.skyTex) {
    // ciel : dégradé du début vers le crépuscule de fin de tranche
    const st = B.skyTex.map(([p, c], i) => [p, '#' + new THREE.Color(c).lerp(new THREE.Color(B.skyTexEnd[i][1]), k).lerp(new THREE.Color(0x6a1010), red).getHexString()]);
    scene.background = skyTex(st);
  } else scene.background = bg;
  scene.fog = new THREE.Fog(bg, B.fog[0] - 4 * k, B.fog[1] - 6 * k);
  lights(col(B.sky, 0xb07080), col(B.gnd, 0x2a1010), num(B.hi), col(B.sun, 0xff9070), num(B.si), [-4, 14, -2]);
  ground(col(B.ground));

  // dalles du sol (estrades : même tirage)
  const floorKey = () => {
    if (B.grass && Math.random() < B.grass) return B.floor[Math.random() < 0.3 ? 3 : 2];
    return B.floor[Math.random() < B.detail ? 1 : 0];
  };
  const wallKey = () => (B.wallAlt && Math.random() < B.wallAlt[1] ? B.wallAlt[0] : B.wall[0]);
  // pièce de mur : [clé, échelle y] ; les modèles générés sont symétriques, on les retourne au hasard
  const piece = ([key, sy], x, z, ry, gen = key === B.wall[0]) => {
    const o = P(gen ? wallKey() : key, x, 0, z, ry + (sy === null && Math.random() < 0.5 ? Math.PI : 0));
    if (sy !== null) o.scale.y = sy;
    return o;
  };

  const D = ROOM_R + TILE / 2;      // centre des blocs de mur
  for (let x = -ROOM_T; x <= ROOM_T + 0.01; x += TILE)
    for (let z = -ROOM_T; z <= ROOM_T + 0.01; z += TILE)
      PT(floorKey(), x, 0, z, rot4());

  const exitId = room.exit === 'z' ? '-z' : '-x', entryId = room.exit === 'z' ? '+z' : '+x';
  for (const sd of SIDES) {
    const ox = Math.sin(sd.ang), oz = Math.cos(sd.ang);     // vers l'extérieur
    const tx = Math.cos(sd.ang), tz = -Math.sin(sd.ang);    // le long du mur
    const at = (d, t) => [ox * d + tx * t, oz * d + tz * t];
    for (let t = -ROOM_T; t <= ROOM_T + 0.01; t += TILE) {
      const [x, z] = at(D, t);
      const mid = Math.abs(t) < 0.1;
      if (sd.far) {
        if (mid && sd.id === exitId) {
          const o = P(B.open[0], x, 0, z, sd.ang + Math.PI);
          if (B.open[1] !== null) o.scale.y = B.open[1];
        } else piece(B.wall, x, z, sd.ang + Math.PI);
      } else if (!(mid && sd.id === entryId)) piece(B.low, x, z, sd.ang);
    }
    if (!sd.far) continue;
    // lumières des murs du fond (salle d'armes : pas sur le mur de la porte, les présentoirs y sont)
    if (B.wallLight && !(room.hub && sd.id === exitId)) for (const t of [-3.75, 3.75]) {
      const [x, z] = at(ROOM_R - 0.13, t);
      if (B.wallLight === 'torch') torch(x, 1.5, z, sd.ang + Math.PI, 4 + 4 * k);
      else wallLantern(x, z, sd.ang + Math.PI, 4 + 4 * k);
    }
    if (sd.id !== exitId) continue;
    // porte de sortie : herse, bannières, couloir éclairé derrière
    if (B.banners) for (const t of [-1.5, 1.5]) { const [x, z] = at(D, t); sway(P('d_banner', x, 0.25, z, sd.ang + Math.PI), 0.04, 1.4, 'x'); }
    for (const d of [D, D + TILE, D + TILE * 2]) { const [x, z] = at(d, 0); P(B.floor[0], x, 0, z); }
    for (const d of [D + TILE, D + TILE * 2]) for (const t of [-TILE, TILE]) { const [x, z] = at(d, t); piece(B.wall, x, z, sd.ang); }
    { const [x, z] = at(D + TILE * 2, 0); const l = new THREE.PointLight(0xffa860, 5, 6, 1.5); l.position.set(x, 1.4, z); world.add(l); }
    const [gx, gz] = at(ROOM_R + 0.08, 0);
    const gate = P('d_gate', gx, 0, gz, sd.ang + Math.PI, 2.0);
    gate.scale.y = 2.6;
    const gm = new THREE.AnimationMixer(gate);
    const closing = playOnce(gm, 'd_gate', 'close');
    gm.update(10);
    updaters.push((dt) => gm.update(dt));
    dng.gate = {
      open() {
        closing.stop();
        playOnce(gm, 'd_gate', 'open');
        sfx.heavy();
        emit(gx, 0.2, gz, 14, { color: [0x8a8090, 0x5a5260], speed: 1.5, up: 1.5, size: 0.08, life: 0.7, grav: 4, spread: 0.5 });
      },
    };
  }
  // coins
  piece(B.wall, -D, -D, 0);
  piece(B.wall, D, -D, 0);
  piece(B.wall, -D, D, 0);
  piece(B.low, D, D, 0);
  if (B.outside) outsideDecor(B.outside, D, room.exit);

  // estrades (blocs surmontés de dalles) et escaliers
  for (const s of room.surf) {
    for (let x = s.x0 + TILE / 2; x < s.x1; x += TILE)
      for (let z = s.z0 + TILE / 2; z < s.z1; z += TILE) {
        if (!s.ramp) {
          P(B.block[0], x, 0, z, rot4()).scale.y = PLAT_H / B.block[1];
          PT(floorKey(), x, PLAT_H + 0.003, z, rot4());
        } else {
          // le modèle d'escalier monte vers son -z local : on le tourne vers le haut de la rampe
          const dir = Math.sign(s.to - s.from), dx = s.ramp === 'x' ? dir : 0, dz = s.ramp === 'z' ? dir : 0;
          P('d_stairs', x, 0, z, Math.atan2(-dx, -dz)).scale.y = PLAT_H / 0.9;
        }
      }
    if (!s.ramp) {
      // un brasero sur un coin de l'estrade, côté mur
      const cx = Math.abs(s.x0) > Math.abs(s.x1) ? s.x0 + 0.45 : s.x1 - 0.45;
      const cz = Math.abs(s.z0) > Math.abs(s.z1) ? s.z0 + 0.45 : s.z1 - 0.45;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.16, 0.18, 10), ironMat);
      bowl.position.set(cx, PLAT_H + 0.09, cz); bowl.castShadow = true;
      world.add(bowl);
      fire(world, cx, PLAT_H + 0.14, cz, 0.9, 3 + 3 * k);
    }
  }

  // obstacles (leur collision est dans dungeon.js) : [clé, échelle, quart de tour seulement]
  for (const o of room.obs) {
    if (o.kind === 'stand' || o.kind === 'counter') continue;      // salle d'armes : socles et comptoir construits par buildHub
    const [key, s, square] = B.obs[o.kind] ?? B.obs.rocks;
    P(key, o.x, 0, o.z, square ? rot4() : rand(0, TAU), S * s);
    if (o.kind === 'barrel' && key === 'd_barrel') P('d_pot', o.x + 0.45, 0, o.z + 0.3, rand(0, TAU), 1.1);
    const glow = B.glowObs?.[o.kind];
    if (glow) { const l = new THREE.PointLight(glow, 2.5, 4, 1.6); l.position.set(o.x, 0.9, o.z); world.add(l); }
  }
  if (boss) for (const [x, z] of [[-5.6, -5.6], [5.6, -5.6], [-5.6, 5.6]]) brazier(x, z, B.brazier, B.brazier === 'd_barrel' ? 1.3 : 1.1, 6);
  if (room.lair) lairDecor();
  if (room.hub) buildHub(room);

  // pièges à pics : l'animation suit l'état des pics dans la simulation
  room.traps.forEach((t, i) => {
    const o = P('d_trap', t.x, 0.004, t.z, 0, S);
    const mx = new THREE.AnimationMixer(o);
    playOnce(mx, 'd_trap', 'hide');
    mx.update(1);
    updaters.push((dt) => mx.update(dt));
    dng.traps.push({ x: t.x, z: t.z, mx, up: false, warnT: 0 });
  });

  // une lanterne par héros
  const lanterns = [0, 1].map(() => { const l = new THREE.PointLight(0xffc890, (3 + 6 * k) * B.lantern, 10, 1.4); world.add(l); return l; });
  updaters.push(() => {
    lanterns.forEach((l, i) => {
      const v = F[i], on = sim instanceof DungeonSim && i < sim.g.np && v;
      l.visible = !!on;
      if (on) l.position.set(v.rx, v.ry + 2.6, v.rz);
    });
  });

  // poussière dans la lumière (cristaux des mines, pollen des ruines, braises de la forge)
  const N = 160, pos = new Float32Array(N * 3), seed = [];
  for (let i = 0; i < N; i++) seed.push([rand(-6.5, 6.5), rand(0, 3.5), rand(-6.5, 6.5), rand(0, 6)]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const motes = new THREE.Points(geo, new THREE.PointsMaterial({ color: B.motes.color, size: B.motes.size, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
  motes.frustumCulled = false;
  world.add(motes);
  updaters.push((dt, t) => {
    for (let i = 0; i < N; i++) {
      const s = seed[i];
      s[1] += dt * B.motes.up; if (s[1] > 3.5) s[1] = 0;
      pos[i * 3] = s[0] + Math.sin(t * 0.3 + s[3]) * 0.4;
      pos[i * 3 + 1] = s[1];
      pos[i * 3 + 2] = s[2] + Math.cos(t * 0.25 + s[3]) * 0.3;
    }
    geo.attributes.position.needsUpdate = true;
  });

  // coffre (apparaît quand la salle est nettoyée) ; sa lumière existe dès le départ, éteinte,
  // pour que son apparition ne force pas la recompilation des shaders
  const glow = new THREE.PointLight(0xffd34a, 0, 4, 1.5);
  world.add(glow);
  flushTiles();
  padLights();                       // toutes les lumières de la salle sont posées
  dng.spawnChest = () => {
    const cx = sim.g.chestX, cz = sim.g.chestZ;
    const ch = P('d_chest', cx, 0, cz, ISO, S * 1.2);
    const cm = new THREE.AnimationMixer(ch);
    glow.position.set(cx, 1.1, cz);
    let opened = false, sparkT = 0, grow = 0;
    ch.scale.setScalar(0.01);
    ring(cx, 0.05, cz, 0xffd34a, 2.2, 0.6, true);
    emit(cx, 0.4, cz, 20, { color: [0xffd34a, 0xfff0a0], speed: 2, up: 3, size: 0.07, life: 0.8, grav: 6 });
    updaters.push((dt, t) => {
      cm.update(dt);
      if (grow < 1) { grow = Math.min(1, grow + dt * 4); ch.scale.setScalar(S * 1.2 * (1 + Math.sin(grow * Math.PI) * 0.25) * grow); }
      if (opened) { glow.intensity = Math.max(0.8, glow.intensity - dt * 6); return; }
      glow.intensity = 4 + Math.sin(t * 5) * 1.2;
      sparkT -= dt;
      if (sparkT < 0) { sparkT = 0.12; emit(cx + rand(-0.4, 0.4), 0.7, cz + rand(-0.4, 0.4), 1, { color: [0xffe27a, 0xffffff], speed: 0.3, up: 1.2, size: 0.05, life: 0.8, grav: -0.5 }); }
    });
    dng.openChest = () => {
      opened = true;
      playOnce(cm, 'd_chest', 'open');
      emit(cx, 0.6, cz, 30, { color: [0xffd34a, 0xffe27a, 0xffffff], speed: 2.5, up: 5, size: 0.08, life: 1.1, grav: 9 });
    };
  };
}

// ---------- Salle d'armes : statues des héros, marchand d'armes, dalles de choix ----------
// étiquette toujours tournée vers la caméra
function label(text, sub, x, y, z, w = 1.5) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = sub ? 150 : 96;
  const x2 = c.getContext('2d');
  x2.fillStyle = 'rgba(14,9,5,0.78)';
  x2.beginPath(); x2.roundRect(4, 4, 504, c.height - 8, 22); x2.fill();
  x2.strokeStyle = 'rgba(217,164,65,0.8)'; x2.lineWidth = 4; x2.stroke();
  x2.textAlign = 'center'; x2.textBaseline = 'middle';
  x2.fillStyle = '#f1c66d'; x2.font = '800 54px Cinzel, serif';
  x2.fillText(text, 256, sub ? 52 : c.height / 2, 480);
  if (sub) { x2.fillStyle = '#f5ead4'; x2.font = '500 38px "Barlow Condensed", sans-serif'; x2.fillText(sub, 256, 108, 480); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  sp.scale.set(w, w * c.height / 512, 1);
  sp.position.set(x, y, z);
  sp.renderOrder = 5;
  world.add(sp);
  return sp;
}
const padGeo = new THREE.CircleGeometry(PAD_R, 32).rotateX(-Math.PI / 2);
const padRing = new THREE.RingGeometry(PAD_R - 0.06, PAD_R, 40).rotateX(-Math.PI / 2);
keep(padGeo, padRing);
function buildHub(room) {
  // héros verrouillés pour le joueur de cette machine : statue grise et figée, dalle éteinte
  const me = localHeroes()[0] ?? 0;
  const lockedFor = (id) => sim instanceof DungeonSim && !sim.canPick(me, id);
  const pads = room.pads.map((pd) => {
    const hero = pd.t === 'hero', locked = hero && lockedFor(pd.id);
    const col = locked ? 0x8a8a90 : hero ? 0xffc04a : 0x6fc3ff;
    // dalle lumineuse
    const disc = new THREE.Mesh(padGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false }));
    disc.position.set(pd.x, 0.012, pd.z);
    const rim = new THREE.Mesh(padRing, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }));
    rim.position.set(pd.x, 0.014, pd.z);
    world.add(disc, rim);
    if (!hero) return { pd, disc, rim, show: null, mixer: null, yes: null, sel: false };
    // socle de pierre et statue vivante du héros, tournée vers la salle
    const st = padStand(pd);
    const base = P('d_wall', st.x, 0, st.z, 0, 0.62);
    base.scale.y = 0.2;
    const show = inst(pd.id, 1.6);
    // verrouillé : statue de pierre (gris uni, sans la palette)
    if (locked) show.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.map = null; o.material.color.setHex(0x8a8580); } });
    show.position.set(st.x, 0.25, st.z);
    show.rotation.y = Math.PI / 2;
    const bow = show.getObjectByName('bow');
    if (bow) bow.getObjectByName('nocked').visible = false;
    world.add(show);
    const mixer = new THREE.AnimationMixer(show);
    mixer.clipAction(clipOf(pd.id, 'idle')).play();
    mixer.update(Math.random());
    const clip = clipOf(pd.id, 'emote-yes');
    let yes = null;
    if (clip) { yes = mixer.clipAction(clip); yes.setLoop(THREE.LoopOnce, 1); }
    const prev = HEROES[HERO_IDS[HERO_IDS.indexOf(pd.id) - 1]];
    label((locked ? '🔒 ' : '') + HEROES[pd.id].name, locked ? `Défi du ${prev?.name ?? ''} requis` : HEROES[pd.id].desc, st.x + 0.2, 2.15, st.z, 1.25);
    return { pd, disc, rim, show, mixer: locked ? null : mixer, yes, sel: false, locked };
  });
  buildMerchant();
  // tapis au centre de la salle
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 5.2), new THREE.MeshStandardMaterial({ color: 0x7a1e1a, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(0.6, 0.008, 1.2); rug.receiveShadow = true;
  world.add(rug);
  const rugIn = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 4.7), new THREE.MeshStandardMaterial({ color: 0xa8742a, roughness: 1 }));
  rugIn.rotation.x = -Math.PI / 2; rugIn.position.set(0.6, 0.01, 1.2);
  world.add(rugIn);
  const rugC = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 4.4), new THREE.MeshStandardMaterial({ color: 0x7a1e1a, roughness: 1 }));
  rugC.rotation.x = -Math.PI / 2; rugC.position.set(0.6, 0.012, 1.2);
  world.add(rugC);
  label('EN AVANT !', 'Franchis la porte quand tu es prêt', 0, 2.9, -6.2, 1.9);

  // ce que portent les héros : leur dalle brille, la statue salue au moment du choix
  updaters.push((dt, t) => {
    const hs = sim instanceof DungeonSim ? sim.heroes : [];
    for (const p of pads) {
      const sel = hs.some((h) => (p.pd.t === 'hero' ? h.kind === p.pd.id : h.shop > 0));
      if (sel && !p.sel && p.yes) p.yes.reset().play();
      p.sel = sel;
      // la dalle du marchand pulse doucement pour attirer l'œil
      p.disc.material.opacity = sel ? 0.45 + 0.12 * Math.sin(t * 4) : p.pd.t === 'shop' ? 0.2 + 0.1 * Math.sin(t * 2.5) : p.locked ? 0.06 : 0.14;
      p.rim.material.opacity = sel ? 1 : p.locked ? 0.3 : 0.55;
      if (p.mixer) p.mixer.update(dt);
    }
  });
}

// ---------- Marchand d'armes ----------
// Un vieux marchand barbu derrière son étal, à droite de la porte. Un héros qui marche sur la dalle
// devant le comptoir entre dans sa boutique (état p.shop de la simulation) : la caméra passe derrière
// lui, le marchand lui parle et les armes défilent au-dessus du comptoir (← → pour choisir).
// Tout ici est de l'affichage : le choix lui-même passe par la simulation (entrées des joueurs).
const SHOP_LINES = {
  sword: 'Le glaive et son bouclier : simple, rapide, fidèle.',
  spear: 'La lance ! Tiens-les à distance, mon brave.',
  tower: 'Le pavois… derrière ça, on ne craint pas grand-chose.',
  axe: 'Une bonne hache, ça fend les crânes d\'orc !',
  hammer: 'Le marteau : un seul coup, mais quel coup !',
  staff: 'Le sceptre de feu… attention à ma barbe !',
  tome: 'Ce grimoire appelle des chiens fidèles. Ouaf !',
  gloves: 'Des gants de boxe ! Tu prendras des coups, mais tu tiendras debout.',
  bow: 'Un arc, pour frapper de loin. Malin, ça.',
};
const SHOP_SHORT = { sword: 'Glaive', spear: 'Lance', tower: 'Pavois', axe: 'Hache', hammer: 'Marteau', staff: 'Sceptre', tome: 'Grimoire', gloves: 'Gants', bow: 'Arc' };
const shopReq = [-1, -1];            // arme choisie à l'écran (clic, touches 1 à 9), envoyée comme entrée
const shopUi = { key: '', say: '', sayT: 0, last: [{ shop: 0, wpn: '' }, { shop: 0, wpn: '' }] };
// héros joué sur cette machine qui est dans la boutique (-1 sinon) : la caméra se place derrière lui
function localShopper() {
  if (!(sim instanceof DungeonSim) || sim.g.phase !== 'hub') return -1;
  return localHeroes().find((h) => sim.f[h]?.shop > 0) ?? -1;
}
function say(text, dur) { shopUi.say = text; shopUi.sayT = dur; }
// arme seule, telle qu'exposée au-dessus du comptoir
function weaponShow(id) {
  const g = new THREE.Group();
  if (id === 'gloves') {
    for (const r of [false, true]) { const gl = gloveModel(r, 1.5); gl.position.set(r ? -0.13 : 0.13, 0.05, 0); g.add(gl); }
    return g;
  }
  const key = { spear: 'spear', axe: 'axe', hammer: 'hammer', staff: 'staff', tome: 'tome' }[id] ?? 'sword';
  const main = id === 'bow' ? bowGroup() : inst(key, id === 'spear' ? 1.6 : 1.3);
  if (id === 'bow') { main.getObjectByName('nocked').visible = true; main.scale.setScalar(1.5); }
  else main.position.y = id === 'spear' ? -0.45 : key === 'sword' ? -0.22 : -0.35;
  if (id === 'staff') glowOrb(main);
  if (id === 'tome') { glowNode(main, 'rune', runeColor); main.position.y = 0; }
  g.add(main);
  if (id === 'sword' || id === 'tower' || id === 'axe') {
    const sh = inst(id === 'tower' ? 'tower' : 'shield', id === 'tower' ? 1.5 : 1.15);
    sh.position.set(0, id === 'tower' ? -0.25 : 0, -0.18);
    g.add(sh);
  }
  return g;
}
function buildMerchant() {
  const M = MERCHANT;
  const stall = inst('stall', 1);
  stall.position.set(M.x, 0, M.counterZ);
  world.add(stall);
  // pièces d'or et pot sur le comptoir, râteliers d'armes contre le mur
  for (const [dx, dz, r] of [[-0.85, 0.05, 0.3], [-0.7, -0.1, 1.2], [0.9, 0, 2]]) P('d_coin', M.x + dx, 0.6, M.counterZ + dz, r, 0.5);
  P('d_pot', M.x + 1.35, 0, M.counterZ - 0.45, 0.4, 1);
  for (const x of [-1.8, -3.6]) P('a_rack', x, 0, -6.15, 0, 1.3);
  P('d_barrel', -5.2, 0, -5.9, 0.3, S);
  const sign = label("MARCHAND D'ARMES", '', M.x, 2.45, M.counterZ + 0.1, 1.7);

  // le marchand se tient sur une caisse (sa tête dépasse du comptoir), à droite de l'étal ;
  // les armes défilent sur la gauche du comptoir
  const MX = M.x + 0.5, AX = M.x - 0.6;
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.5), new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 1 }));
  box.position.set(MX, 0.11, M.z); box.castShadow = box.receiveShadow = true;
  world.add(box);
  const man = inst('merchant', 1.6);
  man.position.set(MX, 0.22, M.z);
  world.add(man);
  const mixer = new THREE.AnimationMixer(man);
  const idle = mixer.clipAction(clipOf('merchant', 'idle'));
  idle.play();
  let cur = null;
  // geste ponctuel (salut, oui, non), puis retour au repos
  const gesture = (name) => {
    const a = mixer.clipAction(clipOf('merchant', name));
    if (cur && cur !== a) cur.fadeOut(0.15);
    a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.fadeIn(0.15).play();
    idle.fadeOut(0.15);
    cur = a;
  };
  mixer.addEventListener('finished', (e) => {
    if (e.action !== cur) return;
    cur.fadeOut(0.25); cur = null;
    idle.reset().fadeIn(0.25).play();
  });

  // armes qui défilent au-dessus du comptoir pendant le choix
  const shows = WEAPON_IDS.map((id) => {
    const g = weaponShow(id);
    g.visible = false;
    world.add(g);
    return g;
  });
  const lamp = new THREE.PointLight(0xffd9a0, 0.8, 4, 1.5);
  lamp.position.set(M.x, 1.9, M.counterZ + 0.9);
  world.add(lamp);
  shopUi.last.forEach((o) => { o.shop = 0; o.wpn = ''; });
  say('', 0);

  updaters.push((dt, t) => {
    const hs = sim instanceof DungeonSim ? sim.heroes : [];
    const buyer = hs.find((h) => h.shop > 0);
    // réactions du marchand, d'après l'état de la simulation (rien à défaire en cas de rollback)
    hs.forEach((h, i) => {
      const was = shopUi.last[i];
      if (was.wpn) {
        if (h.shop && !was.shop) { gesture('interact-right'); say('Tu veux quelle arme, mon brave ?', 0); }
        else if (h.shop && h.shop !== was.shop) say(SHOP_LINES[WEAPON_IDS[h.shop - 1]] ?? '', 0);
        else if (!h.shop && was.shop) {
          if (h.wpn !== was.wpn) { gesture('emote-yes'); say('Bon choix, mon brave ! Fais-en bon usage.', 2.6); }
          else { gesture('emote-no'); say('Reviens quand tu veux !', 2); }
        }
      }
      was.shop = h.shop; was.wpn = h.wpn;
    });
    // il se tourne vers son client, ou vers le héros le plus proche
    let look = 0, best = 4.5;
    for (const h of hs) {
      const d = h.shop ? -1 : Math.hypot(h.x - MX, h.z - M.z);
      if (d < best) { best = d; look = clamp(Math.atan2(h.x - MX, h.z - M.z), -0.9, 0.9); }
    }
    man.rotation.y += (look - man.rotation.y) * Math.min(1, dt * 4);
    mixer.update(dt);
    shopUi.sayT -= dt;
    if (!buyer && shopUi.sayT <= 0) {
      const near = hs.some((h) => h.state !== 'dead' && Math.hypot(h.x - M.x, h.z - (M.counterZ + 1.5)) < 2.4);
      shopUi.say = near ? 'Approche, mon brave ! J\'ai de belles armes.' : '';
    }
    // carrousel : l'arme montrée au centre, ses voisines de part et d'autre
    const sel = buyer ? buyer.shop - 1 : -1, N = WEAPON_IDS.length, k2 = Math.min(1, dt * 10);
    shows.forEach((g, k) => {
      let d = sel < 0 ? 9 : (k - sel + N) % N;
      if (d > N / 2) d -= N;
      if (Math.abs(d) > 1) { g.visible = false; return; }
      const x = AX + d * 0.58;
      if (!g.visible) { g.visible = true; g.position.set(x, 1, M.counterZ); g.scale.setScalar(0.01); }
      g.position.x += (x - g.position.x) * k2;
      g.position.y = (d ? 0.92 : 1.12) + Math.sin(t * 2 + k) * 0.04;
      g.position.z = M.counterZ + (d ? -0.1 : 0.1);
      g.scale.setScalar(g.scale.x + ((d ? 0.55 : 1.05) - g.scale.x) * k2);
      g.rotation.y = d ? -0.5 * d : t * 1.2;
    });
    lamp.intensity += ((buyer ? 3 : 0.8) - lamp.intensity) * Math.min(1, dt * 4);
    sign.visible = localShopper() < 0;   // vue de près : l'enseigne passerait sous le titre
    shopSync();
  });
}

// bulle du marchand et panneau de choix (HTML par-dessus la scène)
function shopSync() {
  const hub = sim instanceof DungeonSim && sim.g.phase === 'hub' && !game.paused;
  const talk = $('talk');
  const v = v1.set(MERCHANT.x + 0.5, 1.75, MERCHANT.z).project(camera);
  if (hub && shopUi.say && v.z < 1) {
    talk.classList.remove('hidden');
    if (talk.dataset.txt !== shopUi.say) { talk.dataset.txt = shopUi.say; $('talkTxt').textContent = shopUi.say; }
    talk.style.left = ((v.x + 1) / 2 * innerWidth) + 'px';
    talk.style.top = ((1 - v.y) / 2 * innerHeight) + 'px';
  } else talk.classList.add('hidden');

  const h = hub ? localShopper() : -1;
  for (const k of [0, 1]) if (k !== h) shopReq[k] = -1;
  $('help').classList.toggle('shopping', h >= 0);
  if (h < 0) { shopUi.key = ''; $('shop').classList.add('hidden'); return; }
  const p = sim.f[h], sel = p.shop - 1;
  const key = [h, sel, p.wpn].join('|');
  if (key === shopUi.key) return;
  shopUi.key = key;
  const id = WEAPON_IDS[sel], w = WEAPONS[id];
  $('shopName').textContent = w.name;
  $('shopMine').classList.toggle('hidden', id !== p.wpn);
  $('shopDesc').textContent = w.desc;
  $('shopList').innerHTML = WEAPON_IDS.map((wid, k) =>
    `<button class="${k === sel ? 'on' : ''}${wid === p.wpn ? ' mine' : ''}" data-k="${k}"><kbd>${k + 1}</kbd>${esc(SHOP_SHORT[wid] ?? WEAPONS[wid].name)}</button>`).join('');
  $('shopList').querySelectorAll('button').forEach((b) => { b.onclick = () => { shopReq[h] = +b.dataset.k; }; });
  const ks = KEYSETS[localHeroes().length > 1 ? h : 0];
  const k1 = (act) => kb(key1(ks, act) ?? '?');
  $('shopKeys').innerHTML = `${k1('l')} ${k1('r')} choisir · ${k1('atk')} ou ${k1('jump')} prendre · ${k1('d')} ou ${k1('blk')} partir`;
  $('shop').classList.remove('hidden');
}

// vues des héros (gardées d'une salle à l'autre) et des ennemis de la salle
function dungeonViews() {
  const np = sim.g.np;
  const keep = F.length >= np && F.slice(0, np).every((v, i) => v.hero);
  if (!keep) { F.forEach((v) => v.dispose()); F = []; }
  else { F.slice(np).forEach((v) => v.dispose()); F.length = np; heroViews(); }
  for (let i = F.length; i < sim.f.length; i++) F.push(makeView(i));
}
// vue du combattant i du donjon : héros, ennemi ou chien invoqué
function makeView(i) {
  const e = sim.f[i], np = sim.g.np;
  if (e.kind === 'cerbere') {
    const v = new DogView(i, 'cerbere', hellGlow);
    v.setSize(e.size);
    v.ring.material.color.set(0xff3020);      // pas de petite barre : grande barre de boss en haut
    return v;
  }
  if (e.kind === 'dog') {
    // chien du grimoire (violet), ou chien des enfers (pelage brûlé, yeux rouges) dans le camp ennemi
    const hell = e.team === 1;
    const v = new DogView(i, 'dog', hell ? hellGlow : runeColor);
    v.setSize(e.size);
    if (hell) { for (const m of v.mats) m.color.setRGB(0.85, 0.42, 0.36); v.ring.material.color.set(0xe0452f); }
    v.addHpBar(hell ? 0xe0452f : 0xb98aff);
    v.hpBar.position.y = 1.05;
    return v;
  }
  const v = new FighterView(i, e.kind, e.wpn);
  if (i < np) {
    v.hero = true;
    v.ring.material.color.set(np > 1 ? HERO_COL[i] : 0xffd34a);
  } else {
    v.setSize(e.size);
    v.ring.material.color.set(e.boss ? 0xff3020 : 0xb03a2a);
    if (!e.boss) v.addHpBar(0xe0452f);          // les boss ont leur grande barre en haut de l'écran
    // le colosse : un automate géant coulé dans le bronze
    if (e.foe === 'colosse') for (const m of v.mats) m.color.setRGB(1.3, 0.82, 0.42);
  }
  return v;
}
// chiens invoqués en cours de salle (ou retirés par un retour en arrière en ligne) : seules leurs vues changent
function extraViews() {
  while (F.length > sim.f.length) F.pop().dispose();
  for (let i = sim.g.np; i < F.length; i++) if (F[i].kind !== sim.f[i].kind) { F[i].dispose(); F[i] = makeView(i); }
  while (F.length < sim.f.length) F.push(makeView(F.length));
}

// un héros a changé de personnage ou d'arme (salle d'armes, ou rollback en ligne) : nouvelle vue
function heroViews() {
  for (let i = 0; i < sim.g.np && i < F.length; i++) {
    const e = sim.f[i], v = F[i];
    if (v.kind === e.kind && v.wpn === e.wpn) continue;
    v.dispose();
    const n = new FighterView(i, e.kind, e.wpn);
    n.hero = true;
    n.ring.material.color.copy(v.ring.material.color);
    F[i] = n;
  }
}

// héros et armes choisis dans la salle d'armes : proposés à nouveau la prochaine fois
function saveHeroes() {
  const loc = localHeroes();
  loc.forEach((h, k) => {
    const n = match?.mode === 'online' ? 1 : k + 1;
    cfg['p' + n] = sim.f[h].kind;
    cfg['w' + n] = sim.f[h].wpn;
  });
  saveCfg();
}

// la salle affichée rattrape celle de la simulation
function dungeonRoom() {
  if (dng.room === 0 && sim.g.room === 1) {
    saveHeroes();
    if (!net.live && net.ws) netClose();   // on ne se rejoint que dans la salle d'armes
  }
  buildDungeonRoom(sim.room, sim.g.room);
  // entrée dans un nouveau biome : son nom s'affiche au-dessus de « SALLE n »
  const n = sim.g.room;
  if (n > 1 && dng.room >= 0 && (sim.room.lair || biomeOf(n) !== biomeOf(n - 1))) {
    const b = $('biome');
    b.textContent = BIOME[sim.room.lair ? 'lair' : biomeOf(n)].name;
    b.className = '';
    void b.offsetWidth;
    b.className = 'show';
  }
  dng.room = sim.g.room;
  dungeonViews();
  snapCamera();
}

// À chaque image : porte, coffre, pièges et fenêtre de bénédiction suivent la simulation
function dungeonSync() {
  const g = sim.g;
  if (dng.room !== g.room) dungeonRoom();
  else { heroViews(); if (F.length !== sim.f.length) extraViews(); }
  if (g.exitOpen && !dng.gateOpen) { dng.gateOpen = true; dng.gate?.open(); }
  if (g.chest >= 1 && !dng.chest) { dng.chest = 1; dng.spawnChest?.(); }
  if (g.chest === 2 && dng.chest === 1) { dng.chest = 2; dng.openChest?.(); }
  dng.traps.forEach((t, k) => {
    const up = trapUp(g.clock, k);
    if (up !== t.up) {
      t.up = up;
      playOnce(t.mx, 'd_trap', up ? 'show' : 'hide');
      if (up) { sfx.clang(); emit(t.x, 0.2, t.z, 8, { color: [0xc0c0c8, 0x8a8090], speed: 1.4, up: 2.5, size: 0.06, life: 0.5, grav: 6 }); }
    }
    // avertissement : un peu de poussière juste avant la sortie des pics
    const ph = trapPhase(g.clock, k);
    if (!up && ph > TRAP.up0 - TRAP.warn && ph < TRAP.up0 && g.phase !== 'reward' && --t.warnT < 0) {
      t.warnT = 4;
      emit(t.x + rand(-0.5, 0.5), 0.05, t.z + rand(-0.5, 0.5), 1, { color: 0x8a8090, speed: 0.4, up: 1, size: 0.06, life: 0.4, grav: 3 });
    }
  });
  rewardSync();
  bossTele();
}

// ---------- Colosse : zones dangereuses au sol (déduites de l'état de la simulation) ----------
// saut : disque rouge sur la zone d'impact, qui se remplit jusqu'à la retombée ;
// charge : couloir fléché dans la direction de la charge, pendant qu'il gratte le sol
const tele = (() => {
  const mat = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, toneMapped: false });
  const disk = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), mat(0xff3a10, 0.22));
  const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), mat(0xffa040, 0.42));
  const edge = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 64).rotateX(-Math.PI / 2), mat(0xffb04a, 0.9));
  // chevrons dessinés une fois sur une texture qui défile
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(255,60,20,0.35)'; x.fillRect(0, 0, 64, 64);
  x.strokeStyle = 'rgba(255,200,90,0.95)'; x.lineWidth = 9; x.lineJoin = 'round';
  x.beginPath(); x.moveTo(10, 22); x.lineTo(32, 44); x.lineTo(54, 22); x.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const laneMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), laneMat);
  // cône du souffle de feu (centré sur +z avant rotation, rayon 1)
  const cone = new THREE.Mesh(new THREE.CircleGeometry(1, 32, -Math.PI / 2 - BOSS.fire.half, 2 * BOSS.fire.half).rotateX(-Math.PI / 2), mat(0xffb030, 0.4));
  const bite = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 24, 1, -Math.PI / 2 - 0.55, 1.1).rotateX(-Math.PI / 2), mat(0xff2a10, 0.45));
  for (const m of [disk, fill, edge, lane, cone, bite]) { m.renderOrder = 2; m.visible = false; scene.add(m); }
  return { disk, fill, edge, lane, tex, cone, bite };
})();
function bossTele() {
  const e = sim.f.find((o) => o.sp && o.state !== 'dead' && o.team === 1);
  const slam = e?.sp === 'slam' && e.spA < 2, charge = e?.sp === 'charge' && e.spA === 0;
  tele.disk.visible = tele.fill.visible = tele.edge.visible = slam;
  tele.lane.visible = charge;
  tele.cone.visible = e?.sp === 'fire';
  // morsure préparée de Cerbère (pas une attaque spéciale : on cherche le boss qui se ramasse)
  const b = sim.f.find((o) => o.brute && o.state === 'attack' && o.stateT < windupOf(o));
  tele.bite.visible = !!b;
  if (b) {
    const W = windupOf(b), r = WEAPONS[b.wpn].reach + 0.6;
    tele.bite.position.set(b.x, b.y + 0.05, b.z);
    tele.bite.rotation.y = b.yaw;
    tele.bite.scale.setScalar(r);
    tele.bite.material.opacity = 0.25 + 0.45 * (b.stateT / W) + 0.1 * Math.sin(clockT * 30);
  }
  if (tele.cone.visible) {
    // préparation : le cône clignote ; pendant le souffle : il vacille comme une flamme
    tele.cone.position.set(e.x, e.y + 0.05, e.z);
    tele.cone.rotation.y = e.yaw;
    tele.cone.scale.setScalar(BOSS.fire.R * (e.size / FOES.cerbere.size));
    tele.cone.material.opacity = e.spA === 0 ? 0.4 + 0.25 * Math.sin(clockT * 20) : 0.3 + 0.08 * Math.sin(clockT * 37);
  }
  if (slam) {
    const S = BOSS.slam, R = e.rage ? S.Rrage : S.R, wind = e.rage ? S.windRage : S.wind;
    const k = e.spA === 0 ? e.spT / (wind + 2 * S.vy / 24) : (wind + e.spT) / (wind + 2 * S.vy / 24);
    const y = sim.groundY({ x: e.spX, z: e.spZ }) + 0.04;
    for (const m of [tele.disk, tele.fill, tele.edge]) m.position.set(e.spX, y, e.spZ);
    tele.disk.scale.setScalar(R);
    tele.edge.scale.setScalar(R);
    tele.fill.scale.setScalar(Math.max(0.01, R * Math.min(1, k)));
    tele.edge.material.opacity = 0.6 + 0.4 * Math.sin(clockT * 20);
  }
  if (charge) {
    // jusqu'au mur, dans la direction (figée en fin de préparation)
    const R = ROOM_R - 0.45, tx = e.spX ? ((e.spX > 0 ? R : -R) - e.x) / e.spX : 1e9, tz = e.spZ ? ((e.spZ > 0 ? R : -R) - e.z) / e.spZ : 1e9;
    const len = Math.max(0.5, Math.min(tx, tz)), w = 2 * BOSS.charge.hitR * (e.size + 1);
    tele.lane.position.set(e.x, e.y + 0.05, e.z);
    tele.lane.rotation.y = Math.atan2(e.spX, e.spZ);
    tele.lane.scale.set(w, 1, len);
    tele.tex.repeat.set(1, len / w);
    tele.tex.offset.y = -clockT * 2.2;
    tele.lane.material.opacity = 0.55 + 0.35 * Math.sin(clockT * 18);
  }
}

// ---------- Barre de vie du boss (en haut de l'écran) ----------
const bossUi = { id: -1, room: -1, hp: 0, gone: false, rage: false };
function bossHud() {
  const g = sim.g, e = g.room > 0 && sim.room.boss ? sim.f.find((o) => o.boss && o.team === 1) : null;
  const bar = $('bossBar');
  if (!e || g.phase === 'menu') { if (bossUi.id >= 0) { bossUi.id = -1; bar.className = 'hidden'; } return; }
  if (bossUi.id !== e.idx || bossUi.room !== g.room) {
    // nouvelle salle de boss : la barre arrive
    Object.assign(bossUi, { id: e.idx, room: g.room, hp: e.hp, gone: false, rage: false });
    $('bbName').textContent = FOES[e.foe].name;
    $('bbSub').textContent = `${{ colosse: "Gardien d'airain", cerbere: 'Gardien des enfers' }[e.foe] ?? 'Seigneur de guerre'} · salle ${g.room}`;
    $('bbMark').classList.toggle('hidden', e.sp === undefined);
    bar.className = '';
    void bar.offsetWidth;
    bar.className = 'enter';
  }
  const k = Math.max(0, e.hp / e.maxHp) * 100;
  setW('bbFill', k);
  setW('bbTrail', k);
  setTxt('bbHp', `${Math.ceil(Math.max(0, e.hp))} / ${e.maxHp}`);
  if (e.hp < bossUi.hp) {
    // secousse à chaque coup
    bar.classList.remove('hit');
    void bar.offsetWidth;
    bar.classList.add('hit');
  }
  bossUi.hp = e.hp;
  const rage = !!e.rage;
  if (rage !== bossUi.rage) { bossUi.rage = rage; bar.classList.toggle('rage', rage); }
  const gone = e.state === 'dead';
  if (gone !== bossUi.gone) { bossUi.gone = gone; bar.classList.toggle('gone', gone); }
}

// salle vide derrière le menu
function dungeonPreview() {
  sim = new DungeonSim(1, [cfg.p1]);
  const col = (x, z) => ({ x, z, r: 0.4, kind: 'column' });
  sim.room = { exit: 'z', obs: [col(-3, -3), col(3, -3), col(-3, 3), col(3, 3)], surf: [], traps: [], boss: false };
  sim.f[0].yaw = sim.f[0].visTarget = ISO;
  buildDungeonRoom(sim.room, 1);
  dng.room = -2;   // aucune salle de la partie : la 1re (ou la salle d'armes) sera construite
  F.forEach((v) => v.dispose());
  F = [];
  dungeonViews();
}

// m : { mode: 'solo' | 'duo' | 'online', p1, p2, seed }
function startDungeon(m = { mode: cfg.mode === 'duo' ? 'duo' : 'solo', p1: cfg.p1, p2: cfg.p2, w1: cfg.w1, w2: cfg.w2 }) {
  match = { ...m, game: 'dungeon' };
  net.live = m.mode === 'online';
  rb = null;
  ac();
  game.paused = false;
  ['menu', 'result', 'pause', 'reward'].forEach((id) => $(id).classList.add('hidden'));
  const np = m.mode === 'solo' ? 1 : 2;
  $('hud').classList.remove('hidden');
  $('hud').classList.add('dng');
  $('hud').classList.toggle('solo', np === 1);
  $('help').classList.remove('hidden');
  $('help').innerHTML = controlsHTML(m.mode, true);
  $('againBtn').textContent = 'Recommencer';
  setupBindings(m.mode, net.live ? net.me : 0);
  const seed = (m.seed ?? Math.random() * 4294967296) >>> 0;
  // héros débloqués : en ligne, ceux de chaque joueur ; à deux sur un clavier, ceux du compte connecté
  const mine = unlockedHeroes();
  const unlocks = m.mode === 'online' ? [cleanUnlocked(m.u1), cleanUnlocked(m.u2)] : [mine, mine];
  sim = new DungeonSim(seed, np > 1 ? [m.p1, m.p2] : [m.p1], [m.w1, m.w2], unlocks.slice(0, np));
  F.forEach((v) => v.dispose());
  F = [];
  ai = ai0 = null;
  pending[0] = pending[1] = 0;
  pickReq.fill(-1);
  rewardUi = '';
  for (const k in uiTxt) delete uiTxt[k];   // l'arène a pu réécrire ces textes
  sim.startHub();   // on commence dans la salle d'armes
  playEvents(sim.ev);
  sim.ev.length = 0;
  rb = net.live ? new Rollback(sim, {
    me: net.me,
    send: (msg, reliable) => (net.link ? net.link.send(msg, reliable) : netSend(msg)),
    onDesync: (d) => console.warn('Désynchronisation détectée à l\'image', d.frame),
  }) : null;
  dungeonRoom();
  acc = 0;
}

function endDungeon() {
  const g = sim.g, rec = dungeonRecord(), best = g.room > rec;
  const me = sim.f[localHeroes()[0] ?? 0];     // à deux sur un clavier : le compte suit le joueur 1
  accountRun(g.room, me.kills, me.kind, me.wpn);
  const guest = net.live && net.role === 'guest';
  if (best) try { localStorage.setItem(DNG_REC, String(g.room)); } catch (e) { /* ignoré */ }
  $('resTitle').textContent = g.np > 1 ? 'VAINCUS…' : 'VAINCU…';
  $('resSub').textContent = `Tombé${g.np > 1 ? 's' : ''} dans la salle ${g.room} · ${g.kills} ennemi${g.kills > 1 ? 's' : ''} vaincu${g.kills > 1 ? 's' : ''}` +
    (best ? ' · nouveau record !' : ` · record : salle ${rec}`) + (guest ? '  ·  l’hôte peut relancer' : '');
  $('againBtn').classList.toggle('hidden', guest);
  $('result').classList.remove('hidden');
  $('help').classList.add('hidden');
}

// ---------- Bénédictions : chaque héros choisit la sienne ----------
// touches : seul ou en ligne 1 2 3 ; à deux sur le même clavier J1 1 2 3, J2 8 9 0 (ou pavé 1 2 3)
function rewardKey(code) {
  const d = /^Digit(\d)$/.exec(code), np = /^Numpad([1-3])$/.exec(code);
  const loc = localHeroes();
  if (loc.length > 1) {
    if (d && '123'.includes(d[1])) return [0, +d[1] - 1];
    if (d && '890'.includes(d[1])) return [1, '890'.indexOf(d[1])];
    if (np) return [1, +np[1] - 1];
    return null;
  }
  if (d && '123'.includes(d[1])) return [loc[0], +d[1] - 1];
  if (np) return [loc[0], +np[1] - 1];
  return null;
}
function pickBoon(h, n) {
  if (!(sim instanceof DungeonSim) || h === undefined || !sim.mustPick(h) || !localHeroes().includes(h)) return;
  pickReq[h] = n;   // transmis à la simulation par localInput (et donc au partenaire en ligne)
  rewardUi = '';
}
function clickBoon(n) { pickBoon(localHeroes().find((h) => sim.mustPick(h) && pickReq[h] < 0), n); }

let rewardUi = '';
function rewardSync() {
  const g = sim.g, loc = localHeroes();
  if (g.phase !== 'reward') {
    rewardUi = '';
    $('reward').classList.add('hidden');
    pickReq.fill(-1);
    return;
  }
  for (const h of [0, 1]) if (!sim.mustPick(h)) pickReq[h] = -1;
  const offer = sim.offer;
  const key = [g.room, ...offer, g.pick0, g.pick1, ...pickReq].join('|');
  if (key === rewardUi) return;
  if (!rewardUi) down.clear();
  rewardUi = key;
  const duo = loc.length > 1;
  const btns = $('reward').querySelectorAll('button');
  offer.forEach((id, i) => {
    const keys = duo ? `${i + 1}</kbd> <kbd>${'890'[i]}` : `${i + 1}`;
    btns[i].innerHTML = `<b><kbd>${keys}</kbd> ${esc(BOONS[id].name)}</b><span>${esc(BOONS[id].desc)}</span>`;
    btns[i].disabled = !loc.some((h) => sim.mustPick(h) && pickReq[h] < 0);
  });
  const st = [];
  for (let h = 0; h < g.np; h++) {
    const p = sim.f[h], pk = g['pick' + h], who = g.np > 1 ? `J${h + 1}` : 'Toi';
    let s;
    if (p.state === 'dead') s = 'à terre';
    else if (pk >= 0) s = '✔ ' + BOONS[offer[pk]].name;
    else if (pickReq[h] >= 0) s = '…';
    else s = loc.includes(h) ? 'choisis !' : 'choisit…';
    st.push(`${who} (${Math.ceil(p.hp)} / ${p.maxHp} PV) : ${s}`);
  }
  $('rewardTxt').textContent = st.join('   ·   ');
  $('reward').classList.remove('hidden');
}

const uiTxt = {};
function setTxt(id, v) { if (uiTxt[id] !== v) { uiTxt[id] = v; $(id).textContent = v; } }
// largeur (en %) et classe d'un élément du HUD, écrites seulement quand elles changent (à chaque image sinon,
// le navigateur recalcule les styles de la page pour rien)
const uiW = {}, uiC = {};
function setW(id, pct) { const v = Math.round(pct * 10) / 10; if (uiW[id] !== v) { uiW[id] = v; $(id).style.width = v + '%'; } }
function setCls(id, cls, on) { const k = id + '.' + cls; if (uiC[k] !== on) { uiC[k] = on; $(id).classList.toggle(cls, on); } }
function dungeonHud() {
  const g = sim.g;
  bossHud();
  sim.heroes.forEach((p, i) => {
    const n = i + 1, hp = Math.max(0, p.hp / p.maxHp * 100);
    setW('h' + n, hp);
    setCls('h' + n, 'low', hp < 30);
    setW('t' + n, hp);
    setW('g' + n, Math.max(0, p.guard));
    setCls('g' + n, 'low', p.guard < 30);
    setW('s' + n, Math.max(0, p.sta));
    setCls('s' + n, 'low', p.sta < STA.tired);
    setCls('s' + n, 'fail', p.staFail > 0);
    const nm = net.live ? (i === net.me ? myName() : net.peerName) : g.np === 1 ? myName() : '';
    const who = nm ? `${nm} · ` : g.np > 1 ? `J${n} · ` : '';
    const what = g.room === 0 ? `${HEROES[p.kind].name} · ${WEAPONS[p.wpn].name}` : HEROES[p.kind].name;
    setTxt('n' + n, who + what + ' · ' + (p.state === 'dead' ? 'À TERRE' : `${Math.ceil(p.hp)} / ${p.maxHp} PV`));
  });
  setTxt('timer', g.room ? `SALLE ${g.room}` : "SALLE D'ARMES");
  if (g.room === 0) { setTxt('roundLbl', 'CHOISIS TON HÉROS, PRENDS TON ARME CHEZ LE MARCHAND, PUIS PASSE LA PORTE'); return; }
  const left = sim.foesLeft;
  let lbl = left ? `${left} ENNEMI${left > 1 ? 'S' : ''}` : '';
  if (g.phase === 'clear' || g.phase === 'reward') lbl = g.chest === 1 ? 'OUVRE LE COFFRE' : 'LA PORTE EST OUVERTE';
  setTxt('roundLbl', lbl);
}

function dungeonCam(dt) {
  if (game.phase === 'menu') {
    camAng += dt * 0.1;
    camPos.set(Math.sin(camAng) * 12, 10, Math.cos(camAng) * 12);
    camTgt.set(0, 0.6, 0);
    return;
  }
  // chez le marchand : la caméra passe derrière le héros, face au comptoir
  const sh = localShopper();
  if (sh >= 0) {
    const p = sim.f[sh];
    camAng = 0;      // les flèches suivent l'écran : ← → le long du comptoir, ↓ pour s'en aller
    camPos.set(p.x + 1.05, 2.4, p.z + 2.45);
    camTgt.set(MERCHANT.x + 0.15, 0.8, MERCHANT.counterZ - 0.3);
    return;
  }
  camAng = ISO;   // fixe : les déplacements suivent l'écran
  const alive = sim.heroes.filter((h) => h.state !== 'dead');
  const hs = alive.length ? alive : sim.heroes;
  const mx = hs.reduce((a, h) => a + h.x, 0) / hs.length, mz = hs.reduce((a, h) => a + h.z, 0) / hs.length;
  const my = hs.reduce((a, h) => a + h.y, 0) / hs.length;
  const sep = hs.length > 1 ? Math.hypot(hs[0].x - hs[1].x, hs[0].z - hs[1].z) : 0;
  const close = game.phase === 'dead' || game.phase === 'end';
  const tx = clamp(mx, -2.5, 2.5), tz = clamp(mz, -2.5, 2.5);
  const far = Math.max(0, sep - 3);
  const dist = (close ? 6.5 : 9.5) + far * 0.45, h = (close ? 7 : 10.5) + far * 0.5;
  camTgt.set(tx, 0.8 + my * 0.5, tz);
  camPos.set(tx + Math.sin(ISO) * dist, h + my * 0.5, tz + Math.cos(ISO) * dist);
}

// =====================================================================
//  Menu
// =====================================================================
function saveCfg() { try { localStorage.setItem('spartiate-cfg', JSON.stringify(cfg)); } catch (e) { /* ignoré */ } }
function refreshMenu() {
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.val === String(cfg[seg.dataset.key])));
  });
  // personnages verrouillés (joueurs humains seulement : l'IA prend qui elle veut)
  const un = unlockedHeroes();
  document.querySelectorAll('[data-key="p1"] button, [data-key="p2"] button').forEach((b) => {
    const human = b.parentElement.dataset.key === 'p1' || cfg.mode === 'duo';
    const lock = human && !un.includes(b.dataset.val);
    b.disabled = lock;
    b.title = lock ? `Verrouillé : réussis un défi du ${HEROES[HERO_IDS[HERO_IDS.indexOf(b.dataset.val) - 1]]?.name ?? ''}` : '';
  });
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('on', c.dataset.val === cfg.arena));
  const online = cfg.mode === 'online', dg = cfg.game === 'dungeon';
  $('diffSec').classList.toggle('hidden', dg || cfg.mode !== 'solo');
  $('netSec').classList.toggle('hidden', !online);
  $('p2Sec').classList.toggle('hidden', online || dg);
  $('p1Sec').classList.toggle('hidden', dg);   // en donjon, on choisit dans la salle d'armes
  const modeTxt = dg ? { solo: 'Seul', duo: '2 joueurs (même clavier)', online: 'En ligne (coop)' }
    : { solo: '1 joueur contre l\'IA', duo: '2 joueurs', online: 'En ligne (réseau local)' };
  document.querySelectorAll('[data-key="mode"] button').forEach((b) => { b.textContent = modeTxt[b.dataset.val]; });
  $('arenaSec').classList.toggle('hidden', dg || (online && net.role === 'guest'));
  $('p1Lbl').textContent = dg && cfg.mode === 'solo' ? 'Ton héros' : online ? 'Ton personnage' : 'Joueur 1';
  $('menuSub').textContent = dg ? 'Les profondeurs du donjon' : 'Les arènes des petits gladiateurs';
  refreshGo();
  $('p2Lbl').textContent = dg ? 'Joueur 2 (héros)' : cfg.mode === 'solo' ? 'Adversaire (IA)' : 'Joueur 2';
  if (dg) {
    const rec = dungeonRecord();
    $('keysMenu').innerHTML = controlsHTML(cfg.mode, false) +
      `<div class="row" style="margin-top:8px"><b>Donjon :</b> tout commence dans la <b>salle d'armes</b> : marche sur la dalle devant une statue pour prendre ce héros (chacun a un petit talent), va voir le <b>vieux marchand</b> pour choisir ton arme (glaive, lance, pavois, hache, marteau, sceptre de feu, grimoire ou arc), puis passe la porte. Traverse ensuite les salles une à une. Élimine tous les ennemis pour ouvrir la porte du fond, ouvre le <b>coffre</b> pour choisir une bénédiction (soin, force, vitalité…), puis franchis la porte. Plus bas, des <b>estrades</b> (monte par l'escalier ou en sautant : d'en haut, on frappe sans être touché au sol) et des <b>pièges à pics</b> (la poussière annonce leur sortie). Un <b>boss</b> garde chaque 5<sup>e</sup> salle : le <b>chef orc</b>, puis le <b>colosse d'airain</b> (son sol rougit avant qu'il retombe : saute ou roule ; s'il charge contre un mur, il reste sonné). Tu te tournes tout seul vers l'ennemi le plus proche · <b>À deux</b> : un héros tombé se relève à la salle suivante, la partie s'arrête quand les deux tombent · Échap = pause` +
      (rec ? `<br><b>Record :</b> salle ${rec}` : '') + '</div>';
    return;
  }
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
        if (key === 'p1') netSend({ t: 'hello', ...myHero() });
        refreshMenu();
        if (key === 'game') menuScene();
        else if (cfg.game === 'dungeon') { if (key === 'p1') dungeonPreview(); }
        else if (key === 'p1' || key === 'p2' || key === 'mode') menuFighters();
      };
    });
  });
  $('go').onclick = () => (cfg.mode === 'online' ? netStart() : cfg.game === 'dungeon' ? startDungeon() : startMatch());
  $('againBtn').onclick = () => (match?.mode === 'online' ? netStart() : match?.game === 'dungeon' ? startDungeon() : startMatch());
  $('reward').querySelectorAll('button').forEach((b, i) => { b.onclick = () => clickBoon(i); });
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
  Object.assign(net, { ws: null, link: null, role: null, me: 0, peer: false, peerKind: null, peerWpn: null, peerName: '', peerUnlocked: [], hall: false, halls: [] });
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
  ws.onopen = () => { opened = true; lobby.down = false; ws.send(JSON.stringify(first)); };
  ws.onmessage = (e) => {
    if (net.ws !== ws) return;
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m && typeof m === 'object') netMsg(m);
  };
  ws.onclose = () => {
    lobby.down = !opened;
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
  const dg = cfg.game === 'dungeon';
  let txt = dg ? 'ENTRER' : 'COMBATTRE', ok = true;
  if (cfg.mode === 'online') {
    if (net.role === 'host') { ok = net.peer; if (!ok) txt = dg ? 'En attente d’un équipier…' : 'En attente d’un adversaire…'; }
    else { ok = false; txt = net.role === 'guest' ? 'L’hôte va lancer la partie…' : 'Crée ou rejoins une partie'; }
  }
  $('go').textContent = txt;
  $('go').disabled = !ok;
}
function netStart() {
  if (net.role !== 'host' || !net.peer) return;
  const m = { mode: 'online', game: cfg.game, p1: cfg.p1, p2: net.peerKind || 'soldier', w1: cfg.w1 || '', w2: net.peerWpn || '', u1: unlockedHeroes(), u2: net.peerUnlocked, arena: cfg.arena, seed: (Math.random() * 4294967296) >>> 0 };
  netSend({ t: 'start', ...m });
  if (m.game === 'dungeon') startDungeon(m); else startMatch(m);
}
function netMsg(m) {
  if (m.t === 'ri' || m.t === 'rs') { if (rb) rb.receive(m); return; }
  if (m.t === 'rtc') { net.link?.signal(m); return; }
  switch (m.t) {
    case 'created':
      Object.assign(net, { role: 'host', me: 0, code: String(m.code ?? ''), hall: !!m.hall, urls: Array.isArray(m.urls) ? m.urls.map(String) : [] });
      netInfo(hostInfo() + '<br>En attente d’un adversaire…');
      break;
    case 'rooms':
      net.halls = (Array.isArray(m.rooms) ? m.rooms : []).filter((r) => r && /^[A-Z]{4}$/.test(r.code) && HEROES[r.kind])
        .map((r) => ({ code: r.code, kind: r.kind, wpn: WEAPON_IDS.includes(r.wpn) ? r.wpn : '', name: cleanName(r.name) }));
      break;
    case 'joined':
      Object.assign(net, { role: 'guest', me: 1, code: String(m.code ?? ''), peer: true, hall: false });
      lobby.msg = `Connecté au salon ${net.code} : la partie va commencer…`;
      netSend({ t: 'hello', ...myHero() });
      netLink();
      netInfo(`Connecté à la partie <b>${esc(m.code)}</b> ! L’hôte choisit l’arène et lance le combat.`);
      break;
    case 'peer':
      net.peer = true;
      netSend({ t: 'hello', ...myHero() });
      netLink();
      netInfo(`Un adversaire a rejoint la partie <b>${esc(net.code)}</b> ! Choisis l’arène puis clique sur COMBATTRE.`);
      break;
    case 'hello':
      net.peerKind = CHARS[m.kind] ? m.kind : 'soldier';
      net.peerWpn = WEAPON_IDS.includes(m.wpn) ? m.wpn : null;
      net.peerName = cleanName(m.name);
      net.peerUnlocked = cleanUnlocked(m.unlocked);
      if (game.phase === 'menu') menuFighters();
      if (net.role === 'host' && net.hall && inHall()) hallStart();   // un équipier entre dans notre salon
      break;
    case 'start':
      if (net.role !== 'guest' || !CHARS[m.p1] || !CHARS[m.p2]) break;
      if (m.game === 'dungeon') startDungeon({ mode: 'online', p1: m.p1, p2: m.p2, w1: m.w1, w2: m.w2, u1: cleanUnlocked(m.u1), u2: cleanUnlocked(m.u2), seed: Number.isFinite(+m.seed) ? +m.seed : 1 });
      else if (ARENAS[m.arena]) startMatch({ mode: 'online', p1: m.p1, p2: m.p2, arena: m.arena, seed: Number.isFinite(+m.seed) ? +m.seed : 1 });
      break;
    case 'menu':
      if (!net.live) break;
      toMenu(true);
      netInfo('L’adversaire est revenu au menu.' + (net.role === 'host' ? ' Clique sur COMBATTRE pour relancer.' : ''));
      break;
    case 'bye': {
      // donjon : on repart seul dans la salle d'armes, avec son héros et son arme (l'hôte garde son salon)
      const dg = net.live && match?.game === 'dungeon', mine = dg && sim.f[net.me];
      if (net.live && !dg) toMenu(true);
      net.link?.close(); net.link = null;
      if (net.role === 'host') {
        Object.assign(net, { peer: false, peerKind: null, peerWpn: null, peerName: '', peerUnlocked: [] });
        if (game.phase === 'menu') menuFighters();
        netInfo('L’adversaire a quitté la partie.<br>' + hostInfo());
      } else {
        netClose();
        if (game.phase === 'menu') menuFighters();
        netInfo('L’hôte a fermé la partie.');
      }
      if (dg) {
        startDungeon({ mode: 'solo', p1: mine.kind, w1: mine.wpn, p2: cfg.p2, w2: cfg.w2 });
        lobby.msg = net.role === 'host' ? 'Ton équipier est parti. Ton salon reste ouvert.' : 'Ton équipier a quitté la partie.';
      }
      break;
    }
    case 'error':
      netClose();
      netInfo(esc(m.msg));
      lobby.msg = String(m.msg ?? '');
      break;
  }
  refreshMenu();
}

// =====================================================================
//  Démarrage
// =====================================================================
// =====================================================================
//  Compte du joueur (facultatif) : serveur.py relaie /api/* vers l'API des comptes (api/, en Rust),
//  seule à parler à la base. Le jeton de session reste dans ce navigateur ; le profil (pseudo, record,
//  statistiques) et le classement viennent du serveur. Sans l'API, le bloc « Compte » est masqué.
// =====================================================================
const ACCOUNT_KEY = 'spartiate-jeton';
// ready : profil chargé (ou absent pour de bon) : on peut appliquer les verrous du menu
const compte = { dispo: false, ready: false, jeton: '', profil: null, top: null, defis: null, msg: '' };
try { compte.jeton = localStorage.getItem(ACCOUNT_KEY) || ''; } catch (e) { /* ignoré */ }
const myName = () => compte.profil?.pseudo ?? '';
// héros débloqués : ceux du compte ; sans compte, le premier seulement
const cleanUnlocked = (u) => [FIRST_HERO, ...(Array.isArray(u) ? u.filter((k) => HEROES[k] && k !== FIRST_HERO) : [])];
const unlockedHeroes = () => cleanUnlocked(compte.profil?.debloques);
// remet le premier héros à la place d'un héros verrouillé choisi dans le menu ; vrai si changé
function clampHeroes() {
  const un = unlockedHeroes();
  let changed = false;
  for (const k of ['p1', 'p2']) {
    if ((k === 'p1' || cfg.mode === 'duo') && !un.includes(cfg[k])) { cfg[k] = FIRST_HERO; changed = true; }
  }
  if (changed) saveCfg();
  return changed;
}
// pseudo reçu d'un autre joueur : seulement ce qu'un pseudo peut contenir
const cleanName = (n) => (typeof n === 'string' && /^[0-9A-Za-zÀ-ÖØ-öø-ÿ_-]{3,16}$/.test(n) ? n : '');
async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (compte.jeton) headers.Authorization = 'Bearer ' + compte.jeton;
  try {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { erreur: 'Serveur injoignable.' } };
  }
}
function setJeton(j) {
  compte.jeton = j;
  try { if (j) localStorage.setItem(ACCOUNT_KEY, j); else localStorage.removeItem(ACCOUNT_KEY); } catch (e) { /* ignoré */ }
}
function sessionLost() { setJeton(''); compte.profil = null; compte.msg = 'Session expirée : reconnecte-toi.'; }
async function setupAccount() {
  $('acLogin').onclick = () => accountLogin(false);
  $('acNew').onclick = () => accountLogin(true);
  $('acMdp').onkeydown = (e) => { if (e.key === 'Enter') accountLogin(false); };
  $('acOut').onclick = accountLogout;
  $('acTop').onclick = accountTop;
  $('acDefis').onclick = accountChallenges;
  compte.dispo = !!(await api('/api/etat')).data.comptes;
  if (compte.dispo && compte.jeton) {
    const r = await api('/api/profil');
    if (r.ok) compte.profil = r.data.profil;
    else if (r.status === 401) sessionLost();
  }
  compte.ready = true;
  accountRender();
}
async function accountLogin(create) {
  const pseudo = $('acPseudo').value.trim(), mdp = $('acMdp').value;
  if (!pseudo || !mdp) { compte.msg = 'Entre ton pseudo et ton mot de passe.'; accountRender(); return; }
  compte.msg = create ? 'Création du compte…' : 'Connexion…';
  accountRender();
  const r = await api(create ? '/api/inscription' : '/api/connexion', { pseudo, mdp });
  if (r.ok) { setJeton(r.data.jeton); compte.profil = r.data.profil; compte.msg = ''; $('acMdp').value = ''; }
  else compte.msg = r.data.erreur || 'Erreur.';
  accountRender();
}
async function accountLogout() {
  await api('/api/deconnexion', {});
  setJeton('');
  compte.profil = compte.top = compte.defis = null;
  compte.msg = '';
  accountRender();
}
async function accountTop() {
  compte.defis = null;
  if (compte.top) { compte.top = null; accountRender(); return; }
  const r = await api('/api/classement');
  compte.top = r.ok ? r.data.classement : null;
  compte.msg = r.ok ? '' : r.data.erreur || 'Erreur.';
  accountRender();
}
// Défis des héros (définis et comptés par le serveur : api/src/defis.rs), regroupés par héros
async function accountChallenges() {
  compte.top = null;
  if (compte.defis) { compte.defis = null; accountRender(); return; }
  const r = await api('/api/defis');
  compte.defis = r.ok ? r.data.defis : null;
  compte.msg = r.ok ? '' : r.data.erreur || 'Erreur.';
  accountRender();
}
function challengesHTML(list) {
  const by = new Map();
  for (const d of list) { if (!by.has(d.heros)) by.set(d.heros, []); by.get(d.heros).push(d); }
  const un = unlockedHeroes();
  return [...by].map(([h, ds]) => `<div class="dh${un.includes(h) ? '' : ' locked'}"><b>${un.includes(h) ? '' : '🔒 '}${esc(HEROES[h]?.name ?? h)}</b> `
    + `<span>${un.includes(h) ? `${ds.filter((d) => d.reussi).length} / ${ds.length}` : `débloqué par un défi du ${esc(HEROES[HERO_IDS[HERO_IDS.indexOf(h) - 1]]?.name ?? '')}`}</span></div>`
    + ds.map((d) => `<div class="df${d.reussi ? ' ok' : ''}"><span class="dn">${d.reussi ? '✔ ' : ''}${esc(d.nom)}</span>`
      + `<span class="dd">${esc(d.desc)}</span><span class="dp"><i style="width:${Math.round(100 * d.progres / d.objectif)}%"></i></span>`
      + `<span class="dv">${d.progres} / ${d.objectif}</span></div>`).join('')).join('');
}
// fin d'un donjon (mort) : le serveur met à jour le record, les statistiques et les défis du héros
async function accountRun(room, kills, kind, wpn) {
  if (!compte.profil || room < 1) return;
  const r = await api('/api/partie', { salle: room, ennemis: kills, heros: kind, arme: wpn, en_ligne: net.live });
  if (r.ok) {
    const before = unlockedHeroes();
    compte.profil = r.data.profil;
    compte.defis = null;
    const nv = Array.isArray(r.data.nouveaux) ? r.data.nouveaux : [];
    const heroes = unlockedHeroes().filter((k) => !before.includes(k));
    $('resDefis').innerHTML = nv.map((d) => `<div>🏆 Défi accompli : <b>${esc(d.nom)}</b> (${esc(HEROES[d.heros]?.name ?? d.heros)}) · ${esc(d.desc)}</div>`).join('')
      + heroes.map((k) => `<div class="unlock">🔓 Nouveau héros débloqué : <b>${esc(HEROES[k].name)}</b></div>`).join('');
    if (nv.length) sfx.cheer?.(1);
  } else if (r.status === 401) sessionLost();
  accountRender();
}
function accountRender() {
  const p = compte.profil;
  $('acctSec').classList.toggle('hidden', !compte.dispo);
  $('acctOut').classList.toggle('hidden', !!p);
  $('acctIn').classList.toggle('hidden', !p);
  if (p) {
    $('acProfil').innerHTML = `<b>${esc(p.pseudo)}</b> · record : salle <b>${p.record}</b> · ${p.parties} partie${p.parties > 1 ? 's' : ''} · `
      + `${p.ennemis} ennemi${p.ennemis > 1 ? 's' : ''} · ${p.boss} boss`;
  }
  $('acTop').textContent = compte.top ? 'Fermer le classement' : 'Classement';
  $('acDefis').textContent = compte.defis ? 'Fermer les défis' : 'Défis';
  $('acDefisList').classList.toggle('hidden', !compte.defis);
  if (compte.defis) $('acDefisList').innerHTML = challengesHTML(compte.defis);
  $('acTopList').classList.toggle('hidden', !compte.top);
  if (compte.top) {
    $('acTopList').innerHTML = compte.top.length
      ? '<ol>' + compte.top.map((x) => `<li${x.pseudo === myName() ? ' class="me"' : ''}><b>${esc(x.pseudo)}</b> · salle ${x.record} · ${x.ennemis} ennemis</li>`).join('') + '</ol>'
      : '<i>Personne au classement pour l’instant.</i>';
  }
  $('acMsg').textContent = compte.msg;
  lobby.key = '';     // le pseudo apparaît dans le panneau des salons
  if (compte.ready && clampHeroes() && game.phase === 'menu') menuScene();
  refreshMenu();      // héros verrouillés du menu
}

// =====================================================================
//  Salons de la salle d'armes : seul dans la salle d'armes, on ouvre son salon (listé sur le serveur)
//  ou on rejoint celui d'un autre, dans la liste ou par son code. Dès qu'un équipier entre, les deux
//  navigateurs relancent la salle d'armes en ligne, à deux (même graine), chacun avec son héros et son
//  arme. Quand l'équipier part, chacun repart seul dans sa salle d'armes (l'hôte garde son salon).
// =====================================================================
// wait : heure limite de la réponse à « ouvrir mon salon » (un serveur d'avant les salons ne répond rien)
const lobby = { next: 0, key: '', msg: '', down: false, wait: 0 };
const inHall = () => sim instanceof DungeonSim && game.phase === 'hub' && !net.live && match?.mode === 'solo';
// héros et arme de ce joueur : ceux de la salle d'armes en cours, sinon ceux du menu
function myHero() {
  const p = game.phase !== 'menu' && sim instanceof DungeonSim ? sim.f[localHeroes()[0] ?? 0] : null;
  return { ...(p ? { kind: p.kind, wpn: p.wpn } : { kind: cfg.p1, wpn: cfg.w1 || '' }), name: myName(), unlocked: unlockedHeroes() };
}
function lobbyWs(m) { if (net.ws?.readyState === 1) netSend(m); else netConnect(m); }
function hallStart() {
  const me = myHero();
  const m = { mode: 'online', game: 'dungeon', p1: me.kind, w1: me.wpn, p2: net.peerKind || 'soldier', w2: net.peerWpn || '',
    u1: unlockedHeroes(), u2: net.peerUnlocked, seed: (Math.random() * 4294967296) >>> 0 };
  netSend({ t: 'start', ...m });
  startDungeon(m);
}
function setupLobby() {
  $('lbMine').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.blur();                         // sinon Espace (saut) le recliquerait
    lobby.msg = '';
    if (b.dataset.act === 'open') { lobbyWs({ t: 'open', ...myHero(), token: compte.jeton }); lobby.wait = performance.now() + 4000; lobby.msg = 'Ouverture du salon…'; }
    else if (b.dataset.act === 'close') { netSend({ t: 'close' }); Object.assign(net, { role: null, code: '', hall: false, peer: false }); }
    lobbyRender();
  };
  $('lbList').onclick = (e) => {
    const b = e.target.closest('button[data-code]');
    if (b) { b.blur(); lobby.msg = 'Connexion…'; lobbyWs({ t: 'join', code: b.dataset.code }); lobbyRender(); }
  };
  const joinCode = () => {
    const code = $('lbCode').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { lobby.msg = 'Un code fait 4 lettres.'; lobbyRender(); return; }
    $('lbCode').value = '';
    $('lbCode').blur();
    lobby.msg = 'Connexion…';
    lobbyWs({ t: 'join', code });
    lobbyRender();
  };
  $('lbJoin').onclick = joinCode;
  $('lbCode').onkeydown = (e) => { if (e.key === 'Enter') joinCode(); };
}
// à chaque image : panneau visible dans la salle d'armes (seul) ; liste des salons redemandée toutes
// les 2 s (temps réel : le temps de jeu peut ralentir)
function lobbySync() {
  const on = inHall();
  setCls('lobby', 'hidden', !on);
  if (!on) { lobby.next = 0; return; }
  const now = performance.now();
  if (lobby.wait && net.hall) { lobby.wait = 0; lobby.msg = ''; }
  else if (lobby.wait && now > lobby.wait) {
    lobby.wait = 0;
    lobby.msg = lobby.down ? '' : 'Le serveur ne répond pas : il date sans doute d’avant les salons. Ferme et relance jouer.bat.';
  }
  if (now >= lobby.next) {
    lobby.next = now + (lobby.down ? 10000 : 2000);    // serveur injoignable : on réessaie moins souvent
    if (!net.ws) netConnect({ t: 'list' });
    else if (net.ws.readyState === 1 && !net.peer) netSend({ t: 'list' });
  }
  lobbyRender();
}
function lobbyRender() {
  const key = JSON.stringify([net.role, net.code, net.hall, net.halls, lobby.msg, lobby.down, myName()]);
  if (key === lobby.key) return;
  lobby.key = key;
  const who = (r) => `${r.name ? `<b>${esc(r.name)}</b> · ` : ''}${esc(HEROES[r.kind].name)}${r.wpn ? ' · ' + esc(WEAPONS[r.wpn].name) : ''}`;
  $('lbMine').innerHTML = net.role === 'host' && net.hall
    ? `Ton salon <span class="code">${esc(net.code)}</span> est ouvert : un ami peut le rejoindre depuis sa salle d'armes.<button data-act="close">Fermer</button>`
    : net.role === 'guest' ? '' : '<button class="main" data-act="open">Ouvrir mon salon</button>';
  $('lbList').innerHTML = lobby.down ? '<i>Serveur de jeu injoignable : lance le jeu avec jouer.bat (Windows) ou jouer.sh (Linux).</i>'
    : net.halls.length ? net.halls.map((r) => `<button data-code="${esc(r.code)}"><span>${who(r)}</span><b>${esc(r.code)}</b></button>`).join('')
      : '<i>Aucun autre salon ouvert pour l’instant.</i>';
  setTxt('lbMsg', lobby.msg);
}

async function boot() {
  try { layout = await navigator.keyboard?.getLayoutMap?.(); } catch (e) { layout = null; }
  const loader = new GLTFLoader();
  const keys = Object.keys(FILES);
  let done = 0;
  try {
    await Promise.all(keys.map((k) => loader.loadAsync(encodeURI(FILES[k])).then((g) => {
      G[k] = g;
      // pièces lumineuses des décors (cristaux, lave, lanternes) : couleur de la palette, sans ombrage
      g.scene.traverse((o) => { if (o.isMesh && o.name.startsWith('glow')) o.material = new THREE.MeshBasicMaterial({ map: o.material.map, toneMapped: false }); });
      // modèles chargés : partagés par toutes les copies, jamais libérés
      g.scene.traverse((o) => { if (o.geometry) keep(o.geometry); if (o.material) for (const m of [].concat(o.material)) { keep(m); const t = new Set(); texturesOf(m, t); keep([...t]); } });
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
  setupLobby();
  setupAccount();
  setupDebug();
  buildArena(cfg.arena);
  game.loading = false;
  $('loading').classList.add('hidden');
  toMenu();
  if (new URLSearchParams(location.search).has('dungeon')) startDungeon();
  // ?debug : accès à la simulation depuis la console (tests dans le navigateur)
  if (new URLSearchParams(location.search).has('debug')) window.spartiate = { get sim() { return sim; }, get views() { return F; }, renderer, scene, camera, debugGoto: dbgGoto };
  else if (new URLSearchParams(location.search).has('fight') || DEMO) startMatch();
  const warm = +new URLSearchParams(location.search).get('sim');
  for (let i = 0; i < warm * 60; i++) step(DT);
}
requestAnimationFrame(frame);
boot();

// =====================================================================
//  Outil de débogage du donjon (F2) : aller à une salle, tuer, soigner, invincibilité, faire apparaître
//  des ennemis, déclencher les attaques du boss, téléporter le héros d'un clic. Hors ligne seulement :
//  il modifie la simulation directement (en ligne, l'autre joueur ne le verrait pas).
// =====================================================================
const dbg = { open: false, god: false, tp: false };
const DBG_ROOMS = [[0, "Salle d'armes"], [1, 'Salle 1'], [5, 'Boss : chef orc'], [10, 'Boss : colosse'], [15, 'Antre de Cerbère'], [6, 'Mines (6)'], [11, 'Ruines (11)'], [16, 'Forge (16)'], [-1, 'Salle suivante']];
function setupDebug() {
  $('dbgRooms').innerHTML = DBG_ROOMS.map(([n, t]) => `<button data-room="${n}">${esc(t)}</button>`).join('');
  $('dbgFoes').innerHTML = Object.keys(FOES).filter((id) => id !== 'dog').map((id) => `<button data-foe="${id}">${esc(FOES[id].name)}</button>`).join('');
  $('dbg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    b.blur();      // sinon Espace (saut) rappuierait sur le bouton
    if (b.dataset.room !== undefined) { const n = +b.dataset.room; dbgGoto(n < 0 ? sim.g.room + 1 : n); }
    else if (b.dataset.foe) { if (!dbgSim()?.debugSpawn(b.dataset.foe)) dbgMsg('Apparition possible seulement pendant un combat.'); }
    else if (b.dataset.boss) { if (!dbgSim()?.debugBoss(b.dataset.boss)) dbgMsg('Pas de boss prêt pour cette attaque dans cette salle.'); }
    else if (b.id === 'dbgGo') dbgGoto(+$('dbgRoom').value || 0);
    else if (b.id === 'dbgKill') dbgSim()?.debugKill();
    else if (b.id === 'dbgHeal') dbgSim()?.debugHeal();
    else if (b.id === 'dbgGod') { dbg.god = !dbg.god; dbgSim()?.debugGod(dbg.god); }
    else if (b.id === 'dbgTp') dbg.tp = !dbg.tp;
    dbgRefresh();
  });
  $('dbgCodeGo').onclick = dbgUnlock;
  $('dbgCode').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') dbgUnlock();
    else if (ev.key === 'Escape') dbgLock(false);
  });
  $('dbgRoom').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { dbgGoto(+$('dbgRoom').value || 0); $('dbgRoom').blur(); } });
  // clic sur le sol : le héros y est téléporté
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    const s = dbg.open && dbg.tp && dbgSim();
    if (!s) return;
    const ndc = new THREE.Vector2(ev.clientX / innerWidth * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (hit) { s.debugTp(localHeroes()[0] ?? 0, hit.x, hit.z); F[localHeroes()[0] ?? 0].snapPos = true; }
  });
}
// la simulation du donjon, si l'outil peut y toucher
function dbgSim() { return sim instanceof DungeonSim && !rb && !net.live && game.phase !== 'menu' ? sim : null; }
function dbgMsg(t) { $('dbgInfo').textContent = t; dbg.msgT = 2.5; }
function dbgGoto(n) {
  const s = dbgSim();
  if (!s) return;
  s.debugGoto(n);
  if (dbg.god) s.debugGod(true);
  dng.room = -1;                  // reconstruire la salle, même si c'est la même
  $('result').classList.add('hidden');
  $('reward').classList.add('hidden');
  $('help').classList.remove('hidden');
  acc = 0;
}
// Le panneau demande un code d'accès (une fois par onglet). Seule l'empreinte du code est ici, pas le code
// lui-même : c'est une simple porte (tout se passe dans le navigateur), et le panneau n'agit de toute façon
// que hors ligne, sur sa propre partie.
const DBG_CODE = 0x4b19fba2;
const fnv = (t) => { let h = 0x811c9dc5; for (const c of t) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0; };
try { dbg.unlocked = sessionStorage.getItem('spartiate-dbg') === '1'; } catch (e) { dbg.unlocked = false; }
function dbgLock(show) {
  $('dbgLock').classList.toggle('hidden', !show);
  if (!show) { $('dbgCode').blur(); return; }
  $('dbgCode').value = '';
  $('dbgCodeMsg').textContent = '';
  $('dbgCode').focus();
}
function dbgUnlock() {
  if (fnv($('dbgCode').value.trim().toLowerCase()) !== DBG_CODE) {
    $('dbgCodeMsg').textContent = 'Code incorrect.';
    $('dbgCode').value = '';
    return;
  }
  dbg.unlocked = true;
  try { sessionStorage.setItem('spartiate-dbg', '1'); } catch (e) { /* ignoré */ }
  dbgLock(false);
  toggleDebug();
}
function toggleDebug() {
  if (!dbg.unlocked) { dbgLock($('dbgLock').classList.contains('hidden')); return; }
  dbg.open = !dbg.open;
  $('dbg').classList.toggle('hidden', !dbg.open);
  dbgRefresh();
}
function dbgRefresh() {
  if (!dbg.open) return;
  const s = dbgSim();
  $('dbgGod').classList.toggle('on', dbg.god);
  $('dbgTp').classList.toggle('on', dbg.tp);
  $('dbg').classList.toggle('off', !s);
  if (dbg.msgT > 0) return;
  if (!s) { $('dbgInfo').textContent = net.live ? 'Indisponible en ligne.' : 'Lance une partie de donjon.'; return; }
  const e = s.f.find((o) => o.boss && o.team === 1 && o.state !== 'dead');
  $('dbgInfo').textContent = `salle ${s.g.room} · ${s.g.phase} · ${s.foesLeft} ennemi(s)` + (e ? ` · boss ${Math.ceil(e.hp)}/${e.maxHp}${e.sp ? ' · ' + e.sp : ''}` : '');
}
setInterval(() => { if (dbg.msgT > 0) dbg.msgT -= 0.25; dbgRefresh(); }, 250);

// Accès de débogage et de test (uniquement avec ?debug dans l'adresse)
if (new URLSearchParams(location.search).has('debug')) {
  window.__game = { get sim() { return sim; }, get rb() { return rb; }, get net() { return net; }, game, cfg, get F() { return F; }, startMatch, netStart, startDungeon };
}
