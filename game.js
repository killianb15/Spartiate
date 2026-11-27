import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Sim, DT, PRESS, NEUTRAL, quant, ATK, BRK, ROLL, STA, SHOT, FIRE, CAST, WEAPONS, SPELLS, SPELL_IDS, spellOf, defaultWeapon, windupOf } from './sim.js';
const AR = 'assets/archer/';
import { AI } from './ai.js';
import { Rollback } from './rollback.js';
import { CoopHost, CoopGuest } from './coop.js';
import { Link } from './net.js';
import { ITEMS, FAMILIES, COMBOS, MINORS, QUALITY, FX, TF_N, itemOf, itemList, has, hasTf } from './items.js';
import { DungeonSim, REVIVE, HEROES, FOES, BOSS, ARENA_LAYOUTS, FINAL_ROOM, FINAL_ACT, ROOM_R, ROOM_T, TILE, PLAT_H, TRAP, trapUp, trapPhase, mapInput, eventInput, padStand, PAD_R, MERCHANT, SORCERER, WEAPON_IDS, spellKey, HERO_IDS, FIRST_HERO, shopInput, biomeOf, biomeOfAct } from './dungeon.js';
import { generateMap, advanceMap, availableNextIds, isBossNode } from './map.js';
import { renderMap } from './map-ui.js';
import { EVENTS } from './events.js';

// =====================================================================
//  Utilitaires
// =====================================================================
const dom = Object.create(null);
const $ = (id) => dom[id] || (dom[id] = document.getElementById(id));
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

// =====================================================================
//  Qualité graphique (Bas / Moyen / Élevé) : adapte ombres, éclairage,
//  particules, foule et résolution au PC sans jamais toucher au gameplay.
// =====================================================================
const GFX_ORDER = ['low', 'med', 'high'];
const GFX = {
  low: {
    label: 'Bas (Petit PC)',
    shadows: false, shadowMap: 0, shadowType: THREE.BasicShadowMap,
    lambert: true, maxLights: 0, ambientBoost: 1.32, sunBoost: 1.15,
    maxPR: 1.0, minPR: 0.6,
    partMax: 240, partMul: 0.4, ringMax: 24,
    crowdMul: 0.25, crowdStep: 0,
    tuftMul: 0.15, tuftHz: 0,
    leafMul: 0.25, ffMul: 0.3,
    rainMul: 0.25, rainRings: false,
    motesMul: 0.25, motesHz: 15,
    sway: false, fireEmbers: false, fireHz: 20,
    meadowRings: 1, meadowDecor: 0.4, birdsMul: 0.45,
  },
  med: {
    label: 'Moyen',
    shadows: true, shadowMap: 1024, shadowType: THREE.PCFShadowMap,
    lambert: false, maxLights: 4, ambientBoost: 1.12, sunBoost: 1.05,
    maxPR: 1.5, minPR: 0.7,
    partMax: 520, partMul: 0.75, ringMax: 48,
    crowdMul: 0.55, crowdStep: 4,
    tuftMul: 0.45, tuftHz: 20,
    leafMul: 0.6, ffMul: 0.6,
    rainMul: 0.55, rainRings: true,
    motesMul: 0.55, motesHz: 20,
    sway: true, fireEmbers: true, fireHz: 30,
    meadowRings: 2, meadowDecor: 0.7, birdsMul: 0.75,
  },
  high: {
    label: 'Élevé (Gros PC)',
    shadows: true, shadowMap: 2048, shadowType: THREE.PCFSoftShadowMap,
    lambert: false, maxLights: 8, ambientBoost: 1.0, sunBoost: 1.0,
    maxPR: 2.0, minPR: 0.85,
    partMax: 900, partMul: 1.0, ringMax: 64,
    crowdMul: 1.0, crowdStep: 3,
    tuftMul: 1.0, tuftHz: 30,
    leafMul: 1.0, ffMul: 1.0,
    rainMul: 1.0, rainRings: true,
    motesMul: 1.0, motesHz: 30,
    sway: true, fireEmbers: true, fireHz: 60,
    meadowRings: 2, meadowDecor: 1.0, birdsMul: 1.0,
  },
};
function readSavedGfx() {
  const qs = new URLSearchParams(location.search).get('gfx');
  if (qs && GFX[qs]) return qs;
  try {
    const saved = JSON.parse(localStorage.getItem('spartiate-cfg') || '{}');
    if (saved && GFX[saved.gfx]) return saved.gfx;
  } catch (e) { /* stockage indisponible */ }
  return null;
}
function detectQuality(gl) {
  let gpu = '';
  try {
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
  } catch (e) { /* ignoré */ }
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = navigator.maxTouchPoints > 1 && Math.min(innerWidth, innerHeight) < 900;
  if (mobile || /swiftshader|llvmpipe|software|basic render|mali|adreno|powervr|intel.*hd graphics [2-5]\d\d/.test(gpu) || cores <= 4) return 'low';
  if (/nvidia|geforce|rtx|gtx|radeon rx|arc a|apple m[2-9]|apple m1 (pro|max|ultra)/.test(gpu) && cores >= 8) return 'high';
  return 'med';
}
let savedGfx = readSavedGfx();
let gfxId = savedGfx || 'med';
let gfx = GFX[gfxId];

// En ligne : les deux navigateurs font tourner la même simulation (sim.js) et s'échangent
// leurs touches ; rollback.js corrige les prédictions. Voir net.js pour le transport.
// hall : salon ouvert depuis la salle d'armes (listé sur le serveur) ; halls : salons des autres, à rejoindre
// friends : amis du compte et leur état ({name, online, code, busy}, envoyé par le serveur) ; invite : invitation reçue
const net = { ws: null, link: null, role: null, me: 0, live: false, code: '', urls: [], peer: false, peerKind: null, peerWpn: null, peerSpell: '', peerName: '', peerUnlocked: [], hall: false, halls: [], friends: [], invite: null };

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
  sorcerer: 'assets/npc/sorcerer.glb', tent: 'assets/npc/tent.glb', cauldron: 'assets/npc/cauldron.glb',   // sorcier (tools/blender/sorcier.py)
  totem: 'assets/summons/totem.glb',   // Totem de vie (sort), même script
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

function inst(key, s = S, cast = true) {
  const src = G[key];
  // clone simple (bien plus rapide que SkeletonUtils) pour tous les modèles sans squelette
  const o = src.skinned ? SkeletonUtils.clone(src.scene) : src.scene.clone(true);
  o.scale.setScalar(s);
  // les dalles de sol et de lave, à plat, ne projettent d'ombre sur rien : autant de moins à dessiner
  const cs = cast && gfx.shadows && !key.includes('floor') && key !== 'b_lava';
  o.traverse((m) => {
    if (!m.isMesh) return;
    const isGlow = m.name.startsWith('glow');
    m.castShadow = cs && !isGlow;
    m.receiveShadow = !isGlow;
  });
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
  instBatch.clear();
  fireBatch.length = 0;
  lightQueue.length = 0;
  disposeTree(world);
  world.clear();
  if (scene.background?.isTexture && !KEEP.has(scene.background)) scene.background.dispose();
  scene.background = null;
}
// Budget fixe de lumières ponctuelles par préréglage graphique (Bas : 0, Moyen : 4, Élevé : 8).
// Le nombre de lumières fait partie des shaders de three.js : en gardant toujours exactement
// gfx.maxLights lumières visibles (les plus prioritaires, complétées par des lumières éteintes),
// les shaders sont compilés une seule fois et ne saccadent jamais en changeant de salle.
const lightQueue = [];
function queueLight(color, intensity, distance, decay, x, y, z, priority = 5) {
  const ref = { light: null };
  lightQueue.push({ color, intensity, distance, decay, x, y, z, priority, ref });
  return ref;
}
function flushLights() {
  const cap = gfx.maxLights;
  lightQueue.sort((a, b) => b.priority - a.priority);
  const used = Math.min(cap, lightQueue.length);
  for (let i = 0; i < used; i++) {
    const q = lightQueue[i];
    const l = new THREE.PointLight(q.color, q.intensity, q.distance, q.decay);
    l.position.set(q.x, q.y, q.z);
    world.add(l);
    q.ref.light = l;
  }
  for (let i = used; i < cap; i++) {
    const l = new THREE.PointLight(0x000000, 0, 1);
    l.position.y = -50;
    world.add(l);
  }
  lightQueue.length = 0;
}
// matériau mat (Lambert en qualité Bas, Standard sinon) pour les décors créés par salle
function stdMat(o) {
  if (!gfx.lambert) return new THREE.MeshStandardMaterial(o);
  const p = { ...o };
  delete p.roughness; delete p.metalness;
  return new THREE.MeshLambertMaterial(p);
}

const CHARS = { soldier: 'Gladiateur', human: 'Mirmillon', orc: 'Orc', archer: 'Archère', knight: 'Chevalier', zombie: 'Zombie', robot: 'Automate' };

// =====================================================================
//  Rendu
// =====================================================================
const renderer = new THREE.WebGLRenderer({ antialias: gfxId !== 'low', powerPreference: 'high-performance' });
if (!savedGfx) { gfxId = detectQuality(renderer.getContext()); gfx = GFX[gfxId]; }
renderer.setPixelRatio(Math.min(devicePixelRatio, gfx.maxPR));
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = gfx.shadows;
renderer.shadowMap.type = gfx.shadowType;
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
  renderer.setSize(innerWidth, innerHeight, false);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { last = performance.now(); resSkip = 12; }
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
  whirl: () => { noise(0.55, { freq: 700, to: 2600, q: 1.4, vol: 0.28 }); tone(220, 0.45, { type: 'triangle', vol: 0.1, to: 440 }); },
  dash: () => { noise(0.24, { freq: 1800, to: 600, q: 1.2, vol: 0.3 }); tone(420, 0.18, { type: 'sawtooth', vol: 0.08, to: 920 }); },
  aegis: () => { tone(520, 0.65, { type: 'triangle', vol: 0.2, to: 780 }); tone(1040, 0.55, { vol: 0.14, delay: 0.04 }); noise(0.18, { freq: 3200, vol: 0.14 }); },
  nova: () => { noise(0.45, { freq: 420, to: 160, q: 0.9, vol: 0.3 }); tone(160, 0.4, { type: 'sawtooth', vol: 0.1, to: 75 }); },
  zap: () => { noise(0.32, { freq: 3600, to: 900, q: 1.8, vol: 0.36 }); tone(880, 0.24, { type: 'sawtooth', vol: 0.14, to: 140 }); tone(1320, 0.18, { type: 'square', vol: 0.08, to: 260, delay: 0.04 }); },
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

// limite les rafales de sons identiques (ex. explosion sur plusieurs ennemis)
const sfxLast = Object.create(null);
function sfxOk(name) {
  const t = performance.now();
  if (t - (sfxLast[name] || 0) < 28) return false;
  sfxLast[name] = t;
  return true;
}
// =====================================================================
//  Particules, anneaux, textes
// =====================================================================
const PMAX = 900;
const pMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), PMAX);
pMesh.frustumCulled = false;
pMesh.setColorAt(0, new THREE.Color());
pMesh.count = 0;
scene.add(pMesh);
// réserve pré-allouée : zéro création d'objet pendant le jeu (pas de pauses du ramasse-miettes)
const pPool = Array.from({ length: PMAX }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 0.08, grav: 9, drag: 0, col: 0xffffff, rot: 0, spin: 0 }));
let pCount = 0, pOld = 0, pWasEmpty = true;
const dummy = new THREE.Object3D();
const pCol = new THREE.Color();

// o.dir : direction privilégiée {x, z}
function emit(x, y, z, n, o = {}) {
  const count = n <= 1 ? (Math.random() < gfx.partMul ? 1 : 0) : Math.max(1, Math.round(n * gfx.partMul));
  if (!count) return;
  const cap = gfx.partMax;
  const colors = Array.isArray(o.color) ? o.color : null;
  const singleCol = colors ? 0 : (o.color ?? 0xffffff);
  const sp = o.speed ?? 3, up = o.up ?? 2, baseLife = o.life ?? 0.6, baseSize = o.size ?? 0.08;
  const grav = o.grav ?? 9, drag = o.drag ?? 0, spread = o.spread ?? 0;
  const dx = o.dir ? o.dir.x * sp * 0.8 : 0, dz = o.dir ? o.dir.z * sp * 0.8 : 0;
  for (let i = 0; i < count; i++) {
    let p;
    if (pCount < cap) p = pPool[pCount++];
    else { p = pPool[pOld]; pOld = (pOld + 1) % cap; }
    const a = Math.random() * TAU, spd = sp * rand(0.2, 1), life = baseLife * rand(0.6, 1);
    p.x = x + (spread ? rand(-spread, spread) : 0);
    p.y = y + (spread ? rand(-spread, spread) : 0);
    p.z = z + (spread ? rand(-spread, spread) : 0);
    p.vx = Math.cos(a) * spd + dx;
    p.vy = up * rand(0.4, 1.2);
    p.vz = Math.sin(a) * spd + dz;
    p.life = p.max = life;
    p.size = baseSize * rand(0.6, 1.3);
    p.grav = grav; p.drag = drag;
    p.col = colors ? pick(colors) : singleCol;
    p.rot = rand(0, 6); p.spin = rand(-8, 8);
  }
}
function updateParticles(dt) {
  if (pCount === 0) {
    if (!pWasEmpty) { pMesh.count = 0; pWasEmpty = true; }
    return;
  }
  pWasEmpty = false;
  for (let i = pCount - 1; i >= 0; i--) {
    const p = pPool[i];
    p.life -= dt;
    // retrait par échange avec la dernière (l'ordre n'a pas d'importance)
    if (p.life <= 0) {
      const lastP = pPool[--pCount];
      pPool[i] = lastP;
      pPool[pCount] = p;
      continue;
    }
    p.vy -= p.grav * dt;
    if (p.drag > 0) {
      const dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vz *= dr; if (p.grav < 3) p.vy *= dr;
    }
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.rot += p.spin * dt;
    if (p.y < 0.03 && p.grav > 0) { p.y = 0.03; p.vy *= -0.3; p.vx *= 0.5; p.vz *= 0.5; p.spin *= 0.5; }
  }
  const arr = pMesh.instanceMatrix.array;
  for (let i = 0; i < pCount; i++) {
    const p = pPool[i];
    const sc = p.size * Math.min(1, (p.life / p.max) * 2.5);
    // écriture directe de la matrice (Euler XYZ avec rz = 0) : évite Object3D.updateMatrix()
    const cx = Math.cos(p.rot), sx = Math.sin(p.rot);
    const cy = Math.cos(p.rot * 0.7), sy = Math.sin(p.rot * 0.7);
    const o = i * 16;
    arr[o] = cy * sc; arr[o + 1] = sx * sy * sc; arr[o + 2] = -cx * sy * sc; arr[o + 3] = 0;
    arr[o + 4] = 0; arr[o + 5] = cx * sc; arr[o + 6] = sx * sc; arr[o + 7] = 0;
    arr[o + 8] = sy * sc; arr[o + 9] = -sx * cy * sc; arr[o + 10] = cx * cy * sc; arr[o + 11] = 0;
    arr[o + 12] = p.x; arr[o + 13] = p.y; arr[o + 14] = p.z; arr[o + 15] = 1;
    pMesh.setColorAt(i, pCol.setHex(p.col));
  }
  pMesh.count = pCount;
  if (pCount > 0) {
    pMesh.instanceMatrix.needsUpdate = true;
    pMesh.instanceColor.needsUpdate = true;
  } else pWasEmpty = true;
}

const ringGeo = new THREE.RingGeometry(0.82, 1, 32);
const rings = [];          // anneaux en cours
const ringPool = [];       // anneaux libres, réutilisés (pas de matériau créé puis détruit à chaque coup)
// anneau d'onde de choc ; face à la caméra sauf s'il est posé au sol
function ring(x, y, z, color, maxS = 1.6, life = 0.35, flat = false, opacity = 1) {
  if (rings.length >= gfx.ringMax) return;
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

function P(key, x, y, z, ry = 0, s = S, parent = world, cast = true) {
  const o = inst(key, s, cast);
  o.position.set(x, y, z);
  o.rotation.y = ry;
  parent.add(o);
  return o;
}
// Décors immobiles (sols, murs, gradins, colonnes, obstacles, rochers…) : regroupés par modèle
// et par ombre projetée en un seul InstancedMesh (1 appel de dessin au lieu de dizaines ou centaines).
const instBatch = new Map();
const mTile = new THREE.Matrix4(), qTile = new THREE.Quaternion(), sTile = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
function PI(key, x, y, z, ry = 0, sx = S, sy = sx, sz = sx, cast = true) {
  const c = cast && gfx.shadows && !key.includes('floor') && key !== 'b_lava';
  const bk = key + (c ? '|1' : '|0');
  let entry = instBatch.get(bk);
  if (!entry) { entry = { key, cast: c, list: [] }; instBatch.set(bk, entry); }
  qTile.setFromAxisAngle(UP, ry);
  entry.list.push(new THREE.Matrix4().compose(v1.set(x, y, z), qTile, sTile.set(sx, sy, sz)));
}
function PT(key, x, y, z, ry = 0, s = S) { PI(key, x, y, z, ry, s, s, s, false); }
function flushInstances() {
  for (const { key, cast, list } of instBatch.values()) {
    const root = G[key].scene;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      const isGlow = o.name.startsWith('glow');
      const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
      for (let i = 0; i < list.length; i++) im.setMatrixAt(i, mTile.multiplyMatrices(list[i], o.matrixWorld));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = cast && !isGlow;
      im.receiveShadow = !isGlow;
      if (im.computeBoundingSphere) im.computeBoundingSphere();
      else im.frustumCulled = false;
      world.add(im);
    });
  }
  instBatch.clear();
}
// objet posé sur un cercle de rayon r à l'angle a, tourné vers le centre
function PR(key, r, a, y = 0, s = S, turn = 0, cast = true) {
  return P(key, Math.sin(a) * r, y, Math.cos(a) * r, a + Math.PI + turn, s, world, cast);
}
function PIR(key, r, a, y = 0, sx = S, sy = sx, sz = sx, turn = 0, cast = true) {
  PI(key, Math.sin(a) * r, y, Math.cos(a) * r, a + Math.PI + turn, sx, sy, sz, cast);
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
  const hemi = new THREE.HemisphereLight(sky, gnd, hi * gfx.ambientBoost);
  world.add(hemi);
  const sun = new THREE.DirectionalLight(sunC, si * gfx.sunBoost);
  sun.position.set(...pos);
  sun.castShadow = gfx.shadows;
  if (gfx.shadows) {
    const c = sun.shadow.camera;
    c.left = -15; c.right = 15; c.top = 15; c.bottom = -15; c.near = 0.5; c.far = 65;
    sun.shadow.mapSize.set(gfx.shadowMap, gfx.shadowMap);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
  }
  world.add(sun, sun.target);
  return { hemi, sun };
}
const groundGeo = new THREE.PlaneGeometry(220, 220).rotateX(-Math.PI / 2);
const hillGeo = new THREE.ConeGeometry(1, 1, 5);
const tuftGeo = new THREE.ConeGeometry(0.05, 0.28, 4);
const flowerGeo = new THREE.OctahedronGeometry(0.07, 0);
const leafGeo = new THREE.PlaneGeometry(0.13, 0.08);
const ffGeo = new THREE.SphereGeometry(0.035, 5, 4);
const puddleGeo = new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2);
const cloudGeo = new THREE.IcosahedronGeometry(1, 0);
const boneShaftGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.42, 6).rotateZ(Math.PI / 2);
const boneKnobGeo = new THREE.SphereGeometry(0.06, 5, 4);
const bowlGeo = new THREE.CylinderGeometry(0.34, 0.2, 0.2, 10);
const bowlSmallGeo = new THREE.CylinderGeometry(0.28, 0.16, 0.18, 10);
const stickGeo = new THREE.CylinderGeometry(0.045, 0.03, 0.5, 6);
const cupGeo = new THREE.CylinderGeometry(0.09, 0.06, 0.1, 8);
keep(groundGeo, hillGeo, tuftGeo, flowerGeo, leafGeo, ffGeo, puddleGeo, cloudGeo, boneShaftGeo, boneKnobGeo, bowlGeo, bowlSmallGeo, stickGeo, cupGeo);

function ground(color) {
  const m = new THREE.Mesh(groundGeo, stdMat({ color, roughness: 1 }));
  m.position.y = -0.02; m.receiveShadow = true;
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
  if (!gfx.sway) return;
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

// Flammes regroupées : toutes les torches et braseros d'une salle partagent 3 InstancedMesh
// (un par couleur de flamme) au lieu de 3 maillages et 1 boucle par feu.
const flameGeo = new THREE.ConeGeometry(1, 1, 6);
flameGeo.translate(0, 0.5, 0);
const flameMats = [0xff4a1c, 0xff9a2e, 0xffe27a].map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.92, toneMapped: false }));
const fireBatch = [];
function fire(parent, x, y, z, s = 1, lightI = 9, priority = 5) {
  let wx = x, wy = y, wz = z;
  if (parent && parent !== world) {
    parent.updateMatrixWorld(true);
    v1.set(x, y, z).applyMatrix4(parent.matrixWorld);
    wx = v1.x; wy = v1.y; wz = v1.z;
  }
  const ref = lightI > 0 ? queueLight(0xff8a3a, lightI, 9 * s, 1.4, wx, wy + 0.4 * s, wz, priority) : null;
  fireBatch.push({ x: wx, y: wy, z: wz, s, lightI, ref, ph: rand(0, 10), emberT: rand(0.05, 0.35) });
}
function flushFires() {
  const n = fireBatch.length;
  if (!n) return;
  const list = fireBatch.slice();
  fireBatch.length = 0;
  const layers = flameMats.map((m) => {
    const im = new THREE.InstancedMesh(flameGeo, m, n);
    im.frustumCulled = false;
    world.add(im);
    return im;
  });
  let accF = 1;
  const stepF = 1 / gfx.fireHz;
  const update = (dt, t) => {
    accF += dt;
    const doAnim = accF >= stepF;
    if (doAnim) accF = 0;
    for (let j = 0; j < n; j++) {
      const f = list[j];
      if (doAnim) {
        const s = f.s, ph = f.ph;
        for (let i = 0; i < 3; i++) {
          const fl = 1 + Math.sin(t * (13 + i * 4) + ph + i) * 0.16 + Math.sin(t * 27 + i * 2) * 0.08;
          const bx = 0.17 * s * (1 - i * 0.27) * (1.5 - fl * 0.5);
          const by = 0.45 * s * (1 - i * 0.22) * fl;
          const ry = t * (2 + i), cy = Math.cos(ry), sy = Math.sin(ry);
          const arr = layers[i].instanceMatrix.array, o = j * 16;
          arr[o] = cy * bx; arr[o + 1] = 0; arr[o + 2] = -sy * bx; arr[o + 3] = 0;
          arr[o + 4] = 0; arr[o + 5] = by; arr[o + 6] = 0; arr[o + 7] = 0;
          arr[o + 8] = sy * bx; arr[o + 9] = 0; arr[o + 10] = cy * bx; arr[o + 11] = 0;
          arr[o + 12] = f.x + Math.sin(t * 9 + i) * 0.015 * s; arr[o + 13] = f.y; arr[o + 14] = f.z; arr[o + 15] = 1;
        }
        if (f.ref?.light) f.ref.light.intensity = f.lightI * (0.82 + Math.sin(t * 17 + ph) * 0.1 + Math.random() * 0.14);
      }
      if (gfx.fireEmbers) {
        f.emberT -= dt;
        if (f.emberT < 0) {
          f.emberT = rand(0.1, 0.35);
          emit(f.x, f.y + 0.3 * f.s, f.z, 1, { color: [0xffa040, 0xffd060], speed: 0.4, up: 1.6, size: 0.045, life: 1.3, grav: -0.4, spread: 0.1 * f.s });
        }
      }
    }
    if (doAnim) for (let i = 0; i < 3; i++) layers[i].instanceMatrix.needsUpdate = true;
  };
  update(1, 0);
  updaters.push(update);
}
const ironMat = new THREE.MeshStandardMaterial({ color: 0x3a3230, metalness: 0.6, roughness: 0.5 });
const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b4426, roughness: 0.9 });
keep(flameGeo, flameMats, ironMat, woodMat);
function brazier(x, z, baseKey = 'a_columnD', baseS = 1.1, lightI = 10, priority = 5) {
  const h = (baseKey === 'd_barrel' ? 0.48 : 0.72) * baseS;
  PI(baseKey, x, 0, z, 0, baseS, baseS, baseS, true);
  const bowl = new THREE.Mesh(bowlGeo, ironMat);
  bowl.position.set(x, h + 0.08, z); bowl.castShadow = gfx.shadows;
  world.add(bowl);
  fire(world, x, h + 0.16, z, 1.2, lightI, priority);
}
// torche murale tournée vers ry
function torch(x, y, z, ry, lightI = 8, priority = 5) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  world.add(g);
  const stick = new THREE.Mesh(stickGeo, woodMat);
  stick.rotation.x = 0.35; g.add(stick);
  const cup = new THREE.Mesh(cupGeo, ironMat);
  cup.position.set(0, 0.24, 0.09); g.add(cup);
  fire(g, 0, 0.27, 0.09, 0.75, lightI, priority);
}

// ---------- Foule ----------
class Crowd {
  constructor() { this.list = []; this.ambT = 0; this.slice = 0; }
  add(x, y, z, kinds, base = 'idle', s = 1.25, ry = 0) {
    if (gfx.crowdMul < 1 && Math.random() > gfx.crowdMul) return null;
    const k = pick(kinds);
    // les spectateurs ne projettent pas d'ombre (économie énorme de skinning sur la carte d'ombres)
    const o = P(k, x, y, z, ry + rand(-0.25, 0.25), s, world, false);
    const mx = new THREE.AnimationMixer(o);
    const acts = {};
    for (const n of ['idle', 'emote-yes', 'sit']) acts[n] = mx.clipAction(THREE.AnimationClip.findByName(G[k].animations, n));
    acts[base].play();
    acts[base].time = rand(0, 1.3);
    mx.update(0);
    const sp = { o, mx, acts, cur: base, base, baseY: y, ex: 0, ph: rand(0, 6), sit: base === 'sit', acc: 0 };
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
    const n = this.list.length;
    if (!n) return;
    this.ambT -= dt;
    if (this.ambT < 0) { this.ambT = rand(0.1, 0.4); pick(this.list).ex += 0.6; }
    // mise à jour des squelettes par tranches (1/3 ou 1/4 par image) : divisé par 3-4 sur le CPU
    const step = gfx.crowdStep;
    const sl = step > 0 ? (this.slice = (this.slice + 1) % step) : -1;
    for (let i = 0; i < n; i++) {
      const s = this.list[i];
      if (s.ex > 0) s.ex = Math.max(0, s.ex - dt * 0.45);
      if (step > 0) {
        const want = s.ex > 0.4 ? 'emote-yes' : s.base;
        if (want !== s.cur) {
          const a = s.acts[want];
          a.reset().play();
          s.acts[s.cur].crossFadeTo(a, 0.2, false);
          s.cur = want;
        }
        s.acc += dt * (1 + s.ex * 0.4);
        if (i % step === sl) { s.mx.update(s.acc); s.acc = 0; }
      }
      const jump = (s.sit && s.ex < 0.4) || s.ex <= 0.3 ? 0 : Math.abs(Math.sin(t * 8 + s.ph)) * 0.24 * Math.min(1, (s.ex - 0.3) * 1.6);
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

// ---------- Oiseaux / nuages / arbres instanciés ----------
function birds(count, color, y0, y1) {
  const n = Math.max(2, Math.round(count * gfx.birdsMul));
  const wingGeo = new THREE.PlaneGeometry(0.42, 0.14);
  wingGeo.translate(0.21, 0, 0);
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  for (let i = 0; i < n; i++) {
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
  const mat = stdMat({ color, roughness: 1, flatShading: true });
  const puffs = [];
  for (let i = 0; i < n; i++) {
    const st = { a: rand(0, TAU), r: rand(35, 55), y: rand(y0, y1) };
    for (let k = 0; k < 4; k++) {
      puffs.push({ st, ox: k * 1.5 - 2.2 + rand(-0.4, 0.4), oy: rand(-0.3, 0.5), oz: rand(-0.5, 0.5), sx: rand(1.2, 2), sy: rand(0.8, 1.3), sz: rand(1, 1.4) });
    }
  }
  const im = new THREE.InstancedMesh(cloudGeo, mat, puffs.length);
  im.frustumCulled = false;
  world.add(im);
  let accC = 1;
  const update = (dt) => {
    for (let i = 0; i < puffs.length; i += 4) puffs[i].st.a += dt * 0.008;
    accC += dt;
    if (accC < 0.05) return;   // 20 Hz suffit largement pour des nuages lents
    accC = 0;
    const arr = im.instanceMatrix.array;
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i], a = p.st.a, ca = Math.cos(a), sa = Math.sin(a);
      const o = i * 16;
      arr[o] = ca * p.sx; arr[o + 1] = 0; arr[o + 2] = -sa * p.sx; arr[o + 3] = 0;
      arr[o + 4] = 0; arr[o + 5] = p.sy; arr[o + 6] = 0; arr[o + 7] = 0;
      arr[o + 8] = sa * p.sz; arr[o + 9] = 0; arr[o + 10] = ca * p.sz; arr[o + 11] = 0;
      arr[o + 12] = sa * p.st.r + ca * p.ox + sa * p.oz;
      arr[o + 13] = p.st.y + p.oy;
      arr[o + 14] = ca * p.st.r - sa * p.ox + ca * p.oz;
      arr[o + 15] = 1;
    }
    im.instanceMatrix.needsUpdate = true;
  };
  update(0);
  updaters.push(update);
}
// Arbres instanciés avec léger balancement dans le vent (1 appel de dessin au lieu d'un par arbre)
function instTrees(list, cast) {
  if (!list.length) return;
  if (!gfx.sway) {
    for (const t of list) PI('a_tree', t.x, 0, t.z, t.ry, t.s, t.s, t.s, cast);
    return;
  }
  const root = G.a_tree.scene;
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
    im.castShadow = cast && gfx.shadows;
    im.receiveShadow = true;
    im.frustumCulled = false;
    world.add(im);
    parts.push({ im, mw: o.matrixWorld });
  });
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  let accT = 1;
  const stepT = 1 / Math.max(15, gfx.tuftHz || 20);
  const update = (dt, time) => {
    accT += dt;
    if (accT < stepT) return;
    accT = 0;
    for (let i = 0; i < list.length; i++) {
      const tr = list[i];
      const sw = Math.sin(time * tr.freq + tr.ph) * tr.amp + Math.sin(time * tr.freq * 2.3 + tr.ph) * tr.amp * 0.3;
      e.set(0, tr.ry, sw);
      qTile.setFromEuler(e);
      m.compose(v1.set(tr.x, 0, tr.z), qTile, sTile.setScalar(tr.s));
      for (const p of parts) p.im.setMatrixAt(i, mTile.multiplyMatrices(m, p.mw));
    }
    for (const p of parts) p.im.instanceMatrix.needsUpdate = true;
  };
  update(1, 0);
  updaters.push(update);
}
// Touffes d'herbe qui ondulent (écriture directe dans instanceMatrix, fréquence adaptée à la qualité)
function grassTufts(tufts) {
  const n = tufts.length;
  if (!n) return;
  const tuft = new THREE.InstancedMesh(tuftGeo, stdMat({ color: 0x7fa64a }), n);
  tuft.frustumCulled = false;
  world.add(tuft);
  const arr = tuft.instanceMatrix.array;
  const write = (t) => {
    for (let i = 0; i < n; i++) {
      const g = tufts[i], x = g[0], z = g[1], ph = g[2];
      const rz = gfx.tuftHz > 0 ? Math.sin(t * 2 + ph + x * 0.3) * 0.25 : 0;
      const cy = Math.cos(ph), sy = Math.sin(ph), cz = Math.cos(rz), sz = Math.sin(rz);
      const o = i * 16;
      arr[o] = cy * cz; arr[o + 1] = sz; arr[o + 2] = -sy * cz; arr[o + 3] = 0;
      arr[o + 4] = -cy * sz; arr[o + 5] = cz; arr[o + 6] = sy * sz; arr[o + 7] = 0;
      arr[o + 8] = sy; arr[o + 9] = 0; arr[o + 10] = cy; arr[o + 11] = 0;
      arr[o + 12] = x; arr[o + 13] = 0.12; arr[o + 14] = z; arr[o + 15] = 1;
    }
    tuft.instanceMatrix.needsUpdate = true;
  };
  write(0);
  if (gfx.tuftHz <= 0) return;
  let accG = 0;
  const stepG = 1 / gfx.tuftHz;
  updaters.push((dt, t) => { accG += dt; if (accG < stepG) return; accG = 0; write(t); });
}

// ---------- Colisée rond : mur circulaire + gradins tout autour ----------
const WALL_R = 10;
const GATES = [Math.PI / 2, -Math.PI / 2];
const isGate = (a, n) => GATES.some((g) => Math.abs(wrap(a - g)) < Math.PI / n);
function roundArena(kinds, rows, density) {
  const n = Math.round(TAU * WALL_R / 1.5);
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU;
    PIR(isGate(a, n) ? 'a_wallGate' : 'a_wall', WALL_R, a, 0, S * 1.06, S, S, 0, true);
  }
  newCrowd();
  for (let r = 0; r < rows; r++) {
    const rad = WALL_R + 1.3 + r * 1.25, top = 1.15 + r * 0.7;
    const nb = Math.ceil(TAU * rad / 1.5);
    // gradins extérieurs regroupés en 1 InstancedMesh, sans ombre projetée (hors zone de combat)
    for (let i = 0; i < nb; i++) PIR('a_block', rad, i / nb * TAU, 0, 1.62, top / 0.5, 1.3, 0, false);
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
    PIR('a_column', 9.15, a);
    if (gfx.sway) sway(PR('a_banner', 9.15, a, 1.5, S, 0, false), 0.07, 2.1);
    else PIR('a_banner', 9.15, a, 1.5, S, S, S, 0, false);
  }
  // statues de part et d'autre des portes
  for (const g of GATES) for (const d of [-0.2, 0.2]) PIR('a_statue', 8.9, g + d, 0, 1.6);
  PIR('a_rack', 8.8, 0.25, 0, 1.4);
  PIR('a_rack', 8.8, Math.PI + 0.25, 0, 1.4);
  PIR('a_block', 8.8, -0.25, 0, 0.8, 1, 0.8);
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

  // 4 côtés : rempart (spectateurs dessus), corniche, grand mur (tous instanciés)
  for (let side = 0; side < 4; side++) {
    const ang = side * Math.PI / 2;           // direction du mur depuis le centre
    const ox = Math.sin(ang), oz = Math.cos(ang); // vers l'extérieur
    const tx = Math.cos(ang), tz = -Math.sin(ang); // le long du mur
    const at = (d, t) => [ox * d + tx * t, oz * d + tz * t];
    for (let t = -10.5; t <= 10.51; t += S) {
      let [x, z] = at(10.5, t);
      PI(Math.abs(t) < 0.1 ? 'd_wallOpen' : 'd_wall', x, 0, z, ang + Math.PI, S, S, S, true);
      [x, z] = at(12, t); PI('d_wall', x, 0, z, ang, S, 2.15, S, false);
      [x, z] = at(13.5, t); PI('d_wall', x, 0, z, ang, S, 3.3, S, false);
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
      if (gfx.sway) sway(P('d_banner', x, 0.1, z, ang + Math.PI, S, world, false), 0.04, 1.4, 'x');
      else PI('d_banner', x, 0.1, z, ang + Math.PI, S, S, S, false);
    }
  }

  // coins
  PI('d_wood', -8.4, 0, -8.4, 0.2);
  PI('d_wood', 8.4, 0, 8.4, 1.2);
  PI('d_support', 8.6, 0, -6.5, Math.PI / 2);
  PI('d_support', -8.6, 0, 6.5, Math.PI / 2);
  PI('d_barrel', 8.6, 0, -8.4); PI('d_barrel', 8.0, 0, -8.9, 1); PI('d_barrel', 8.3, 0.72, -8.6, 2, 1.3);
  PI('d_pot', -8.6, 0, 8.6, 0.6); PI('d_pot', -8.0, 0, 8.9, 2.1, 1.2);
  PI('d_rocks', -8.8, 0, -6.3, 0.3); PI('d_stones', 6.4, 0, 8.8, 1.2);
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
        const c = P('d_coin', -8.1, 0.3, -3.5, 0, 0.55, world, false);
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

  // poussière dans la lumière (densité et fréquence adaptées à la qualité)
  const N = Math.max(30, Math.round(320 * gfx.motesMul)), pos = new Float32Array(N * 3), seed = [];
  for (let i = 0; i < N; i++) seed.push([rand(-9.5, 9.5), rand(0, 4), rand(-9.5, 9.5), rand(0, 6)]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const motes = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffd9a0, size: 0.05, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  motes.frustumCulled = false;
  world.add(motes);
  let accM = 1;
  const stepM = 1 / gfx.motesHz;
  updaters.push((dt, t) => {
    accM += dt;
    if (accM < stepM) return;
    const d = accM; accM = 0;
    for (let i = 0; i < N; i++) {
      const s = seed[i];
      s[1] += d * 0.08; if (s[1] > 4) s[1] = 0;
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

  // soleil + collines instanciées (1 appel de dessin)
  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(5, 24), new THREE.MeshBasicMaterial({ color: 0xffe0a0, fog: false, toneMapped: false }));
  sunDisc.position.set(-75, 22, 31);
  sunDisc.lookAt(0, 0, 0);
  world.add(sunDisc);
  const hills = new THREE.InstancedMesh(hillGeo, stdMat({ color: 0x4a5a6a, flatShading: true, roughness: 1 }), 18);
  hills.frustumCulled = false;
  for (let i = 0; i < 18; i++) {
    const a = i / 18 * TAU + rand(-0.1, 0.1), r = rand(45, 58), rad = rand(8, 13), h = rand(6, 13);
    dummy.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(rad, h, rad);
    dummy.updateMatrix();
    hills.setMatrixAt(i, dummy.matrix);
  }
  hills.instanceMatrix.needsUpdate = true;
  world.add(hills);

  // herbes qui ondulent
  const NT = Math.round(420 * gfx.tuftMul);
  const tufts = [];
  for (let i = 0; i < NT; i++) { const a = rand(0, TAU), r = rand(8.1, 16); tufts.push([Math.sin(a) * r, Math.cos(a) * r, rand(0, 6)]); }
  grassTufts(tufts);

  // forêt en anneau (regroupée en 2 InstancedMesh : premier rang avec ombres, fond sans ombre)
  const innerT = [], outerT = [];
  const totalT = Math.round(75 * (0.55 + 0.45 * gfx.meadowDecor));
  for (let i = 0; i < totalT; i++) {
    const a = rand(0, TAU), inner = i < Math.min(25, totalT), r = inner ? rand(10.2, 12) : rand(12, 26);
    const tr = { x: Math.sin(a) * r, z: Math.cos(a) * r, ry: rand(0, 6), s: rand(1.5, 2.6), amp: 0.035, freq: rand(1, 1.6), ph: rand(0, 10) };
    (inner ? innerT : outerT).push(tr);
  }
  instTrees(innerT, true);
  for (const t of outerT) PI('a_tree', t.x, 0, t.z, t.ry, t.s, t.s, t.s, false);

  // ruines en cercle
  PIR('a_block', 9.2, Math.PI, 0, S);
  PIR('a_statue', 9.2, Math.PI, 0.75, 1.7);
  const ruins = [['a_column', 0.6], ['a_columnD', 1.2], ['a_column', 2.0], ['a_columnD', 2.6], ['a_column', -0.6], ['a_columnD', -1.3], ['a_column', -2.1], ['a_columnD', -2.6]];
  const sitters = [];
  for (const [k, a] of ruins) {
    const sc = k === 'a_column' ? S * 1.4 : S;
    PIR(k, 9.2, a, 0, sc);
    if (k === 'a_columnD') sitters.push(a);
  }
  for (const a of [0.2, 1.6, -1.7, 2.9]) PIR('a_bricks', 8.6, a, 0, 1.2, 1.2, 1.2, rand(0, 3));

  newCrowd();
  for (const a of sitters) crowd.addR(9.2, a, 1.08, ['human', 'soldier', 'orc'], 'sit', 1.15);
  for (let i = 0; i < 16; i++) crowd.addR(rand(10.4, 12.5), rand(0, TAU), 0, ['human', 'soldier', 'orc'], 'idle', 1.2);

  // feuilles qui tombent : 1 seul InstancedMesh (au lieu de 140 appels de dessin)
  const NL = Math.max(16, Math.round(140 * gfx.leafMul));
  const leafCols = [0xe8742a, 0xd94a2a, 0xf2b33a, 0x9ab84a];
  const leafIm = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), NL);
  leafIm.frustumCulled = false;
  const leaves = [];
  const spawnLeaf = (l, top) => { const a = rand(0, TAU), r = rand(0, 12); l.x = Math.sin(a) * r; l.y = top ? rand(6, 8) : rand(0, 7); l.z = Math.cos(a) * r; };
  for (let i = 0; i < NL; i++) {
    const l = { x: 0, y: 0, z: 0, ph: rand(0, 6), sp: rand(0.4, 0.8), rest: 0 };
    spawnLeaf(l, false);
    leaves.push(l);
    leafIm.setColorAt(i, pCol.setHex(pick(leafCols)));
  }
  leafIm.instanceColor.needsUpdate = true;
  world.add(leafIm);
  updaters.push((dt, t) => {
    for (let i = 0; i < NL; i++) {
      const l = leaves[i];
      if (l.y <= 0.02) {
        l.rest += dt;
        if (l.rest > 2) { l.rest = 0; spawnLeaf(l, true); }
        dummy.position.set(l.x, 0.02, l.z);
        dummy.rotation.set(-Math.PI / 2, 0, l.ph);
      } else {
        l.y -= l.sp * dt;
        l.x += (Math.sin(t * 1.3 + l.ph) * 0.6 + 0.35) * dt;
        l.z += Math.cos(t * 1.1 + l.ph) * 0.2 * dt;
        if (l.y <= 0.02) { l.y = 0.02; dummy.rotation.set(-Math.PI / 2, 0, l.ph); }
        else dummy.rotation.set(t * 2 + l.ph, t * 1.3 + l.ph, Math.sin(t * 3 + l.ph));
        dummy.position.set(l.x, l.y, l.z);
      }
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      leafIm.setMatrixAt(i, dummy.matrix);
    }
    leafIm.instanceMatrix.needsUpdate = true;
  });

  // lucioles : 1 seul InstancedMesh (au lieu de 70 appels de dessin)
  const NFF = Math.max(12, Math.round(70 * gfx.ffMul));
  const ffIm = new THREE.InstancedMesh(ffGeo, new THREE.MeshBasicMaterial({ color: 0xe2ff7a, toneMapped: false }), NFF);
  ffIm.frustumCulled = false;
  const ffs = [];
  for (let i = 0; i < NFF; i++) {
    const a = rand(0, TAU), r = rand(2, 13);
    ffs.push({ cx: Math.sin(a) * r, cy: rand(0.4, 3), cz: Math.cos(a) * r, ph: rand(0, 20), r: rand(0.3, 0.9) });
  }
  world.add(ffIm);
  updaters.push((dt, t) => {
    const arr = ffIm.instanceMatrix.array;
    for (let i = 0; i < NFF; i++) {
      const f = ffs[i], sc = 0.4 + Math.max(0, Math.sin(t * 2 + f.ph)) * 1.2, o = i * 16;
      arr[o] = sc; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0;
      arr[o + 4] = 0; arr[o + 5] = sc; arr[o + 6] = 0; arr[o + 7] = 0;
      arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = sc; arr[o + 11] = 0;
      arr[o + 12] = f.cx + Math.sin(t * 0.5 + f.ph) * f.r;
      arr[o + 13] = f.cy + Math.sin(t * 0.8 + f.ph * 2) * 0.3;
      arr[o + 14] = f.cz + Math.cos(t * 0.4 + f.ph) * f.r;
      arr[o + 15] = 1;
    }
    ffIm.instanceMatrix.needsUpdate = true;
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
    PIR(broken ? 'a_columnD' : 'a_column', 9.15, a);
    if (!broken) {
      if (gfx.sway) {
        const bn = PR('a_banner', 9.15, a, 1.5, S, 0, false);
        sway(bn, 0.2, 4.2);
        sway(bn, 0.08, 3.1, 'x');
      } else PIR('a_banner', 9.15, a, 1.5, S, S, S, 0, false);
    }
  }
  for (const a of [0.9, 2.4, -2.2]) PIR('a_bricks', 8.7, a, 0, 1.3, 1.3, 1.3, rand(0, 3));
  PIR('a_statue', 8.9, Math.PI / 2 + 0.2, 0, 1.6);
  PIR('a_statue', 8.9, -Math.PI / 2 - 0.2, 0, 1.6);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2;
    brazier(Math.sin(a) * 8.3, Math.cos(a) * 8.3, 'a_columnD', 1.1, 4);
  }
  for (const g of GATES) for (const d of [-0.12, 0.12]) {
    const a = g + d;
    torch(Math.sin(a) * 9.5, 1.0, Math.cos(a) * 9.5, a + Math.PI, 3, 4);
  }

  // flaques : 1 seul InstancedMesh
  const puddleMat = stdMat({ color: 0x1c2a44, metalness: 0.7, roughness: 0.08, transparent: true, opacity: 0.75 });
  const puddles = new THREE.InstancedMesh(puddleGeo, puddleMat, 16);
  puddles.receiveShadow = true;
  puddles.frustumCulled = false;
  for (let i = 0; i < 16; i++) {
    const a = rand(0, TAU), r = rand(0, 8.5), rad = rand(0.35, 0.85);
    dummy.position.set(Math.sin(a) * r, 0.012 + i * 0.0005, Math.cos(a) * r);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(rad, 1, rad * rand(0.6, 1));
    dummy.updateMatrix();
    puddles.setMatrixAt(i, dummy.matrix);
  }
  puddles.instanceMatrix.needsUpdate = true;
  world.add(puddles);

  // pluie (suit la caméra, densité adaptée à la qualité)
  const N = Math.max(400, Math.round(2400 * gfx.rainMul)), pos = new Float32Array(N * 6), drops = [];
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
        if (gfx.rainRings && Math.random() < 0.02 && Math.hypot(wx, wz) < 9.3) ring(wx, 0.03, wz, 0xbcd0ff, 0.35, 0.5, true, 0.5);
        d[0] = rand(-16, 14); d[1] = rand(11, 13); d[2] = rand(-14, 14);
      }
      const k = i * 6;
      pos[k] = cx + d[0]; pos[k + 1] = d[1]; pos[k + 2] = cz + d[2];
      pos[k + 3] = cx + d[0] - wind * 0.025; pos[k + 4] = d[1] + 0.42; pos[k + 5] = cz + d[2];
    }
    geo.attributes.position.needsUpdate = true;
  });

  // éclairs : tampon réutilisé (pas de recréation de BufferGeometry)
  const boltMat = new THREE.LineBasicMaterial({ color: 0xeef3ff, toneMapped: false, fog: false });
  const boltPos = new Float32Array(32 * 3);
  const boltGeo = new THREE.BufferGeometry();
  boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPos, 3));
  const bolt = new THREE.Line(boltGeo, boltMat);
  bolt.visible = false;
  bolt.frustumCulled = false;
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
      let x = fwd.x * 40 - fwd.z * side, z = fwd.z * 40 + fwd.x * side, y = 26, cnt = 0;
      while (y > 2 && cnt < 32) {
        boltPos[cnt * 3] = x; boltPos[cnt * 3 + 1] = y; boltPos[cnt * 3 + 2] = z; cnt++;
        x += rand(-2.5, 2.5); z += rand(-2.5, 2.5); y -= rand(1.4, 3);
      }
      boltGeo.setDrawRange(0, cnt);
      boltGeo.attributes.position.needsUpdate = true;
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
  talkVis = shopVis = false;
  for (const id of ['talk', 'shop']) $(id).classList.add('hidden');   // marchand (salle d'armes)
  crowd = null;
  arenaHooks = {};
  scene.fog = null;
  ARENAS[id].build();
  flushInstances();
  flushFires();
  flushLights();
  curArena = id;
  resSkip = 8;
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
const ringFoot = new THREE.RingGeometry(0.42, 0.56, 28).rotateX(-Math.PI / 2);
const shadowDiscGeo = new THREE.CircleGeometry(0.42, 16).rotateX(-Math.PI / 2);
const shadowDiscMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.34, depthWrite: false, toneMapped: false });
const hpBgGeo = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
const hpBgMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.65, depthTest: false, toneMapped: false });
const starGeo = new THREE.OctahedronGeometry(0.075);
const starMat = new THREE.MeshBasicMaterial({ color: 0xffe14a, toneMapped: false });
keep(ringFoot, shadowDiscGeo, shadowDiscMat, hpBgGeo, hpBgMat, starGeo, starMat);

// Vue d'un combattant : modèle 3D, animations et effets visuels. Tout ce qui touche au
// gameplay est dans sim.js ; ici on ne fait que LIRE l'état de la simulation (sf).
// Armes tenues en main : épée (ou lance) dans la main droite, bouclier (ou arc) dans la gauche.
// L'arc joue le rôle du bouclier : il reste droit et brille à la parade.
const SWORD_DIR = new THREE.Vector3(0.65, 0, 0.76).normalize();
const HAND = new THREE.Vector3(-0.25, 0, 0.02);    // main droite, dans le repère du bras
// back : la main tient l'arme à cette distance de son origine (le long du manche)
function heldWeapon(key, s, back = 0) {
  const o = inst(key, s);
  o.quaternion.setFromUnitVectors(UP, SWORD_DIR);
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
function collectMats(obj) {
  const out = [];
  if (obj) obj.traverse((o) => { if (o.isMesh && o.material) out.push(o.material); });
  return out;
}
// Gants de boxe (tools/blender/gloves.py) : le modèle est le gant gauche (jointures vers l'avant,
// manchette vers le bas, pouce vers le milieu du corps) ; miroir (x → -x) pour la main droite.
function gloveModel(right, s) {
  const g = inst('glove', s);
  if (right) g.scale.x = -s;
  return g;
}
// Grande faux d'os spectrale du Souverain d'Os (attachée au bras droit)
const scytheShaftGeo = new THREE.CylinderGeometry(0.025, 0.032, 1.45, 7);
const scytheBladeGeo = new THREE.BoxGeometry(0.55, 0.14, 0.035);
const scytheEdgeGeo = new THREE.BoxGeometry(0.56, 0.045, 0.042);
const scytheTipGeo = new THREE.ConeGeometry(0.09, 0.28, 5);
const skullGeo = new THREE.BoxGeometry(0.28, 0.27, 0.27);
const jawGeo = new THREE.BoxGeometry(0.18, 0.09, 0.17);
const eyeSocketGeo = new THREE.BoxGeometry(0.065, 0.055, 0.04);
const eyeGlowGeo = new THREE.SphereGeometry(0.024, 6, 6);
const ribGeo = new THREE.BoxGeometry(0.3, 0.04, 0.19);
const crownBandGeo = new THREE.CylinderGeometry(0.165, 0.155, 0.06, 8, 1, true);
const crownSpikeGeo = new THREE.ConeGeometry(0.032, 0.11, 4);
const pauldronGeo = new THREE.SphereGeometry(0.13, 8, 6, 0, TAU, 0, Math.PI * 0.65);
keep(scytheShaftGeo, scytheBladeGeo, scytheEdgeGeo, scytheTipGeo, skullGeo, jawGeo, eyeSocketGeo, eyeGlowGeo, ribGeo, crownBandGeo, crownSpikeGeo, pauldronGeo);

function scytheGroup() {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(scytheShaftGeo, stdMat({ color: 0x2a242c, roughness: 0.75, metalness: 0.25 }));
  shaft.position.y = 0.45;
  const blade = new THREE.Mesh(scytheBladeGeo, stdMat({ color: 0xd8cdb0, roughness: 0.55, metalness: 0.2 }));
  blade.position.set(0.24, 1.1, 0);
  blade.rotation.z = -0.22;
  const edge = new THREE.Mesh(scytheEdgeGeo, new THREE.MeshBasicMaterial({ color: 0x6effb8, toneMapped: false }));
  edge.position.set(0.24, 1.03, 0);
  edge.rotation.z = -0.22;
  const tip = new THREE.Mesh(scytheTipGeo, stdMat({ color: 0xd8cdb0, roughness: 0.55 }));
  tip.position.set(0.52, 0.96, 0);
  tip.rotation.z = -2.1;
  g.add(shaft, blade, edge, tip);
  g.position.set(-0.22, -0.02, 0.12);
  g.rotation.set(Math.PI / 2, 0, 0);
  g.userData.back = 0.2;
  return g;
}

// Habille un FighterView (sur rig zombie) en Squelette ou en Souverain d'Os (crâne, yeux spectraux, côtes, couronne)
function dressSkeleton(v, boss = false) {
  const boneMat = stdMat({ color: 0xded4bc, roughness: 0.72, metalness: 0.08 });
  const darkMat = stdMat({ color: 0x16141a, roughness: 0.9 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x6effb8, toneMapped: false });
  const goldMat = stdMat({ color: 0xd9a441, roughness: 0.35, metalness: 0.75 });
  // teinte ivoire pâle sur tout le corps de base
  for (const m of v.mats) m.color.setRGB(1.38, 1.34, 1.18);
  const head = v.model.getObjectByName('head') || v.torso;
  if (head) {
    const sk = new THREE.Group();
    sk.position.set(0, head === v.torso ? 0.34 : 0.14, 0.01);
    const cranium = new THREE.Mesh(skullGeo, boneMat);
    const jaw = new THREE.Mesh(jawGeo, boneMat);
    jaw.position.set(0, -0.14, 0.03);
    sk.add(cranium, jaw);
    for (const s of [-1, 1]) {
      const sock = new THREE.Mesh(eyeSocketGeo, darkMat);
      sock.position.set(s * 0.065, 0.02, 0.125);
      const eye = new THREE.Mesh(eyeGlowGeo, eyeMat);
      eye.position.set(s * 0.065, 0.02, 0.145);
      sk.add(sock, eye);
    }
    if (boss) {
      const band = new THREE.Mesh(crownBandGeo, goldMat);
      band.position.y = 0.145;
      sk.add(band);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * TAU;
        const sp = new THREE.Mesh(crownSpikeGeo, goldMat);
        sp.position.set(Math.sin(a) * 0.15, 0.21, Math.cos(a) * 0.15);
        sk.add(sp);
      }
    }
    head.add(sk);
  }
  if (v.torso) {
    for (let k = 0; k < 3; k++) {
      const rib = new THREE.Mesh(ribGeo, boneMat);
      rib.position.set(0, 0.05 + k * 0.075, 0.02);
      v.torso.add(rib);
    }
    if (boss) {
      const armorMat = stdMat({ color: 0x26222c, roughness: 0.45, metalness: 0.65 });
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(pauldronGeo, armorMat);
        p.position.set(s * 0.24, 0.25, 0);
        p.rotation.z = -s * 0.35;
        v.torso.add(p);
      }
    }
  }
  v.glowCol.setRGB(0.22, 1.0, 0.58);
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
  v.sword = wpn === 'scythe' ? scytheGroup()
    : wpn === 'spear' ? heldWeapon('spear', 1.45, 0.3) : wpn === 'staff' ? heldWeapon('staff', 1.0, 0.08)
    : wpn === 'axe' || wpn === 'hammer' ? heldWeapon(wpn, 0.9) : heldWeapon('sword', 0.9);
  v.armR.add(v.sword);
  v.swordQ = v.sword.quaternion.clone();     // tenue de repos (dans le repère du bras)
  v.swordP = v.sword.position.clone();
  if (wpn === 'hammer' || wpn === 'staff' || wpn === 'scythe') { v.shield = new THREE.Group(); v.armL.add(v.shield); }   // pas de bouclier
  if (wpn === 'staff') v.orb = glowOrb(v.sword);
  if (wpn === 'hammer' || wpn === 'staff' || wpn === 'scythe') return;
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
    this.runeMats = collectMats(this.rune);
    this.orbMats = collectMats(this.orb);
    this.shieldMats = [];
    // (les pièces lumineuses, comme la rune du grimoire, n'ont pas de couleur émissive : on les laisse)
    this.shield.traverse((o) => { if (o.isMesh && o.material.emissive) { o.material = o.material.clone(); this.shieldMats.push(o.material); } });

    this.ring = new THREE.Mesh(ringFoot, new THREE.MeshBasicMaterial({ color: idx ? 0x4aa3ff : 0xff5a4a, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false }));
    scene.add(this.ring);
    // ombre douce au sol quand les ombres dynamiques sont coupées (qualité Bas)
    this.blob = new THREE.Mesh(shadowDiscGeo, shadowDiscMat);
    this.blob.visible = !gfx.shadows;
    scene.add(this.blob);
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
    this.flash = 0; this.shieldGlow = 0; this.bw = 0; this.flinch = 0; this.vyaw = 0; this.downK = 0; this.stoneK = 0; this.stoneOn = false;
    this.emissiveOn = false; this.shieldOn = false; this.sizeK = 1;
    this.model.rotation.order = 'YXZ';     // à terre : penché vers l'avant dans sa propre direction
    this.seenReset = -1; this.seenAnimN = -1; this.seenAnim = ''; this.seenAnimTs = 0;
    this.px = this.py = this.pz = 0;       // position à l'image de simulation précédente (interpolation)
    this.rx = this.ry = this.rz = 0;       // position affichée
    this.snapPos = true;
  }
  // retire la vue et libère ce qui lui est propre (matériaux clonés, squelette, barre de vie, anneau)
  dispose() {
    scene.remove(this.root, this.ring, this.blob);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    disposeTree(this.root); disposeTree(this.ring);
  }
  setSize(k) { this.sizeK = k; this.root.scale.setScalar(k); this.ring.scale.setScalar(k); this.blob.scale.setScalar(k); }
  // petite barre de vie au-dessus de la tête (ennemis du donjon) : géométrie et fond partagés
  addHpBar(color) {
    const g = new THREE.Group();
    g.position.y = 2.05;
    const bg = new THREE.Mesh(hpBgGeo, hpBgMat);
    bg.scale.set(0.82, 0.11, 1);
    bg.position.set(-0.41, 0, 0);
    bg.renderOrder = 10;
    g.add(bg);
    const fill = new THREE.Mesh(hpBgGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false, toneMapped: false }));
    fill.scale.set(0.76, 0.06, 1);
    fill.position.set(-0.38, 0, 0.001);
    fill.renderOrder = 10;
    g.add(fill);
    this.hpFill = fill;
    this.hpBar = g;
    this.root.add(g);
  }

  // jauge de réanimation au-dessus d'un héros à terre (créée au premier besoin)
  revive(sf) {
    if (!sf.down && !this.revBar) return;
    if (!this.revBar) {
      const g = new THREE.Group();
      g.position.y = 1.55;
      const bg = new THREE.Mesh(hpBgGeo, hpBgMat);
      bg.scale.set(0.9, 0.13, 1);
      bg.position.set(-0.45, 0, 0);
      bg.renderOrder = 10;
      g.add(bg);
      const fill = new THREE.Mesh(hpBgGeo, new THREE.MeshBasicMaterial({ color: 0x8fe36a, transparent: true, opacity: 1, depthTest: false, toneMapped: false }));
      fill.scale.set(0.84, 0.08, 1);
      fill.position.set(-0.42, 0, 0.001);
      fill.renderOrder = 10;
      g.add(fill);
      this.revFill = fill;
      this.revBar = g;
      this.root.add(g);
    }
    this.revBar.visible = !!sf.down;
    if (!sf.down) return;
    this.revBar.quaternion.copy(camera.quaternion);
    this.revFill.scale.x = 0.84 * Math.max(0.001, sf.revT / REVIVE.time);
    this.revFill.material.opacity = sf.revT > 0 ? 1 : 0.35 + 0.25 * Math.sin(clockT * 5);
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
    if (sf.resetN !== this.seenReset) { this.seenReset = sf.resetN; this.applyReset(sf); this.seenAnimN = -1; }
    if (sf.animN !== this.seenAnimN || sf.anim !== this.seenAnim || sf.animTs !== this.seenAnimTs) {
      this.seenAnimN = sf.animN; this.seenAnim = sf.anim; this.seenAnimTs = sf.animTs;
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
      for (const m of this.runeMats) m.color.copy(runeColor).multiplyScalar(c);
      if (sf.state === 'shoot' && sf.stateT < CAST.rel && Math.random() < 0.5) {
        this.rune.getWorldPosition(v1);
        emit(v1.x, v1.y, v1.z, 1, { color: [0xb98aff, 0xffffff], speed: 0.6, up: 1.2, size: 0.05, life: 0.5, grav: -1 });
      }
    }
    if (this.orb) {
      const c = sf.state === 'shoot' ? (sf.stateT < FIRE.rel ? 1 + 2.2 * sf.stateT / FIRE.rel : 1.2) : 0.85 + 0.15 * Math.sin(T * 4);
      for (const m of this.orbMats) m.color.copy(orbColor).multiplyScalar(c);
      this.orb.scale.setScalar(sf.state === 'shoot' && sf.stateT < FIRE.rel ? 1 + 0.5 * sf.stateT / FIRE.rel : 1);
    }
    if (this.hpBar) {
      this.hpBar.visible = sf.state !== 'dead';
      if (this.hpBar.visible) {
        this.hpBar.quaternion.copy(camera.quaternion);
        this.hpFill.scale.x = 0.76 * Math.max(0.001, sf.hp / sf.maxHp);
      }
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
    const spDef = st === 'spell' ? spellOf(sf) : null;
    this.model.rotation.y = spDef?.id === 'spin' ? this.vyaw + sf.stateT * TAU * 3.6 : this.vyaw;
    this.model.rotation.z = st === 'stun' ? Math.sin(T * 7) * 0.1 : 0;
    // à terre (à deux) : penché en avant, à quatre pattes, en attendant d'être relevé
    this.downK += ((sf.down ? 1 : 0) - this.downK) * Math.min(1, dt * 8);
    this.model.rotation.x = this.downK * (0.95 + 0.04 * Math.sin(T * 3)) + (spDef?.id === 'dash' ? 0.32 : 0);
    this.model.position.y = -0.65 - this.downK * 0.12;
    this.revive(sf);
    if (spDef) {
      if (spDef.id === 'overload') { this.flashCol.setRGB(0.45, 0.8, 1); this.flash = Math.max(this.flash, 0.4 + 0.35 * Math.sin(T * 40)); }
      else if (spDef.id === 'nova') { this.flashCol.setRGB(0.45, 0.95, 0.35); this.flash = Math.max(this.flash, 0.35 + 0.25 * Math.sin(T * 30)); }
      else if (spDef.id === 'slam') { this.flashCol.setRGB(1, 0.55, 0.15); this.flash = Math.max(this.flash, 0.35); }
      else if (spDef.id === 'spin' || spDef.id === 'dash') { this.flashCol.setRGB(1, 0.85, 0.3); this.flash = Math.max(this.flash, 0.28); }
    }
    if (sf.spellBuffT > 0) this.shieldGlow = Math.max(this.shieldGlow, 0.85 + 0.25 * Math.sin(T * 10));
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
    const sg = this.stGlow || 0;          // états (brûlure, gel…) : posé par statusPre
    // Peau de pierre : couleurs ternies et grisées (fondu à l'entrée et à la sortie)
    this.stoneK += ((sf.stoneT > 0 ? 1 : 0) - this.stoneK) * Math.min(1, dt * 6);
    const sk = this.stoneK > 0.01 ? this.stoneK : 0;
    if (sk > 0 || this.stoneOn) {
      this.stoneOn = sk > 0;
      for (const m of this.mats) { if (!m.userData.c0) m.userData.c0 = m.color.clone(); m.color.copy(m.userData.c0).multiplyScalar(1 - 0.6 * sk); }
    }
    const emOn = this.flash > 0 || this.glow > 0 || sg > 0 || sk > 0;
    if (emOn || this.emissiveOn) {
      this.emissiveOn = emOn;
      for (const m of this.mats) {
        m.emissive.copy(this.flashCol).multiplyScalar(this.flash);
        if (this.glow > 0) { m.emissive.r += this.glowCol.r * this.glow; m.emissive.g += this.glowCol.g * this.glow; m.emissive.b += this.glowCol.b * this.glow; }
        if (sg > 0) { m.emissive.r += this.stCol.r * sg; m.emissive.g += this.stCol.g * sg; m.emissive.b += this.stCol.b * sg; }
        if (sk > 0) { m.emissive.r += 0.3 * sk; m.emissive.g += 0.29 * sk; m.emissive.b += 0.27 * sk; }
      }
    }
    this.shieldGlow = Math.max(0, this.shieldGlow - dt * 3);
    const bg = st === 'block' ? 0.12 : 0;
    const shOn = this.shieldGlow > 0 || bg > 0;
    if (shOn || this.shieldOn) {
      this.shieldOn = shOn;
      for (const m of this.shieldMats) m.emissive.setRGB(0.5 * this.shieldGlow + bg * 0.4, 0.8 * this.shieldGlow + bg * 0.7, this.shieldGlow + bg);
    }

    if (this.stars.visible) this.stars.rotation.y = T * 5;
    const gy = sim.groundY(sf);
    this.ring.position.set(this.rx, gy + 0.03, this.rz);
    this.ring.material.opacity = sf.down ? 0.45 + 0.3 * Math.sin(T * 6) : st === 'dead' ? 0 : 0.75 - Math.min(0.5, (this.ry - gy) * 0.25);
    this.blob.visible = !gfx.shadows && st !== 'dead';
    if (this.blob.visible) {
      this.blob.position.set(this.rx, gy + 0.02, this.rz);
      this.blob.scale.setScalar(this.sizeK * Math.max(0.45, 1 - (this.ry - gy) * 0.22));
    }
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
    this.gemMats = this.gems.flatMap(collectMats);
    this.ring = new THREE.Mesh(ringFoot, new THREE.MeshBasicMaterial({ color: 0xa070ff, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }));
    scene.add(this.ring);
    this.blob = new THREE.Mesh(shadowDiscGeo, shadowDiscMat);
    this.blob.visible = !gfx.shadows;
    scene.add(this.blob);
    this.flash = 0; this.flinch = 0; this.vyaw = 0; this.phase = 0; this.spawn = 0; this.deadT = 0;
    this.emissiveOn = false; this.sizeK = 1;
    this.flashCol = new THREE.Color(1, 1, 1);
    this.px = this.py = this.pz = 0; this.rx = this.ry = this.rz = 0;
    this.snapPos = true; this.seenReset = -1;
  }
  dispose() { scene.remove(this.root, this.ring, this.blob); disposeTree(this.root); disposeTree(this.ring); }
  setSize(k) { this.sizeK = k; this.root.scale.setScalar(k); this.ring.scale.setScalar(k); this.blob.scale.setScalar(k); }
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
    const sg = this.stGlow || 0;          // états (brûlure, gel…) : posé par statusPre
    const emOn = this.flash > 0 || sg > 0;
    if (emOn || this.emissiveOn) {
      this.emissiveOn = emOn;
      for (const m of this.mats) {
        if (!m.emissive) continue;
        m.emissive.copy(this.flashCol).multiplyScalar(this.flash);
        if (sg > 0) { m.emissive.r += this.stCol.r * sg; m.emissive.g += this.stCol.g * sg; m.emissive.b += this.stCol.b * sg; }
      }
    }
    if (this.fireG) {
      const on = spc === 'fire' && sf.spA === 1;
      this.fireK = on ? Math.min(1, this.fireK + dt * 7) : Math.max(0, this.fireK - dt * 5);
      this.fireG.visible = this.fireK > 0.01;
      if (this.fireG.visible) {
        this.fireG.rotation.y = this.vyaw;
        for (let k = 0; k < this.jets.length; k++) {
          const f = 1 + 0.12 * Math.sin(T * 40 + k * 2.3);
          this.jets[k].scale.set(f, f, this.fireK * (0.9 + 0.1 * Math.sin(T * 23 + k)) * BOSS.fire.R / FOES.cerbere.size);
        }
      }
    }
    // les yeux de Cerbère flambent quand il prépare une attaque ou qu'il est enragé
    const hot = (spc && sf.spA === 0) || (st === 'attack' && t < W) ? 2.2 + Math.sin(T * 28) : sf.rage ? 1.6 : 0;
    const gemScale = 1 + hot + 0.6 * Math.sin(T * 5);
    for (const m of this.gemMats) m.color.copy(this.glowCol).multiplyScalar(gemScale);
    if (this.hpBar) {
      this.hpBar.visible = st !== 'dead';
      if (this.hpBar.visible) {
        this.hpBar.quaternion.copy(camera.quaternion);
        this.hpFill.scale.x = 0.76 * Math.max(0.001, sf.hp / sf.maxHp);
      }
    }
    const gy = sim.groundY(sf);
    this.ring.position.set(this.rx, gy + 0.03, this.rz);
    this.ring.material.opacity = st === 'dead' ? 0 : 0.6;
    this.blob.visible = !gfx.shadows && st !== 'dead';
    if (this.blob.visible) {
      this.blob.position.set(this.rx, gy + 0.02, this.rz);
      this.blob.scale.setScalar(this.sizeK * Math.max(0.45, 1 - (this.ry - gy) * 0.22));
    }
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
const boneOrbCoreMat = new THREE.MeshBasicMaterial({ color: 0xeafff4, toneMapped: false });
const boneOrbHaloMat = new THREE.MeshBasicMaterial({ color: 0x3aff9e, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
keep(fbCore, fbHalo, fbCoreMat, fbHaloMat, boneOrbCoreMat, boneOrbHaloMat);
const boneViews = [];
function boneOrbView() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(fbCore, boneOrbCoreMat), new THREE.Mesh(fbHalo, boneOrbHaloMat));
  g.scale.setScalar(1.15);
  scene.add(g);
  return g;
}
const NONE = [], arrowList = [], fireList = [], bladeList = [], boneList = [], bladeViews = [];
function syncArrows(alpha) {
  const all = game.phase === 'menu' ? NONE : sim.pr;
  arrowList.length = fireList.length = bladeList.length = boneList.length = 0;
  for (let i = 0; i < all.length; i++) { const a = all[i]; (a.k === 1 ? fireList : a.k === 2 ? bladeList : a.k === 3 ? boneList : arrowList).push(a); }
  while (boneViews.length < boneList.length) boneViews.push(boneOrbView());
  for (let i = 0; i < boneViews.length; i++) {
    const o = boneViews[i], a = boneList[i];
    o.visible = !!a;
    if (!a) continue;
    o.position.set(a.x + a.vx * DT * (alpha - 1), a.y + a.vy * DT * (alpha - 1), a.z + a.vz * DT * (alpha - 1));
    o.rotation.set(clockT * 8, clockT * 6, 0);
    o.children[1].scale.setScalar(1 + 0.18 * Math.sin(clockT * 26 + i));
    if ((arrowTrail = (arrowTrail + 1) % 2) === 0) emit(o.position.x, o.position.y, o.position.z, 1, { color: [0x6effb8, 0xd8cdb0, 0xffffff], speed: 0.25, up: 0.3, size: 0.065, life: 0.35, grav: -0.6 });
  }
  // lames spectrales (objets) : forme partagée, en additif
  while (bladeViews.length < bladeList.length) { const m = new THREE.Mesh(bladeGeo, bladeMat); m.scale.setScalar(1.5); scene.add(m); bladeViews.push(m); }
  for (let i = 0; i < bladeViews.length; i++) {
    const o = bladeViews[i], a = bladeList[i];
    o.visible = !!a;
    if (!a) continue;
    o.position.set(a.x + a.vx * DT * (alpha - 1), a.y + a.vy * DT * (alpha - 1), a.z + a.vz * DT * (alpha - 1));
    o.lookAt(vA.set(o.position.x + a.vx, o.position.y + a.vy, o.position.z + a.vz));
    if ((arrowTrail = (arrowTrail + 1) % 2) === 0) emit(o.position.x, o.position.y, o.position.z, 1, { color: [0xcfeaff, 0xffffff], speed: 0.1, up: 0.1, size: 0.05, life: 0.3, grav: 0 });
  }
  const list = arrowList, fire = fireList;
  while (fireViews.length < fire.length) fireViews.push(fireballView());
  for (let i = 0; i < fireViews.length; i++) {
    const o = fireViews[i], a = fire[i];
    o.visible = !!a;
    if (!a) continue;
    o.position.set(a.x + a.vx * DT * (alpha - 1), a.y + a.vy * DT * (alpha - 1), a.z + a.vz * DT * (alpha - 1));
    o.rotation.set(clockT * 7, clockT * 5, 0);
    o.children[1].scale.setScalar(1 + 0.15 * Math.sin(clockT * 30 + i));
    emit(o.position.x, o.position.y, o.position.z, 2, { color: [0xffe27a, 0xff9a2e, 0xff4a1c], speed: 0.4, up: 0.6, size: 0.07, life: 0.35, grav: -1.5 });
  }
  while (arrowViews.length < list.length) { const o = inst('arrow', 1.25, false); scene.add(o); arrowViews.push(o); }
  for (let i = 0; i < arrowViews.length; i++) {
    const o = arrowViews[i], a = list[i];
    o.visible = !!a;
    if (!a) continue;
    // position interpolée entre deux images de simulation, pointe dans le sens du vol
    o.position.set(a.x + a.vx * DT * (alpha - 1), a.y + a.vy * DT * (alpha - 1), a.z + a.vz * DT * (alpha - 1));
    o.lookAt(vA.set(o.position.x + a.vx, o.position.y + a.vy, o.position.z + a.vz));
    // traînée légère derrière la flèche
    if ((arrowTrail = (arrowTrail + 1) % 2) === 0) emit(o.position.x, o.position.y, o.position.z, 1, { color: [0xfff3d0, 0xffffff], speed: 0.1, up: 0.1, size: 0.035, life: 0.25, grav: 0 });
  }
}

// =====================================================================
//  Objets (items.js) : piédestaux, états des combattants, lames, éclairs. Tout est déduit de l'état
//  de la simulation (sim.pk, champs des combattants) ou de ses événements ('item', 'tf', 'combo', 'bolt').
// =====================================================================
const pedGeo = new THREE.CylinderGeometry(0.27, 0.35, 0.6, 8).translate(0, 0.3, 0);
const pedTopGeo = new THREE.CylinderGeometry(0.4, 0.33, 0.1, 8).translate(0, 0.65, 0);
const gemGeo = new THREE.OctahedronGeometry(0.16, 0);
const shardGeo = new THREE.OctahedronGeometry(0.09, 0).scale(0.7, 1.7, 0.7);
const haloGeo = new THREE.RingGeometry(0.44, 0.58, 32).rotateX(-Math.PI / 2);
const auraGeo = new THREE.RingGeometry(0.93, 1, 48).rotateX(-Math.PI / 2);
const bladeGeo = new THREE.OctahedronGeometry(0.1, 0).scale(0.55, 0.22, 3.4);     // lame spectrale, pointe vers +z
const pedMat = new THREE.MeshStandardMaterial({ color: 0xa39a8a, roughness: 0.85 });
const gemMats = QUALITY.map((q) => new THREE.MeshBasicMaterial({ color: q.hex, toneMapped: false }));
const haloMats = QUALITY.map((q) => new THREE.MeshBasicMaterial({ color: q.hex, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
const shardMat = new THREE.MeshBasicMaterial({ color: 0x8fe8ff, toneMapped: false });
const bladeMat = new THREE.MeshBasicMaterial({ color: 0xcfeaff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
keep(pedGeo, pedTopGeo, gemGeo, shardGeo, haloGeo, auraGeo, bladeGeo, pedMat, gemMats, haloMats, shardMat, bladeMat);

// icônes (émojis) dessinées une fois chacune, partagées entre les salles
const emojiMats = new Map();
function emojiMat(ch) {
  let m = emojiMats.get(ch);
  if (m) return m;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = '92px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  x.shadowColor = 'rgba(0,0,0,0.7)'; x.shadowBlur = 8;
  x.fillText(ch, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false });
  keep(m, t);
  emojiMats.set(ch, m);
  return m;
}

// ---------- objets à ramasser : une vue par objet de sim.pk (clé : son numéro n) ----------
function pkView(o) {
  const g = new THREE.Group();
  g.position.set(o.x, 0, o.z);
  const v = { g, spin: null, icon: null, base: 0, ph: rand(0, TAU), grow: 0, seen: 0, q: o.q, t: o.t, x: o.x, z: o.z, sparkT: 0 };
  const icon = (ch, s, y) => { v.icon = new THREE.Sprite(emojiMat(ch)); v.icon.scale.setScalar(s); v.icon.position.y = v.base = y; g.add(v.icon); };
  if (o.t === 'item') {
    for (const geo of [pedGeo, pedTopGeo]) { const m = new THREE.Mesh(geo, pedMat); m.castShadow = gfx.shadows; m.receiveShadow = true; g.add(m); }
    const h = new THREE.Mesh(haloGeo, haloMats[o.q] ?? haloMats[0]);
    h.position.y = 0.02; h.renderOrder = 2;
    g.add(h);
    v.spin = new THREE.Mesh(gemGeo, gemMats[o.q] ?? gemMats[0]);
    v.spin.position.y = 0.9;
    g.add(v.spin);
    icon(itemOf(o.v)?.icon ?? '✨', 0.62, 1.42);
  } else if (o.t === 'heart') icon('❤️', 0.5, 0.48);
  else {
    v.spin = new THREE.Mesh(shardGeo, shardMat);
    v.spin.position.y = 0.42;
    g.add(v.spin);
    icon(MINORS[o.v]?.icon ?? '✨', 0.36, 0.9);
  }
  g.scale.setScalar(0.01);
  world.add(g);
  return v;
}
let pkStamp = 0;
function pkSync(dt, T) {
  const st = ++pkStamp;
  let best = null;
  for (const o of sim.pk ?? NONE) {
    let v = dng.pk.get(o.n);
    if (!v) { v = pkView(o); dng.pk.set(o.n, v); }
    v.seen = st;
    if (o.t === 'item' && (!best || o.q > best.q)) best = o;
  }
  for (const [n, v] of dng.pk) {
    if (v.seen !== st) { world.remove(v.g); dng.pk.delete(n); continue; }   // formes et matériaux partagés : rien à libérer
    if (v.grow < 1) {
      v.grow = Math.min(1, v.grow + dt * 3.5);
      v.g.scale.setScalar(Math.max(0.01, Math.sin(v.grow * Math.PI / 2) * (1 + 0.2 * Math.sin(v.grow * Math.PI))));
    }
    if (v.spin) v.spin.rotation.y = T * 1.6 + v.ph;
    if (v.icon) v.icon.position.y = v.base + Math.sin(T * 2.2 + v.ph) * 0.06;
    // les objets épiques et légendaires scintillent
    if (v.t === 'item' && v.q >= 2 && gfx.fireEmbers && (v.sparkT -= dt) < 0) {
      v.sparkT = v.q === 3 ? 0.08 : 0.18;
      emit(v.x + rand(-0.3, 0.3), 0.9 + rand(0, 0.6), v.z + rand(-0.3, 0.3), 1, { color: [QUALITY[v.q].hex, 0xffffff], speed: 0.3, up: 1, size: 0.05, life: 0.8, grav: -0.5 });
    }
  }
  const l = dng.glow?.light;
  if (!l) return;
  if (best) { l.color.setHex(QUALITY[best.q].hex); l.position.set(best.x, 1.4, best.z); l.intensity = 3 + Math.sin(T * 3) * 0.6; }
  else if (l.intensity) { l.intensity = 0; l.position.y = -50; }
}

// ---------- fiche de l'objet le plus proche d'un héros local ----------
let cardKey = '';
function itemCard() {
  let best = null, who = null, bd = 2.3;
  for (const h of localHeroes()) {
    const p = sim.f[h];
    if (!p || p.state === 'dead') continue;
    for (const o of sim.pk ?? NONE) {
      if (o.t === 'heart') continue;
      const d = Math.hypot(p.x - o.x, p.z - o.z) / Math.max(1, p.size ?? 1);
      if (d < bd) { bd = d; best = o; who = p; }
    }
  }
  const key = best ? `${best.n}:${who.idx}:${who.items}:${who.took}` : '';
  if (key === cardKey) return;
  cardKey = key;
  const el = $('itemCard');
  if (!best) { el.classList.add('hidden'); return; }
  const duo = localHeroes().length > 1, me = duo ? `J${who.idx + 1} : ` : '';
  const took = who.took & (best.t === 'item' ? 1 : 2);
  if (best.t === 'item') {
    const it = itemOf(best.v), q = QUALITY[it.q];
    el.style.setProperty('--qc', q.col);
    $('icIcon').textContent = it.icon;
    $('icName').textContent = it.name;
    $('icQual').innerHTML = esc(q.name.toUpperCase()) + (it.curse ? '<span class="curse">☠ MAUDIT</span>' : '');
    $('icDesc').textContent = it.desc;
    let fam = '';
    if (it.fam) {
      const F = FAMILIES[it.fam], n = itemList(who).filter((k) => ITEMS[k]?.fam === it.fam).length;
      fam = `${F.icon} Famille ${esc(F.name)} : ${n} / ${TF_N}`;
      if (!hasTf(who, it.fam) && n + 1 >= TF_N) fam += ` → <b>${esc(F.tf)} !</b>`;
    }
    for (const c of Object.values(COMBOS)) {
      const other = c.a === best.v ? c.b : c.b === best.v ? c.a : '';
      if (other && has(who, other)) fam += `${fam ? '<br>' : ''}<span class="syn">✦ Réagit avec ${esc(ITEMS[other].name)}…</span>`;
    }
    $('icFam').innerHTML = fam;
  } else {
    const m = MINORS[best.v];
    el.style.setProperty('--qc', '#8fe8ff');
    $('icIcon').textContent = m?.icon ?? '✨';
    $('icName').textContent = m?.name ?? '';
    $('icQual').textContent = 'PETIT BONUS';
    $('icDesc').textContent = m?.desc ?? '';
    $('icFam').innerHTML = '';
  }
  $('icTake').textContent = took ? `${me}tu as déjà pris le tien ici` : best.arm ? `${me}marche dessus pour le prendre` : `${me}éloigne-toi puis reviens pour le prendre`;
  el.classList.remove('hidden');
}

// ---------- annonces : objet pris, transformation, combo (à la file) ----------
const bannerQ = [];
let bannerT = 0;
function itemBanner(title, sub, col, prio) {
  bannerQ.push({ title, sub, col, prio });
  bannerQ.sort((a, b) => b.prio - a.prio);
  if (bannerQ.length > 3) bannerQ.length = 3;      // beaucoup d'objets d'un coup : seulement les plus marquants
}
function bannerTick() {
  if (clockT < bannerT || !bannerQ.length) return;
  const b = bannerQ.shift(), el = $('itemBanner');
  el.style.setProperty('--qc', b.col);
  $('ibTitle').textContent = b.title;
  $('ibSub').textContent = b.sub;
  el.className = '';
  void el.offsetWidth;
  el.className = 'show';
  bannerT = clockT + 2.3;
}
function heroTag(i) { return sim.g.np > 1 ? `J${i + 1} · ` : ''; }
function onItemEvent(e) {
  if (e[0] === 'item') {
    const it = itemOf(e[2]);
    if (it) itemBanner(heroTag(e[1]) + it.icon + ' ' + it.name, it.desc, QUALITY[it.q].col, it.q);
  } else if (e[0] === 'tf') {
    const F = FAMILIES[e[2]];
    if (F) itemBanner(heroTag(e[1]) + F.icon + ' ' + F.tf.toUpperCase(), F.desc, '#ffe27a', 10);
  } else if (e[0] === 'combo') {
    const c = COMBOS[e[2]];
    if (c) itemBanner(heroTag(e[1]) + '✦ ' + c.name + ' ✦', c.desc, '#ff8ae8', 8);
  }
}

// ---------- éclairs (événements 'bolt') : petite réserve de lignes brisées ----------
const BOLT_PTS = 9;
const bolts = Array.from({ length: 10 }, () => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOLT_PTS * 3), 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, toneMapped: false, depthWrite: false }));
  line.frustumCulled = false; line.visible = false; line.renderOrder = 3;
  scene.add(line);
  return { line, t: 0, a: [0, 0, 0], b: [0, 0, 0] };
});
let boltI = 0;
function boltShape(b) {
  const p = b.line.geometry.attributes.position.array, [x1, y1, z1] = b.a, [x2, y2, z2] = b.b;
  for (let i = 0; i < BOLT_PTS; i++) {
    const k = i / (BOLT_PTS - 1), j = i === 0 || i === BOLT_PTS - 1 ? 0 : 0.28;
    p[i * 3] = x1 + (x2 - x1) * k + rand(-j, j);
    p[i * 3 + 1] = y1 + (y2 - y1) * k + rand(-j, j) * 0.6;
    p[i * 3 + 2] = z1 + (z2 - z1) * k + rand(-j, j);
  }
  b.line.geometry.attributes.position.needsUpdate = true;
}
function bolt(x1, y1, z1, x2, y2, z2, col = 0x9fd8ff) {
  const b = bolts[boltI++ % bolts.length];
  b.a[0] = x1; b.a[1] = y1; b.a[2] = z1; b.b[0] = x2; b.b[1] = y2; b.b[2] = z2;
  b.t = 0.24;
  b.line.material.color.setHex(col);
  b.line.visible = true;
  boltShape(b);
  emit(x2, y2, z2, 6, { color: [col, 0xffffff], speed: 2.5, up: 1.5, size: 0.05, life: 0.3, grav: 3 });
}
function updateBolts(dt) {
  for (const b of bolts) {
    if (!b.line.visible) continue;
    b.t -= dt;
    if (b.t <= 0) { b.line.visible = false; continue; }
    b.line.material.opacity = Math.min(1, b.t / 0.12);
    if (Math.random() < 0.5) boltShape(b);      // l'éclair crépite
  }
}

// ---------- états des combattants (brûlure, poison, froid, gel, discorde), taille, auras, lames ----------
const ST_COL = {
  frz: new THREE.Color(0.5, 0.85, 1), burn: new THREE.Color(1, 0.4, 0.05), psn: new THREE.Color(0.3, 0.9, 0.2),
  chill: new THREE.Color(0.4, 0.7, 1), conf: new THREE.Color(1, 0.35, 0.9),
};
const FAM_FX = {
  feu: [0xff9a2e, 0xffe27a], peste: [0x7ae85a, 0xb8ff9a], foudre: [0x9fd8ff, 0xffffff], givre: [0xbff0ff, 0xffffff],
  sang: [0xe0303a, 0xff8080], meute: [0xb98aff, 0xe0d0ff], vent: [0xe8f4ff, 0xffffff], rempart: [0xffe066, 0xfff4c0],
  fortune: [0x7aff9a, 0xffe27a],
};
const AURA_FAM = [['feu', 0xff7a2e], ['peste', 0x7ae85a], ['givre', 0x8fe0ff]];
// vitesse de l'animation d'un combattant : le froid le ralentit, le gel le fige, la vitesse d'attaque accélère les coups
function animK(sf) {
  if (sf.sFrz > 0) return 0;
  let k = sf.sChill > 0 ? FX.chill.slow : 1;
  if (sf.stoneT > 0 && (sf.state === 'walk' || sf.state === 'block')) k *= SPELLS.stone.slow;   // Peau de pierre : seule la marche est ralentie dans la sim
  if (sim.aspdOf && sf.idx < sim.g.np && (sf.state === 'attack' || sf.state === 'shoot')) k *= sim.aspdOf(sf);
  return k;
}
// avant le rendu de la vue : lueur et particules des états, taille
function statusPre(v, sf, dt, T) {
  const s = sf.size ?? 1;
  if (Math.abs(s - v.sizeK) > 0.002) v.setSize(v.sizeK + (s - v.sizeK) * Math.min(1, dt * 6));
  let col = null, gl = 0;
  if (sf.state !== 'dead') {
    if (sf.sFrz > 0) { col = ST_COL.frz; gl = 0.55; }
    else if (sf.sConf > 0) { col = ST_COL.conf; gl = 0.25 + 0.12 * Math.sin(T * 9); }
    else if (sf.sBurnT > 0) { col = ST_COL.burn; gl = 0.28 + 0.12 * Math.sin(T * 14); }
    else if (sf.sPsn > 0) { col = ST_COL.psn; gl = 0.22 + 0.06 * Math.sin(T * 5); }
    else if (sf.sChill > 0) { col = ST_COL.chill; gl = 0.22; }
  }
  v.stGlow = gl;
  if (col) v.stCol = col;
  if (sf.state === 'dead' || !gfx.fireEmbers) return;
  v.stT = (v.stT ?? 0) - dt;
  if (v.stT > 0) return;
  v.stT = 0.09;
  const px = v.rx + rand(-0.3, 0.3) * s, pz = v.rz + rand(-0.3, 0.3) * s;
  if (sf.sBurnT > 0) emit(px, v.ry + rand(0.3, 1.3) * s, pz, 1, { color: [0xff9a2e, 0xffe27a, 0xff4a1c], speed: 0.3, up: 1.8, size: 0.07, life: 0.5, grav: -1.5 });
  if (sf.sPsn > 0 && Math.random() < 0.6) emit(px, v.ry + rand(0.5, 1.4) * s, pz, 1, { color: [0x7ae85a, 0xb8ff9a], speed: 0.15, up: 0.7, size: 0.06, life: 0.7, grav: -0.6 });
  if ((sf.sChill > 0 || sf.sFrz > 0) && Math.random() < 0.5) emit(px, v.ry + rand(0.6, 1.6) * s, pz, 1, { color: [0xdff8ff, 0xffffff], speed: 0.2, up: 0.2, size: 0.05, life: 0.8, grav: 1.2 });
  if (sf.sConf > 0 && Math.random() < 0.5) emit(v.rx + Math.sin(T * 6) * 0.35, v.ry + 2 * s, v.rz + Math.cos(T * 6) * 0.35, 1, { color: [0xff8ae8, 0xffd0f4], speed: 0.1, up: 0.3, size: 0.06, life: 0.5, grav: 0 });
  // héros transformé : particules aux couleurs de ses familles
  if (sf.tf && sf.idx < sim.g.np) {
    const fams = sf.tf.split(','), c = FAM_FX[fams[(Math.random() * fams.length) | 0]];
    if (c && Math.random() < 0.7) emit(px, v.ry + rand(0.2, 1.5) * s, pz, 1, { color: c, speed: 0.25, up: 0.9, size: 0.055, life: 0.7, grav: -0.8 });
  }
}
// après le rendu : ivresse, aura au sol, lames tournoyantes
function statusPost(v, sf, T, alpha) {
  if (sf.idx >= sim.g.np) return;
  const s = v.sizeK || 1, alive = sf.state !== 'dead';
  if (sf.drunk && alive && v.model) { v.model.rotation.z += Math.sin(T * 2.1) * 0.13; v.model.rotation.x += Math.sin(T * 1.3) * 0.06; }
  // aura (transformations feu, peste, givre) : cercle au sol de la portée de l'aura
  const af = alive && sf.tf ? AURA_FAM.find(([f]) => hasTf(sf, f)) : null;
  if (af && !v.aura) {
    v.aura = new THREE.Mesh(auraGeo, new THREE.MeshBasicMaterial({ color: af[1], transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false }));
    v.aura.renderOrder = 2;
    v.root.add(v.aura);
  }
  if (v.aura) {
    v.aura.visible = !!af;
    if (af) {
      v.aura.material.color.setHex(af[1]);
      v.aura.material.opacity = 0.3 + 0.12 * Math.sin(T * 3);
      v.aura.scale.setScalar(FX.aura.R / s);
      v.aura.position.y = 0.04 / s;
    }
  }
  // lames tournoyantes (Anneau de Gygès…) : même angle que la simulation (orbitTick)
  const n = alive ? sf.orbit | 0 : 0;
  if (!v.orbs && !n) return;
  v.orbs ??= [];
  while (v.orbs.length < n) { const m = new THREE.Mesh(bladeGeo, bladeMat); v.root.add(m); v.orbs.push(m); }
  const O = FX.orbit, base = (sim.g.clock + (alpha - 1) * DT) * O.speed + sf.idx * 1.3;
  for (let k = 0; k < v.orbs.length; k++) {
    const m = v.orbs[k];
    m.visible = k < n;
    if (!m.visible) continue;
    const a = base + (k * TAU) / n;
    m.position.set(Math.sin(a) * O.R / s, 1 / s, Math.cos(a) * O.R / s);
    m.rotation.set(0, a + Math.PI / 2, 0);
    m.scale.setScalar(1.6 / s);
  }
}

// ---------- salle au trésor : décor ----------
function vaultDecor() {
  for (const [x, z] of [[-5.6, -5.6], [5.6, -5.6], [-5.6, 5.6]]) {
    brazier(x, z, 'a_columnD', 1.1, 7, 6);
    for (let k = 0; k < 3; k++) PI('d_coin', x + rand(-0.9, 0.9) * Math.sign(-x || 1), 0, z + rand(0.4, 1.1) * Math.sign(-z || 1), rand(0, TAU), 1.3, 1.3, 1.3, false);
  }
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
  { l: ['KeyA', null], r: ['KeyD', null], u: ['KeyW', null], d: ['KeyS', null], jump: ['Space', null], atk: ['KeyF', null], blk: ['KeyG', null], par: ['KeyH', null], brk: ['KeyR', null], roll: ['KeyE', 'ShiftLeft'], spell: ['KeyQ', 'KeyC'] },
  { l: ['ArrowLeft', null], r: ['ArrowRight', null], u: ['ArrowUp', null], d: ['ArrowDown', null], jump: ['KeyO', 'Numpad0'], atk: ['KeyK', 'Numpad1'], blk: ['KeyL', 'Numpad2'], par: ['Semicolon', 'Numpad3'], brk: ['KeyI', 'Numpad4'], roll: ['KeyJ', 'Numpad5'], spell: ['KeyU', 'Numpad6'] },
];
const ACTIONS = [
  ['u', 'Haut (pas vers le fond)'], ['d', 'Bas (pas vers l\'avant)'], ['l', 'Gauche'], ['r', 'Droite'],
  ['jump', 'Sauter'], ['atk', 'Attaquer'], ['blk', 'Bloquer (maintenir)'], ['par', 'Parer'],
  ['brk', 'Briser la garde'], ['roll', 'Roulade'], ['spell', 'Sort spécial'],
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
      `<b>Se déplacer</b> ${move(a)} ou ${move(b)} · <b>Sauter</b> ${kb(key1(a, 'jump') ?? key1(b, 'jump'))} · <b>Roulade</b> ${one('roll')} · <b>Sort</b> ${kb(key1(a, 'spell') ?? key1(b, 'spell'))}`,
      `<b>Attaquer</b> ${one('atk')} · <b>Bloquer</b> ${one('blk')} (maintenir) · <b>Parer</b> ${one('par')} · <b>Briser la garde</b> ${one('brk')}`,
    ];
    if (!compact) rows.push(`<span>(ou ${['atk', 'blk', 'par', 'brk', 'roll', 'spell'].map((act) => kb(key1(a, act))).join(' ')} de la main gauche)</span>`);
    return rows.map((r) => `<div class="row">${r}</div>`).join('');
  }
  const p = (s, n) => `<b style="color:${n ? '#a8d4ff' : '#ffb3a8'}">J${n + 1}</b> ${['u', 'l', 'd', 'r'].map((act) => kb(key1(s, act))).join('')} saut ${kb(key1(s, 'jump'))} · att. ${kb(key1(s, 'atk'))} · bloc ${kb(key1(s, 'blk'))} · parer ${kb(key1(s, 'par'))} · briser ${kb(key1(s, 'brk'))} · roulade ${kb(key1(s, 'roll'))} · sort ${kb(key1(s, 'spell'))}`;
  return `<div class="row">${p(a, 0)}</div><div class="row">${p(b, 1)}</div>`;
}

addEventListener('keydown', (e) => {
  if (keysEditorKey(e)) return;
  if (e.code === 'Escape' && !$('guideOv').classList.contains('hidden')) { $('guideOv').classList.add('hidden'); return; }
  if (mapPreviewKey(e)) return;
  if (e.code === 'Escape' && !$('gfxSec').classList.contains('hidden')) { $('gfxSec').classList.add('hidden'); $('gfxToggleBtn')?.classList.remove('active'); return; }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (isDungeon() && sim.g.phase === 'event' && !$('eventOv').classList.contains('hidden')) {
    const k = choiceKey(e.code);
    if (k) { e.preventDefault(); pickEventChoice(k[0], k[1]); }
    if (e.code !== 'Escape') return;
  }
  if (isDungeon() && sim.g.phase === 'map' && !$('mapOv').classList.contains('hidden')) {
    const k = mapChoiceKey(e.code);
    if (k) { e.preventDefault(); pickMapChoice(k[0], k[1]); }
    if (e.code !== 'Escape') return;
  }
  if (mapPeek && (e.code === 'Escape' || e.code === 'KeyM')) {
    e.preventDefault();
    toggleMapPeek(false);
    return;
  }
  if (e.code === 'KeyM' && !e.repeat && canPeekMap()) {
    e.preventDefault();
    toggleMapPeek(true);
    return;
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
// Entrée d'un joueur pour la prochaine image de simulation (déplacement quantifié, identique chez les deux joueurs).
// consume = false permet de lire l'entrée sans effacer pending/tapped (utile si le rollback attend un paquet).
function readMoveInput(pl, consume = true) {
  const h = held[pl];
  for (const k of HELD) h[k] = false;
  if (!game.paused) for (const code of down) {
    const b = bindings.get(code);
    if (!b) continue;
    for (const [p, act] of b) if (p === pl && HELD.includes(act)) h[act] = true;
  }
  if (!game.paused) for (const act of tapped[pl]) h[act] = true;
  if (consume) tapped[pl].clear();
  const rx = Math.cos(camAng), rz = -Math.sin(camAng);   // droite de l'écran
  const fx = -Math.sin(camAng), fz = -Math.cos(camAng);  // vers le fond de l'écran
  const hh = (h.r ? 1 : 0) - (h.l ? 1 : 0), v = (h.u ? 1 : 0) - (h.d ? 1 : 0);
  let mx = rx * hh + fx * v, mz = rz * hh + fz * v;
  const n = Math.hypot(mx, mz);
  if (n > 1) { mx /= n; mz /= n; }
  const press = pending[pl];
  if (consume) pending[pl] = 0;
  return { mx: quant(mx), mz: quant(mz), blk: !!h.blk, press };
}
function localInput(pl, consume = true) {
  if (isDungeon() && sim.g.phase === 'map' && mapReq[pl] >= 0) { const n = mapReq[pl]; if (consume) { mapReq[pl] = -1; pending[pl] = 0; } return mapInput(n); }
  if (isDungeon() && sim.g.phase === 'event' && evtReq[pl] >= 0) { if (consume) pending[pl] = 0; return eventInput(evtReq[pl]); }
  if (isDungeon() && sim.g.phase === 'hub' && shopReq[pl] >= 0) { const n = shopReq[pl]; if (consume) { shopReq[pl] = -1; pending[pl] = 0; } return shopInput(n); }
  return readMoveInput(pl, consume);
}

// =====================================================================
//  Déroulement du match
// =====================================================================
let sim = new Sim(1);          // simulation du combat (remplacée à chaque match)
let rb = null;                 // rollback réseau (arène 1v1 en ligne)
let coop = null;               // moteur coop hôte-autoritaire (donjon à 2 en ligne, coop.js)
let sessionSeq = 0;
const nextSid = () => (((Date.now() & 0xfffff) * 1024) + (++sessionSeq & 1023)) >>> 0 || 1;
const isDungeon = (s = sim) => s instanceof DungeonSim || !!s?.isCoopGuest;
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
const cfg = { game: 'arena', mode: 'solo', diff: '1', p1: 'soldier', p2: 'orc', arena: 'colisee', gfx: gfxId };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('spartiate-cfg') || '{}')); } catch (e) { /* stockage indisponible */ }
cfg.gfx = gfxId;
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
  if (isDungeon()) return;
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
      case 'sfx': if (sfxOk(e[1])) sfx[e[1]]?.(...e.slice(2)); break;
      case 'emit': emit(e[1], e[2], e[3], e[4], e[5]); break;
      case 'ring': ring(e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]); break;
      case 'pop': pop(e[1], e[2], e[3], e[4], e[5]); break;
      case 'announce': announce(e[1], e[2], e[3]); break;
      case 'cheer': crowd?.cheer(e[1]); break;
      case 'fx': F[e[1]]?.fx(e[2]); break;
      case 'shake': game.shake = Math.max(game.shake, e[1]); break;
      case 'ko': arenaHooks.ko?.(); break;
      case 'item': case 'tf': case 'combo': onItemEvent(e); break;
      case 'bolt': bolt(e[1], e[2], e[3], e[4], e[5], e[6], e[7]); break;
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
  match = { ...m, game: 'arena' };
  net.live = m.mode === 'online';
  coop = null;
  ac();
  game.paused = false;
  ['menu', 'result', 'pause', 'itemCard', 'guideOv', 'gfxSec'].forEach((id) => $(id)?.classList.add('hidden'));
  $('gfxToggleBtn')?.classList.remove('active');
  $('hud').classList.remove('hidden', 'dng', 'solo');
  $('it1').innerHTML = $('it2').innerHTML = '';
  uiItems[0] = uiItems[1] = null;
  $('resItems').innerHTML = '';
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
    sid: m.sid || 0,
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
  $('result').classList.toggle('lose', match.mode !== 'duo' && game.wins[me] < game.wins[1 - me]);
  $('resSub').textContent = `${n1}  ${a} – ${b}  ${n2}  ·  ${ARENAS[match.arena].name}` + (guest ? '  ·  l’hôte peut lancer la revanche' : '');
  $('endlessBtn').classList.add('hidden');
  $('againBtn').classList.toggle('hidden', guest);
  $('result').classList.remove('hidden');
  $('help').classList.add('hidden');
}

// remote : c'est l'adversaire qui a quitté le combat, inutile de le prévenir
function toMenu(remote = false) {
  if (isDungeon() && match?.mode === 'solo' && !net.live) saveRun();
  if (match?.game === 'dungeon' && !remote && net.ws) {
    if (net.live) netInfo('Partie en ligne quittée.');
    netSend({ t: 'leave' });
    netClose();
  } else if (net.live && !remote) netSend({ t: 'menu' });
  net.live = false;
  rb = null;
  coop = null;
  sim.g.phase = 'menu';
  game.paused = false;
  mapPeek = false;
  ['hud', 'help', 'result', 'pause', 'itemCard', 'lobby', 'talk', 'shop', 'bossBar', 'mapOv', 'eventOv', 'mapToggleBtn'].forEach((id) => $(id)?.classList.add('hidden'));
  $('fade').classList.remove('on');
  $('menu').classList.remove('hidden');
  menuScene();
  refreshMenu();
}
// décor et personnages derrière le menu, selon le jeu choisi
function menuScene() {
  if (cfg.game === 'dungeon') { dungeonPreview(); return; }
  if (isDungeon()) sim = new Sim(1);
  if (curArena !== cfg.arena) buildArena(cfg.arena);
  menuFighters();
}

function togglePause() {
  if (!['intro', 'fight', 'ko', 'clear', 'exit', 'dead', 'hub'].includes(game.phase)) return;
  game.paused = !game.paused;
  $('pauseTxt').textContent = net.live ? 'En ligne, la partie continue pendant la pause !' : 'Échap pour reprendre';
  $('pause').classList.toggle('hidden', !game.paused);
  if (game.paused) down.clear();
}

// Une image de simulation (1/60 s). Retourne false si on doit attendre l'adversaire (arène en ligne).
function simTick() {
  F.forEach((v, i) => sim.f[i] && v.capture(sim.f[i]));
  if (coop) {
    if (coop.role === 'host') {
      coop.tick(localInput(0));
      playEvents(coop.takeEvents());
    } else {
      const me = net.me;
      const inp = readMoveInput(me, true);
      const shop = sim.g.phase === 'hub' && shopReq[me] >= 0 ? shopReq[me] : -1;
      if (shop >= 0) shopReq[me] = -1;
      let map = -1, evt = -1;
      if (sim.g.phase === 'map' && mapReq[me] >= 0 && !mapSent[me]) { map = mapReq[me]; mapSent[me] = true; }
      if (sim.g.phase === 'event' && evtReq[me] >= 0 && !evtSent[me]) { evt = evtReq[me]; evtSent[me] = true; }
      coop.tick(inp, { shop, map, evt });
      playEvents(coop.takeEvents());
    }
    return true;
  }
  if (isDungeon() && !rb) {
    sim.step(localInput(0), sim.g.np > 1 ? localInput(1) : NEUTRAL);
    playEvents(sim.ev);
    sim.ev.length = 0;
    return true;
  }
  if (rb) {
    // on lit sans effacer tant que rollback n'a pas réellement avancé (évite de perdre une touche sur un stall)
    const inp = localInput(net.me, false);
    if (!rb.tick(inp)) return false;
    pending[net.me] = 0; tapped[net.me].clear();
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
// barre de sort spécial et temps de recharge dans le HUD (arène et donjon)
function updateSpellHud(f, n, showKey) {
  const S = spellOf(f);
  const max = f.spellMax || S.cd || 7;
  const cd = Math.max(0, f.spellCd || 0);
  const ready = cd <= 0.01;
  const kCode = showKey ? key1(KEYSETS[match?.mode === 'duo' ? n - 1 : 0], 'spell') : null;
  setTxt('spn' + n, (kCode ? `[${lab(kCode)}] ` : '') + S.name);
  const act = Math.max(f.spellBuffT || 0, f.stoneT || 0, f.totT || 0);   // Rempart sacré, Peau de pierre, Totem de vie
  setTxt('spc' + n, act > 0 ? `ACTIF ${act.toFixed(1)} s` : ready ? 'PRÊT' : `${cd.toFixed(1)} s`);
  setW('spf' + n, ready ? 100 : Math.max(0, Math.min(100, (1 - cd / max) * 100)));
  setCls('spb' + n, 'ready', ready);
}
function updateHud() {
  if (game.phase === 'menu' || !F.length) return;
  if (isDungeon()) { dungeonHud(); return; }
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
    updateSpellHud(f, n, match?.mode === 'duo' || (net.live ? i === net.me : i === 0));
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
  if (isDungeon() && game.phase !== 'loading') { dungeonCam(dt); return; }
  if (game.phase === 'menu' || game.phase === 'loading') {
    camAng += dt * 0.12;
    const rx = Math.cos(camAng), rz = -Math.sin(camAng);
    const off = game.phase === 'menu' && innerWidth > 880 ? 1.45 : 0;
    camPos.set(Math.sin(camAng) * 8.6 - rx * off * 0.35, 3.4, Math.cos(camAng) * 8.6 - rz * off * 0.35);
    camTgt.set(-rx * off, 1.0, -rz * off);
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
// si elle a de la marge pendant un moment, on la remonte (dans les bornes du préréglage graphique).
let pixelRatio = Math.min(devicePixelRatio, gfx.maxPR), maxPixelRatio = pixelRatio, resAvg = 16, resN = 0, resGood = 0, resSkip = 12;
function resetResolution() {
  maxPixelRatio = Math.min(devicePixelRatio, gfx.maxPR);
  pixelRatio = maxPixelRatio;
  resAvg = 16; resN = 0; resGood = 0; resSkip = 12;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight, false);
}
function adaptResolution(raw) {
  if (resSkip > 0) { resSkip--; return; }
  if (raw > 0.2) return;   // retour d'onglet ou pause : ne pas fausser la moyenne
  resAvg += (Math.min(raw, 0.1) * 1000 - resAvg) * 0.06;
  if (++resN % 90) return;
  let pr = pixelRatio;
  if (resAvg > 25) { pr = Math.max(gfx.minPR, +(pr - 0.2).toFixed(2)); resGood = 0; }
  else if (resAvg < 18.5 && ++resGood >= 4) { pr = Math.min(maxPixelRatio, +(pr + 0.2).toFixed(2)); resGood = 0; }
  if (pr !== pixelRatio) { pixelRatio = pr; renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight, false); }
}

// Boucle à pas fixe : la simulation avance par images de 1/60 s quel que soit l'écran (60, 144 Hz…),
// l'affichage interpole entre deux images de simulation.
let uiFlash = 0;
function step(rdt) {
  clockT += rdt;
  acc = Math.min(acc + rdt, 0.1);
  let n = 0;
  while (acc >= DT && n < 6) {
    if (!simTick()) break;       // en ligne : on attend l'adversaire (le temps non simulé est conservé)
    acc -= DT; n++;
  }
  if (coop?.role === 'guest') coop.interpolate(rdt);
  const g = sim.g, alpha = coop?.role === 'guest' ? 1 : Math.min(1, acc / DT);
  const animDt = g.hitstop > 0 ? 0 : rdt * g.slow;
  if (isDungeon() && game.phase !== 'menu') dungeonSync();
  lobbySync();
  syncArrows(alpha);
  const dg = isDungeon();
  for (let i = 0; i < F.length; i++) {
    const sf = sim.f[i];
    if (!sf) continue;
    if (!dg) { F[i].render(sf, animDt, clockT, alpha); continue; }
    statusPre(F[i], sf, rdt, clockT);
    F[i].render(sf, animDt * animK(sf), clockT, alpha);
    statusPost(F[i], sf, clockT, alpha);
  }
  updateBolts(rdt);
  for (let i = 0; i < updaters.length; i++) updaters[i](rdt, clockT);
  updateParticles(rdt);
  updateRings(rdt);
  if (flashV > 0) flashV = Math.max(0, flashV - rdt * 3);
  if (flashV !== uiFlash) { uiFlash = flashV; $('flash').style.opacity = flashV; }
  updateCamera(rdt);
  updateHud();
  syncUi();
}

// éléments d'interface qui suivent l'état de la simulation (écrits seulement quand ils changent)
let uiFade = false, uiNet = '';
function syncUi() {
  const fade = isDungeon() ? game.phase === 'exit' : game.phase === 'ko' && sim.g.flagFade;
  if (fade !== uiFade) { uiFade = fade; $('fade').classList.toggle('on', fade); }
  let txt = '';
  if (coop) {
    const mode = net.link?.state === 'rtc' ? 'direct' : 'relais';
    const ping = coop.stats.ping ? ` · ${coop.stats.ping} ms` : '';
    const warn = coop.stats.stalled ? ' · signal faible…' : '';
    txt = `Coop (${coop.role === 'host' ? 'Hôte' : 'Invité'}) · ${mode}${ping}${warn}`;
  } else if (rb) {
    txt = `${net.link?.state === 'rtc' ? 'direct' : 'relais'} · ↺ ${rb.stats.rollbacks}`;
  }
  if (txt !== uiNet) { uiNet = txt; $('netStat').textContent = txt; }
}

// =====================================================================
//  Donjon (rogue-like) : affichage. Toute la logique est dans dungeon.js.
//  L'affichage suit l'ÉTAT de la simulation (salle, porte, coffre, pièges).
// =====================================================================
// pk : vues des objets à ramasser (piédestaux, cœurs, éclats), par numéro n de l'objet dans la simulation
const dng = { room: -1, rn: -1, roomVer: -1, arenaVer: -1, dynGroup: null, dynGrow: 1, dynMixers: [], hallLeft: false, gateOpen: false, gate: null, traps: [], pk: new Map(), tot: [], glow: null, endShown: false };
const mapReq = [-1, -1];             // destination choisie sur la carte (phase 'map'), envoyée comme entrée
const mapSent = [false, false];      // en coop invité : évite de renvoyer 60 fois la même sélection
const evtReq = [-1, -1];             // option d'événement choisie (phase 'event')
const evtSent = [false, false];
const DNG_REC = 'spartiate-donjon-record';
const RUN_SAVE_KEY = 'spartiate-run';
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
  if (!isDungeon()) return [];
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
  PI('b_lantern', x, 1.3, z, ry, S, S, S, false);
  const ref = queueLight(0xffc070, lightI, 9, 1.4, x + Math.sin(ry) * 0.35, 1.55, z + Math.cos(ry) * 0.35, 5);
  const ph = rand(0, 10);
  updaters.push((dt, t) => { if (ref.light) ref.light.intensity = lightI * (0.9 + Math.sin(t * 3 + ph) * 0.05 + Math.sin(t * 11 + ph) * 0.04); });
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
      queueLight(0xff5a1a, 7, 11, 1.4, x, 0.6, z, 2);
    }
    // bulles qui éclatent à la surface de la lave
    if (gfx.fireEmbers) {
      let bubT = 0;
      updaters.push((dt) => {
        bubT -= dt;
        if (bubT > 0) return;
        bubT = rand(0.18, 0.45);
        const a = rand(0, 1) < 0.5, u = rand(D + TILE * 1.6, D + TILE * 4.5), v = rand(-D, D + TILE * 4);
        emit(a ? u : v, 0.0, a ? v : u, 3, { color: [0xff9a2e, 0xffe27a], speed: 0.6, up: 2.2, size: 0.06, life: 0.6, grav: 6 });
      });
    }
  } else if (kind === 'meadow') {
    // prairie : herbe et fleurs au pied des murs, puis sol vert et touffes instanciées ;
    // arbres, buissons et rochers instanciés (sans ombre hors de la salle), collines au loin
    const R = D + TILE * gfx.meadowRings;
    for (let x = -R; x <= R + 0.01; x += TILE)
      for (let z = -R; z <= R + 0.01; z += TILE) {
        if (!out(x, z) || corridor(x, z)) continue;
        PT(gfx.meadowDecor >= 0.7 && Math.random() < 0.2 ? 'b_grass-floor-flowers' : 'b_grass-floor', x, 0, z, rot4());
      }
    const spot = (r0, r1) => {
      for (let tries = 0; tries < 20; tries++) {
        const x = rand(-r1, r1), z = rand(-r1, r1), m = Math.max(Math.abs(x), Math.abs(z));
        if (m > r0 && !corridor(x, z) && !(exit === 'z' ? Math.abs(x) < 3 && z < -D : Math.abs(z) < 3 && x < -D)) return [x, z];
      }
      return null;
    };
    const treeList = [], maxTrees = Math.round(26 * gfx.meadowDecor);
    for (let i = 0; i < 40 && treeList.length < maxTrees; i++) {
      const p = spot(D + 1.8, D + 12);
      if (!p || !seen(p[0], p[1])) continue;
      treeList.push({ x: p[0], z: p[1], ry: rand(0, TAU), s: S * rand(1.0, 1.7), amp: 0.03, freq: rand(1, 1.6), ph: rand(0, 10) });
    }
    instTrees(treeList, false);
    const nBush = Math.round(16 * gfx.meadowDecor), nRock = Math.round(8 * gfx.meadowDecor);
    for (let i = 0; i < nBush; i++) { const p = spot(D + 0.9, D + 9); if (p) { const sc = S * rand(0.8, 1.35); PI('b_bush', p[0], 0, p[1], rand(0, TAU), sc, sc, sc, false); } }
    for (let i = 0; i < nRock; i++) { const p = spot(D + 1.2, D + 9); if (p) { const sc = S * rand(0.7, 1.1); PI('d_rocks', p[0], 0, p[1], rand(0, TAU), sc, sc, sc, false); } }
    const hills = new THREE.InstancedMesh(hillGeo, stdMat({ color: 0x5f8a4a, flatShading: true, roughness: 1 }), 16);
    hills.frustumCulled = false;
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * TAU + rand(-0.1, 0.1), r = rand(30, 40), rad = rand(7, 11), h = rand(4, 9);
      dummy.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(rad, h, rad);
      dummy.updateMatrix();
      hills.setMatrixAt(i, dummy.matrix);
    }
    hills.instanceMatrix.needsUpdate = true;
    world.add(hills);
    // touffes d'herbe qui ondulent (densité et fréquence adaptées à la qualité)
    const NT = Math.round(900 * gfx.tuftMul), tufts = [];
    for (let i = 0; i < NT; i++) { const p = spot(D + 0.3, D + 14) ?? [D + 2, D + 2]; tufts.push([p[0], p[1], rand(0, 6)]); }
    grassTufts(tufts);
    // fleurs des prés (immobiles, une forme instanciée, couleurs variées)
    const NF = Math.round(260 * gfx.meadowDecor);
    if (NF > 0) {
      const flowers = new THREE.InstancedMesh(flowerGeo, stdMat({ color: 0xffffff, roughness: 0.8 }), NF);
      flowers.frustumCulled = false;
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
      flowers.instanceMatrix.needsUpdate = true;
      flowers.instanceColor.needsUpdate = true;
      world.add(flowers);
    }
  } else if (kind === 'garden') {
    const nG = Math.round(26 * gfx.meadowDecor);
    for (let i = 0; i < nG; i++) {
      const x = rand(-D - 8, D + 8), z = rand(-D - 8, D + 8);
      if (Math.max(Math.abs(x), Math.abs(z)) < D + 1.4 || !seen(x, z)) continue;
      const r = Math.random();
      if (r < 0.55) { const sc = S * rand(0.95, 1.45); PI('a_tree', x, 0, z, rand(0, TAU), sc, sc, sc, false); }
      else if (r < 0.85) { const sc = S * rand(0.8, 1.3); PI('b_bush', x, 0, z, rand(0, TAU), sc, sc, sc, false); }
      else { const sc = S * rand(0.9, 1.2); PI('a_columnD', x, 0, z, rot4(), sc, sc, sc, false); }
    }
  } else if (kind === 'necropole') {
    // Nécropole d'Émeraude : stèles brisées, cristaux spectraux et brume verte au-delà des murs
    const nN = Math.round(24 * gfx.meadowDecor);
    for (let i = 0; i < nN; i++) {
      const x = rand(-D - 9, D + 9), z = rand(-D - 9, D + 9);
      if (Math.max(Math.abs(x), Math.abs(z)) < D + 1.4 || !seen(x, z)) continue;
      const r = Math.random();
      if (r < 0.45) { const sc = S * rand(0.9, 1.4); PI('a_columnD', x, 0, z, rot4(), sc, sc, sc, false); }
      else if (r < 0.78) { const sc = S * rand(0.8, 1.3); PI('b_crystals', x, 0, z, rand(0, TAU), sc, sc, sc, false); }
      else { const sc = S * rand(0.9, 1.2); PI('a_bricks', x, 0, z, rot4(), sc, sc, sc, false); }
    }
    for (const [x, z] of [[D + 3, -3], [D + 3, 3], [-3, D + 3], [3, D + 3]]) queueLight(0x3aff9e, 5.5, 11, 1.4, x, 1.2, z, 2);
  } else if (kind === 'snow') {
    // Citadelle Gelée : piliers givrés, cristaux de glace lumineux et rochers enneigés
    const nS = Math.round(24 * gfx.meadowDecor);
    for (let i = 0; i < nS; i++) {
      const x = rand(-D - 9, D + 9), z = rand(-D - 9, D + 9);
      if (Math.max(Math.abs(x), Math.abs(z)) < D + 1.4 || !seen(x, z)) continue;
      const r = Math.random();
      if (r < 0.5) { const sc = S * rand(0.9, 1.45); PI('b_crystals', x, 0, z, rand(0, TAU), sc, sc, sc, false); }
      else if (r < 0.8) { const sc = S * rand(0.9, 1.3); PI('a_column', x, 0, z, rot4(), sc, sc, sc, false); }
      else { const sc = S * rand(0.8, 1.2); PI('d_rocks', x, 0, z, rand(0, TAU), sc, sc, sc, false); }
    }
    for (const [x, z] of [[D + 3, -3], [D + 3, 3], [-3, D + 3], [3, D + 3]]) queueLight(0x7ae4ff, 5, 11, 1.4, x, 1.2, z, 2);
  }
}
// Sanctuaire d'Os (salle du Souverain d'Os) : ossements instanciés et brasiers spectraux verts aux coins
function ossuaryDecor() {
  for (const [x, z] of [[-5.6, -5.6], [5.6, -5.6], [-5.6, 5.6], [5.6, 5.6]]) {
    queueLight(0x3aff9e, 6, 9, 1.4, x, 1.7, z, 5);
  }
  const boneMat = stdMat({ color: 0xd8cdb0, roughness: 0.9 });
  const NB = 18;
  const shafts = new THREE.InstancedMesh(boneShaftGeo, boneMat, NB);
  const knobs = new THREE.InstancedMesh(boneKnobGeo, boneMat, NB * 4);
  shafts.frustumCulled = knobs.frustumCulled = false;
  let ki = 0;
  for (let i = 0; i < NB; i++) {
    const a = rand(0, TAU), r = rand(4.8, 6.4), ry = rand(0, TAU);
    const bx = Math.sin(a) * r, bz = Math.cos(a) * r, cy = Math.cos(ry), sy = Math.sin(ry);
    dummy.position.set(bx, 0.05, bz);
    dummy.rotation.set(0, ry, 0);
    dummy.scale.setScalar(1.1);
    dummy.updateMatrix();
    shafts.setMatrixAt(i, dummy.matrix);
    for (const s of [-1, 1]) for (const d of [-0.04, 0.04]) {
      const lx = s * 0.21, lz = d;
      dummy.position.set(bx + cy * lx + sy * lz, 0.05, bz - sy * lx + cy * lz);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      knobs.setMatrixAt(ki++, dummy.matrix);
    }
  }
  shafts.instanceMatrix.needsUpdate = true;
  knobs.instanceMatrix.needsUpdate = true;
  world.add(shafts, knobs);
}
// antre de Cerbère : flammes aux quatre colonnes, brasier dans le coin, ossements instanciés (2 appels au lieu de 70)
function lairDecor() {
  for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) fire(world, x, 1.55, z, 0.8, 4, 4);
  for (const [x, z] of [[5.6, 5.6]]) brazier(x, z, 'a_columnD', 1.1, 6, 5);
  const boneMat = stdMat({ color: 0xd8cdb0, roughness: 0.9 });
  const NB = 14;
  const shafts = new THREE.InstancedMesh(boneShaftGeo, boneMat, NB);
  const knobs = new THREE.InstancedMesh(boneKnobGeo, boneMat, NB * 4);
  shafts.frustumCulled = knobs.frustumCulled = false;
  let ki = 0;
  for (let i = 0; i < NB; i++) {
    const a = rand(0, TAU), r = rand(4.2, 6.2), ry = rand(0, TAU);
    const bx = Math.sin(a) * r, bz = Math.cos(a) * r, cy = Math.cos(ry), sy = Math.sin(ry);
    dummy.position.set(bx, 0.05, bz);
    dummy.rotation.set(0, ry, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    shafts.setMatrixAt(i, dummy.matrix);
    for (const s of [-1, 1]) for (const d of [-0.04, 0.04]) {
      const lx = s * 0.21, lz = d;
      dummy.position.set(bx + cy * lx + sy * lz, 0.05, bz - sy * lx + cy * lz);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      knobs.setMatrixAt(ki++, dummy.matrix);
    }
  }
  shafts.instanceMatrix.needsUpdate = true;
  knobs.instanceMatrix.needsUpdate = true;
  world.add(shafts, knobs);
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
  necropole: {
    name: "LA NÉCROPOLE D'ÉMERAUDE", floor: ['a_floor', 'a_floorD'], detail: 0.32,
    wall: ['d_wall', 2.25], wallAlt: ['b_ruin-wall-broken', 0.25], low: ['d_wallHalf', 0.55], open: ['d_wallOpen', 2.475], block: ['a_block', 0.5],
    obs: { column: ['a_columnD', 1.15, true], barrel: ['a_bricks', 1.15, true], rocks: ['b_crystals', 1] },
    bg: [0x0f241f, 0x061210], sky: [0xbfffe0, 0x56b894], gnd: [0x244a3c, 0x102820], hi: [1.15, 0.9], sun: [0xa0ffd4, 0x58d0a4], si: [1.35, 0.95],
    ground: [0x0b1a16, 0x050d0b], fog: [21, 42], wallLight: 'lantern', banners: true, brazier: 'a_columnD', lantern: 0.95,
    motes: { color: 0x6effb8, up: 0.26, size: 0.055 }, glowObs: { rocks: 0x3aff9e }, outside: 'necropole',
  },
  citadelle: {
    name: 'LA CITADELLE GELÉE', floor: ['b_mine-floor', 'b_mine-floor-stones'], detail: 0.35,
    wall: ['a_wall', 2.25], wallAlt: ['b_ruin-wall', 0.2], low: ['b_ruin-low', null], open: ['a_wallGate', 2.4], block: ['a_block', 0.5],
    obs: { column: ['a_column', 1.15, true], barrel: ['d_stones', 1.15, true], rocks: ['b_crystals', 1] },
    sky: [0xdcf4ff, 0x8cc8f0], gnd: [0x4c708e, 0x2a4562], hi: [1.45, 1.15], sun: [0xeaf8ff, 0x9ed8ff], si: [1.9, 1.35],
    skyTex: [[0, '#102c4e'], [0.55, '#3474a8'], [1, '#bce8ff']], skyTexEnd: [[0, '#081830'], [0.5, '#1e5282'], [1, '#7fc2ea']],
    bg: [0xbce8ff, 0x7fc2ea], ground: [0x7aa8c8, 0x4b7496], fog: [26, 56], wallLight: 'lantern', banners: false, brazier: 'a_column', lantern: 0.55,
    motes: { color: 0xeef9ff, up: -0.55, size: 0.055 }, glowObs: { rocks: 0x7ae4ff }, outside: 'snow',
  },
};
// salle d'armes : murs des cryptes, mais en plein air, au milieu d'une prairie (verdure au-delà des murs)
BIOME.hub = {
  ...BIOME.crypt, name: "LA SALLE D'ARMES",
  skyTex: [[0, '#4f93dc'], [0.6, '#a9d3ef'], [1, '#efe6c6']], skyTexEnd: [[0, '#4f93dc'], [0.6, '#a9d3ef'], [1, '#efe6c6']],
  bg: [0xefe6c6, 0xefe6c6], sky: [0xfff4e0, 0xfff4e0], gnd: [0x5a7040, 0x5a7040], hi: [1.45, 1.45], sun: [0xfff0d0, 0xfff0d0], si: [2.1, 2.1],
  ground: [0x5e8a48, 0x5e8a48], fog: [36, 90], lantern: 0.5, motes: { color: 0xe8f0a0, up: 0.03, size: 0.04 }, outside: 'meadow',
};
// antre de Cerbère (salle dédiée, room.lair = 'cerbere') : basalte, lave tout autour, lueurs rouges
BIOME.lair = {
  ...BIOME.forge, name: "L'ANTRE DE CERBÈRE",
  bg: [0x1a0404, 0x1a0404], sky: [0xff7050, 0xff7050], gnd: [0x701008, 0x701008], hi: [0.9, 0.9], sun: [0xff6040, 0xff6040], si: [1.0, 1.0],
  ground: [0x0e0302, 0x0e0302], fog: [20, 40], lantern: 0.9, motes: { color: 0xff5a20, up: 0.6, size: 0.07 },
};
// sanctuaire du Souverain d'Os (salle finale, room.lair = 'squelette') : marbre sombre et brume d'émeraude
BIOME.ossuary = {
  ...BIOME.necropole, name: "LE SANCTUAIRE D'OS",
  bg: [0x081613, 0x081613], sky: [0x88ffca, 0x88ffca], gnd: [0x14382c, 0x14382c], hi: [1.05, 1.05], sun: [0x78ffc0, 0x78ffc0], si: [1.15, 1.15],
  ground: [0x06110e, 0x06110e], fog: [19, 38], lantern: 0.9, motes: { color: 0x6effb8, up: 0.42, size: 0.065 },
};
const rot4 = () => ((Math.random() * 4) | 0) * Math.PI / 2;

// n : numéro de la salle. Chaque biome s'assombrit un peu au fil de sa tranche ; salle du boss en rouge.
function buildDungeonRoom(room, n) {
  clearWorld();
  updaters = [];
  talkVis = shopVis = false;
  for (const id of ['talk', 'shop']) $(id).classList.add('hidden');   // marchand (salle d'armes)
  crowd = null;
  arenaHooks = {};
  curArena = 'dungeon';
  Object.assign(dng, { gateOpen: false, gate: null, traps: [], glow: null, dynGroup: null, dynGrow: 1, dynMixers: [], arenaVer: sim?.g?.arenaVer ?? 0 });
  dng.pk.clear();                      // leurs objets 3D partent avec le monde
  dng.tot = [];                        // totems de vie (sort) : idem
  const boss = room.boss;
  const runSeed = sim?.map?.runSeed ?? sim?.runSeed ?? 0;
  dng.biome = room.hub ? 'hub' : room.biome && BIOME[room.biome] ? room.biome : room.lair === 'squelette' ? 'ossuary' : room.lair ? 'lair' : (room.act ? biomeOfAct(room.act, runSeed) : biomeOf(n, runSeed));
  const B = BIOME[dng.biome] ?? BIOME.crypt;
  const k = clamp(((Math.max(n, 1) - 1) % 5) / 4, 0, 1) * (boss ? 1 : 0.85);   // 0 : début de la tranche … 1 : salle du boss
  const red = boss && dng.biome !== 'ossuary' ? 0.45 : 0;                      // teinte rouge de la salle du boss (sauf Sanctuaire d'Os émeraude)
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
  // pièce de mur instanciée : [clé, échelle y] ; les modèles générés sont symétriques, on les retourne au hasard
  const piece = ([key, sy], x, z, ry, cast = true, gen = key === B.wall[0]) => {
    PI(gen ? wallKey() : key, x, 0, z, ry + (sy === null && Math.random() < 0.5 ? Math.PI : 0), S, sy !== null ? sy : S, S, cast);
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
          PI(B.open[0], x, 0, z, sd.ang + Math.PI, S, B.open[1] !== null ? B.open[1] : S, S, true);
        } else piece(B.wall, x, z, sd.ang + Math.PI, true);
      } else if (!(mid && sd.id === entryId)) {
        // murets côté caméra (+x, +z) : leur ombre tombe hors de la salle, inutile de la calculer
        piece(B.low, x, z, sd.ang, false);
      }
    }
    if (!sd.far) continue;
    // lumières des murs du fond (salle d'armes : pas sur le mur de la porte, les présentoirs y sont)
    if (B.wallLight && !(room.hub && sd.id === exitId)) for (const t of [-3.75, 3.75]) {
      const [x, z] = at(ROOM_R - 0.13, t);
      if (B.wallLight === 'torch') torch(x, 1.5, z, sd.ang + Math.PI, 4 + 4 * k, 5);
      else wallLantern(x, z, sd.ang + Math.PI, 4 + 4 * k);
    }
    if (sd.id !== exitId) continue;
    // porte de sortie : herse, bannières, couloir éclairé derrière
    if (B.banners) for (const t of [-1.5, 1.5]) {
      const [x, z] = at(D, t);
      if (gfx.sway) sway(P('d_banner', x, 0.25, z, sd.ang + Math.PI, S, world, false), 0.04, 1.4, 'x');
      else PI('d_banner', x, 0.25, z, sd.ang + Math.PI, S, S, S, false);
    }
    for (const d of [D, D + TILE, D + TILE * 2]) { const [x, z] = at(d, 0); PT(B.floor[0], x, 0, z); }
    for (const d of [D + TILE, D + TILE * 2]) for (const t of [-TILE, TILE]) { const [x, z] = at(d, t); piece(B.wall, x, z, sd.ang, false); }
    { const [x, z] = at(D + TILE * 2, 0); queueLight(0xffa860, 5, 6, 1.5, x, 1.4, z, 4); }
    const [gx, gz] = at(ROOM_R + 0.08, 0);
    const gate = P('d_gate', gx, 0, gz, sd.ang + Math.PI, 2.0);
    gate.scale.y = 2.6;
    const gm = new THREE.AnimationMixer(gate);
    const closing = playOnce(gm, 'd_gate', 'close');
    gm.update(10);
    updaters.push((dt) => gm.update(dt));
    dng.gate = {
      open(silent = false) {
        closing.stop();
        const a = playOnce(gm, 'd_gate', 'open');
        if (silent) { gm.update(10); return; }
        sfx.heavy();
        emit(gx, 0.2, gz, 14, { color: [0x8a8090, 0x5a5260], speed: 1.5, up: 1.5, size: 0.08, life: 0.7, grav: 4, spread: 0.5 });
      },
    };
  }
  // coins
  piece(B.wall, -D, -D, 0, true);
  piece(B.wall, D, -D, 0, false);
  piece(B.wall, -D, D, 0, false);
  piece(B.low, D, D, 0, false);
  if (B.outside) outsideDecor(B.outside, D, room.exit);

  const dynArena = room.lair === 'squelette';
  // estrades (blocs surmontés de dalles) et escaliers (tous instanciés, sauf en arène mouvante gérée par dng.dynGroup)
  if (!dynArena) for (const s of room.surf) {
    for (let x = s.x0 + TILE / 2; x < s.x1; x += TILE)
      for (let z = s.z0 + TILE / 2; z < s.z1; z += TILE) {
        if (!s.ramp) {
          PI(B.block[0], x, 0, z, rot4(), S, PLAT_H / B.block[1], S, true);
          PT(floorKey(), x, PLAT_H + 0.003, z, rot4());
        } else {
          // le modèle d'escalier monte vers son -z local : on le tourne vers le haut de la rampe
          const dir = Math.sign(s.to - s.from), dx = s.ramp === 'x' ? dir : 0, dz = s.ramp === 'z' ? dir : 0;
          PI('d_stairs', x, 0, z, Math.atan2(-dx, -dz), S, PLAT_H / 0.9, S, true);
        }
      }
    if (!s.ramp) {
      // un brasero sur un coin de l'estrade, côté mur
      const cx = Math.abs(s.x0) > Math.abs(s.x1) ? s.x0 + 0.45 : s.x1 - 0.45;
      const cz = Math.abs(s.z0) > Math.abs(s.z1) ? s.z0 + 0.45 : s.z1 - 0.45;
      const bowl = new THREE.Mesh(bowlSmallGeo, ironMat);
      bowl.position.set(cx, PLAT_H + 0.09, cz); bowl.castShadow = gfx.shadows;
      world.add(bowl);
      fire(world, cx, PLAT_H + 0.14, cz, 0.9, 3 + 3 * k, 4);
    }
  }

  // obstacles (leur collision est dans dungeon.js) : [clé, échelle, quart de tour seulement]
  if (!dynArena) for (const o of room.obs) {
    if (o.kind === 'stand' || o.kind === 'counter' || o.kind === 'tent' || o.kind === 'cauldron' || o.kind === 'npc') continue;      // salle d'armes : construits par buildHub
    const [key, s, square] = B.obs[o.kind] ?? B.obs.rocks;
    const sc = S * s;
    PI(key, o.x, 0, o.z, square ? rot4() : rand(0, TAU), sc, sc, sc, true);
    if (o.kind === 'barrel' && key === 'd_barrel') PI('d_pot', o.x + 0.45, 0, o.z + 0.3, rand(0, TAU), 1.1, 1.1, 1.1, true);
    const glow = B.glowObs?.[o.kind];
    if (glow) queueLight(glow, 2.5, 4, 1.6, o.x, 0.9, o.z, 3);
  }
  if (boss && !dynArena) for (const [x, z] of [[-5.6, -5.6], [5.6, -5.6], [-5.6, 5.6]]) brazier(x, z, B.brazier, B.brazier === 'd_barrel' ? 1.3 : 1.1, 6, 5);
  if (room.roomType === 'treasure') {
    for (const [x, z] of [[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9]]) {
      PI('a_trophy', x, 0, z, rot4(), S * 0.9, S * 0.9, S * 0.9, true);
      PI('d_coin', x * 0.72, 0.06, z * 0.72, rand(0, TAU), S * 0.8, S * 0.8, S * 0.8, false);
    }
    queueLight(0xffd34a, 6, 9, 1.4, 0, 2.2, 0, 8);
  } else if (room.roomType === 'event') {
    PI('a_statue', 0, 0, -1.2, 0, S * 1.15, S * 1.15, S * 1.15, true);
    for (const [x, z] of [[-1.5, -1.2], [1.5, -1.2]]) PI('b_crystals', x, 0, z, rand(0, TAU), S * 0.9, S * 0.9, S * 0.9, false);
    queueLight(0xa584ff, 6.5, 10, 1.4, 0, 2.1, -1.2, 8);
  }
  if (room.lair === 'cerbere') lairDecor();
  if (room.lair === 'squelette') {
    ossuaryDecor();
    dng.dynGroup = new THREE.Group();
    world.add(dng.dynGroup);
    rebuildDynamicArena(room, true);
    updaters.push((dt) => {
      for (const mx of dng.dynMixers) mx.update(dt);
      if (dng.dynGroup && dng.dynGrow < 1) {
        dng.dynGrow = Math.min(1, dng.dynGrow + dt * 3.2);
        const e = Math.sin(dng.dynGrow * Math.PI * 0.5);
        dng.dynGroup.position.y = (1 - e) * -1.4;
      }
    });
  }
  if (room.hub) buildHub(room);

  // pièges à pics : l'animation suit l'état des pics dans la simulation
  if (!dynArena) room.traps.forEach((t, i) => {
    const o = P('d_trap', t.x, 0.004, t.z, 0, S, world, false);
    const mx = new THREE.AnimationMixer(o);
    playOnce(mx, 'd_trap', 'hide');
    mx.update(1);
    updaters.push((dt) => mx.update(dt));
    dng.traps.push({ x: t.x, z: t.z, mx, up: false, warnT: 0 });
  });

  // une lanterne par héros (toujours visible, intensité à 0 quand inactive : évite de recompiler les shaders !)
  const lanternBaseI = (3 + 6 * k) * B.lantern;
  const lanterns = [0, 1].map(() => queueLight(0xffc890, 0, 10, 1.4, 0, -50, 0, 10));
  updaters.push(() => {
    for (let i = 0; i < 2; i++) {
      const l = lanterns[i].light;
      if (!l) continue;
      const v = F[i], on = isDungeon() && i < sim.g.np && v;
      if (on) { l.intensity = lanternBaseI; l.position.set(v.rx, v.ry + 2.6, v.rz); }
      else if (l.intensity !== 0) { l.intensity = 0; l.position.y = -50; }
    }
  });

  // poussière dans la lumière (densité et fréquence adaptées à la qualité)
  const N = Math.max(24, Math.round(160 * gfx.motesMul)), pos = new Float32Array(N * 3), seed = [];
  for (let i = 0; i < N; i++) seed.push([rand(-6.5, 6.5), rand(0, 3.5), rand(-6.5, 6.5), rand(0, 6)]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const motes = new THREE.Points(geo, new THREE.PointsMaterial({ color: B.motes.color, size: B.motes.size, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
  motes.frustumCulled = false;
  world.add(motes);
  let accM = 1;
  const stepM = 1 / gfx.motesHz;
  updaters.push((dt, t) => {
    accM += dt;
    if (accM < stepM) return;
    const d = accM; accM = 0;
    for (let i = 0; i < N; i++) {
      const s = seed[i];
      s[1] += d * B.motes.up; if (s[1] > 3.5) s[1] = 0; else if (s[1] < 0) s[1] = 3.5;
      pos[i * 3] = s[0] + Math.sin(t * 0.3 + s[3]) * 0.4;
      pos[i * 3 + 1] = s[1];
      pos[i * 3 + 2] = s[2] + Math.cos(t * 0.25 + s[3]) * 0.3;
    }
    geo.attributes.position.needsUpdate = true;
  });

  // lueur des piédestaux (objets à ramasser) : lumière réservée dès la construction, éteinte sans objet
  dng.glow = queueLight(0xffd34a, 0, 5, 1.5, 0, -50, 0, 10);
  if (room.vault) vaultDecor();
  flushInstances();
  flushFires();
  flushLights();                       // toutes les lumières de la salle sont posées (nombre fixe)
  resSkip = 8;
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
  const lockedFor = (id) => isDungeon() && !sim.canPick(me, id);
  const pads = room.pads.map((pd) => {
    const hero = pd.t === 'hero', locked = hero && lockedFor(pd.id);
    const col = locked ? 0x8a8a90 : hero ? 0xffc04a : pd.t === 'spell' ? 0xb98aff : 0x6fc3ff;
    // dalle lumineuse
    const disc = new THREE.Mesh(padGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false }));
    disc.position.set(pd.x, 0.012, pd.z);
    const rim = new THREE.Mesh(padRing, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }));
    rim.position.set(pd.x, 0.014, pd.z);
    world.add(disc, rim);
    if (!hero) return { pd, disc, rim, show: null, mixer: null, yes: null, sel: false };
    // socle de pierre et statue vivante du héros, tournée vers la salle
    const st = padStand(pd);
    PI('d_wall', st.x, 0, st.z, 0, 0.62, 0.2, 0.62, false);
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
    const sp = SPELLS[pd.id];
    label((locked ? '🔒 ' : '') + HEROES[pd.id].name, locked ? `Défi du ${prev?.name ?? ''} requis` : `${HEROES[pd.id].desc} · ${sp.name}`, st.x + 0.2, 2.15, st.z, 1.35);
    return { pd, disc, rim, show, mixer: locked ? null : mixer, yes, sel: false, locked };
  });
  buildMerchant();
  buildSorcerer();
  updaters.push(shopSync);   // panneau #shop et bulle #talk des deux marchands
  // tapis au centre de la salle
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 5.2), stdMat({ color: 0x7a1e1a, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(0.6, 0.008, 1.2); rug.receiveShadow = true;
  world.add(rug);
  const rugIn = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 4.7), stdMat({ color: 0xa8742a, roughness: 1 }));
  rugIn.rotation.x = -Math.PI / 2; rugIn.position.set(0.6, 0.01, 1.2);
  world.add(rugIn);
  const rugC = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 4.4), stdMat({ color: 0x7a1e1a, roughness: 1 }));
  rugC.rotation.x = -Math.PI / 2; rugC.position.set(0.6, 0.012, 1.2);
  world.add(rugC);
  label('EN AVANT !', 'Franchis la porte quand tu es prêt', 0, 2.9, -6.2, 1.9);

  // ce que portent les héros : leur dalle brille, la statue salue au moment du choix
  updaters.push((dt, t) => {
    const np = isDungeon() ? Math.min(sim.g.np, sim.f.length) : 0;
    for (let k = 0; k < pads.length; k++) {
      const p = pads[k];
      let sel = false;
      for (let i = 0; i < np; i++) {
        const h = sim.f[i];
        if (p.pd.t === 'hero' ? h.kind === p.pd.id : h.shop > 0 && !h.shopK === (p.pd.t === 'shop')) { sel = true; break; }
      }
      if (sel && !p.sel && p.yes) p.yes.reset().play();
      p.sel = sel;
      // la dalle du marchand pulse doucement pour attirer l'œil
      p.disc.material.opacity = sel ? 0.45 + 0.12 * Math.sin(t * 4) : p.pd.t !== 'hero' ? 0.2 + 0.1 * Math.sin(t * 2.5) : p.locked ? 0.06 : 0.14;
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
// bulles : spk[0] = marchand, spk[1] = sorcier (une seule bulle affichée à la fois)
const shopUi = { key: '', spk: [{ say: '', sayT: 0 }, { say: '', sayT: 0 }], last: [{ shop: 0, wpn: '' }, { shop: 0, wpn: '' }], lastS: [{ shop: 0, sp: '' }, { shop: 0, sp: '' }] };
// héros joué sur cette machine qui est dans la boutique (-1 sinon) : la caméra se place derrière lui
function localShopper() {
  if (!isDungeon() || sim.g.phase !== 'hub') return -1;
  return localHeroes().find((h) => sim.f[h]?.shop > 0) ?? -1;
}
function say(k, text, dur) { const s = shopUi.spk[k]; s.say = text; s.sayT = dur; }
// boutique où se trouve le héros h : 0 = aucune, 1 = marchand, 2 = sorcier
const shopOf = (h) => (h.shop > 0 ? (h.shopK ? 2 : 1) : 0);
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
  // pièces d'or et pot sur le comptoir, râteliers d'armes contre le mur (instanciés)
  for (const [dx, dz, r] of [[-0.85, 0.05, 0.3], [-0.7, -0.1, 1.2], [0.9, 0, 2]]) PI('d_coin', M.x + dx, 0.6, M.counterZ + dz, r, 0.5, 0.5, 0.5, false);
  PI('d_pot', M.x + 1.35, 0, M.counterZ - 0.45, 0.4, 1);
  PI('a_rack', -1.8, 0, -6.15, 0, 1.3);   // (à gauche : la tente du sorcier)
  PI('d_barrel', -5.2, 0, -5.9, 0.3, S);
  const sign = label("MARCHAND D'ARMES", '', M.x, 2.45, M.counterZ + 0.1, 1.7);

  // le marchand se tient sur une caisse (sa tête dépasse du comptoir), à droite de l'étal ;
  // les armes défilent sur la gauche du comptoir
  const MX = M.x + 0.5, AX = M.x - 0.6;
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.5), stdMat({ color: 0x6b4423, roughness: 1 }));
  box.position.set(MX, 0.11, M.z); box.castShadow = gfx.shadows; box.receiveShadow = true;
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
  const lampRef = queueLight(0xffd9a0, 0.8, 4, 1.5, M.x, 1.9, M.counterZ + 0.9, 6);
  shopUi.last.forEach((o) => { o.shop = 0; o.wpn = ''; });
  say(0, '', 0);

  updaters.push((dt, t) => {
    const np = isDungeon() ? Math.min(sim.g.np, sim.f.length) : 0;
    const locSh = localShopper();
    let buyer = locSh >= 0 && shopOf(sim.f[locSh]) === 1 ? sim.f[locSh] : null, look = 0, best = 4.5, near = false;
    for (let i = 0; i < np; i++) {
      const h = sim.f[i], hs = shopOf(h) === 1 ? h.shop : 0;
      if (!buyer && hs) buyer = h;
      const was = shopUi.last[i];
      if (was.wpn) {
        if (hs && !was.shop) { gesture('interact-right'); say(0, 'Tu veux quelle arme, mon brave ?', 0); }
        else if (hs && hs !== was.shop) say(0, SHOP_LINES[WEAPON_IDS[hs - 1]] ?? '', 0);
        else if (!hs && was.shop) {
          if (h.wpn !== was.wpn) { gesture('emote-yes'); say(0, 'Bon choix, mon brave ! Fais-en bon usage.', 2.6); }
          else { gesture('emote-no'); say(0, 'Reviens quand tu veux !', 2); }
        }
      }
      was.shop = hs; was.wpn = h.wpn;
      const d = hs ? -1 : Math.hypot(h.x - MX, h.z - M.z);
      if (d < best) { best = d; look = clamp(Math.atan2(h.x - MX, h.z - M.z), -0.9, 0.9); }
      if (!near && h.state !== 'dead' && Math.hypot(h.x - M.x, h.z - (M.counterZ + 1.5)) < 2.4) near = true;
    }
    man.rotation.y += (look - man.rotation.y) * Math.min(1, dt * 4);
    mixer.update(dt);
    const sp0 = shopUi.spk[0];
    sp0.sayT -= dt;
    if (!buyer && sp0.sayT <= 0) sp0.say = near ? 'Approche, mon brave ! J\'ai de belles armes.' : '';
    // carrousel : l'arme montrée au centre, ses voisines de part et d'autre
    const sel = buyer ? buyer.shop - 1 : -1, N = WEAPON_IDS.length, k2 = Math.min(1, dt * 10);
    for (let k = 0; k < N; k++) {
      const g = shows[k];
      let d = (k - sel + N) % N;
      if (d > N / 2) d -= N;
      if (sel < 0 || Math.abs(d) > 1) { g.visible = false; continue; }
      const x = AX + d * 0.58;
      if (!g.visible) { g.visible = true; g.position.set(x, 1, M.counterZ); g.scale.setScalar(0.01); }
      g.position.x += (x - g.position.x) * k2;
      g.position.y = (d ? 0.92 : 1.12) + Math.sin(t * 2 + k) * 0.04;
      g.position.z = M.counterZ + (d ? -0.1 : 0.1);
      g.scale.setScalar(g.scale.x + ((d ? 0.55 : 1.05) - g.scale.x) * k2);
      g.rotation.y = d ? -0.5 * d : t * 1.2;
    }
    if (lampRef.light) lampRef.light.intensity += ((buyer ? 3 : 0.8) - lampRef.light.intensity) * Math.min(1, dt * 4);
    sign.visible = localShopper() < 0;   // vue de près : l'enseigne passerait sous le titre
  });
}

// ---------- Sorcier ----------
// Un vieux sorcier devant sa petite tente, à gauche de la porte. Un héros qui marche sur la dalle devant son
// chaudron entre dans son « étal » (p.shop avec p.shopK = 1) : il choisit un sort parmi tous (SPELL_IDS),
// dont les icônes tournent au-dessus du chaudron. Comme le marchand : tout passe par la simulation.
const SPELL_ICON = { soldier: '🌀', human: '💨', orc: '💥', archer: '🏹', knight: '🛡️', zombie: '☠️', robot: '⚡', stone: '🪨', totem: '🗿' };
const SPELL_LINES = {
  soldier: 'Le Tourbillon : tourne, tourne, et que tout tombe autour de toi !',
  human: 'L\'Estoc fulgurant… rapide comme l\'éclair, hé hé.',
  orc: 'La Frappe sismique ! Le sol lui-même leur tombera dessus.',
  archer: 'Une pluie de flèches, et un bond en arrière. Prudent !',
  knight: 'Le Rempart sacré : la lumière te protège un moment.',
  zombie: 'La Nuée putride… ça sent mauvais, mais ça soigne.',
  robot: 'La Décharge d\'arc : les gardes ne tiennent pas face à la foudre.',
  stone: 'Peau de pierre ! Tu seras lent… mais qui pourra te faire mal ?',
  totem: 'Mon Totem de vie : plante-le, reste près de lui, et guéris.',
};
// à qui appartient un sort (affiché dans le panneau)
const spellOwner = (id) => {
  const n = HEROES[id]?.name;
  return !n ? 'Secret du sorcier' : /^[AEIOUYÉÈÂ]/i.test(n) ? `Sort de l'${n}` : `Sort du ${n}`;
};
function buildSorcerer() {
  const S = SORCERER;
  const tent = inst('tent', 1);
  tent.position.set(S.tentX, 0, S.tentZ);
  world.add(tent);
  const pot = inst('cauldron', 1);
  pot.position.set(S.x, 0, S.cauldronZ);
  glowNode(pot, 'brew', new THREE.Color(0x7dff5a));
  world.add(pot);
  const sign = label('SORCIER', 'Sorts au choix', S.tentX, 2.35, S.tentZ + 0.75, 1.5);
  const man = inst('sorcerer', 1.6);
  man.position.set(S.manX, 0, S.z);
  world.add(man);
  const mixer = new THREE.AnimationMixer(man);
  const idle = mixer.clipAction(clipOf('sorcerer', 'idle'));
  idle.play();
  let cur = null;
  const gesture = (name) => {
    const a = mixer.clipAction(clipOf('sorcerer', name));
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
  // icônes des sorts qui tournent au-dessus du chaudron pendant le choix (la sélection au premier plan)
  const shows = SPELL_IDS.map((id) => {
    const sp = new THREE.Sprite(emojiMat(SPELL_ICON[id] ?? '✨'));
    sp.visible = false;
    world.add(sp);
    return sp;
  });
  const lampRef = queueLight(0x7dff5a, 0.9, 3.5, 1.5, S.x, 0.9, S.cauldronZ, 6);
  shopUi.lastS.forEach((o) => { o.shop = 0; o.sp = ''; });
  say(1, '', 0);

  updaters.push((dt, t) => {
    const np = isDungeon() ? Math.min(sim.g.np, sim.f.length) : 0;
    const locSh = localShopper();
    let buyer = locSh >= 0 && shopOf(sim.f[locSh]) === 2 ? sim.f[locSh] : null, look = 0, best = 4.5, near = false;
    for (let i = 0; i < np; i++) {
      const h = sim.f[i], hs = shopOf(h) === 2 ? h.shop : 0, mine = spellKey(h);
      if (!buyer && hs) buyer = h;
      const was = shopUi.lastS[i];
      if (was.sp) {
        if (hs && !was.shop) { gesture('interact-right'); say(1, 'Hé hé… Quel sort veux-tu apprendre ?', 0); }
        else if (hs && hs !== was.shop) say(1, SPELL_LINES[SPELL_IDS[hs - 1]] ?? '', 0);
        else if (!hs && was.shop) {
          if (mine !== was.sp) { gesture('emote-yes'); say(1, 'Voilà, c\'est gravé dans ta tête. Hé hé !', 2.6); }
          else { gesture('emote-no'); say(1, 'Reviens quand tu veux, jeune pousse.', 2); }
        }
      }
      was.shop = hs; was.sp = mine;
      const d = hs ? -1 : Math.hypot(h.x - S.manX, h.z - S.z);
      if (d < best) { best = d; look = clamp(Math.atan2(h.x - S.manX, h.z - S.z), -0.9, 0.9); }
      if (!near && h.state !== 'dead' && Math.hypot(h.x - S.x, h.z - (S.cauldronZ + 1.2)) < 2.2) near = true;
    }
    man.rotation.y += (look - man.rotation.y) * Math.min(1, dt * 4);
    mixer.update(dt);
    const sp1 = shopUi.spk[1];
    sp1.sayT -= dt;
    if (!buyer && sp1.sayT <= 0) sp1.say = near ? 'Psst… Des sorts, jeune guerrier ?' : '';
    // carrousel : la sélection au-dessus du chaudron, ses voisines plus petites de part et d'autre
    const sel = buyer ? buyer.shop - 1 : -1, N = SPELL_IDS.length, k2 = Math.min(1, dt * 10);
    for (let k = 0; k < N; k++) {
      const g = shows[k];
      let d = (k - sel + N) % N;
      if (d > N / 2) d -= N;
      if (sel < 0 || Math.abs(d) > 1) { g.visible = false; continue; }
      const x = S.x - 0.15 + d * 0.42;
      if (!g.visible) { g.visible = true; g.position.set(x, 1, S.cauldronZ); g.scale.setScalar(0.01); }
      g.position.x += (x - g.position.x) * k2;
      g.position.y = (d ? 1.3 : 1.55) + Math.sin(t * 2 + k) * 0.05;
      g.position.z = S.cauldronZ + (d ? -0.1 : 0.15);
      g.scale.setScalar(g.scale.x + ((d ? 0.32 : 0.55) - g.scale.x) * k2);
    }
    // la potion bouillonne (petites bulles qui montent), plus fort pendant le choix
    if (Math.random() < dt * (buyer ? 8 : 2.5)) emit(S.x + rand(-0.15, 0.15), 0.6, S.cauldronZ + rand(-0.15, 0.15), 1, { color: [0x7dff5a, 0xc8ff9a], speed: 0.15, up: 0.7, size: 0.06, life: 0.7, grav: -0.5 });
    if (lampRef.light) lampRef.light.intensity = (buyer ? 2.4 : 0.9) + Math.sin(t * 7) * 0.15;
    sign.visible = localShopper() < 0;
  });
}

// bulle du marchand ou du sorcier et panneau de choix (HTML par-dessus la scène)
let talkVis = false, shopVis = false, talkX = '', talkY = '';
const TALKERS = [
  { who: 'Le vieux marchand', x: MERCHANT.x + 0.5, y: 1.75, z: MERCHANT.z },
  { who: 'Le sorcier', x: SORCERER.manX, y: 2.05, z: SORCERER.z },
];
function shopSync() {
  const hub = isDungeon() && sim.g.phase === 'hub' && !game.paused;
  const talk = $('talk');
  const h = hub ? localShopper() : -1;
  // qui parle : la boutique du héros local, sinon le dernier qui a quelque chose à dire
  const [a, b] = shopUi.spk;
  const k = h >= 0 ? (sim.f[h].shopK ? 1 : 0) : b.say && (!a.say || b.sayT > a.sayT) ? 1 : 0;
  const T = TALKERS[k], txt = shopUi.spk[k].say;
  const v = v1.set(T.x, T.y, T.z).project(camera);
  const showTalk = !!(hub && txt && v.z < 1);
  if (showTalk) {
    if (!talkVis) { talkVis = true; talk.classList.remove('hidden'); }
    if (talk.dataset.txt !== txt) { talk.dataset.txt = txt; $('talkTxt').textContent = txt; }
    if (talk.dataset.who !== T.who) { talk.dataset.who = T.who; $('talkWho').textContent = T.who; }
    const lx = Math.round((v.x + 1) / 2 * innerWidth) + 'px', ty = Math.round((1 - v.y) / 2 * innerHeight) + 'px';
    if (lx !== talkX) { talkX = lx; talk.style.left = lx; }
    if (ty !== talkY) { talkY = ty; talk.style.top = ty; }
  } else if (talkVis) { talkVis = false; talk.classList.add('hidden'); }

  for (const n of [0, 1]) if (n !== h) shopReq[n] = -1;
  setCls('help', 'shopping', h >= 0);
  if (h < 0) {
    shopUi.key = '';
    if (shopVis) { shopVis = false; $('shop').classList.add('hidden'); }
    return;
  }
  const p = sim.f[h], sel = p.shop - 1, spells = !!p.shopK, mine = spells ? spellKey(p) : p.wpn;
  const key = [h, p.shopK, sel, mine].join('|');
  if (key === shopUi.key) return;
  shopUi.key = key;
  const list = spells ? SPELL_IDS : WEAPON_IDS, id = list[sel];
  setCls('shop', 'spells', spells);
  $('shopMine').classList.toggle('hidden', id !== mine);
  const stats = [];
  if (spells) {
    const S = SPELLS[id];
    $('shopName').textContent = `${SPELL_ICON[id] ?? ''} ${S.name}`;
    $('shopMine').textContent = '✓ TON SORT';
    $('shopDesc').textContent = S.desc;
    stats.push(`<span>Recharge <b>${S.cd} s</b></span>`, `<span><b>${spellOwner(id)}</b></span>`);
  } else {
    const w = WEAPONS[id];
    $('shopName').textContent = w.name;
    $('shopMine').textContent = '✓ TON ARME';
    $('shopDesc').textContent = w.desc;
    if (w.summon) stats.push(`<span>Invocation <b>×${CAST.max} chiens</b></span>`);
    else if (w.fire) stats.push(`<span>Dégâts <b>${FIRE.dmg} (zone)</b></span>`);
    else if (w.bow) stats.push(`<span>Tir <b>${SHOT.dmg} dégâts</b></span>`);
    else stats.push(`<span>Dégâts <b>${w.dmg}</b> · <b>${w.combo}</b> coup${w.combo > 1 ? 's' : ''}</span>`);
    stats.push(`<span>Portée <b>${w.bow ? 'Distance' : w.reach >= 1.9 ? 'Longue' : w.reach <= 1.2 ? 'Courte' : 'Moyenne'}</b></span>`);
    stats.push(`<span>Garde <b>${w.guard <= 0.65 ? 'Excellente' : w.guard <= 1.05 ? 'Bonne' : 'Fragile'}</b></span>`);
    if (w.tank) stats.push(`<span>Armure <b>−${Math.round(w.tank * 100)} %</b></span>`);
    if (w.crush) stats.push(`<span>Brise-garde <b>×${w.crush}</b></span>`);
    if (w.run > 1.05) stats.push('<span>Course <b>Rapide</b></span>');
    else if (w.run < 0.92) stats.push('<span>Course <b>Lourde</b></span>');
  }
  $('shopStats').innerHTML = stats.map((s) => `<span class="wstat">${s}</span>`).join('');
  $('shopList').innerHTML = list.map((wid, n) =>
    `<button class="${n === sel ? 'on' : ''}${wid === mine ? ' mine' : ''}" data-k="${n}"><kbd>${n + 1}</kbd>${spells ? `${SPELL_ICON[wid] ?? ''} ${esc(SPELLS[wid].name)}` : esc(SHOP_SHORT[wid] ?? WEAPONS[wid].name)}</button>`).join('');
  $('shopList').querySelectorAll('button').forEach((bt) => { bt.onclick = () => { shopReq[h] = +bt.dataset.k; }; });
  const ks = KEYSETS[localHeroes().length > 1 ? h : 0];
  const k1 = (act) => kb(key1(ks, act) ?? '?');
  $('shopKeys').innerHTML = `${k1('l')} ${k1('r')} choisir · ${k1('atk')} ou ${k1('jump')} prendre · ${k1('d')} ou ${k1('blk')} partir`;
  shopVis = true;
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
// Reconstruit uniquement les éléments dynamiques (piliers, estrades, pièges) du Sanctuaire mouvant du Souverain d'Os
function rebuildDynamicArena(room, instant = false) {
  if (!dng.dynGroup) return;
  disposeTree(dng.dynGroup);
  dng.dynGroup.clear();
  dng.traps = [];
  dng.dynMixers = [];
  const B = BIOME.ossuary;
  for (const s of room.surf) {
    for (let x = s.x0 + TILE / 2; x < s.x1; x += TILE) {
      for (let z = s.z0 + TILE / 2; z < s.z1; z += TILE) {
        if (!s.ramp) {
          const blk = P(B.block[0], x, 0, z, rot4(), S, dng.dynGroup, true);
          blk.scale.y = PLAT_H / B.block[1];
          P(B.floor[0], x, PLAT_H + 0.003, z, rot4(), S, dng.dynGroup, false);
        } else {
          const dir = Math.sign(s.to - s.from), dx = s.ramp === 'x' ? dir : 0, dz = s.ramp === 'z' ? dir : 0;
          const st = P('d_stairs', x, 0, z, Math.atan2(-dx, -dz), S, dng.dynGroup, true);
          st.scale.y = PLAT_H / 0.9;
        }
      }
    }
  }
  for (const o of room.obs) {
    const [key, s, square] = B.obs[o.kind] ?? B.obs.column;
    P(key, o.x, 0, o.z, square ? rot4() : rand(0, TAU), S * s, dng.dynGroup, true);
  }
  room.traps.forEach((t) => {
    const o = P('d_trap', t.x, 0.004, t.z, 0, S, dng.dynGroup, false);
    const mx = new THREE.AnimationMixer(o);
    playOnce(mx, 'd_trap', 'hide');
    mx.update(1);
    dng.dynMixers.push(mx);
    dng.traps.push({ x: t.x, z: t.z, mx, up: false, warnT: 0 });
  });
  dng.dynGrow = instant ? 1 : 0;
  dng.dynGroup.position.y = instant ? 0 : -1.4;
}

// vue du combattant i du donjon : héros, ennemi ou chien invoqué
function makeView(i) {
  const e = sim.f[i], np = sim.g.np;
  if (e.kind === 'cerbere') {
    const v = new DogView(i, 'cerbere', hellGlow);
    v.team = e.team;
    v.setSize(e.size);
    v.ring.material.color.set(0xff3020);      // pas de petite barre : grande barre de boss en haut
    return v;
  }
  if (e.kind === 'dog') {
    // chien du grimoire (violet), ou chien des enfers (pelage brûlé, yeux rouges) dans le camp ennemi
    const hell = e.team === 1;
    const v = new DogView(i, 'dog', hell ? hellGlow : runeColor);
    v.team = e.team;
    v.setSize(e.size);
    if (hell) { for (const m of v.mats) m.color.setRGB(0.85, 0.42, 0.36); v.ring.material.color.set(0xe0452f); }
    v.addHpBar(hell ? 0xe0452f : 0xb98aff);
    v.hpBar.position.y = 1.05;
    return v;
  }
  if (e.kind === 'squelette') {
    const v = new FighterView(i, 'zombie', e.wpn);
    v.kind = 'squelette';
    v.team = e.team;
    v.setSize(e.size);
    dressSkeleton(v, !!e.boss);
    v.ring.material.color.set(e.boss ? 0x3aff9e : 0x6effb8);
    if (!e.boss) v.addHpBar(0x6effb8);
    return v;
  }
  const v = new FighterView(i, e.kind, e.wpn);
  v.team = e.team;
  if (i < np) {
    v.hero = true;
    v.ring.material.color.set(np > 1 ? HERO_COL[i] : 0xffd34a);
  } else {
    v.setSize(e.size);
    v.ring.material.color.set(e.boss || e.eliteChamp ? 0xff3020 : 0xb03a2a);
    if (!e.boss) v.addHpBar(e.eliteChamp ? 0xff7040 : 0xe0452f);          // les boss ont leur grande barre en haut de l'écran
    // le colosse : un automate géant coulé dans le bronze ; champion d'élite : teinte pourpre/bronze
    if (e.foe === 'colosse') for (const m of v.mats) m.color.setRGB(1.3, 0.82, 0.42);
    else if (e.eliteChamp) for (const m of v.mats) m.color.setRGB(1.28, 0.68, 0.56);
  }
  return v;
}
// chiens invoqués ou ennemis mis à jour en cours de salle : seules leurs vues changent
function extraViews() {
  while (F.length > sim.f.length) F.pop().dispose();
  for (let i = sim.g.np; i < F.length; i++) {
    if (F[i].kind !== sim.f[i].kind || F[i].team !== sim.f[i].team) { F[i].dispose(); F[i] = makeView(i); }
  }
  while (F.length < sim.f.length) F.push(makeView(F.length));
}

// un héros a changé de personnage ou d'arme (salle d'armes) : nouvelle vue
function heroViews() {
  for (let i = 0; i < sim.g.np && i < F.length; i++) {
    const e = sim.f[i], v = F[i];
    if (v.kind === e.kind && v.wpn === e.wpn) continue;
    v.dispose();
    const n = new FighterView(i, e.kind, e.wpn);
    n.hero = true;
    n.team = e.team;
    n.ring.material.color.copy(v.ring.material.color);
    F[i] = n;
    // si notre salon est ouvert dans la salle d'armes, on met à jour son aperçu sur le serveur
    if (net.hall && !net.live && i === 0) netSend({ t: 'hall_state', kind: e.kind, wpn: e.wpn });
  }
}

// héros et armes choisis dans la salle d'armes : proposés à nouveau la prochaine fois
function saveHeroes() {
  const loc = localHeroes();
  loc.forEach((h, k) => {
    const n = match?.mode === 'online' ? 1 : k + 1;
    cfg['p' + n] = sim.f[h].kind;
    cfg['w' + n] = sim.f[h].wpn;
    cfg['s' + n] = sim.f[h].spell;
  });
  saveCfg();
}

// la salle affichée rattrape celle de la simulation
// on quitte la salle d'armes (porte franchie : la carte s'ouvre, ou la salle 1 commence)
function leaveHall() {
  dng.hallLeft = true;
  saveHeroes();
  if (coop?.role === 'host') {
    // à deux : retirer le salon de la liste publique
    netSend({ t: 'hall_state', open: false });
    net.hall = false;
  } else if (!net.live && net.ws) {
    netClose();   // on ne se rejoint que dans la salle d'armes
  }
}
function dungeonRoom() {
  if (dng.room === 0 && sim.g.room === 1 && !dng.hallLeft) leaveHall();
  dng.hallLeft = sim.g.room !== 0;
  buildDungeonRoom(sim.room, sim.g.room);
  // entrée dans un nouveau biome : son nom s'affiche au-dessus de « SALLE n »
  const n = sim.g.room;
  const runSeed = sim.map?.runSeed ?? sim.runSeed ?? 0;
  const curBiome = sim.room.biome && BIOME[sim.room.biome] ? sim.room.biome : sim.room.lair === 'squelette' ? 'ossuary' : sim.room.lair ? 'lair' : (sim.room.act ? biomeOfAct(sim.room.act, runSeed) : biomeOf(n, runSeed));
  if (n >= 1 && dng.room >= 0 && curBiome !== dng.lastBiome && !sim.room.hub && !sim.room.vault) {
    const b = $('biome');
    b.textContent = (BIOME[curBiome] ?? BIOME.crypt).name;
    b.className = '';
    void b.offsetWidth;
    b.className = 'show';
  }
  dng.lastBiome = curBiome;
  dng.room = sim.g.room;
  dng.rn = sim.g.rn;
  dng.arenaVer = sim.g.arenaVer ?? 0;
  dng.roomVer = coop?.role === 'guest' ? coop.roomVer : 0;
  dungeonViews();
  snapCamera();
  if (n >= 1) saveRun();
}

// À chaque image : porte, objets à ramasser, pièges, carte et événements suivent la simulation
// (g.rn change à chaque salle, y compris la salle au trésor qui garde le numéro g.room)
let syncT = 0;
function dungeonSync() {
  if (coop?.role === 'guest' && !coop.ready) return;
  const g = sim.g;
  const dt = Math.min(0.1, clockT - syncT);
  syncT = clockT;
  const sameRoom = dng.room === g.room && dng.rn === g.rn;
  const arenaChanged = sameRoom && sim.room?.lair === 'squelette' && dng.arenaVer !== (g.arenaVer ?? 0);
  if (arenaChanged) {
    dng.arenaVer = g.arenaVer ?? 0;
    if (coop?.role === 'guest') dng.roomVer = coop.roomVer;
    rebuildDynamicArena(sim.room, false);
  }
  const needRoom = !sameRoom || (coop?.role === 'guest' && dng.roomVer !== coop.roomVer);
  if (needRoom) dungeonRoom();
  else { heroViews(); extraViews(); }
  if (g.room === 0 && g.phase === 'map' && !dng.hallLeft && dng.room === 0) leaveHall();
  if (g.exitOpen && !dng.gateOpen) { dng.gateOpen = true; dng.gate?.open(); }
  pkSync(dt, clockT);
  totemSync(dt, clockT);
  itemCard();
  bannerTick();
  dng.traps.forEach((t, k) => {
    const up = trapUp(g.clock, k);
    if (up !== t.up) {
      t.up = up;
      playOnce(t.mx, 'd_trap', up ? 'show' : 'hide');
      if (up) { sfx.clang(); emit(t.x, 0.2, t.z, 8, { color: [0xc0c0c8, 0x8a8090], speed: 1.4, up: 2.5, size: 0.06, life: 0.5, grav: 6 }); }
    }
    // avertissement : un peu de poussière juste avant la sortie des pics
    const ph = trapPhase(g.clock, k);
    if (!up && ph > TRAP.up0 - TRAP.warn && ph < TRAP.up0 && --t.warnT < 0) {
      t.warnT = 4;
      emit(t.x + rand(-0.5, 0.5), 0.05, t.z + rand(-0.5, 0.5), 1, { color: 0x8a8090, speed: 0.4, up: 1, size: 0.06, life: 0.4, grav: 3 });
    }
  });
  eventSync();
  mapSync();
  bossTele();
  if (g.phase === 'end' && !dng.endShown) endDungeon();
  else if (g.phase !== 'end' && dng.endShown) {
    // reprise en Mode Infini (local ou propagée par l'hôte coop)
    dng.endShown = false;
    $('result').classList.add('hidden');
    $('help').classList.remove('hidden');
  }
}

// ---------- Totem de vie (sort) : un totem 3D par lanceur, déduit de f.totT / totX / totY / totZ ----------
const totRingGeo = new THREE.RingGeometry(SPELLS.totem.R - 0.08, SPELLS.totem.R, 48).rotateX(-Math.PI / 2);
const totDiscGeo = new THREE.CircleGeometry(SPELLS.totem.R, 48).rotateX(-Math.PI / 2);
keep(totRingGeo, totDiscGeo);
const totCol = new THREE.Color(0x8fe36a);
function totemSync(dt, T) {
  const np = Math.min(sim.g.np, sim.f.length), S = SPELLS.totem;
  for (let i = 0; i < Math.max(np, dng.tot.length); i++) {   // dng.tot peut garder le totem d'un équipier parti
    const f = i < np ? sim.f[i] : null;
    let v = dng.tot[i];
    if (!(f?.totT > 0)) { if (v) { v.g.visible = false; v.x = NaN; } continue; }   // NaN : le prochain repoussera du sol
    if (!v) {
      const g = new THREE.Group();
      const m = inst('totem', 1);
      const gem = glowNode(m, 'gem', totCol);
      const mat = (o) => new THREE.MeshBasicMaterial({ color: totCol, transparent: true, opacity: o, depthWrite: false, toneMapped: false });
      const ring = new THREE.Mesh(totRingGeo, mat(0.6)), disc = new THREE.Mesh(totDiscGeo, mat(0.08));
      ring.position.y = 0.03; disc.position.y = 0.02; ring.renderOrder = disc.renderOrder = 2;
      g.add(m, ring, disc);
      world.add(g);
      v = dng.tot[i] = { g, m, gem, ring, disc, grow: 0, x: NaN, z: NaN };
    }
    // un nouveau totem (autre position) repousse depuis le sol
    if (v.x !== f.totX || v.z !== f.totZ) { v.x = f.totX; v.z = f.totZ; v.grow = 0; v.g.position.set(f.totX, f.totY, f.totZ); }
    v.g.visible = true;
    v.grow = Math.min(1, v.grow + dt * 3.5);
    const fade = Math.min(1, f.totT / 0.4);                 // il s'enfonce dans le sol à la fin
    const up = v.grow < 1 ? v.grow * (1 + 0.35 * Math.sin(v.grow * Math.PI)) : 1;
    v.m.scale.set(1, Math.max(0.01, up * fade), 1);
    if (v.gem) { v.gem.rotation.y = T * 2; v.gem.position.y = 0.04 * Math.sin(T * 3); }
    // l'anneau s'illumine à chaque soin (totK repart de S.tick), puis s'éteint doucement
    const p = clamp((f.totK ?? 0) / S.tick, 0, 1);
    v.ring.material.opacity = (0.25 + 0.55 * p * p) * fade;
    v.disc.material.opacity = (0.05 + 0.1 * p * p) * fade;
  }
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
  // fauchage tournoyant du Souverain d'Os + groupe de télégraphes de mutation d'arène (shift)
  const reap = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 48).rotateX(-Math.PI / 2), mat(0x3aff9e, 0.55));
  const shiftG = new THREE.Group();
  shiftG.visible = false;
  scene.add(shiftG);
  const shiftObsGeo = new THREE.CircleGeometry(BOSS.shift.pillarR, 28).rotateX(-Math.PI / 2);
  const shiftTrapGeo = new THREE.PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2);
  const shiftSurfGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shiftObsMat = mat(0x3aff9e, 0.35), shiftTrapMat = mat(0xff3a30, 0.38), shiftSurfMat = mat(0x7ae4ff, 0.25);
  keep(shiftObsGeo, shiftTrapGeo, shiftSurfGeo, shiftObsMat, shiftTrapMat, shiftSurfMat);
  for (const m of [disk, fill, edge, lane, cone, bite, reap]) { m.renderOrder = 2; m.visible = false; scene.add(m); }
  return { disk, fill, edge, lane, tex, cone, bite, reap, shiftG, shiftLayout: -1, shiftObsGeo, shiftTrapGeo, shiftSurfGeo, shiftObsMat, shiftTrapMat, shiftSurfMat };
})();
const telePos = { x: 0, z: 0 };
function bossTele() {
  let e = null, b = null;
  for (let i = 0; i < sim.f.length; i++) {
    const o = sim.f[i];
    if (!e && o.sp && o.state !== 'dead' && o.team === 1) e = o;
    if (!b && o.brute && o.state === 'attack' && o.stateT < windupOf(o)) b = o;
  }
  const slam = e?.sp === 'slam' && e.spA < 2, charge = e?.sp === 'charge' && e.spA === 0;
  const reaping = e?.sp === 'reap';
  const shifting = (sim.g.arenaNext ?? -1) >= 0 && (sim.g.arenaQuake ?? 0) > 0;
  tele.disk.visible = tele.fill.visible = tele.edge.visible = slam;
  tele.lane.visible = charge;
  tele.cone.visible = e?.sp === 'fire';
  tele.reap.visible = reaping;
  tele.shiftG.visible = shifting;
  if (reaping) {
    tele.reap.position.set(e.x, e.y + 0.05, e.z);
    tele.reap.scale.setScalar(BOSS.reap.R);
    tele.reap.material.opacity = e.spA === 0 ? 0.35 + 0.25 * Math.sin(clockT * 24) : 0.65;
  }
  if (shifting) {
    const idx = sim.g.arenaNext;
    if (tele.shiftLayout !== idx) {
      tele.shiftLayout = idx;
      tele.shiftG.clear();
      const L = ARENA_LAYOUTS[idx];
      if (L) {
        for (const [i, j] of L.obs) {
          const m = new THREE.Mesh(tele.shiftObsGeo, tele.shiftObsMat);
          m.position.set(i * TILE, 0.05, j * TILE); m.renderOrder = 2; tele.shiftG.add(m);
        }
        for (const s of L.surf) {
          const m = new THREE.Mesh(tele.shiftSurfGeo, tele.shiftSurfMat);
          m.scale.set(s.x1 - s.x0, 1, s.z1 - s.z0);
          m.position.set((s.x0 + s.x1) / 2, 0.04, (s.z0 + s.z1) / 2); m.renderOrder = 2; tele.shiftG.add(m);
        }
        for (const [i, j] of L.traps) {
          const m = new THREE.Mesh(tele.shiftTrapGeo, tele.shiftTrapMat);
          m.position.set(i * TILE, 0.05, j * TILE); m.renderOrder = 2; tele.shiftG.add(m);
        }
      }
    }
    const pulse = 0.22 + 0.25 * Math.abs(Math.sin(clockT * 10));
    tele.shiftObsMat.opacity = pulse + 0.12;
    tele.shiftTrapMat.opacity = pulse + 0.16;
    tele.shiftSurfMat.opacity = pulse * 0.85;
  } else tele.shiftLayout = -1;
  // morsure préparée de Cerbère (pas une attaque spéciale : on cherche le boss qui se ramasse)
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
    telePos.x = e.spX; telePos.z = e.spZ;
    const y = sim.groundY(telePos) + 0.04;
    tele.disk.position.set(e.spX, y, e.spZ);
    tele.fill.position.set(e.spX, y, e.spZ);
    tele.edge.position.set(e.spX, y, e.spZ);
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
    $('bbSub').textContent = `${{ colosse: "Gardien d'airain", cerbere: 'Gardien des enfers', squelette: 'Seigneur des ossements' }[e.foe] ?? 'Seigneur de guerre'} · salle ${g.room}`;
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

// ---------- Sauvegarde / Reprise d'une run Donjon solo ----------
function saveRun() {
  if (!isDungeon() || match?.mode !== 'solo' || net.live || !sim?.useMap || sim.g.phase === 'dead' || sim.g.phase === 'end') return;
  if (sim.g.room < 1 && sim.g.phase !== 'map') return;
  try {
    localStorage.setItem(RUN_SAVE_KEY, JSON.stringify({
      v: 1,
      hero: sim.f[0]?.kind ?? 'soldier',
      wpn: sim.f[0]?.wpn ?? 'sword',
      act: sim.g.act || 1,
      room: sim.g.room || 0,
      snap: sim.save(),
    }));
  } catch (e) { /* stockage plein ou indisponible */ }
}
function loadSavedRun() {
  try {
    const raw = JSON.parse(localStorage.getItem(RUN_SAVE_KEY) || 'null');
    if (raw && raw.v === 1 && raw.snap && raw.snap.map && raw.snap.g && raw.snap.f?.length) return raw;
  } catch (e) { /* ignoré */ }
  return null;
}
function clearSavedRun() { try { localStorage.removeItem(RUN_SAVE_KEY); } catch (e) { /* ignoré */ } }

// m : { mode: 'solo' | 'duo' | 'online', p1, p2, seed, sid, resumeSnap }
// sort appris chez le sorcier (clé de SPELLS), '' = celui du héros
const cleanSpell = (x) => (typeof x === 'string' && SPELLS[x] ? x : '');
function startDungeon(m = { mode: cfg.mode === 'duo' ? 'duo' : 'solo', p1: cfg.p1, p2: cfg.p2, w1: cfg.w1, w2: cfg.w2, s1: cfg.s1, s2: cfg.s2 }) {
  match = { ...m, game: 'dungeon' };
  net.live = m.mode === 'online';
  rb = null;
  coop = null;
  ac();
  game.paused = false;
  mapPeek = false;
  ['menu', 'result', 'pause', 'itemCard', 'guideOv', 'gfxSec', 'mapOv', 'eventOv'].forEach((id) => $(id)?.classList.add('hidden'));
  $('gfxToggleBtn')?.classList.remove('active');
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
  const sendCoop = (msg, reliable) => (net.link ? net.link.send(msg, reliable) : netSend(msg));
  F.forEach((v) => v.dispose());
  F = [];
  ai = ai0 = null;
  pending[0] = pending[1] = 0;
  tapped[0].clear(); tapped[1].clear();
  mapReq.fill(-1); mapSent.fill(false);
  evtReq.fill(-1); evtSent.fill(false);
  shopReq.fill(-1);
  mapUi = ''; evtUi = '';
  dng.room = -1;
  dng.rn = -1;
  bannerQ.length = 0;
  cardKey = '';
  uiItems[0] = uiItems[1] = null;
  dng.roomVer = -1;
  dng.lastBiome = '';
  dng.endShown = false;
  for (const k in uiTxt) delete uiTxt[k];   // l'arène a pu réécrire ces textes
  if (m.mode === 'online' && net.role === 'guest') {
    // Invité COOP : reçoit l'état autoritaire de l'hôte (zéro rollback, zéro désync)
    coop = new CoopGuest({ sid: m.sid || 1, send: sendCoop, unlocked: unlocks });
    sim = coop.sim;
    acc = 0;
    return;
  }
  sim = new DungeonSim(seed, np > 1 ? [m.p1, m.p2] : [m.p1], [m.w1, m.w2], unlocks.slice(0, np), [cleanSpell(m.s1), cleanSpell(m.s2)], { useMap: true });
  if (m.resumeSnap) {
    sim.load(m.resumeSnap);
    sim.ev.length = 0;
  } else {
    if (m.mode === 'solo') clearSavedRun();
    sim.startHub();   // on commence dans la salle d'armes
    playEvents(sim.ev);
    sim.ev.length = 0;
  }
  if (m.mode === 'online') {
    // Hôte COOP : simulation autoritaire à 60 Hz, diffusion compacte à 30 Hz
    coop = new CoopHost(sim, { sid: m.sid || nextSid(), send: sendCoop });
  }
  dungeonRoom();
  if (sim.g.exitOpen) { dng.gateOpen = true; dng.gate?.open(true); }
  acc = 0;
}
function resumeDungeon() {
  const saved = loadSavedRun();
  if (!saved) return;
  startDungeon({ mode: 'solo', p1: saved.hero, p2: cfg.p2, w1: saved.wpn, w2: cfg.w2, seed: saved.snap.runSeed || 1, resumeSnap: saved.snap });
}

function endDungeon() {
  if (dng.endShown) return;
  dng.endShown = true;
  const g = sim.g, won = !!g.victory;
  if (match?.mode === 'solo' && !won) clearSavedRun();
  mapPeek = false;
  ['mapOv', 'eventOv', 'mapToggleBtn'].forEach((id) => $(id)?.classList.add('hidden'));
  $('resDefis').innerHTML = '';
  $('result').classList.toggle('lose', !won);
  const rec = dungeonRecord(), best = g.room > rec;
  const me = sim.f[localHeroes()[0] ?? 0];     // à deux sur un clavier : le compte suit le joueur 1
  if (me) accountRun(g.room, me.kills, me.kind, me.wpn);
  const guest = net.live && net.role === 'guest';
  if (best) try { localStorage.setItem(DNG_REC, String(g.room)); } catch (e) { /* ignoré */ }
  $('resTitle').textContent = won ? 'VICTOIRE !' : (g.np > 1 ? 'VAINCUS…' : 'VAINCU…');
  $('resSub').textContent = (won
    ? `Souverain d’Os vaincu · Salle ${g.room} · ${g.kills} ennemi${g.kills > 1 ? 's' : ''} vaincu${g.kills > 1 ? 's' : ''}`
    : `Tombé${g.np > 1 ? 's' : ''} dans la salle ${g.room} · ${g.kills} ennemi${g.kills > 1 ? 's' : ''} vaincu${g.kills > 1 ? 's' : ''}`) +
    (best ? ' · nouveau record !' : ` · record : salle ${rec}`) +
    (guest ? (won ? '  ·  l’hôte peut continuer en Infini ou relancer' : '  ·  l’hôte peut relancer') : '');
  // objets de la partie, par héros
  let items = '';
  for (let i = 0; i < g.np; i++) {
    const p = sim.f[i];
    if (!p) continue;
    const icons = itemList(p).map((id) => { const it = itemOf(id); return it ? `<i class="q${it.q}" title="${esc(it.name)}">${it.icon}</i>` : ''; }).join('');
    const tf = (p.tf ? p.tf.split(',') : []).map((f) => FAMILIES[f] ? `<i class="tf">${FAMILIES[f].icon} ${esc(FAMILIES[f].tf)}</i>` : '').join('');
    items += `<div class="row">${g.np > 1 ? `<b>J${i + 1}</b>` : ''}${tf}${icons || '<span>aucun objet</span>'}</div>`;
  }
  $('resItems').innerHTML = items;
  $('endlessBtn').classList.toggle('hidden', !won || guest);
  $('againBtn').classList.toggle('hidden', guest);
  $('result').classList.remove('hidden');
  $('help').classList.add('hidden');
}

// ---------- Choix d'un événement au clavier ----------
// touches : seul ou en ligne 1 2 3 ; à deux sur le même clavier J1 1 2 3, J2 8 9 0 (ou pavé 1 2 3)
function choiceKey(code) {
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

// ---------- Carte des chemins (phase 'map' + consultation 'M') ----------
let mapUi = '', mapOpen = false, mapPeek = false;
function canPeekMap() {
  return isDungeon() && !!sim?.map && sim.g.room >= 1 && !game.paused
    && ['intro', 'fight', 'clear'].includes(sim.g.phase);
}
function toggleMapPeek(force) {
  if (!canPeekMap() && force !== false) return;
  mapPeek = force !== undefined ? !!force : !mapPeek;
  mapUi = '';
  if (mapPeek) down.clear();
  else if (!mapPreviewState && sim.g.phase !== 'map') { mapOpen = false; $('mapOv').classList.add('hidden'); }
}
function mapChoiceKey(code) {
  const d = /^Digit(\d)$/.exec(code), np = /^Numpad([1-4])$/.exec(code);
  const loc = localHeroes();
  if (loc.length > 1) {
    if (d && '1234'.includes(d[1])) return [0, +d[1] - 1];
    if (d && '8907'.includes(d[1])) return [1, '8907'.indexOf(d[1])];
    if (np) return [1, +np[1] - 1];
    return null;
  }
  if (d && '1234'.includes(d[1])) return [loc[0], +d[1] - 1];
  if (np) return [loc[0], +np[1] - 1];
  return null;
}
function pickMapChoice(h, idx) {
  if (!isDungeon() || sim.g.phase !== 'map' || !sim.map || h === undefined || !localHeroes().includes(h)) return;
  const avail = availableNextIds(sim.map);
  if (idx < 0 || idx >= avail.length) return;
  mapReq[h] = idx;
  mapSent[h] = false;
  mapUi = '';
}
function clickMapNode(id) {
  if (!sim?.map) return;
  const idx = availableNextIds(sim.map).indexOf(id);
  if (idx < 0) return;
  const loc = localHeroes();
  const who = loc.find((h) => !sim.g['mapVote' + h]) ?? loc[0];
  pickMapChoice(who, idx);
}
function mapSync() {
  if (mapPreviewState) return;
  const g = sim.g;
  const showPick = g.phase === 'map' && !!sim.map;
  if (showPick && mapPeek) mapPeek = false;
  if (!showPick && mapPeek && !canPeekMap()) mapPeek = false;
  const show = showPick || (mapPeek && !!sim.map);
  if (!show) {
    mapUi = '';
    if (mapOpen) { mapOpen = false; $('mapOv').classList.add('hidden'); }
    mapReq[0] = mapReq[1] = -1;
    mapSent[0] = mapSent[1] = false;
    return;
  }
  const loc = localHeroes();
  const key = [showPick ? 'pick' : 'peek', sim.map.act, sim.map.currentId, sim.map.visited.length, g.mapVote0, g.mapVote1, ...mapReq].join('|');
  if (key === mapUi) return;
  const justOpened = !mapOpen && showPick;
  if (!mapUi) down.clear();
  mapUi = key;
  if (justOpened) saveRun();
  let statusText = '';
  if (showPick && g.np > 1) {
    const v0 = g.mapVote0 ? '✔ voté' : 'choisit…';
    const v1 = g.mapVote1 ? '✔ voté' : 'choisit…';
    statusText = `Vote coop : J1 ${v0} · J2 ${v1} (accord = départ, désaccord = tirage au sort)`;
  }
  renderMap($('mapOv'), sim.map, {
    interactive: showPick,
    duoKeys: loc.length > 1,
    votes: showPick && g.np > 1 ? [g.mapVote0, g.mapVote1] : [],
    statusText,
    canClose: !showPick,
    onClose: () => toggleMapPeek(false),
    onPick: clickMapNode,
  });
  mapOpen = true;
  $('mapOv').classList.remove('hidden');
}

// ---------- Événements mystérieux '?' (phase 'event') ----------
let evtUi = '', evtOpen = false, lastEventLog = '';
function pickEventChoice(h, idx) {
  if (!isDungeon() || sim.g.phase !== 'event' || h === undefined || !sim.mustPickEvent(h) || !localHeroes().includes(h)) return;
  evtReq[h] = idx;
  evtSent[h] = false;
  evtUi = '';
}
function clickEventChoice(idx) {
  const who = localHeroes().find((h) => sim.mustPickEvent(h) && evtReq[h] < 0);
  pickEventChoice(who, idx);
}
function eventSync() {
  const g = sim.g;
  if (g.phase !== 'event' || !Object.hasOwn(EVENTS, g.eventId)) {
    if (evtOpen && g.eventLog && g.eventLog !== lastEventLog) {
      lastEventLog = g.eventLog;
      announce(g.eventLog.slice(0, 68), '', 2.2);
    }
    evtUi = '';
    if (evtOpen) { evtOpen = false; $('eventOv').classList.add('hidden'); }
    evtReq[0] = evtReq[1] = -1;
    evtSent[0] = evtSent[1] = false;
    return;
  }
  lastEventLog = '';
  const loc = localHeroes();
  for (const h of [0, 1]) if (!sim.mustPickEvent(h)) { evtReq[h] = -1; evtSent[h] = false; }
  const ev = EVENTS[g.eventId];
  const key = [g.room, g.eventId, g.evPick0, g.evPick1, ...evtReq].join('|');
  if (key === evtUi) return;
  if (!evtUi) down.clear();
  evtUi = key;
  const duo = loc.length > 1;
  $('evTitle').textContent = ev.title;
  $('evText').textContent = ev.text;
  const canAny = loc.some((h) => sim.mustPickEvent(h) && evtReq[h] < 0);
  $('evChoices').innerHTML = ev.choices.map((ch, i) => {
    const keys = duo ? `${i + 1}</kbd> <kbd>${'890'[i]}` : `${i + 1}`;
    return `<button type="button" class="ev-choice tone-${ch.tone || 'neutral'}" data-i="${i}"${canAny ? '' : ' disabled'}>`
      + `<b><kbd>${keys}</kbd> ${esc(ch.label)}</b><span>${esc(ch.hint)}</span></button>`;
  }).join('');
  $('evChoices').querySelectorAll('button').forEach((b) => { b.onclick = () => clickEventChoice(+b.dataset.i); });
  if (g.np > 1) {
    const st = [0, 1].map((h) => {
      const p = sim.f[h], pk = g['evPick' + h];
      return `J${h + 1} (${Math.ceil(p.hp)}/${p.maxHp} PV) : ${pk >= 0 ? '✔ choisi' : 'choisit…'}`;
    });
    $('evStatus').textContent = st.join('   ·   ');
  } else {
    const p = sim.f[0];
    $('evStatus').textContent = `PV actuels : ${Math.ceil(p.hp)} / ${p.maxHp}`;
  }
  evtOpen = true;
  $('eventOv').classList.remove('hidden');
}

const uiTxt = {};
function setTxt(id, v) { if (uiTxt[id] !== v) { uiTxt[id] = v; $(id).textContent = v; } }
// largeur (en %) et classe d'un élément du HUD, écrites seulement quand elles changent (à chaque image sinon,
// le navigateur recalcule les styles de la page pour rien)
const uiW = {}, uiC = {};
function setW(id, pct) { const v = Math.round(pct * 10) / 10; if (uiW[id] !== v) { uiW[id] = v; $(id).style.width = v + '%'; } }
function setCls(id, cls, on) { const k = id + '.' + cls; if (uiC[k] !== on) { uiC[k] = on; $(id).classList.toggle(cls, on); } }
// objets d'un héros sous sa barre de sort (réécrits seulement quand ils changent)
const uiItems = [null, null];
function itemsHud(p, i) {
  const key = p ? `${p.items}|${p.tf}|${p.combos}|${p.minors}` : '';
  if (uiItems[i] === key) return;
  uiItems[i] = key;
  if (!p) { $('it' + (i + 1)).innerHTML = ''; return; }
  const tip = (a, b) => `title="${esc(a)} — ${esc(b)}"`;
  let h = '';
  for (const id of (p.tf ? p.tf.split(',') : [])) { const F = FAMILIES[id]; if (F) h += `<i class="tf" ${tip(F.tf, F.desc)}>${F.icon} ${esc(F.tf)}</i>`; }
  for (const id of (p.combos ? p.combos.split(',') : [])) { const c = COMBOS[id]; if (c) h += `<i class="cb" ${tip(c.name, c.desc)}>✦ ${esc(c.name)}</i>`; }
  for (const id of itemList(p)) { const it = itemOf(id); if (it) h += `<i class="q${it.q}" ${tip(it.name, it.desc)}>${it.icon}</i>`; }
  if (p.minors) h += `<i class="mn" title="Petits bonus ramassés">+${p.minors}</i>`;
  $('it' + (i + 1)).innerHTML = h;
}
function dungeonHud() {
  const g = sim.g;
  bossHud();
  for (let i = 0; i < g.np; i++) {
    const p = sim.f[i];
    if (!p) continue;
    const n = i + 1, hp = Math.max(0, p.hp / p.maxHp * 100);
    setW('h' + n, hp);
    setCls('h' + n, 'low', hp < 30);
    setW('t' + n, hp);
    setW('g' + n, Math.max(0, p.guard));
    setCls('g' + n, 'low', p.guard < 30);
    setW('s' + n, Math.max(0, p.sta));
    setCls('s' + n, 'low', p.sta < STA.tired);
    setCls('s' + n, 'fail', p.staFail > 0);
    updateSpellHud(p, n, match?.mode === 'duo' || (net.live ? i === net.me : i === 0));
    const nm = net.live ? (i === net.me ? myName() : net.peerName) : g.np === 1 ? myName() : '';
    const who = nm ? `${nm} · ` : g.np > 1 ? `J${n} · ` : '';
    const what = g.room === 0 ? `${HEROES[p.kind].name} · ${WEAPONS[p.wpn].name}` : HEROES[p.kind].name;
    const st = p.state === 'dead' ? 'À TERRE' : (g.room === 0 && p.shop > 0 ? 'EN BOUTIQUE' : `${Math.ceil(p.hp)} / ${p.maxHp} PV`);
    setTxt('n' + n, who + what + ' · ' + st);
    itemsHud(p, i);
  }
  if (g.np < 2) itemsHud(null, 1);
  const rtLbl = { elite: 'ÉLITE', treasure: 'TRÉSOR', event: 'ÉVÉNEMENT', boss: 'BOSS' }[g.roomType] || '';
  setTxt('timer', !g.room ? "SALLE D'ARMES" : sim.map ? `ACTE ${g.act} · ${g.vault ? 'TRÉSOR' : rtLbl || 'SALLE ' + g.room}` : g.vault ? 'SALLE AU TRÉSOR' : `SALLE ${g.room}`);
  setCls('mapToggleBtn', 'hidden', !canPeekMap());
  if (g.room === 0) {
    const shopping = g.np > 1 && sim.heroes.some((h) => h.shop > 0);
    setTxt('roundLbl', g.phase === 'map' ? 'CHOISIS LA PREMIÈRE SALLE SUR LA CARTE'
      : shopping ? 'ÉQUIPIER EN BOUTIQUE — ATTENDS-LE AVANT DE PASSER LA PORTE' : 'CHOISIS TON HÉROS, PRENDS TON ARME CHEZ LE MARCHAND, PUIS PASSE LA PORTE');
    return;
  }
  const left = sim.foesLeft;
  const me = sim.f[localHeroes()[0] ?? 0];
  let lbl = left ? `${left} ENNEMI${left > 1 ? 'S' : ''}` : '';
  if (me?.down && g.phase === 'fight') lbl = 'À TERRE · ATTENDS QUE TON ÉQUIPIER BLOQUE PRÈS DE TOI';
  else if (g.phase === 'map') lbl = 'CHOISIS LA PROCHAINE SALLE SUR LA CARTE';
  else if (g.phase === 'event') lbl = 'CHOISIS TON OPTION';
  else if (g.phase === 'clear') {
    const loc = localHeroes().map((h) => sim.f[h]).filter((p) => p && p.state !== 'dead');
    const left = (sim.pk ?? NONE).some((o) => o.t === 'item' && loc.some((p) => !(p.took & 1)));
    lbl = left ? 'PRENDS UN OBJET SUR UN PIÉDESTAL' : g.eventLog ? g.eventLog : g.vaultNext ? 'LA PORTE MÈNE À UNE SALLE AU TRÉSOR' : 'LA PORTE EST OUVERTE';
  }
  setTxt('roundLbl', lbl);
}

function dungeonCam(dt) {
  if (game.phase === 'menu') {
    camAng += dt * 0.1;
    const rx = Math.cos(camAng), rz = -Math.sin(camAng);
    const off = innerWidth > 880 ? 2.1 : 0;
    camPos.set(Math.sin(camAng) * 12 - rx * off * 0.35, 10, Math.cos(camAng) * 12 - rz * off * 0.35);
    camTgt.set(-rx * off, 0.6, -rz * off);
    return;
  }
  // chez le marchand : la caméra passe derrière le héros (hors duo même clavier pour ne pas décaler les touches de l'autre joueur)
  const sh = localShopper();
  if (sh >= 0 && match?.mode !== 'duo') {
    const p = sim.f[sh];
    camAng = 0;      // les flèches suivent l'écran : ← → le long du comptoir, ↓ pour s'en aller
    if (p.shopK) {   // sorcier : plus haut et en retrait, pour que le héros (en bas de l'image) ne cache pas le chaudron
      camPos.set(p.x + 1.6, 5.2, p.z + 2.7);
      camTgt.set(SORCERER.x + 0.1, 0.7, SORCERER.cauldronZ - 0.5);
    } else {
      camPos.set(p.x + 1.05, 2.4, p.z + 2.45);
      camTgt.set(MERCHANT.x + 0.15, 0.8, MERCHANT.counterZ - 0.3);
    }
    return;
  }
  camAng = ISO;   // fixe : les déplacements suivent l'écran
  // inclut les héros à terre (réanimables) dans le cadrage pour que l'équipier les voie toujours
  const np = Math.min(sim.g.np, sim.f.length);
  if (!np) return;
  let sx = 0, sy = 0, sz = 0, cnt = 0, h0 = null, h1 = null;
  for (let i = 0; i < np; i++) {
    const h = sim.f[i];
    if (h.state !== 'dead' || h.down) { sx += h.x; sy += h.y; sz += h.z; cnt++; if (!h0) h0 = h; else h1 = h; }
  }
  if (!cnt) {
    for (let i = 0; i < np; i++) { const h = sim.f[i]; sx += h.x; sy += h.y; sz += h.z; cnt++; }
    h0 = sim.f[0]; h1 = np > 1 ? sim.f[1] : null;
  }
  const mx = sx / cnt, my = sy / cnt, mz = sz / cnt;
  const sep = h1 ? Math.hypot(h0.x - h1.x, h0.z - h1.z) : 0;
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
const GFX_SHORT = { low: 'Bas', med: 'Moyen', high: 'Élevé' };
const GFX_DESC = {
  low: 'Petit PC : sans ombres, éclairage allégé et effets réduits.',
  med: 'Bon équilibre entre qualité visuelle et fluidité.',
  high: 'Gros PC : ombres fines, effets et détails complets.',
};
function syncSoundUi() {
  const lbl = $('soundLbl');
  if (lbl) lbl.textContent = soundOn ? 'Son' : 'Muet';
  $('soundBtn')?.classList.toggle('muted', !soundOn);
  const pb = $('pauseSoundBtn');
  if (pb) pb.textContent = 'Son : ' + (soundOn ? 'Activé' : 'Coupé');
}
function openGuide(tab = 'rules') {
  $('guideOv').classList.remove('hidden');
  $('guideTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('guideTabRules').classList.toggle('hidden', tab !== 'rules');
  $('guideTabHeroes').classList.toggle('hidden', tab !== 'heroes');
}
function copyCodeClick(ev) {
  const el = ev.target.closest('.code');
  if (!el || !navigator.clipboard) return;
  const code = el.dataset.code || el.textContent.trim();
  if (!/^[A-Z0-9]{4}$/i.test(code)) return;
  el.dataset.code = code;
  navigator.clipboard.writeText(code).then(() => {
    el.textContent = 'COPIÉ !';
    setTimeout(() => { if (el.isConnected) el.textContent = code; }, 1100);
  }).catch(() => {});
}
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
    const sp = SPELLS[b.dataset.val];
    const h = HEROES[b.dataset.val];
    b.title = lock
      ? `Verrouillé : réussis un défi du ${HEROES[HERO_IDS[HERO_IDS.indexOf(b.dataset.val) - 1]]?.name ?? ''}`
      : `${h ? h.desc + ' · ' : ''}${sp ? `Sort : ${sp.name} (${sp.cd} s) — ${sp.desc}` : ''}`;
  });
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('on', c.dataset.val === cfg.arena));
  const online = cfg.mode === 'online', dg = cfg.game === 'dungeon';
  $('diffSec').classList.toggle('hidden', dg || cfg.mode !== 'solo');
  $('netSec').classList.toggle('hidden', !online);
  $('fightersBox').classList.toggle('hidden', dg);
  $('p2Sec').classList.toggle('hidden', online || dg);
  $('p1Sec').classList.toggle('hidden', dg);   // en donjon, on choisit dans la salle d'armes
  $('dngPreview').classList.toggle('hidden', !dg);
  const modeTxt = dg ? { solo: 'Seul', duo: '2 joueurs', online: 'En ligne' }
    : { solo: 'Solo vs IA', duo: '2 joueurs', online: 'En ligne' };
  document.querySelectorAll('[data-key="mode"] button').forEach((b) => {
    const lbl = b.querySelector('.m-lbl');
    if (lbl) lbl.textContent = modeTxt[b.dataset.val];
    else b.textContent = modeTxt[b.dataset.val];
  });
  $('arenaSec').classList.toggle('hidden', dg || (online && net.role === 'guest'));
  $('p1Lbl').textContent = dg && cfg.mode === 'solo' ? 'Ton héros' : online ? 'Ton personnage' : 'Joueur 1';
  $('menuSub').textContent = dg ? 'Expédition rogue-like · Salles & boss' : 'Duels d’arène des petits gladiateurs';
  refreshGo();
  $('p2Lbl').textContent = dg ? 'Joueur 2 (héros)' : cfg.mode === 'solo' ? 'Adversaire (IA)' : 'Joueur 2';

  // Aperçu du héros choisi (mode Arène)
  const sp1 = SPELLS[cfg.p1], h1 = HEROES[cfg.p1];
  if (!dg && sp1 && h1) {
    $('heroSpotlight').innerHTML = `<span class="hs-badge">SORT · ${sp1.cd} s</span><span><b>${esc(h1.name)}</b> — ${esc(sp1.name)} : ${esc(sp1.desc)}</span>`;
  }

  // Record affiché sur la carte Donjon + reprise éventuelle d'une run solo sauvegardée
  const rec = Math.max(dungeonRecord(), compte.profil?.record || 0);
  $('dngRecBadge').textContent = rec ? `🏆 Record : Salle ${rec}` : 'Nouvelle expédition';
  const saved = dg && cfg.mode === 'solo' ? loadSavedRun() : null;
  $('resumeRunRow').classList.toggle('hidden', !saved);
  if (saved) {
    const hName = HEROES[saved.hero]?.name ?? 'Héros';
    $('resumeRunBtn').textContent = `Reprendre · Acte ${saved.act}, Salle ${saved.room} (${hName})`;
  }

  // Qualité graphique dans la barre d'outils
  if ($('gfxToggleLbl')) $('gfxToggleLbl').textContent = GFX_SHORT[gfxId] || gfx.label;
  if ($('gfxDesc')) $('gfxDesc').textContent = GFX_DESC[gfxId] || '';

  // Résumé rapide 1 ligne sous le bouton Jouer
  const a = KEYSETS[0], b = KEYSETS[1];
  const k = (act) => kb(key1(a, act) ?? key1(b, act));
  $('qhKeys').innerHTML = `${kb(key1(a, 'u'))}${kb(key1(a, 'l'))}${kb(key1(a, 'd'))}${kb(key1(a, 'r'))} Bouger · ${k('atk')} Att. · ${k('blk')} Bloc · ${k('roll')} Roulade · ${k('spell')} Sort`;

  // Fiches des héros dans le Guide modal
  $('guideHeroGrid').innerHTML = HERO_IDS.map((id) => {
    const h = HEROES[id], s = SPELLS[id], locked = !un.includes(id);
    return `<div class="gh-card${locked ? ' locked' : ''}"><div class="gh-head"><b>${locked ? '🔒 ' : ''}${esc(h.name)}</b><span>${esc(h.desc)}</span></div>`
      + `<div class="gh-spell"><strong>${esc(s.name)}</strong> (${s.cd} s) — ${esc(s.desc)}</div></div>`;
  }).join('');

  if (dg) {
    $('keysMenu').innerHTML = controlsHTML(cfg.mode, false) +
      `<div class="row" style="margin-top:8px"><b>Donjon :</b> tout commence dans la <b>salle d'armes</b> : marche sur la dalle devant une statue pour prendre ce héros (chacun a un talent), va voir le <b>vieux marchand</b> pour choisir ton arme (glaive, lance, pavois, hache, marteau, sceptre de feu, grimoire, gants ou arc) et le <b>sorcier</b> pour ton sort (<kbd>Q</kbd>), puis passe la porte. Traverse ensuite les salles une à une : élimine tous les ennemis, ramasse les <b>objets</b> (salles au trésor, piédestaux des boss) en marchant dessus, puis franchis la porte. Plus bas, des <b>estrades</b> (monte par l'escalier ou en sautant) et des <b>pièges à pics</b> (la poussière annonce leur sortie). Un <b>boss</b> garde chaque 5<sup>e</sup> salle (chef orc, colosse d'airain, Cerbère). Tu te tournes tout seul vers l'ennemi le plus proche · <b>À deux</b> : un héros tombé peut être réanimé en bloquant près de lui, ou se relève à la salle suivante · <kbd>Échap</kbd> pause` +
      (rec ? `<br><b>Record :</b> salle ${rec}` : '') + '</div>';
    return;
  }
  $('keysMenu').innerHTML = controlsHTML(cfg.mode, false) +
    `<div class="row" style="margin-top:8px"><b>Astuces :</b> l'arène est en 3D : bouge dans toutes les directions, la caméra tourne autour du combat · un <b>pas de côté</b> (${esc(lab(key1(KEYSETS[0], 'u')))} / ${esc(lab(key1(KEYSETS[0], 'd')))}) fait rater les coups lents · le blocage use ta garde · la <b>parade</b> au bon moment étourdit l'attaquant · <b>briser la garde</b> traverse blocage et parade, mais on l'esquive en <b>sautant</b>, en se décalant ou en frappant en premier · pris dans un enchaînement ? fais une <b>roulade</b> (invincible pendant la rotation) · la <b>barre verte</b> est ton endurance : laisse-la remonter · <kbd>Échap</kbd> pause</div>`;
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

function applyQualityMaterials() {
  for (const k in G) {
    G[k].scene.traverse((o) => {
      if (!o.isMesh || !o.userData.matStd) return;
      o.material = gfx.lambert ? o.userData.matLow : o.userData.matStd;
    });
  }
}
function setQuality(id, rebuild = true) {
  if (!GFX[id]) return;
  gfxId = id; gfx = GFX[id]; cfg.gfx = id;
  saveCfg();
  renderer.shadowMap.enabled = gfx.shadows;
  renderer.shadowMap.type = gfx.shadowType;
  renderer.shadowMap.needsUpdate = true;
  resetResolution();
  applyQualityMaterials();
  scene.traverse((o) => {
    if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true;
  });
  if (pCount > gfx.partMax) { pCount = gfx.partMax; pOld = 0; }
  const pb = $('pauseGfxBtn');
  if (pb) pb.textContent = 'Graphismes : ' + gfx.label;
  refreshMenu();
  if (!rebuild || game.loading) return;
  if (game.phase === 'menu') { curArena = null; menuScene(); return; }
  if (isDungeon()) {
    if (coop?.role === 'guest' && !coop.ready) return;
    const hadGate = dng.gateOpen;
    buildDungeonRoom(sim.room, sim.g.room);        // les piédestaux sont recréés par pkSync
    if (hadGate) { dng.gateOpen = true; dng.gate?.open(true); }
    F.forEach((v) => v.dispose());
    F = [];
    dungeonViews();
    F.forEach((v) => { v.snapPos = true; });
  } else if (curArena && ARENAS[curArena]) {
    buildArena(curArena);
    makeFighters(match?.p1 ?? cfg.p1, match?.p2 ?? cfg.p2);
    F.forEach((v) => { v.snapPos = true; });
  }
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
        if (key === 'gfx') { setQuality(b.dataset.val, true); return; }
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
  $('endlessBtn').onclick = () => {
    if (!isDungeon() || (net.live && net.role === 'guest')) return;
    if (sim.continueEndless()) {
      playEvents(sim.ev); sim.ev.length = 0;
      dng.endShown = false;
      $('result').classList.add('hidden');
      $('help').classList.remove('hidden');
      if (match?.mode === 'solo') saveRun();
    }
  };
  $('againBtn').onclick = () => (match?.mode === 'online' ? netStart(match.game) : match?.game === 'dungeon' ? startDungeon() : startMatch());
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
  const pGfx = $('pauseGfxBtn');
  if (pGfx) {
    pGfx.textContent = 'Graphismes : ' + gfx.label;
    pGfx.onclick = () => { setQuality(GFX_ORDER[(GFX_ORDER.indexOf(gfxId) + 1) % GFX_ORDER.length], true); };
  }
  $('kDone').onclick = closeKeysEditor;
  $('kReset').onclick = () => { KEYSETS = cloneKeys(DEFAULT_KEYSETS); keysChanged('Touches par défaut rétablies.'); };
  const toggleSound = () => { soundOn = !soundOn; syncSoundUi(); };
  $('soundBtn').onclick = toggleSound;
  if ($('pauseSoundBtn')) $('pauseSoundBtn').onclick = toggleSound;
  syncSoundUi();

  // Popover Graphismes dans la barre d'outils du menu
  $('gfxToggleBtn').onclick = (ev) => {
    ev.stopPropagation();
    const open = $('gfxSec').classList.toggle('hidden');
    $('gfxToggleBtn').classList.toggle('active', !open);
  };
  $('gfxSec').onclick = (ev) => ev.stopPropagation();
  document.addEventListener('click', () => {
    if (!$('gfxSec').classList.contains('hidden')) {
      $('gfxSec').classList.add('hidden');
      $('gfxToggleBtn').classList.remove('active');
    }
  });

  // Modal Guide & Héros
  $('guideBtn').onclick = () => openGuide('rules');
  $('qhGuideBtn').onclick = () => openGuide('rules');
  $('guideClose').onclick = () => $('guideOv').classList.add('hidden');
  $('guideCloseTop').onclick = () => $('guideOv').classList.add('hidden');
  $('guideKeysBtn').onclick = () => { $('guideOv').classList.add('hidden'); openKeysEditor(); };
  $('guideOv').onclick = (ev) => { if (ev.target === $('guideOv')) $('guideOv').classList.add('hidden'); };
  $('keysOv').onclick = (ev) => { if (ev.target === $('keysOv') && !keyCapture) closeKeysEditor(); };
  $('guideTabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => openGuide(b.dataset.tab);
  });

  // Copie rapide des codes de partie en un clic
  $('netInfo').addEventListener('click', copyCodeClick);
  $('lbMine').addEventListener('click', copyCodeClick);
  $('resumeRunBtn').onclick = resumeDungeon;
  $('clearRunBtn').onclick = () => { clearSavedRun(); refreshMenu(); };
  $('mapToggleBtn').onclick = () => { $('mapToggleBtn').blur(); toggleMapPeek(); };

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
  Object.assign(net, { ws: null, link: null, role: null, me: 0, peer: false, peerKind: null, peerWpn: null, peerSpell: '', peerName: '', peerUnlocked: [], hall: false, halls: [], friends: [], invite: null });
  rb = null;
  coop = null;
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
  ws.onopen = () => {
    opened = true; lobby.down = false;
    if (compte.profil && compte.jeton) ws.send(JSON.stringify({ t: 'ident', token: compte.jeton }));   // présence pour les amis
    ws.send(JSON.stringify(first));
  };
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
function netStart(forcedGame = null) {
  if (net.role !== 'host' || !net.peer) return;
  const g = forcedGame || cfg.game;
  const keepDg = g === 'dungeon' && isDungeon() && sim.f.length >= 2;
  const p1 = keepDg ? sim.f[0].kind : cfg.p1, w1 = keepDg ? sim.f[0].wpn : (cfg.w1 || '');
  const p2 = keepDg ? sim.f[1].kind : (net.peerKind || 'soldier'), w2 = keepDg ? sim.f[1].wpn : (net.peerWpn || '');
  const s1 = keepDg ? sim.f[0].spell : cleanSpell(cfg.s1), s2 = keepDg ? sim.f[1].spell : net.peerSpell;
  const m = {
    mode: 'online', game: g, sid: nextSid(),
    p1, p2, w1, w2, s1, s2,
    u1: unlockedHeroes(), u2: net.peerUnlocked,
    arena: cfg.arena, seed: (Math.random() * 4294967296) >>> 0,
  };
  netSend({ t: 'start', ...m });
  if (m.game === 'dungeon') startDungeon(m); else startMatch(m);
}
function netMsg(m) {
  if (m.t === 'cs' || m.t === 'ci' || m.t === 'cp' || m.t === 'cq') { if (coop) coop.receive(m); return; }
  if (m.t === 'ri' || m.t === 'rs') { if (rb) rb.receive(m); return; }
  if (m.t === 'rtc') { net.link?.signal(m); return; }
  switch (m.t) {
    case 'created':
      Object.assign(net, { role: 'host', me: 0, code: String(m.code ?? ''), hall: !!m.hall, urls: Array.isArray(m.urls) ? m.urls.map(String) : [] });
      netInfo(hostInfo() + (cfg.game === 'dungeon' ? '<br>En attente d’un équipier…' : '<br>En attente d’un adversaire…'));
      break;
    case 'rooms':
      net.halls = (Array.isArray(m.rooms) ? m.rooms : []).filter((r) => r && /^[A-Z]{4}$/.test(r.code) && HEROES[r.kind])
        .map((r) => ({ code: r.code, kind: r.kind, wpn: WEAPON_IDS.includes(r.wpn) ? r.wpn : '', name: cleanName(r.name) }));
      break;
    case 'friends':
      net.friends = (Array.isArray(m.friends) ? m.friends : []).map((a) => ({ name: cleanName(a?.name), online: !!a?.online,
        code: /^[A-Z]{4}$/.test(a?.code) ? a.code : '', busy: !!a?.busy })).filter((a) => a.name);
      break;
    case 'invite':
      if (cleanName(m.name) && /^[A-Z]{4}$/.test(m.code) && !net.peer) { net.invite = { name: cleanName(m.name), code: m.code }; sfx.cheer?.(0.4); }
      break;
    case 'invited':
      lobby.msg = m.ok ? `Invitation envoyée à ${cleanName(m.name)}.` : `${cleanName(m.name)} n’est pas dans sa salle d’armes.`;
      break;
    case 'joined':
      net.invite = null;
      Object.assign(net, { role: 'guest', me: 1, code: String(m.code ?? ''), peer: true, hall: false });
      lobby.msg = `Connecté au salon ${net.code} : la partie va commencer…`;
      netSend({ t: 'hello', ...myHero() });
      netLink();
      netInfo(`Connecté à la partie <b>${esc(m.code)}</b> ! ` + (cfg.game === 'dungeon' ? 'L’hôte va lancer le donjon.' : 'L’hôte choisit l’arène et lance le combat.'));
      break;
    case 'peer':
      net.peer = true;
      netSend({ t: 'hello', ...myHero() });
      netLink();
      netInfo(`Un ${cfg.game === 'dungeon' ? 'équipier' : 'adversaire'} a rejoint la partie <b>${esc(net.code)}</b> ! ` +
        (cfg.game === 'dungeon' ? 'Clique sur ENTRER.' : 'Choisis l’arène puis clique sur COMBATTRE.'));
      break;
    case 'hello':
      net.peerKind = CHARS[m.kind] ? m.kind : 'soldier';
      net.peerWpn = WEAPON_IDS.includes(m.wpn) ? m.wpn : null;
      net.peerSpell = cleanSpell(m.spell);
      net.peerName = cleanName(m.name);
      net.peerUnlocked = cleanUnlocked(m.unlocked);
      if (coop?.role === 'host' && sim.g.room === 0 && sim.unlocked) sim.unlocked[1] = net.peerUnlocked;
      if (game.phase === 'menu') menuFighters();
      if (net.role === 'host' && inHall()) hallStart();   // un équipier rejoint notre salle d'armes
      break;
    case 'start': {
      if (net.role !== 'guest' || !CHARS[m.p1] || !CHARS[m.p2]) break;
      const sid = Number.isFinite(+m.sid) ? +m.sid : 1;
      const seed = Number.isFinite(+m.seed) ? +m.seed : 1;
      if (m.game === 'dungeon') startDungeon({ mode: 'online', sid, p1: m.p1, p2: m.p2, w1: m.w1, w2: m.w2, s1: cleanSpell(m.s1), s2: cleanSpell(m.s2), u1: cleanUnlocked(m.u1), u2: cleanUnlocked(m.u2), seed });
      else if (ARENAS[m.arena]) startMatch({ mode: 'online', sid, p1: m.p1, p2: m.p2, arena: m.arena, seed });
      break;
    }
    case 'menu':
      if (!net.live) break;
      toMenu(true);
      netInfo('L’adversaire est revenu au menu.' + (net.role === 'host' ? ' Clique sur COMBATTRE pour relancer.' : ''));
      break;
    case 'bye': {
      const dg = net.live && match?.game === 'dungeon';
      const wasHost = net.role === 'host';
      const mine = dg && sim.f[net.me] ? { kind: sim.f[net.me].kind, wpn: sim.f[net.me].wpn, spell: sim.f[net.me].spell } : null;
      const onResult = !$('result').classList.contains('hidden');
      net.link?.close(); net.link = null;
      coop = null; rb = null;
      if (dg && onResult) {
        // Écran de fin : ne pas interrompre le joueur, lui permettre de relancer seul
        net.live = false;
        if (wasHost) Object.assign(net, { peer: false, peerKind: null, peerWpn: null, peerSpell: '', peerName: '', peerUnlocked: [] });
        else netClose();
        match.mode = 'solo';
        $('resSub').textContent += '  ·  équipier parti';
        $('againBtn').classList.remove('hidden');
        break;
      }
      if (dg && sim.g.room >= 1) {
        if (wasHost) {
          // L'hôte continue sa partie en cours dans la même salle, convertie en solo
          net.live = false;
          netClose();
          sim.dropHero(1);
          match.mode = 'solo';
          $('hud').classList.add('solo');
          $('help').innerHTML = controlsHTML('solo', true);
          setupBindings('solo', 0);
          F.forEach((v) => v.dispose()); F = [];
          dungeonViews();
          announce('ÉQUIPIER PARTI — TU CONTINUES SEUL', 2.4, '#ffd34a');
        } else {
          // L'invité retourne dans sa salle d'armes solo avec son héros et son arme
          netClose();
          startDungeon({ mode: 'solo', p1: mine?.kind || cfg.p1, w1: mine?.wpn || cfg.w1, s1: mine ? mine.spell : cfg.s1, p2: cfg.p2, w2: cfg.w2, s2: cfg.s2 });
          lobby.msg = 'L’hôte a quitté la partie.';
          announce('L’HÔTE A QUITTÉ', 2.2, '#ff6b57');
        }
        break;
      }
      if (net.live && !dg) toMenu(true);
      if (wasHost) {
        Object.assign(net, { peer: false, peerKind: null, peerWpn: null, peerSpell: '', peerName: '', peerUnlocked: [] });
        if (game.phase === 'menu') menuFighters();
        netInfo('L’adversaire a quitté la partie.<br>' + hostInfo());
      } else {
        netClose();
        if (game.phase === 'menu') menuFighters();
        netInfo('L’hôte a fermé la partie.');
      }
      if (dg) {
        startDungeon({ mode: 'solo', p1: mine?.kind || cfg.p1, w1: mine?.wpn || cfg.w1, s1: mine ? mine.spell : cfg.s1, p2: cfg.p2, w2: cfg.w2, s2: cfg.s2 });
        lobby.msg = wasHost && net.hall ? 'Ton équipier est parti. Ton salon reste ouvert.' : 'Ton équipier a quitté la partie.';
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
// top : classement ouvert ({ tab: 'monde' | 'amis', monde: { classement, moi }, amis: [...] }) ; amis : panneau des amis
const compte = { dispo: false, ready: false, jeton: '', profil: null, top: null, defis: null, amis: null, msg: '' };
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
  $('acAmis').onclick = accountFriends;
  $('acAmiAdd').onclick = () => friendAct('ajouter', $('acAmiPseudo').value.trim());
  $('acAmiPseudo').onkeydown = (e) => { if (e.key === 'Enter') friendAct('ajouter', $('acAmiPseudo').value.trim()); };
  $('acAmisBody').onclick = (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    // retirer un ami : deux clics (le premier demande confirmation)
    if (b.dataset.act === 'retirer' && !b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Retirer ?'; return; }
    friendAct(b.dataset.act, b.dataset.name);
  };
  $('acTopList').onclick = (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b && compte.top) { compte.top.tab = b.dataset.tab; accountTopLoad(); }
  };
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
  compte.profil = compte.top = compte.defis = compte.amis = null;
  compte.msg = '';
  accountRender();
}
// Classements : mondial (10 premiers + sa place) ou entre amis (rang mondial affiché)
async function accountTop() {
  compte.defis = compte.amis = null;
  if (compte.top) { compte.top = null; accountRender(); return; }
  compte.top = { tab: 'monde', monde: null, amis: null };
  await accountTopLoad();
}
async function accountTopLoad() {
  const t = compte.top, tab = t.tab;
  const r = await api(tab === 'amis' ? '/api/classement/amis' : '/api/classement');
  if (compte.top !== t) return;
  if (r.ok) t[tab] = tab === 'amis' ? r.data.classement : r.data;
  else if (r.status === 401) sessionLost();
  compte.msg = r.ok ? '' : r.data.erreur || 'Erreur.';
  accountRender();
}
// rang : place affichée (entre amis : place dans la liste ; le rang mondial va dans l'info-bulle)
const topRow = (x, rang = x.rang) => {
  const hero = HEROES[x.heros]?.name ?? '', wpn = WEAPONS[x.arme]?.name ?? '';
  const tip = [rang !== x.rang ? `${+x.rang}ᵉ au classement mondial` : '', wpn ? `meilleure partie : ${hero} · ${wpn}` : ''].filter(Boolean).join(' · ');
  return `<li data-r="${+rang}" class="r${+rang}${x.pseudo === myName() ? ' me' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>`
    + `<span class="tn"><b>${esc(x.pseudo)}</b>${hero ? ` <span class="th">${esc(hero)}</span>` : ''}</span>`
    + `<span class="ts">salle <b>${+x.record}</b> · ${+x.ennemis} ennemis</span></li>`;
};
function topHTML(t) {
  const tabs = `<div class="netrow tabs"><button data-tab="monde"${t.tab === 'monde' ? ' class="accent"' : ''}>Monde</button>`
    + `<button data-tab="amis"${t.tab === 'amis' ? ' class="accent"' : ''}>Amis</button></div>`;
  const d = t[t.tab];
  if (!d) return tabs + '<i>Chargement…</i>';
  if (t.tab === 'amis') {
    // rangs entre amis (le rang mondial reste en info-bulle)
    // seuls les joueurs ayant fini un donjon sont classés : le joueur lui-même peut manquer
    const ol = '<ol>' + d.map((x, i) => topRow(x, i + 1)).join('') + '</ol>';
    const others = d.some((x) => x.pseudo !== myName()), mine = d.some((x) => x.pseudo === myName());
    return tabs + (others ? ol : '<i>Ajoute des amis (bouton « Amis ») pour vous comparer ici.</i>' + (d.length ? ol : ''))
      + (others && !mine ? '<i>Termine un donjon pour entrer au classement.</i>' : '');
  }
  const list = Array.isArray(d.classement) ? d.classement : [];
  if (!list.length) return tabs + '<i>Personne au classement pour l’instant.</i>';
  const me = d.moi, inTop = me && list.some((x) => x.pseudo === me.pseudo);
  return tabs + '<ol>' + list.map(topRow).join('') + (me && !inTop ? '<li class="gap">⋮</li>' + topRow(me) : '') + '</ol>'
    + (compte.profil && !me ? '<i>Termine un donjon pour entrer au classement.</i>' : '');
}
// Amis : ajouter (ou accepter), refuser / annuler / retirer ; le serveur renvoie la liste à jour
async function accountFriends() {
  compte.top = compte.defis = null;
  if (compte.amis) { compte.amis = null; accountRender(); return; }
  compte.amis = { amis: [], recues: [], envoyees: [], msg: '', load: true };
  accountRender();
  const r = await api('/api/amis');
  if (!compte.amis) return;
  if (r.ok) Object.assign(compte.amis, r.data, { load: false });
  else if (r.status === 401) sessionLost();
  compte.msg = r.ok ? '' : r.data.erreur || 'Erreur.';
  accountRender();
}
async function friendAct(act, pseudo) {
  if (!compte.amis || !pseudo) return;
  const r = await api(`/api/amis/${act === 'ajouter' ? 'ajouter' : 'retirer'}`, { pseudo });
  if (!compte.amis) return;
  if (r.ok) {
    Object.assign(compte.amis, r.data, { msg: act === 'ajouter' ? String(r.data.msg ?? '') : '', load: false });
    if (act === 'ajouter') $('acAmiPseudo').value = '';
    compte.msg = '';
  } else if (r.status === 401) sessionLost();
  else compte.msg = r.data.erreur || 'Erreur.';
  accountRender();
}
function friendsHTML(a) {
  if (a.load) return '<i>Chargement…</i>';
  const names = (l) => (Array.isArray(l) ? l : []).map((x) => cleanName(typeof x === 'string' ? x : x?.pseudo)).filter(Boolean);
  const btn = (act, n, txt, cls = '') => `<button data-act="${act}" data-name="${esc(n)}"${cls ? ` class="${cls}"` : ''}>${txt}</button>`;
  const rec = names(a.recues), env = names(a.envoyees);
  const amis = (Array.isArray(a.amis) ? a.amis : []).filter((x) => cleanName(x?.pseudo));
  return (a.msg ? `<div class="ok-msg">${esc(a.msg)}</div>` : '')
    + (rec.length ? '<h4>Demandes reçues</h4>' + rec.map((n) => `<div class="am"><span><b>${esc(n)}</b></span>${btn('ajouter', n, 'Accepter', 'accent')}${btn('refuser', n, 'Refuser', 'no')}</div>`).join('') : '')
    + `<h4>Mes amis (${amis.length})</h4>`
    + (amis.length ? amis.map((x) => `<div class="am"><span><b>${esc(x.pseudo)}</b> · record : salle ${+x.record}</span>${btn('retirer', x.pseudo, '✕', 'no')}</div>`).join('')
      : '<i>Pas encore d’amis : ajoute le pseudo d’un joueur. Dans la salle d’armes, tu verras ensuite s’il est là et tu pourras rejoindre son salon ou l’inviter.</i>')
    + (env.length ? '<h4>En attente de réponse</h4>' + env.map((n) => `<div class="am"><span>${esc(n)}</span>${btn('annuler', n, 'Annuler')}</div>`).join('') : '');
}
// Défis des héros (définis et comptés par le serveur : api/src/defis.rs), regroupés par héros
async function accountChallenges() {
  compte.top = compte.amis = null;
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
  $('acTop').textContent = compte.top ? 'Fermer' : 'Classement';
  $('acTop').classList.toggle('accent', !!compte.top);
  $('acDefis').textContent = compte.defis ? 'Fermer' : 'Défis';
  $('acDefis').classList.toggle('accent', !!compte.defis);
  $('acDefisList').classList.toggle('hidden', !compte.defis);
  if (compte.defis) $('acDefisList').innerHTML = challengesHTML(compte.defis);
  $('acAmis').textContent = compte.amis ? 'Fermer' : 'Amis';
  $('acAmis').classList.toggle('accent', !!compte.amis);
  $('acAmisList').classList.toggle('hidden', !compte.amis);
  if (compte.amis) $('acAmisBody').innerHTML = friendsHTML(compte.amis);
  $('acTopList').classList.toggle('hidden', !compte.top);
  if (compte.top) $('acTopList').innerHTML = topHTML(compte.top);
  $('acMsg').textContent = compte.msg;
  lobby.key = '';     // le pseudo apparaît dans le panneau des salons
  if (compte.ready && clampHeroes() && game.phase === 'menu') menuScene();
  if (compte.ready && net.ws?.readyState === 1 && net.peer) netSend({ t: 'hello', ...myHero() });
  refreshMenu();      // héros verrouillés du menu
}

// =====================================================================
//  Salons de la salle d'armes : seul dans la salle d'armes, on ouvre son salon (listé sur le serveur)
//  ou on rejoint celui d'un autre, dans la liste ou par son code. Dès qu'un équipier entre, les deux
//  navigateurs relancent la salle d'armes en ligne, à deux, chacun avec son héros et son arme.
//  Quand l'équipier part, chacun repart seul (l'hôte continue sa salle en cours ou garde son salon).
// =====================================================================
// wait : heure limite de la réponse à « ouvrir mon salon » (un serveur d'avant les salons ne répond rien)
const lobby = { next: 0, key: '', msg: '', down: false, wait: 0 };
const inHall = () => isDungeon() && game.phase === 'hub' && !net.live && match?.mode === 'solo';
// héros et arme de ce joueur : ceux de la salle d'armes en cours, sinon ceux du menu
function myHero() {
  const p = game.phase !== 'menu' && isDungeon() ? sim.f[localHeroes()[0] ?? 0] : null;
  return { ...(p ? { kind: p.kind, wpn: p.wpn, spell: p.spell } : { kind: cfg.p1, wpn: cfg.w1 || '', spell: cleanSpell(cfg.s1) }), name: myName(), unlocked: unlockedHeroes() };
}
function lobbyWs(m) { if (net.ws?.readyState === 1) netSend(m); else netConnect(m); }
function hallStart() {
  const me = myHero();
  const m = { mode: 'online', game: 'dungeon', sid: nextSid(), p1: me.kind, w1: me.wpn, s1: me.spell, p2: net.peerKind || 'soldier', w2: net.peerWpn || '', s2: net.peerSpell,
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
  // amis : rejoindre leur salon, ou les inviter dans le sien ; invitation reçue : rejoindre ou ignorer
  $('lbFriends').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.blur();
    if (b.dataset.code) { lobby.msg = 'Connexion…'; lobbyWs({ t: 'join', code: b.dataset.code }); }
    else if (b.dataset.invite) netSend({ t: 'invite', name: b.dataset.invite });
    lobbyRender();
  };
  $('lbInvite').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.blur();
    const inv = net.invite;
    net.invite = null;
    if (inv && b.dataset.act === 'join') { lobby.msg = 'Connexion…'; lobbyWs({ t: 'join', code: inv.code }); }
    lobbyRender();
  };
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
    else if (net.ws.readyState === 1 && !net.peer) {
      netSend({ t: 'list' });
      if (compte.profil) netSend({ t: 'friends' });
    }
  }
  lobbyRender();
}
let lobbyHallsRef = null, lobbyFriendsRef = null, lobbyInviteRef = null;
// amis dans le panneau des salons : salon ouvert (rejoindre), dans la salle d'armes (inviter si mon salon est
// ouvert), en partie, hors ligne ; les hors-ligne sont seulement comptés
const FRIENDS_SHOWN = 6;
function lobbyFriendsHTML() {
  if (!compte.profil) return '';
  const fr = net.friends;
  if (!fr.length) return '<h4>Amis</h4><div class="more">Ajoute des amis depuis le menu (Compte → Amis) pour les retrouver ici.</div>';
  const myHall = net.role === 'host' && net.hall;
  const on = fr.filter((a) => a.online), off = fr.length - on.length;
  const row = (a) => a.code
    ? `<div class="fr hall"><i></i><span><b>${esc(a.name)}</b> · salon ouvert</span><button data-code="${esc(a.code)}">Rejoindre</button></div>`
    : a.busy ? `<div class="fr busy"><i></i><span><b>${esc(a.name)}</b> · en partie</span></div>`
      : `<div class="fr on"><i></i><span><b>${esc(a.name)}</b> · salle d'armes</span>${myHall ? `<button data-invite="${esc(a.name)}">Inviter</button>` : ''}</div>`;
  return `<h4>Amis · ${on.length} en ligne</h4>` + on.slice(0, FRIENDS_SHOWN).map(row).join('')
    + (on.length > FRIENDS_SHOWN ? `<div class="more">et ${on.length - FRIENDS_SHOWN} autre${on.length - FRIENDS_SHOWN > 1 ? 's' : ''} en ligne</div>` : '')
    + (!on.length ? '<div class="fr off"><i></i><span>Aucun ami en ligne</span></div>' : '')
    + (off ? `<div class="more">${off} hors ligne</div>` : '')
    + (on.some((a) => !a.code && !a.busy) && !myHall ? '<div class="more">Ouvre ton salon pour inviter un ami.</div>' : '');
}
function lobbyRender() {
  const nm = myName();
  // comparaison directe sans JSON.stringify à chaque image
  if (lobby.key && lobby.r === net.role && lobby.c === net.code && lobby.h === net.hall
      && lobby.m === lobby.msg && lobby.d === lobby.down && lobby.n === nm && lobbyHallsRef === net.halls
      && lobbyFriendsRef === net.friends && lobbyInviteRef === net.invite) return;
  lobby.r = net.role; lobby.c = net.code; lobby.h = net.hall;
  lobby.m = lobby.msg; lobby.d = lobby.down; lobby.n = nm; lobbyHallsRef = net.halls;
  lobbyFriendsRef = net.friends; lobbyInviteRef = net.invite;
  lobby.key = 'ok';
  const who = (r) => `${r.name ? `<b>${esc(r.name)}</b> · ` : ''}${esc(HEROES[r.kind].name)}${r.wpn ? ' · ' + esc(WEAPONS[r.wpn].name) : ''}`;
  $('lbMine').innerHTML = net.role === 'host' && net.hall
    ? `Ton salon <span class="code">${esc(net.code)}</span> est ouvert : un ami peut le rejoindre depuis sa salle d'armes.<button data-act="close">Fermer</button>`
    : net.role === 'guest' ? '' : '<button class="main" data-act="open">Ouvrir mon salon</button>';
  $('lbList').innerHTML = lobby.down ? '<i>Serveur de jeu injoignable : lance le jeu avec jouer.bat (Windows) ou jouer.sh (Linux).</i>'
    : net.halls.length ? net.halls.map((r) => `<button data-code="${esc(r.code)}"><span>${who(r)}</span><b>${esc(r.code)}</b></button>`).join('')
      : '<i>Aucun autre salon ouvert pour l’instant.</i>';
  $('lbFriends').innerHTML = lobby.down ? '' : lobbyFriendsHTML();
  const inv = net.invite;
  $('lbInvite').innerHTML = inv && !net.peer ? `<b>${esc(inv.name)}</b> t’invite dans son salon <b>${esc(inv.code)}</b> !`
    + '<div class="lb-row"><button class="main" data-act="join">Rejoindre</button><button data-act="no">Plus tard</button></div>' : '';
  setTxt('lbMsg', lobby.msg);
}

async function boot() {
  try { layout = await navigator.keyboard?.getLayoutMap?.(); } catch (e) { layout = null; }
  const loader = new GLTFLoader();
  const keys = Object.keys(FILES);
  let done = 0;
  // déduplication des textures et matériaux partagés entre tous les GLB (93 textures -> ~3-4 en VRAM)
  const texCache = new Map(), stdMatCache = new Map(), glowMatCache = new Map(), lowMatMap = new Map();
  const sigCanvas = document.createElement('canvas');
  sigCanvas.width = sigCanvas.height = 16;
  const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });
  const texSig = (t) => {
    const img = t.image;
    if (!img) return t.uuid;
    const w = img.width || img.naturalWidth || 0, h = img.height || img.naturalHeight || 0;
    let hash = 2166136261;
    try {
      sigCtx.clearRect(0, 0, 16, 16);
      sigCtx.drawImage(img, 0, 0, 16, 16);
      const d = sigCtx.getImageData(0, 0, 16, 16).data;
      for (let i = 0; i < d.length; i += 4) {
        hash = Math.imul(hash ^ d[i], 16777619);
        hash = Math.imul(hash ^ d[i + 1], 16777619);
        hash = Math.imul(hash ^ d[i + 2], 16777619);
      }
    } catch (e) { return t.uuid; }
    return `${w}x${h}|${t.flipY ? 1 : 0}|${t.colorSpace}|${t.magFilter}|${t.minFilter}|${hash >>> 0}`;
  };
  const shareTex = (t) => {
    if (!t || !t.isTexture) return t;
    const key = texSig(t);
    const hit = texCache.get(key);
    if (hit) { if (hit !== t) t.dispose(); return hit; }
    texCache.set(key, t);
    keep(t);
    return t;
  };
  const shareMat = (m) => {
    if (!m) return m;
    if (m.map) m.map = shareTex(m.map);
    if (m.isMeshBasicMaterial) { keep(m); return m; }
    const key = `${m.map ? m.map.uuid : ''}|${m.color ? m.color.getHex() : 0}|${Math.round((m.roughness ?? 1) * 100)}|${Math.round((m.metalness ?? 0) * 100)}|${m.transparent ? 1 : 0}|${Math.round((m.opacity ?? 1) * 100)}|${m.side}|${m.flatShading ? 1 : 0}`;
    let std = stdMatCache.get(key);
    if (std) {
      if (std !== m) m.dispose();
    } else {
      std = m;
      stdMatCache.set(key, std);
      keep(std);
      const low = new THREE.MeshLambertMaterial({
        color: std.color ? std.color.clone() : 0xffffff,
        map: std.map || null,
        transparent: !!std.transparent,
        opacity: std.opacity ?? 1,
        side: std.side,
        flatShading: !!std.flatShading,
      });
      lowMatMap.set(std, low);
      keep(low);
    }
    return std;
  };
  try {
    await Promise.all(keys.map((k) => loader.loadAsync(encodeURI(FILES[k])).then((g) => {
      G[k] = g;
      g.skinned = false;
      g.scene.traverse((o) => {
        if (o.isSkinnedMesh) g.skinned = true;
        if (!o.isMesh) return;
        if (o.geometry) keep(o.geometry);
        // pièces lumineuses des décors (cristaux, lave, lanternes) : couleur de la palette, sans ombrage
        if (o.name.startsWith('glow')) {
          const map = shareTex(o.material.map);
          const gk = map ? map.uuid : 'none';
          let gm = glowMatCache.get(gk);
          if (!gm) { gm = new THREE.MeshBasicMaterial({ map, toneMapped: false }); glowMatCache.set(gk, gm); keep(gm); }
          o.material = gm;
          return;
        }
        if (Array.isArray(o.material)) {
          o.material = o.material.map(shareMat);
        } else if (o.material) {
          const std = shareMat(o.material);
          o.userData.matStd = std;
          o.userData.matLow = lowMatMap.get(std) || std;
          o.material = gfx.lambert ? o.userData.matLow : std;
        }
      });
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
  const qs = new URLSearchParams(location.search);
  if (qs.has('dungeon')) startDungeon();
  if (qs.has('map')) openMapPreview(+(qs.get('map') || 42) || 42, +(qs.get('act') || 1) || 1);
  // ?debug : accès à la simulation depuis la console (tests dans le navigateur)
  if (qs.has('debug')) window.spartiate = { get sim() { return sim; }, get views() { return F; }, get gfx() { return gfxId; }, setQuality, renderer, scene, camera, debugGoto: dbgGoto, previewMap: openMapPreview };
  else if (qs.has('fight') || DEMO) startMatch();
  const warm = +qs.get('sim');
  for (let i = 0; i < warm * 60; i++) step(DT);
}

// =====================================================================
//  Aperçu interactif de l'écran de carte (?map ou spartiate.previewMap)
// =====================================================================
let mapPreviewState = null;
function openMapPreview(seed = 42, act = 1) {
  mapPreviewState = generateMap(seed, act);
  renderMapPreview();
  $('mapOv').classList.remove('hidden');
}
function closeMapPreview() {
  mapPreviewState = null;
  $('mapOv').classList.add('hidden');
}
function renderMapPreview() {
  if (!mapPreviewState) return;
  const done = isBossNode(mapPreviewState);
  renderMap($('mapOv'), mapPreviewState, {
    interactive: !done,
    canClose: true,
    onClose: closeMapPreview,
    statusText: done ? 'Boss vaincu ! Clique sur « Acte suivant » pour générer la carte suivante.' : '',
    onPick: (id) => {
      advanceMap(mapPreviewState, id);
      renderMapPreview();
    },
    previewControls: {
      onReroll: () => { mapPreviewState = generateMap(((Math.random() * 99999) | 0) + 1, 1); renderMapPreview(); },
      onNextAct: () => { mapPreviewState = generateMap(mapPreviewState.runSeed, mapPreviewState.act + 1); renderMapPreview(); },
    },
  });
}
function mapPreviewKey(e) {
  if (!mapPreviewState || $('mapOv').classList.contains('hidden')) return false;
  if (e.code === 'Escape') { e.preventDefault(); closeMapPreview(); return true; }
  const d = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (d) {
    const ids = availableNextIds(mapPreviewState);
    const id = ids[+d[1] - 1];
    if (id) { e.preventDefault(); advanceMap(mapPreviewState, id); renderMapPreview(); return true; }
  }
  return false;
}
requestAnimationFrame(frame);
boot();

// =====================================================================
//  Outil de débogage du donjon (F2) : aller à une salle, tuer, soigner, invincibilité, faire apparaître
//  des ennemis, déclencher les attaques du boss, téléporter le héros d'un clic. Hors ligne seulement :
//  il modifie la simulation directement (en ligne, l'autre joueur ne le verrait pas).
// =====================================================================
const dbg = { open: false, god: false, tp: false };
const DBG_ROOMS = [[0, "Salle d'armes"], [1, 'Salle 1'], [5, 'Boss : chef orc'], [10, 'Boss : colosse'], [15, 'Antre de Cerbère'], [20, "Boss : Souverain d'Os"], [6, 'Mines (6)'], [11, 'Ruines (11)'], [16, 'Forge (16)'], [21, 'Nécropole (21)'], [26, 'Citadelle (26)'], [-1, 'Salle suivante']];
function setupDebug() {
  $('dbgRooms').innerHTML = DBG_ROOMS.map(([n, t]) => `<button data-room="${n}">${esc(t)}</button>`).join('');
  // objets : liste triée par qualité, puis les petits bonus
  $('dbgItem').innerHTML = Object.entries(ITEMS).sort((a, b) => a[1].q - b[1].q || a[1].name.localeCompare(b[1].name))
    .map(([id, it]) => `<option value="${id}">${it.icon} ${esc(it.name)} (${esc(QUALITY[it.q].name)})</option>`).join('') +
    Object.entries(MINORS).map(([id, m]) => `<option value="${id}">${m.icon} ${esc(m.name)}</option>`).join('');
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
    else if (b.id === 'dbgGive') { if (!dbgSim()?.debugItem(localHeroes()[0] ?? 0, $('dbgItem').value)) dbgMsg('Objet impossible à donner ici.'); }
    else if (b.id === 'dbgVault') { const s = dbgSim(); if (s) { s.debugVault(); dng.room = -1; $('result').classList.add('hidden'); } }
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
function dbgSim() { return sim instanceof DungeonSim && !rb && !coop && !net.live && game.phase !== 'menu' ? sim : null; }
function dbgMsg(t) { $('dbgInfo').textContent = t; dbg.msgT = 2.5; }
function dbgGoto(n) {
  const s = dbgSim();
  if (!s) return;
  s.debugGoto(n);
  if (dbg.god) s.debugGod(true);
  dng.room = -1;                  // reconstruire la salle, même si c'est la même
  $('result').classList.add('hidden');
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
  window.__game = { get sim() { return sim; }, get rb() { return rb; }, get coop() { return coop; }, get net() { return net; }, game, cfg, get F() { return F; }, startMatch, netStart, startDungeon };
}
