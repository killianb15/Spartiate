// =====================================================================
//  Mode Donjon (rogue-like) : on enchaîne des salles remplies d'ennemis, seul ou à deux.
//
//  Reprend toute la mécanique de combat de sim.js (attaque, blocage, parade, brise-garde,
//  roulade, endurance…) ; seuls changent l'aire de jeu (salle carrée avec obstacles,
//  estrades, escaliers, pièges et porte), le nombre de combattants (1 ou 2 héros contre
//  plusieurs ennemis) et le déroulement (salle → butin → salle suivante ; salles au trésor et boss
//  laissent des objets sur des piédestaux : voir items.js).
//
//  Comme sim.js : logique pure et déterministe (dmath.js, this.rng, aucun Math.random) ;
//  les IA des ennemis tournent DANS la simulation et sont sauvegardées avec elle, ce qui
//  permet de jouer en ligne avec le rollback de rollback.js (step(entrée0, entrée1)).
// =====================================================================
import { Sim, DT, ACTS, PRESS, NEUTRAL, STA, CAST, WEAPONS, SPELLS, SPELL_IDS, spellOf, spellCdOf, spellShield, knockOf, wpnOf, guardOf, defaultWeapon, newFighter, newInput, hashState } from './sim.js';
import { hypot, atan2, clamp, sin, cos, Rng } from './dmath.js';
import { AI } from './ai.js';
import { ITEM_BASE, STATUS0, ITEM_METHODS, MINOR_IDS, LOOT, FX, CAPS, heal, rollItem, itemOf } from './items.js';
import { generateMap, availableNextIds, advanceMap, isBossNode, cloneMap, nodeById } from './map.js';
import { EVENTS, EVENT_IDS } from './events.js';

export const TILE = 1.5;
export const ROOM_T = 6;           // centre des dalles du bord (sol de -6.75 à 6.75)
export const ROOM_R = 6.75;        // bord du sol : les murs commencent là
export const PLAT_H = 0.9;         // hauteur des estrades (on peut y sauter)
const BODY = 0.42;                 // rayon d'un personnage contre les murs et obstacles
const LANE = 0.55;                 // demi-largeur du passage de la porte
const LOCK_R = 5.5;                // un héros se tourne vers l'ennemi le plus proche à cette distance
const STEP = 0.35;                 // hauteur qu'on franchit sans sauter
const BOSS_EVERY = 5;
export const FINAL_ACT = 4;        // victoire officielle au bout de 4 actes (20 salles)
export const FINAL_ROOM = 20;

// Biomes : 6 décors au total (cryptes, mines, ruines, forge, nécropole d'émeraude, citadelle gelée).
// L'ordre des biomes est mélangé de façon déterministe à partir de runSeed (sans doublon avant d'avoir fait
// le tour des 6) ; sans runSeed (= 0), l'ordre historique reste inchangé pour les tests.
export const BIOMES = ['crypt', 'mine', 'ruins', 'forge', 'necropole', 'citadelle'];
export function biomeOrder(runSeed = 0) {
  const arr = BIOMES.slice();
  if (!runSeed) return arr;
  const r = new Rng((((runSeed >>> 0) ^ 0x51a7b3d1) >>> 0) || 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (r.next() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
export const biomeOfAct = (act, runSeed = 0) => {
  const order = biomeOrder(runSeed);
  return order[(Math.max(1, act) - 1) % order.length];
};
export const biomeOf = (n, runSeed = 0) => (n <= 0 ? 'crypt' : biomeOfAct(Math.floor((n - 1) / BOSS_EVERY) + 1, runSeed));

// Pièges à pics : cycle de TRAP.period s, pics sortis entre up0 et up1 (décalé par piège)
export const TRAP = { period: 2.6, up0: 1.7, up1: 2.3, warn: 0.45, dmg: 12 };
export const trapPhase = (clock, k) => (clock + k * 0.9) % TRAP.period;
export const trapUp = (clock, k) => { const t = trapPhase(clock, k); return t >= TRAP.up0 && t < TRAP.up1; };

// Types d'ennemis (lv : niveau de l'IA de ai.js, pow : multiplicateur de dégâts)
export const FOES = {
  grunt: { kind: 'orc', name: 'Orc', hp: 30, pow: 0.4, lv: 0, size: 1 },
  guard: { kind: 'human', name: 'Mirmillon', hp: 40, pow: 0.5, lv: 1, size: 1 },
  elite: { kind: 'soldier', name: 'Gladiateur', hp: 52, pow: 0.6, lv: 1, size: 1 },
  archer: { kind: 'archer', name: 'Archer', hp: 26, pow: 0.55, lv: 1, size: 1 },
  zombie: { kind: 'zombie', name: 'Zombie', hp: 44, pow: 0.45, lv: 0, size: 1 },
  // chien invoqué par le grimoire : il se bat dans le camp des héros
  dog: { kind: 'dog', name: 'Chien', hp: 24, pow: 0.6, lv: 1, size: 0.8 },
  // chien des enfers : renfort de Cerbère (même corps que le chien du grimoire, dans le camp ennemi)
  hound: { kind: 'dog', name: 'Chien des enfers', hp: 26, pow: 0.5, lv: 1, size: 0.9, wpn: 'bite' },
  // boss (boss : garde une salle sur 5, voir bossOf) ; moves : ses attaques spéciales (voir BOSS), adds :
  // renforts appelés quand il enrage ; wpn : arme (sinon celle du personnage)
  boss: { kind: 'orc', name: 'Chef orc', hp: 140, pow: 0.85, lv: 2, size: 1.4, boss: true },
  colosse: { kind: 'robot', name: "Colosse d'airain", hp: 190, pow: 0.75, lv: 2, size: 1.9, boss: true, wpn: 'hammer', moves: ['slam', 'charge'], adds: 'zombie' },
  // Cerbère : chien géant à trois têtes, gardien des enfers, dans son antre (salle dédiée, room.lair)
  // brute : ni parade ni blocage (son IA fonce et mord ; ses morsures se préparent : voir l'arme fangs)
  cerbere: { kind: 'cerbere', name: 'Cerbère', hp: 230, pow: 0.7, lv: 2, size: 2.8, boss: true, wpn: 'fangs', moves: ['fire', 'slam', 'charge'], adds: 'hound', brute: true },
  // petit squelette rapide invoqué par le Souverain d'Os
  skel: { kind: 'squelette', name: 'Squelette', hp: 28, pow: 0.5, lv: 1, size: 0.92, wpn: 'sword' },
  // Souverain d'Os : boss final (salle 20 / Acte 4), dans son Sanctuaire mouvant (room.lair = 'squelette')
  // moves : shift (tremblement + mutation d'arène), reap (fauchage tournoyant), bones (salve spectrale)
  squelette: { kind: 'squelette', name: "Souverain d'Os", hp: 280, pow: 0.72, lv: 2, size: 2.05, boss: true, wpn: 'scythe', moves: ['shift', 'reap', 'bones'], adds: 'skel' },
};
// boss de la salle n (une salle sur BOSS_EVERY) : chef orc (5), colosse (10), Cerbère (15), Souverain d'Os (20), puis on recommence en Infini
const BOSS_ORDER = ['boss', 'colosse', 'cerbere', 'squelette'];
export const bossOf = (n) => BOSS_ORDER[(Math.max(1, Math.floor(n / BOSS_EVERY)) - 1) % BOSS_ORDER.length];

// Attaques spéciales des boss (state 'special', f.sp = 'slam' | 'charge' | 'roar' | 'fire' | 'shift' | 'reap' | 'bones') :
//  - slam : il s'accroupit (wind), bondit et retombe sur la position visée (spX, spZ) : onde de choc ;
//  - charge : il gratte le sol (wind) puis fonce tout droit (dur) ; s'il heurte un mur ou un obstacle, sonné ;
//  - roar : à la moitié de ses PV (rage), il rugit, repousse tout le monde et appelle des renforts ;
//  - fire (Cerbère) : souffle de feu en cône devant lui ;
//  - shift (Souverain d'Os) : fait trembler l'arène (wind) avec télégraphes au sol, puis change la disposition
//    entière des piliers, estrades et pièges (ARENA_LAYOUTS) ;
//  - reap (Souverain d'Os) : double fauchage tournoyant à 360° autour de lui ;
//  - bones (Souverain d'Os) : éventail de 3 (ou 5 en rage) projectiles spectraux renvoyables à la parade.
// Pendant une attaque spéciale, il encaisse les coups sans broncher (pas d'interruption).
export const BOSS = {
  cd: 4.2, cdRage: 2.8, first: 2.5, rage: 0.5, speedRage: 1.25,
  slam: { wind: 0.6, windRage: 0.42, vy: 10, R: 2.7, Rrage: 3.3, dmg: 22, knock: 6.5, guard: 45, rest: 0.75 },
  charge: { wind: 0.75, windRage: 0.5, dur: 0.9, speed: 10.5, dmg: 18, knock: 7, guard: 40, hitR: 0.6, stun: 1.7 },
  roar: { dur: 1.4, at: 0.45, R: 3.6, knock: 7.5 },
  fire: { wind: 0.75, windRage: 0.5, dur: 1.6, R: 4.8, half: 0.62, turn: 1.0, turnRage: 1.5, tick: 0.2, dmg: 6, guard: 9, knock: 1.2 },
  shift: { wind: 1.75, windRage: 1.45, recover: 0.55, pillarR: 1.15, dmg: 16, knock: 6.5 },
  reap: { wind: 0.65, windRage: 0.48, dur: 0.85, hits: [0.22, 0.62], R: 3.3, dmg: 17, knock: 5.5, guard: 34 },
  bones: { wind: 0.55, windRage: 0.4, count: 3, countRage: 5, spread: 0.28, speed: 9.5, dmg: 13, life: 2.0, rest: 0.4 },
};

// Les 4 configurations d'arène du Sanctuaire mouvant (Souverain d'Os, salle 20)
const mkObs = (pts) => pts.map(([i, j]) => ({ x: i * TILE, z: j * TILE, r: OBS_R.column, kind: 'column' }));
const mkTraps = (pts) => pts.map(([i, j]) => ({ x: i * TILE, z: j * TILE }));
export const ARENA_LAYOUTS = [
  {
    id: 'nef', name: 'La Nef des Os',
    obs: [[-2, -2], [2, -2], [-2, 2], [2, 2]],
    surf: [],
    traps: [],
  },
  {
    id: 'labyrinthe', name: "Le Labyrinthe d'Os",
    obs: [[-2, -1], [0, -2], [2, -1], [-2, 1], [0, 2], [2, 1]],
    surf: [],
    traps: [[0, 0], [-1, -1], [1, 1]],
  },
  {
    id: 'estrades', name: 'Les Estrades du Jugement',
    obs: [[-3, -3], [3, 3]],
    surf: [
      { x0: -5.25, x1: -2.25, z0: -2.25, z1: 2.25, h: PLAT_H, ramp: '' },
      { x0: -2.25, x1: -0.75, z0: -2.25, z1: 2.25, h: PLAT_H, ramp: 'x', from: -0.75, to: -2.25 },
      { x0: 2.25, x1: 5.25, z0: -2.25, z1: 2.25, h: PLAT_H, ramp: '' },
      { x0: 0.75, x1: 2.25, z0: -2.25, z1: 2.25, h: PLAT_H, ramp: 'x', from: 0.75, to: 2.25 },
    ],
    traps: [[0, -2], [0, -1], [0, 1], [0, 2]],
  },
  {
    id: 'cercle', name: 'Le Cercle Maudit',
    obs: [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]],
    surf: [],
    traps: [[-3, -3], [0, -3], [3, -3], [3, 0], [3, 3], [0, 3], [-3, 3], [-3, 0]],
  },
];
export function arenaLayoutData(idx) {
  const L = ARENA_LAYOUTS[((idx | 0) % ARENA_LAYOUTS.length + ARENA_LAYOUTS.length) % ARENA_LAYOUTS.length];
  return {
    name: L.name,
    obs: mkObs(L.obs),
    surf: L.surf.map((s) => ({ ...s })),
    traps: mkTraps(L.traps),
  };
}

// Adaptation au nombre de joueurs (à deux) : un peu plus d'ennemis et de PV sans multiplier les dégâts
// par deux, pour que le joueur au corps à corps reste jouable face à l'aggro (notamment avec un allié à distance).
// count/cap : nombre d'ennemis des salles normales ; hp, pow : PV et dégâts des ennemis ; boss* : boss ;
// escort/escortCap : escorte du chef orc
export const COOP = { count: 1.4, cap: 7, hp: 1.15, pow: 1, bossHp: 1.65, bossPow: 1.1, bossCd: 0.85, escort: 1.5, escortCap: 5 };
// multiplicateur de COOP pour np joueurs (1 en solo)
const coop = (np, k) => (np > 1 ? COOP[k] : 1);

// Héros jouables, chacun avec un petit trait (appliqué par equip)
export const HEROES = {
  soldier: { name: 'Gladiateur', desc: 'Équilibré', apply: () => {} },
  human: { name: 'Mirmillon', desc: '+10 % de dégâts', apply: (p) => { p.pow = 1.1; } },
  orc: { name: 'Orc', desc: '120 PV', apply: (p) => { p.maxHp = 120; } },
  archer: { name: 'Archère', desc: 'Endurance +25 %', apply: (p) => { p.staMul = 1.25; } },
  knight: { name: 'Chevalier', desc: 'Armure : −15 % de dégâts subis', apply: (p) => { p.armor = 0.15; } },
  zombie: { name: 'Zombie', desc: 'Chaque coup porté soigne 1 PV', apply: (p) => { p.leech = 1; } },
  robot: { name: 'Automate', desc: '110 PV, −8 % de dégâts subis', apply: (p) => { p.maxHp = 110; p.armor = 0.08; } },
};
export const HERO_IDS = Object.keys(HEROES);
// Héros jouables d'emblée ; les autres se débloquent dans l'ordre de HERO_IDS (un défi réussi avec un
// héros débloque le suivant : calculé par le serveur des comptes, api/src/defis.rs).
export const FIRST_HERO = 'soldier';
export const WEAPON_IDS = Object.keys(WEAPONS).filter((k) => !WEAPONS[k].hidden);

// Salle d'armes (avant la 1re salle) : on choisit son héros en marchant sur une dalle devant sa
// statue (rangée le long du mur x = -R) et son arme chez le marchand (étal contre le mur z = -R, à
// droite de la porte). Le choix du héros passe par sa position : rien de plus à transmettre en ligne.
export const PAD_R = 0.55;
// le marchand, derrière son comptoir ; on lui parle en marchant sur la dalle devant le comptoir
export const MERCHANT = { x: 3.4, z: -5.55, counterZ: -4.95, counterW: 2.3 };
// le sorcier, devant sa tente (à gauche de la porte) : on apprend un sort en marchant sur la dalle devant son chaudron
// (x : dalle et chaudron ; manX, z : le sorcier, debout à droite du chaudron, devant sa tente)
export const SORCERER = { x: -3.1, manX: -2.2, z: -5.0, tentX: -3.35, tentZ: -6.05, cauldronZ: -4.55 };
export const HUB_PADS = [
  ...HERO_IDS.map((id, k) => ({ t: 'hero', id, x: -4.6, z: -2.4 + k * 1.35 })),
  { t: 'shop', id: 'shop', x: MERCHANT.x, z: -3.85 },
  { t: 'spell', id: 'spell', x: SORCERER.x, z: -3.55 },
];
const HUB_WALL = -5.15;
// socle de la statue, derrière chaque dalle de héros (contre le mur)
export const padStand = (pd) => ({ x: -5.9, z: pd.z });

// Boutique : un héros sur la dalle du marchand choisit son arme, sur celle du sorcier son sort
// (p.shopK : 0 = marchand, 1 = sorcier ; p.shop = 1 + arme ou sort montré).
// ← → (selon l'écran) changent l'arme montrée, attaque ou saut la prend, reculer ou bloquer s'en va.
// Une arme peut aussi être prise directement (clic, touches 1 à 9) : entrée mx = SHOP + n, mz = 127,
// blk = vrai (un déplacement au clavier ne donne jamais mx entre 110 et 126).
const SHOP = 110;
export const shopInput = (n) => ({ mx: SHOP + n, mz: 127, blk: true, press: 0 });
const SHOP_N = Math.max(WEAPON_IDS.length, SPELL_IDS.length);
const readShop = (s) => (s.blk && s.mz === 127 && s.mx >= SHOP && s.mx < SHOP + SHOP_N ? s.mx - SHOP : -1);
// ce que propose la boutique où se trouve p (armes ou sorts)
export const shopList = (p) => (p.shopK ? SPELL_IDS : WEAPON_IDS);
// sort actuel de p (clé de SPELLS) : celui choisi chez le sorcier, sinon celui de son personnage
export const spellKey = (p) => (SPELLS[p.spell] ? p.spell : SPELLS[p.kind] ? p.kind : 'soldier');
const SHOP_DIR = 64;   // seuil d'une direction franche (sur 127)

// Butin : les objets (items.js) sont sur des piédestaux (salle au trésor, boss) ; les salles normales
// laissent un cœur, des éclats (petits bonus, un par héros) ou rien. On ramasse en marchant dessus.
// Salle au trésor : après la salle n quand n % BOSS_EVERY vaut 2 (toujours) ou 4 (une fois sur deux).
export const VAULT = { always: 2, maybe: 4, chance: 0.5, maxItems: 5, spacing: 1.8 };
export const PICK_R = { item: 0.95, heart: 0.7, minor: 0.7, arm: 1.0, ped: 0.4 };
const PK_GRP = { item: 0, minor: 1, heart: 2 };
const PHOENIX = 0.6;            // PV rendus par la Plume de phénix
// Réanimation (à deux) : un héros tombé reste à quatre pattes (état 'dead' + down = 1, les ennemis l'ignorent).
// Son équipier le relève en bloquant à moins de R de lui pendant time s (la jauge redescend s'il s'arrête) ;
// sinon il se relève quand la salle est nettoyée. hp : part de ses PV max rendue. Seul, tomber = fin.
export const REVIVE = { time: 3, R: 1.5, hp: 0.4, decay: 2 };
const FURY = { below: 0.4, mul: 1.7 };

// Choix transmis comme des entrées (pour qu'ils passent par le rollback en ligne) : mz = 127, blk = vrai et
// mx hors des valeurs d'un déplacement au clavier (0, ±90 ou ±127). Plages : événement 95..99, boutique 110..,
// carte 120..126.
// Choix d'une destination sur la carte (phase 'map') : mx = 120 + n (0..6)
const MAP_IN = 120;
export const mapInput = (n) => ({ mx: MAP_IN + n, mz: 127, blk: true, press: 0 });
const readMapIn = (s) => (s.blk && s.mz === 127 && s.mx >= MAP_IN && s.mx <= MAP_IN + 6 ? s.mx - MAP_IN : -1);

// Choix d'une option d'événement '?' (phase 'event') : mx = 95 + n (0..4)
const EVT_IN = 95;
export const eventInput = (n) => ({ mx: EVT_IN + n, mz: 127, blk: true, press: 0 });
const readEventIn = (s) => (s.blk && s.mz === 127 && s.mx >= EVT_IN && s.mx <= EVT_IN + 4 ? s.mx - EVT_IN : -1);

const OBS_R = { column: 0.4, barrel: 0.45, rocks: 0.65, stand: 0.45 };
const OBS_H = { column: 1.8, barrel: 0.8, rocks: 0.75, stand: 1.8, tent: 1.6, cauldron: 0.7, npc: 1.6 };   // hauteur (les flèches passent au-dessus)

// donne au héros p son personnage et son arme (statistiques de base + trait du personnage)
// spell : sort appris chez le sorcier ('' = celui du personnage) ; gardé par défaut
export function equip(p, kind, wpn = defaultWeapon(kind), spell = p.spell ?? '') {
  if (!HEROES[kind]) kind = 'soldier';
  if (!WEAPONS[wpn]) wpn = defaultWeapon(kind);
  if (!SPELLS[spell]) spell = '';
  // statistiques de base et effets des objets (tout est remis à zéro : objets possédés compris)
  Object.assign(p, { kind, wpn, spell, ...ITEM_BASE, spellCd: 0, spellMax: spellOf({ kind, spell }).cd, spellBuffT: 0, stoneT: 0, totT: 0 });
  p.arch = !!wpnOf(p).bow;
  HEROES[kind].apply(p);
  const tank = wpnOf(p).tank;                   // gants de boxe : se cumule avec l'armure du héros
  if (tank) p.armor = 1 - (1 - p.armor) * (1 - tank);
  p.hp = p.maxHp;
}
function newHero(i, kind, wpn, spell) {
  // team : 0 = camp des héros (héros et chiens invoqués), 1 = ennemis ; owner : maître d'un chien
  const p = Object.assign(newFighter(i), { foe: '', size: 1, boss: false, trapT: 0, pad: -1, shop: 0, shopK: 0, shopIn: 0, team: 0, owner: -1, kills: 0, down: 0, revT: 0, ...STATUS0 });
  equip(p, kind, wpn, spell);
  return p;
}

// hauteur d'une surface (estrade ou escalier) au point (x, z)
function heightAt(s, x, z) {
  if (!s.ramp) return s.h;
  const c = s.ramp === 'x' ? x : z;
  return s.h * clamp((c - s.from) / (s.to - s.from), 0, 1);
}
const inRect = (s, x, z, m = 0) => x > s.x0 - m && x < s.x1 + m && z > s.z0 - m && z < s.z1 + m;
// rectangle couvrant les dalles d'indices [a, b] (côté signe sg) : coordonnées en unités de jeu
const span = (a, b, sg) => { const p = sg * a * TILE, q = sg * b * TILE; return [Math.min(p, q) - TILE / 2, Math.max(p, q) + TILE / 2]; };

export class DungeonSim extends Sim {
  // kinds : personnage de chaque héros (1 ou 2) ; wpns : leurs armes (par défaut : celle du personnage)
  // unlocked : héros débloqués de chaque joueur (listes d'identifiants), ou null = tous (tests, outils).
  // Ce n'est pas de l'état : identique chez les deux joueurs en ligne (transmis au lancement).
  // spells : sorts appris chez le sorcier ('' ou absent = celui du personnage)
  // opts.useMap : active la carte par actes (style Slay the Spire) ; false par défaut pour garder les tests historiques intacts.
  // (opts peut aussi être passé à la place de spells : new DungeonSim(seed, kinds, wpns, unlocked, { useMap: true }))
  constructor(seed = 1, kinds = ['soldier'], wpns = [], unlocked = null, spells = [], opts = {}) {
    if (spells && !Array.isArray(spells)) { opts = spells; spells = []; }
    const { useMap = false } = opts ?? {};
    super(seed);
    if (!Array.isArray(kinds)) kinds = [kinds];
    this.runSeed = (seed >>> 0) || 1;
    this.useMap = !!useMap;
    this.map = null;
    this.unlocked = unlocked ? kinds.map((_, i) => (Array.isArray(unlocked[i]) ? unlocked[i].filter((k) => HEROES[k]) : [])) : null;
    this.f = kinds.map((k, i) => newHero(i, this.canPick(i, k) ? k : FIRST_HERO, wpns[i], spells?.[i] ?? ''));
    this.inp = this.f.map(() => newInput());
    this.g = { phase: 'menu', np: kinds.length, room: 0, act: 1, roomType: 'hub', kills: 0, t: 0, clock: 0, slow: 1, slowT: 0, hitstop: 0, frame: 0,
      exitOpen: false, flagEnd: false, victory: false, endless: false,
      // rn : numéro de la salle construite (change aussi pour une salle au trésor, qui garde g.room) ;
      // vault : on est dans une salle au trésor ; vaultNext : la prochaine porte y mène ;
      // pkN : numéro du prochain objet ramassable ; seen : objets déjà sortis (pas de doublon dans une partie)
      // arenaLayout/Next/Quake/Ver : état de l'arène mouvante du Souverain d'Os (salle 20)
      rn: 0, vault: false, vaultNext: false, pkN: 0, seen: '',
      arenaLayout: 0, arenaNext: -1, arenaQuake: 0, arenaVer: 0,
      // carte : lootKind = butin de la salle une fois nettoyée ('combat' | 'elite') ; votes et événements '?'
      lootKind: 'combat', mapVote0: '', mapVote1: '', eventId: '', evPick0: -1, evPick1: -1, eventLog: '' };
    // objets à ramasser : { n, t: 'item' | 'heart' | 'minor', v : identifiant, x, z, grp, q : qualité, arm }
    this.pk = [];
    this.src = '';                 // nature du coup en cours ('melee', 'shot', 'fire') pour les effets
    // exit : mur de la porte de sortie ('z' : mur z = -R, 'x' : mur x = -R) ; on entre par le mur opposé
    this.room = { exit: 'z', obs: [], surf: [], traps: [], boss: false, roomType: 'hub', act: 1 };
    this.ais = [];
  }

  isHero(f) { return f.idx < this.g.np; }
  // le joueur i peut-il prendre ce héros ?
  canPick(i, kind) { return !this.unlocked || kind === FIRST_HERO || this.unlocked[i]?.includes(kind); }
  get heroes() { return this.f.slice(0, this.g.np); }
  get foesLeft() { let n = 0; for (const e of this.f) if (e.team === 1 && e.state !== 'dead') n++; return n; }
  // chiens vivants invoqués par le héros h
  dogsOf(h) { let n = 0; for (const e of this.f) if (e.owner === h && e.state !== 'dead') n++; return n; }

  start() { this.g.room = 0; this.g.kills = 0; this.g.seen = ''; this.g.victory = false; this.g.endless = false; for (const p of this.heroes) p.kills = 0; this.newRoom(); }

  // ---------------- salle d'armes ----------------
  startHub() {
    const g = this.g;
    g.room = 0; g.kills = 0; g.seen = ''; g.rn++; g.vault = false; g.vaultNext = false;
    g.victory = false; g.endless = false; g.arenaLayout = 0; g.arenaNext = -1; g.arenaQuake = 0; g.arenaVer = 0;
    g.act = 1; g.roomType = 'hub'; g.lootKind = 'combat';
    g.mapVote0 = g.mapVote1 = ''; g.eventId = ''; g.evPick0 = g.evPick1 = -1; g.eventLog = '';
    this.map = this.useMap ? generateMap(this.runSeed, 1) : null;
    for (const p of this.heroes) p.kills = 0;
    this.pk = [];
    const obs = HUB_PADS.filter((pd) => pd.t === 'hero').map((pd) => ({ ...padStand(pd), r: OBS_R.stand, kind: 'stand' }));
    // comptoir du marchand (trois cercles côte à côte)
    for (const dx of [-0.8, 0, 0.8]) obs.push({ x: MERCHANT.x + dx, z: MERCHANT.counterZ, r: OBS_R.stand, kind: 'counter' });
    // le sorcier : sa tente (deux cercles contre le mur) et son chaudron
    for (const dx of [-0.55, 0.55]) obs.push({ x: SORCERER.tentX + dx, z: SORCERER.tentZ, r: 0.75, kind: 'tent' });
    obs.push({ x: SORCERER.x, z: SORCERER.cauldronZ, r: 0.42, kind: 'cauldron' });
    obs.push({ x: SORCERER.manX, z: SORCERER.z, r: 0.35, kind: 'npc' });
    for (const [x, z] of [[5.3, -2.4], [5.3, -1.2], [5.3, 5.3]]) obs.push({ x, z, r: OBS_R.barrel, kind: 'barrel' });
    this.room = { exit: 'z', obs, surf: [], traps: [], boss: false, hub: true, roomType: 'hub', act: 1, pads: HUB_PADS };
    this.heroes.forEach((p, i) => {
      const x = this.g.np > 1 ? (i ? 1.6 : 0.4) : 1, yaw = Math.PI * 0.75;
      Object.assign(p, { x, y: 0, z: 2.5, vx: 0, vy: 0, vz: 0, yaw, visTarget: yaw, pad: -1, shop: 0, shopK: 0, shopIn: 0, down: 0, revT: 0, spellCd: 0, spellBuffT: 0, stoneT: 0, totT: 0, spellMax: spellOf(p).cd });
      p.resetN++;
      this.toIdle(p);
    });
    this.f = this.heroes;
    this.inp = this.f.map(() => newInput());
    this.ais = this.f.map(() => null);
    this.pr = [];
    g.phase = 'hub'; g.t = 0;
    g.exitOpen = true;
    this.emit('room', 0);
    this.emit('announce', "SALLE D'ARMES", '', 1.3);
  }
  // le héros p marche sur les dalles de la salle d'armes
  hubPads(p) {
    const pads = this.room.pads;
    let on = -1;
    if (p.y < 0.3) for (let k = 0; k < pads.length; k++) if (hypot(p.x - pads[k].x, p.z - pads[k].z) < PAD_R) { on = k; break; }
    if (on === p.pad) return;
    p.pad = on;
    if (on < 0) return;
    const pd = pads[on];
    if (pd.t === 'shop' || pd.t === 'spell') { this.enterShop(p, pd); return; }
    if (pd.id === p.kind) return;
    if (!this.canPick(p.idx, pd.id)) {
      this.emit('pop', 'VERROUILLÉ', p.x, p.y + 2.1, p.z, 'miss');
      this.emit('sfx', 'dodge');
      return;
    }
    equip(p, pd.id, p.wpn === defaultWeapon(p.kind) ? defaultWeapon(pd.id) : p.wpn);
    this.equipped(p, HEROES[pd.id].name);
  }
  // effets d'un changement d'équipement
  equipped(p, name) {
    p.resetN++;
    this.toIdle(p);
    this.emit('ring', p.x, p.y + 0.05, p.z, 0xffd34a, 1.8, 0.45, true);
    this.emit('emit', p.x, p.y + 1, p.z, 16, { color: [0xffd34a, 0xffe27a, 0xffffff], speed: 2, up: 3, size: 0.07, life: 0.7, grav: 6 });
    this.emit('pop', name, p.x, p.y + 2.1, p.z, 'parry');
    this.emit('sfx', 'parry');
    this.emit('equip', p.idx);
  }

  // ---------------- boutique du marchand ----------------
  enterShop(p, pd) {
    if (p.state === 'dead' || p.shop) return;
    p.shopK = pd.t === 'spell' ? 1 : 0;
    p.shop = 1 + Math.max(0, p.shopK ? SPELL_IDS.indexOf(spellKey(p)) : WEAPON_IDS.indexOf(p.wpn));
    p.shopIn = 7;                       // ignore la direction tenue en arrivant, jusqu'à ce qu'on la relâche
    const yaw = Math.PI;                // face au marchand ou au sorcier (vers −z)
    // à deux devant le comptoir : on se décale légèrement pour ne pas se pousser hors de la dalle
    const busy = this.heroes.some((q) => q !== p && q.shop > 0 && q.shopK === p.shopK);
    const x = busy ? pd.x + (p.idx ? 0.52 : -0.52) : pd.x;
    Object.assign(p, { x, z: pd.z, vx: 0, vz: 0, yaw, visTarget: yaw });
    this.toIdle(p);
    this.emit('sfx', p.shopK ? 'spell' : 'coin');
  }
  leaveShop(p) { p.shop = 0; p.shopIn = 0; }
  // entrée d'un héros dans la boutique (sa vraie entrée est ensuite remplacée par NEUTRAL)
  shopStep(p, src) {
    const n = readShop(src);
    if (n >= 0) { this.buy(p, n); return; }
    if (p.shopIn !== 7 && (src.mz > SHOP_DIR || src.blk || src.press & PRESS.roll)) { this.leaveShop(p); return; }
    const dir = src.mx > SHOP_DIR ? 1 : src.mx < -SHOP_DIR ? -1 : 0;
    if (p.shopIn === 7) { if (dir === 0 && src.mz >= -SHOP_DIR) p.shopIn = 0; }
    else if (dir !== p.shopIn) {
      p.shopIn = dir;
      if (dir) {
        const N = shopList(p).length;
        p.shop = 1 + ((p.shop - 1 + dir + N) % N);
        this.emit('sfx', 'tick');
      }
    }
    if (p.shopIn !== 7 && src.press & (PRESS.atk | PRESS.jump)) this.buy(p, p.shop - 1);
  }
  buy(p, n) {
    if (p.shopK) { this.learn(p, n); return; }
    const id = WEAPON_IDS[n];
    this.leaveShop(p);
    if (!id || id === p.wpn) return;
    equip(p, p.kind, id);
    this.emit('sfx', 'coin');
    this.equipped(p, WEAPONS[id].name);
  }
  // sorcier : p apprend le sort n de SPELL_IDS (celui de son propre héros = '' : il suivra ses changements de héros)
  learn(p, n) {
    const id = SPELL_IDS[n];
    this.leaveShop(p);
    if (!id || id === spellKey(p)) return;
    p.spell = id === p.kind ? '' : id;
    Object.assign(p, { spellCd: 0, spellBuffT: 0, stoneT: 0, totT: 0, spellMax: spellCdOf(p) });
    this.emit('sfx', 'spell');
    this.equipped(p, SPELLS[id].name);
  }

  // ---------------- sauvegarde (rollback en ligne & reprise de run) ----------------
  save() {
    return { f: this.f.map((o) => ({ ...o })), g: { ...this.g }, inp: this.inp.map((o) => ({ ...o })), rng: this.rng.s,
      runSeed: this.runSeed, useMap: this.useMap, map: cloneMap(this.map),
      room: this.room, ai: this.ais.map((a) => (a ? a.save() : null)), pr: this.pr.map((a) => ({ ...a })), pk: this.pk.map((o) => ({ ...o })) };
  }
  load(s) {
    this.f = s.f.map((o) => ({ ...o }));
    this.g = { ...s.g };
    this.inp = s.inp.map((o) => ({ ...o }));
    this.rng.s = s.rng;
    if (s.runSeed !== undefined) this.runSeed = s.runSeed;
    if (s.useMap !== undefined) this.useMap = !!s.useMap;
    this.map = cloneMap(s.map ?? null);
    this.room = s.room;            // jamais modifiée après sa création : partage sans risque
    this.ais = s.ai.map((a, i) => (a ? AI.restore(this, i, a) : null));
    this.pr = (s.pr ?? []).map((a) => ({ ...a }));
    this.pk = (s.pk ?? []).map((o) => ({ ...o }));
  }

  hash() { return hashState(this.save()); }

  // ---------------- carte des chemins (style Slay the Spire) ----------------
  openMap() {
    const g = this.g;
    if (!this.map) { g.act = 1; this.map = generateMap(this.runSeed, 1); }
    else if (isBossNode(this.map)) { g.act++; this.map = generateMap(this.runSeed, g.act); }
    g.phase = 'map'; g.t = 0;
    g.mapVote0 = ''; g.mapVote1 = '';
    this.emit('map', g.act);
  }
  mustVoteMap(h) { return this.g.phase === 'map' && h < this.g.np && !this.g['mapVote' + h]; }
  voteMap(h, choiceIdx) {
    const g = this.g;
    if (g.phase !== 'map' || h < 0 || h >= g.np || !this.map) return false;
    const avail = availableNextIds(this.map);
    const id = avail[choiceIdx];
    if (!id) return false;
    if (g.np === 1) {
      const node = advanceMap(this.map, id);
      if (!node) return false;
      this.newRoom(node);
      return true;
    }
    g['mapVote' + h] = id;
    this.emit('sfx', 'tick');
    if (g.mapVote0 && g.mapVote1) {
      let winId = g.mapVote0;
      if (g.mapVote0 !== g.mapVote1) {
        winId = this.rng.next() < 0.5 ? g.mapVote0 : g.mapVote1;
        this.emit('announce', 'VOTE PARTAGÉ !', '', 1.0);
      }
      const node = advanceMap(this.map, winId);
      if (node) this.newRoom(node);
    }
    return true;
  }

  // ---------------- génération d'une salle ----------------
  // node : salle choisie sur la carte (type, graine) ; sans carte : salles numérotées, boss toutes les 5
  newRoom(node = null) {
    const g = this.g, np = g.np;
    const r = node ? new Rng(node.roomSeed) : this.rng;
    g.room++; g.rn++; g.vault = false; g.vaultNext = false;
    this.pk = [];
    const n = g.room;
    const roomType = node ? node.type : (n % BOSS_EVERY === 0 ? 'boss' : 'combat');
    const boss = roomType === 'boss';
    const elite = roomType === 'elite';
    const treasure = roomType === 'treasure';
    const isEvent = roomType === 'event';
    const bossId = boss ? (node ? BOSS_ORDER[(Math.max(1, g.act) - 1) % BOSS_ORDER.length] : bossOf(n)) : '';
    const act = this.useMap ? g.act : Math.floor((Math.max(1, n) - 1) / BOSS_EVERY) + 1;
    g.roomType = roomType;
    g.lootKind = elite ? 'elite' : 'combat';
    g.eventId = ''; g.evPick0 = g.evPick1 = -1; g.eventLog = '';
    g.arenaLayout = 0; g.arenaNext = -1; g.arenaQuake = 0; g.arenaVer = 0;

    const exit = r.next() < 0.5 ? 'z' : 'x';
    const used = new Set();                       // dalles occupées « i,j »
    const key = (i, j) => i + ',' + j;

    // estrades avec un escalier tourné vers le centre (à partir de la 3e salle, hors salles calmes / antre)
    let surf = [];
    const q = r.next();
    const lair = bossId === 'cerbere' ? 'cerbere' : bossId === 'squelette' ? 'squelette' : '';
    const calm = treasure || isEvent;
    const nPlat = n < 3 || lair || calm ? 0 : boss ? 2 : q < 0.4 ? 1 : q < 0.6 ? 2 : 0;
    const quads = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
    for (let p = 0; p < nPlat; p++) {
      const [sx, sz] = quads.splice((r.next() * quads.length) | 0, 1)[0];
      const w = 2 + ((r.next() * 2) | 0), d = 2 + ((r.next() * 2) | 0);
      const a = w === 3 ? 2 : 2 + ((r.next() * 2) | 0), b = d === 3 ? 2 : 2 + ((r.next() * 2) | 0);
      const [x0, x1] = span(a, a + w - 1, sx), [z0, z1] = span(b, b + d - 1, sz);
      surf.push({ x0, x1, z0, z1, h: PLAT_H, ramp: '' });
      for (let i = a; i < a + w; i++) for (let j = b; j < b + d; j++) used.add(key(sx * i, sz * j));
      // escalier sur une dalle du côté du centre, sur toute la largeur de l'estrade
      if (r.next() < 0.5) {
        const [rx0, rx1] = span(a - 1, a - 1, sx);
        surf.push({ x0: rx0, x1: rx1, z0, z1, h: PLAT_H, ramp: 'x', from: sx > 0 ? rx0 : rx1, to: sx > 0 ? rx1 : rx0 });
        for (let j = b; j < b + d; j++) used.add(key(sx * (a - 1), sz * j));
      } else {
        const [rz0, rz1] = span(b - 1, b - 1, sz);
        surf.push({ x0, x1, z0: rz0, z1: rz1, h: PLAT_H, ramp: 'z', from: sz > 0 ? rz0 : rz1, to: sz > 0 ? rz1 : rz0 });
        for (let i = a; i < a + w; i++) used.add(key(sx * i, sz * (b - 1)));
      }
    }

    // obstacles et pièges hors des deux allées centrales (celles des portes) et des estrades
    const freeTile = () => {
      for (let tries = 0; tries < 40; tries++) {
        const i = ((r.next() * 7) | 0) - 3, j = ((r.next() * 7) | 0) - 3;
        if (i === 0 || j === 0 || used.has(key(i, j))) continue;
        used.add(key(i, j));
        // un peu d'air autour
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) used.add(key(i + di, j + dj));
        return [i * TILE, j * TILE];
      }
      return null;
    };
    let obs = [];
    const nObs = lair || calm ? 0 : boss ? 2 : (r.next() * 4) | 0;
    const kinds = ['column', 'column', 'barrel', 'rocks'];
    if (lair === 'cerbere' || calm) for (const [i, j] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) obs.push({ x: i * TILE, z: j * TILE, r: OBS_R.column, kind: 'column' });
    for (let k = 0; k < nObs; k++) {
      const t = freeTile();
      if (!t) break;
      const kind = boss ? 'column' : kinds[(r.next() * kinds.length) | 0];
      obs.push({ x: t[0], z: t[1], r: OBS_R[kind], kind });
    }
    let traps = [];
    if (n >= 2 && !lair && !calm && r.next() < 0.45) {
      const nt = 2 + ((r.next() * 3) | 0);
      for (let k = 0; k < nt; k++) { const t = freeTile(); if (t) traps.push({ x: t[0], z: t[1] }); }
    }
    if (lair === 'squelette') {
      const L0 = arenaLayoutData(0);
      obs = L0.obs; surf = L0.surf; traps = L0.traps;
    }
    const biome = lair === 'cerbere' ? 'lair' : lair === 'squelette' ? 'ossuary' : biomeOfAct(act, this.useMap ? this.runSeed : 0);
    this.room = { exit, obs, surf, traps, boss, bossId, lair, biome, roomType, act };

    // les héros entrent par le mur opposé à la sortie (les héros tombés se relèvent)
    const ent = ROOM_R - 0.7;
    this.enterHeroes(exit);

    // Salles sans combat initial : Trésor & Événement '?'
    if (treasure || isEvent) {
      this.f = [...this.heroes];
      this.inp = this.f.map(() => newInput());
      this.pr = [];
      this.ais = this.f.map(() => null);
      g.slow = 1; g.slowT = 0; g.hitstop = 0;
      if (node) this.rng.s = r.s;
      if (treasure) {
        // salle au trésor de la carte : objets sur des piédestaux (comme newVault), porte ouverte
        g.vault = true;
        this.room = { ...this.room, vault: true };
        this.placeItems('vault');
        g.phase = 'clear'; g.t = 0;
        g.exitOpen = true;
        this.emit('room', n);
        this.emit('announce', 'SALLE AU TRÉSOR', '', 1.4);
        this.emit('sfx', 'coin');
        return;
      }
      // Événement mystérieux
      const evId = EVENT_IDS[(r.next() * EVENT_IDS.length) | 0];
      g.eventId = evId;
      g.phase = 'event'; g.t = 0;
      g.exitOpen = false;
      this.emit('room', n);
      this.emit('announce', EVENTS[evId].title.toUpperCase(), '', 1.4);
      this.emit('sfx', 'spell');
      return;
    }

    // ennemis (plus nombreux à deux)
    const list = [];
    // le chef orc vient avec des orcs ; le colosse arrive seul (ses renforts viennent quand il enrage)
    // (à deux, son escorte grandit : x COOP.escort, au plus COOP.escortCap)
    const escort = Math.min(4, Math.max(1, Math.floor(n / BOSS_EVERY))), escortN = np > 1 ? Math.min(COOP.escortCap, Math.ceil(escort * COOP.escort)) : escort;
    if (boss) { list.push(bossId); if (bossId === 'boss') for (let k = 0; k < escortN; k++) list.push('grunt'); }
    else if (elite) {
      // Salle Élite : 1 champion renforcé + escorte
      list.push('elite');
      let extra = Math.min(4, 1 + Math.floor(n / 3));
      if (np > 1) extra = Math.min(COOP.cap - 1, Math.ceil(extra * COOP.count));
      for (let k = 0; k < extra; k++) {
        const u = r.next();
        list.push(u < 0.28 ? 'archer' : u < 0.65 ? 'guard' : 'zombie');
      }
    } else {
      let count = Math.min(5, 1 + Math.floor(n / 2));
      if (np > 1) count = Math.min(COOP.cap, Math.ceil(count * COOP.count));
      for (let k = 0; k < count; k++) {
        const u = r.next();
        // à partir de la 2e salle, environ un ennemi sur cinq est un archer
        if (n >= 2 && r.next() < 0.22) { list.push('archer'); continue; }
        const id = u < Math.min(0.35, (n - 2) * 0.06) ? 'elite' : u < Math.min(0.7, (n - 1) * 0.12) ? 'guard' : 'grunt';
        // plus bas, un orc sur deux est remplacé par un zombie (plus résistant)
        list.push(id === 'grunt' && n >= 4 && k % 2 ? 'zombie' : id);
      }
    }
    const foes = [];
    const [px, pz] = exit === 'z' ? [0, ent] : [ent, 0];
    for (let li = 0; li < list.length; li++) {
      const id = list[li];
      const T = FOES[id];
      let x = 0, z = 0;
      for (let tries = 0; tries < 40; tries++) {
        // dans la moitié de la salle côté sortie, loin des héros
        const a = r.range(-ROOM_T + 0.5, ROOM_T - 0.5), b = r.range(-ROOM_T + 0.5, 0.5);
        [x, z] = exit === 'z' ? [a, b] : [b, a];
        if (T.boss || (elite && li === 0)) [x, z] = exit === 'z' ? [0, -3] : [-3, 0];
        const free = obs.every((o) => hypot(o.x - x, o.z - z) > o.r + 0.8) && foes.every((e) => hypot(e.x - x, e.z - z) > 1.4) &&
          surf.every((s) => !s.ramp || !inRect(s, x, z, 0.3));
        if (free && hypot(px - x, pz - z) > 4) break;
      }
      const foe = this.newFoe(id, np + foes.length, x, z, atan2(px - x, pz - z));
      if (elite && li === 0) {
        foe.size = 1.32;
        foe.hp = foe.maxHp = Math.round(foe.hp * 1.65);
        foe.pow *= 1.2;
        foe.eliteChamp = 1;
      }
      foes.push(foe);
    }
    this.f = [...this.heroes, ...foes];
    this.inp = this.f.map(() => newInput());
    this.pr = [];
    const aseed = (r.next() * 4294967296) >>> 0;
    this.ais = this.f.map((e, i) => (i < np ? null : new AI(this, i, FOES[e.foe].lv, (aseed + i * 104729) >>> 0)));
    if (node) this.rng.s = r.s;
    // objets « chien à chaque salle » (Sifflet de berger, Os de Cerbère…) : la meute entre avec son maître
    for (const p of this.heroes) for (let k = 0; k < p.dogRoom && this.dogsOf(p.idx) < this.dogCap(p); k++) this.spawnDog(p, (k + 1) * 0.9);

    g.phase = 'intro'; g.t = 0;
    g.exitOpen = false;
    g.slow = 1; g.slowT = 0; g.hitstop = 0;

    this.emit('room', n);
    this.emit('announce', boss ? FOES[bossId].name.toUpperCase() + ' !' : elite ? 'SALLE ÉLITE !' : `SALLE ${n}`, boss || elite ? 'ko' : '', 1.3);
    this.emit('sfx', 'gong');
  }

  // ---------------- événements '?' ----------------
  mustPickEvent(h) { return this.g.phase === 'event' && h < this.g.np && this.f[h]?.state !== 'dead' && this.g['evPick' + h] < 0; }
  chooseEvent(h, optIdx) {
    const g = this.g, ev = EVENTS[g.eventId];
    if (g.phase !== 'event' || !ev || !this.mustPickEvent(h)) return false;
    const ch = ev.choices[optIdx];
    if (!ch) return false;
    const p = this.f[h];
    g['evPick' + h] = optIdx;
    const res = ch.apply(this, p);
    const txt = typeof res === 'string' ? res : (res?.text ?? '');
    if (txt) {
      const prefix = g.np > 1 ? `J${h + 1} : ` : '';
      g.eventLog = g.eventLog ? `${g.eventLog}  ·  ${prefix}${txt}` : `${prefix}${txt}`;
    }
    if (res && typeof res === 'object' && res.ambush) {
      this.spawnAmbush(res.ambush);
      return true;
    }
    // objets sur des piédestaux au milieu de la salle (Coffre maudit ouvert sans piège)
    if (res && typeof res === 'object' && res.spawnItems) this.placeItems(res.spawnItems);
    if (!this.heroes.some((_, i) => this.mustPickEvent(i))) {
      g.phase = 'clear'; g.t = 0;
      g.exitOpen = true;
    }
    return true;
  }
  spawnAmbush(kind) {
    const g = this.g, list = kind === 'elite' ? ['elite', 'guard', 'archer'] : ['elite', 'guard'];
    if (g.np > 1) list.push('guard');
    const spots = [[-2.4, -2.2], [2.4, -2.2], [0, -3.4], [-2.8, 1.2]];
    list.forEach((id, k) => {
      const [sx, sz] = spots[k % spots.length];
      const e = this.addFoe(id, sx, sz);
      if (k === 0) { e.size = 1.28; e.hp = e.maxHp = Math.round(e.hp * 1.45); e.pow *= 1.15; e.eliteChamp = 1; }
    });
    g.lootKind = 'elite';      // une fois l'embuscade vaincue : butin d'élite
    g.eventId = '';
    g.phase = 'fight'; g.t = 0;
    g.exitOpen = false;
    this.emit('announce', 'EMBUSCADE !', 'ko', 1.3);
  }
  // ennemi n° idx de type id (PV et dégâts selon la profondeur et le nombre de héros)
  newFoe(id, idx, x, z, yaw) {
    const T = FOES[id], n = Math.max(1, this.g.room);
    const np = this.g.np, hp = Math.round(T.hp * (1 + 0.07 * (n - 1)) * coop(np, T.boss ? 'bossHp' : 'hp'));
    const e = Object.assign(newFighter(idx), { x, z, yaw, visTarget: yaw, kind: T.kind, wpn: T.wpn ?? defaultWeapon(T.kind), foe: id, size: T.size,
      boss: !!T.boss, hp, maxHp: hp, pow: T.pow * (1 + 0.04 * (n - 1)) * coop(np, T.boss ? 'bossPow' : 'pow'), armor: 0, leech: 0, staMul: 1, trapT: 0, team: 1, owner: -1, ...STATUS0 });
    e.arch = !!wpnOf(e).bow;
    if (T.moves) Object.assign(e, { sp: '', spT: 0, spA: 0, spX: 0, spZ: 0, spHit: 0, spCd: BOSS.first * coop(np, 'bossCd'), rage: 0, spTick: 0, spStage: 0 });
    if (T.brute) e.brute = 1;
    e.y = this.groundY(e);
    return e;
  }
  // ajoute un ennemi en cours de salle (renforts, outil de débogage) ; il se bat tout de suite
  addFoe(id, x, z) {
    const idx = this.f.length, lim = ROOM_R - 0.7;
    x = clamp(x, -lim, lim); z = clamp(z, -lim, lim);
    const o = this.f[0];
    const e = this.newFoe(id, idx, x, z, atan2(o.x - x, o.z - z));
    this.f.push(e);
    this.inp.push(newInput());
    this.ais.push(new AI(this, idx, FOES[id].lv, (this.rng.next() * 4294967296) >>> 0));
    this.emit('emit', x, e.y + 0.3, z, 22, { color: [0x8a8090, 0x5a5260, 0x6aff6a], speed: 2.2, up: 3, size: 0.09, life: 0.7, grav: 6 });
    this.emit('ring', x, e.y + 0.05, z, 0x7aff7a, 1.6, 0.5, true);
    return e;
  }
  // les héros entrent par le mur opposé à la sortie ; les héros tombés se relèvent ; on remet à zéro ce qui
  // ne dure qu'une salle (sort, états, effets d'objets « jusqu'à la fin de la salle »)
  enterHeroes(exit) {
    const ent = ROOM_R - 0.7, np = this.g.np;
    this.heroes.forEach((p, i) => {
      const off = np > 1 ? (i ? 0.8 : -0.8) : 0;
      const [px, pz, yaw] = exit === 'z' ? [off, ent, Math.PI] : [ent, off, -Math.PI / 2];
      if (p.state === 'dead') p.hp = Math.round(p.maxHp * 0.4);
      else if (p.roomHeal > 0) heal(p, Math.round(p.maxHp * p.roomHeal));
      const smax = spellCdOf(p);
      Object.assign(p, { x: px, y: 0, z: pz, vx: 0, vy: 0, vz: 0, yaw, visTarget: yaw, hitDone: false, combo: 0, airAtk: false, trapT: 0, pad: -1, shop: 0, shopIn: 0, down: 0, revT: 0, spellCd: 0, spellBuffT: 0, stoneT: 0, totT: 0, spellMax: smax,
        ...STATUS0, took: 0, frenzyN: 0, rollBuffOn: 0, rollHit: 0, hitN: 0, zeusN: 0, auraT: 0, stormT: FX.storm.every });
      p.resetN++;
      this.toIdle(p);
    });
  }
  // salle au trésor : pas d'ennemi, des objets sur des piédestaux (un par héros, plus les choix en plus),
  // porte ouverte. Elle ne compte pas comme une salle (g.room ne change pas).
  newVault() {
    const g = this.g, r = this.rng;
    g.rn++; g.vault = true; g.vaultNext = false;
    this.pk = [];
    const exit = r.next() < 0.5 ? 'z' : 'x';
    this.room = { exit, obs: [], surf: [], traps: [], boss: false, bossId: '', lair: '', vault: true };
    this.enterHeroes(exit);
    this.f = this.heroes;
    this.inp = this.f.map(() => newInput());
    this.ais = this.f.map(() => null);
    this.pr = [];
    this.placeItems('vault');
    g.phase = 'clear'; g.t = 0;
    g.exitOpen = true;
    g.slow = 1; g.slowT = 0; g.hitstop = 0;
    this.emit('room', g.room);
    this.emit('announce', 'SALLE AU TRÉSOR', '', 1.4);
    this.emit('sfx', 'coin');
  }

  // ---------------- objets à ramasser ----------------
  // position d'un objet : a en travers de l'allée de la porte, b le long (allées : jamais d'obstacle ni de piège)
  lanePos(a, b) { return this.room.exit === 'z' ? [a, b] : [b, a]; }
  addPk(t, v, a, b, q = 0) {
    const [x, z] = this.lanePos(a, b);
    const o = { n: this.g.pkN++, t, v, x, z, grp: PK_GRP[t], q, arm: t === 'item' ? 0 : 1 };
    this.pk.push(o);
    return o;
  }
  // objets sur des piédestaux : un par héros, plus les choix en plus (Trèfle…) ; on n'en garde qu'un chacun
  placeItems(src) {
    const g = this.g, hs = this.heroes;
    let n = g.np;
    for (const p of hs) n += p.choice;
    n = Math.min(VAULT.maxItems, n);
    const luck = Math.max(0, ...hs.map((p) => p.luck));
    for (let k = 0; k < n; k++) {
      const id = rollItem(this.rng, src, Math.max(1, g.room), luck, g.seen) || 'eclat';
      if (id !== 'eclat') g.seen += (g.seen ? ',' : '') + id;
      this.addPk('item', id, (k - (n - 1) / 2) * VAULT.spacing, 0, itemOf(id).q);
    }
  }
  dropHeart(x, z) {
    const lim = ROOM_R - 1;
    this.pk.push({ n: this.g.pkN++, t: 'heart', v: '', x: clamp(x, -lim, lim), z: clamp(z, -lim, lim), grp: PK_GRP.heart, q: 0, arm: 1 });
    this.emit('ring', x, 0.1, z, 0xff5a6a, 1, 0.3, true);
  }
  // butin d'une salle nettoyée
  dropLoot() {
    const r = this.rng, hs = this.heroes, abund = hs.some((p) => p.abund);
    let hearts = abund ? 1 : 0;
    if (this.room.boss) { this.placeItems('boss'); hearts++; }
    else if (this.g.lootKind === 'elite') { this.placeItems('elite'); hearts++; }   // salle élite (carte) : objet rare ou mieux
    else {
      const u = r.next();
      if (u < LOOT.heart) hearts++;
      else if (u < LOOT.minor) hs.forEach((p, k) => this.addPk('minor', MINOR_IDS[(r.next() * MINOR_IDS.length) | 0], hs.length > 1 ? (k ? 1.5 : -1.5) : 0, 0));
    }
    for (let k = 0; k < hearts; k++) this.addPk('heart', '', 0, k ? -1.5 : 1.5);
  }
  // un héros ramasse ce qu'il touche
  pickups() {
    if (!this.pk.length) return;
    const hs = this.heroes;
    for (const o of this.pk) if (!o.arm && hs.every((p) => hypot(p.x - o.x, p.z - o.z) > PICK_R.arm)) o.arm = 1;
    for (let k = this.pk.length - 1; k >= 0; k--) {
      const o = this.pk[k];
      if (!o.arm) continue;
      const p = hs.find((h) => h.state !== 'dead' && h.y - this.groundY(h) < 0.6 && !(h.took & (1 << o.grp) && o.grp !== PK_GRP.heart) &&
        hypot(h.x - o.x, h.z - o.z) < PICK_R[o.t] * Math.max(1, h.size ?? 1) && (o.t !== 'heart' || h.hp < h.maxHp));
      if (!p) continue;
      this.pk.splice(k, 1);
      if (o.t === 'heart') {
        this.healPop(p, Math.round(FX.heart * p.heartMul));
        this.emit('sfx', 'coin');
        this.emit('emit', o.x, 0.6, o.z, 14, { color: [0xff5a6a, 0xffb0b8, 0xffffff], speed: 2, up: 3, size: 0.07, life: 0.7, grav: 4 });
        continue;
      }
      p.took |= 1 << o.grp;
      if (o.t === 'item') this.giveItem(p, o.v); else this.giveMinor(p, o.v);
      this.emit('take', p.idx, o.n);
      // chacun a pris son objet : les autres disparaissent
      if (hs.every((h) => h.took & (1 << o.grp))) {
        for (let j = this.pk.length - 1; j >= 0; j--) {
          const q = this.pk[j];
          if (q.grp !== o.grp) continue;
          this.emit('emit', q.x, 1, q.z, 16, { color: [0xd8d0ff, 0x8a80b0, 0xffffff], speed: 1.6, up: 2, size: 0.08, life: 0.7, grav: -1 });
          this.pk.splice(j, 1);
        }
        if (k > this.pk.length) k = this.pk.length;
      }
    }
  }


  // ---------------- points d'extension de Sim ----------------
  target(i) {
    const me = this.f[i], hero = this.isHero(me);
    // Pomme de discorde : un ennemi semé dans la discorde s'en prend à ses alliés (s'il en reste)
    const conf = me.sConf > 0 && me.team === 1 && this.foesAlive() > 1;
    let best = null, bd = hero ? LOCK_R : 1e9;
    for (const o of this.f) {
      if (o === me || o.state === 'dead' || (conf ? o.team !== me.team : o.team === me.team)) continue;
      const d = hypot(o.x - me.x, o.z - me.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  groundY(f) {
    let h = 0;
    for (const s of this.room.surf) if (inRect(s, f.x, f.z)) h = Math.max(h, heightAt(s, f.x, f.z));
    return h;
  }
  // au sol : on suit les marches de l'escalier, vers le haut comme vers le bas
  settle(f) {
    if (f.state === 'air') return;
    const gy = this.groundY(f);
    if (f.y < gy || (f.y - gy < 0.2 && f.vy <= 0)) { f.y = gy; f.vy = 0; }
  }

  foeOf(o, f) { const s = this.f[o]; return !!s && s.team !== f.team; }
  canCastSpell(f) { return this.isHero(f) && !!(SPELLS[f.spell] || SPELLS[f.kind]); }
  mitigateSpell(def, dmg) { return dmg; }   // appliqué directement dans DungeonSim.damage()

  // ---------------- grimoire : chiens invoqués ----------------
  canSummon(f) {
    const ph = this.g.phase;
    return this.isHero(f) && (ph === 'fight' || ph === 'intro' || ph === 'clear' || ph === 'hub') && this.dogsOf(f.idx) < this.dogCap(f);
  }
  // chiens au plus pour le héros p (grimoire : CAST.max, plus les objets de la meute)
  dogCap(p) { return CAST.max + (p.dogMax ?? 0); }
  summon(p) { if (this.canSummon(p)) this.spawnDog(p); }
  // un chien apparaît devant le héros p (ou à côté : side) et se bat avec lui (piloté par une IA, dans la simulation)
  // Objets : Collier clouté (dogMul : PV et dégâts), Portée infernale (hellPack : chiens des enfers)
  spawnDog(p, side = 0) {
    const g = this.g, T = FOES.dog, n = Math.max(1, g.room), idx = this.f.length;
    const lim = ROOM_R - 0.6, a = p.yaw + side;
    const x = clamp(p.x + sin(a), -lim, lim), z = clamp(p.z + cos(a), -lim, lim);
    const buff = 1 + (p.dogMul ?? 0), hell = p.hellPack ? 1 : 0;
    const hp = Math.round(T.hp * (1 + 0.07 * (n - 1)) * buff);
    const d = Object.assign(newFighter(idx), { x, z, yaw: p.yaw, visTarget: p.yaw, kind: 'dog', wpn: 'bite', arch: false, foe: 'dog', size: hell ? 1 : T.size,
      boss: false, hp, maxHp: hp, pow: T.pow * (1 + 0.04 * (n - 1)) * buff * (hell ? 1.5 : 1), armor: 0, leech: 0, staMul: 1, trapT: 0, pad: -1, team: 0, owner: p.idx, ...STATUS0, hell });
    d.y = this.groundY(d);
    this.f.push(d);
    this.inp.push(newInput());
    this.ais.push(new AI(this, idx, T.lv, (this.rng.next() * 4294967296) >>> 0));
    const col = hell ? [0xff7a2e, 0xff3a10, 0xffe27a] : [0xb98aff, 0x7a4adf, 0xffffff];
    this.emit('emit', x, d.y + 0.4, z, 26, { color: col, speed: 2.4, up: 3, size: 0.08, life: 0.7, grav: 4 });
    this.emit('ring', x, d.y + 0.05, z, col[0], 1.6, 0.5, true);
    this.emit('sfx', 'bark');
    return d;
  }
  arrowWall(a) {
    if (Math.abs(a.x) > ROOM_R || Math.abs(a.z) > ROOM_R || a.y < 0.02) return true;
    for (const o of this.room.obs) if (a.y < OBS_H[o.kind] && hypot(a.x - o.x, a.z - o.z) < o.r) return true;
    for (const s of this.room.surf) if (inRect(s, a.x, a.z) && a.y < heightAt(s, a.x, a.z)) return true;
    return false;
  }

  inLane(f) { return Math.abs(this.room.exit === 'z' ? f.x : f.z) < LANE + 0.35; }

  bound(f) {
    for (const o of this.room.obs) {
      const dx = f.x - o.x, dz = f.z - o.z, d = hypot(dx, dz), m = o.r + BODY;
      if (d < m && f.y < 1.2) {
        if (d < 1e-6) f.x = o.x + m;
        else { f.x = o.x + dx / d * m; f.z = o.z + dz / d * m; }
      }
    }
    // piédestaux des objets
    for (const o of this.pk) {
      if (o.t !== 'item') continue;
      const dx = f.x - o.x, dz = f.z - o.z, d = hypot(dx, dz), m = PICK_R.ped + BODY * (f.size ?? 1);
      if (d < m && f.y < 0.9) {
        if (d < 1e-6) f.z = o.z + m;
        else { f.x = o.x + dx / d * m; f.z = o.z + dz / d * m; }
      }
    }

    // salle d'armes : les rangées de statues et de présentoirs forment un mur (sauf devant la porte)
    if (this.room.hub) {
      if (f.x < HUB_WALL) f.x = HUB_WALL;
      if (f.z < HUB_WALL && Math.abs(f.x) > LANE + 0.45) f.z = HUB_WALL;
    }
    // bords d'estrade trop hauts : on bute dessus (sauter permet de monter)
    const M = 0.3;
    for (const s of this.room.surf) {
      if (!inRect(s, f.x, f.z, M)) continue;
      const top = heightAt(s, clamp(f.x, s.x0, s.x1), clamp(f.z, s.z0, s.z1));
      if (f.y >= top - STEP) continue;
      const pen = [f.x - (s.x0 - M), (s.x1 + M) - f.x, f.z - (s.z0 - M), (s.z1 + M) - f.z];
      const k = pen.indexOf(Math.min(...pen));
      if (k === 0) f.x = s.x0 - M; else if (k === 1) f.x = s.x1 + M; else if (k === 2) f.z = s.z0 - M; else f.z = s.z1 + M;
    }
    const g = this.g, R = ROOM_R - BODY, ex = this.room.exit;
    const door = this.isHero(f) && g.exitOpen && f.state !== 'dead';
    // coordonnée qui traverse la porte (a) et coordonnée le long du mur (b)
    let a = ex === 'z' ? f.z : f.x, b = ex === 'z' ? f.x : f.z;
    b = clamp(b, -R, R);
    if (door && (a < -R || this.inLane(f))) {
      a = Math.min(a, R);
      if (a < -R) b *= 0.8;                       // dans le passage : on est guidé vers le milieu
      // ne pas arracher un équipier en train de choisir son arme chez le marchand
      const blockedByShop = g.phase === 'hub' && this.heroes.some((q) => q !== f && q.shop > 0);
      if (blockedByShop) a = Math.max(a, -R);
      else if (a < -ROOM_R - 0.5 && (g.phase === 'clear' || g.phase === 'hub')) { g.phase = 'exit'; g.t = 0; this.emit('exit'); }
    } else a = clamp(a, -R, R);
    if (ex === 'z') { f.z = a; f.x = b; } else { f.x = a; f.z = b; }
  }

  nearWall(f, mx, mz) {
    const R = ROOM_R - 1.1;
    if ((f.x > R && mx > 0) || (f.x < -R && mx < 0) || (f.z > R && mz > 0) || (f.z < -R && mz < 0)) return true;
    for (const o of this.room.obs) {
      const dx = o.x - f.x, dz = o.z - f.z;
      if (hypot(dx, dz) < o.r + 0.9 && dx * mx + dz * mz > 0) return true;
    }
    return false;
  }

  damage(att, def, dmg, knock, dur, cx, cy, cz) {
    if (def.god) { this.emit('pop', 'INVINCIBLE', def.x, def.y + 1.8, def.z, 'miss'); return; }
    if (def.fireImmune && this.src === 'fire') return;                              // Avatar d'Héphaïstos
    const hero = this.itemHero(att);                                                  // héros dont les objets comptent (ou null)
    const fury = att.berserk && att.hp < att.maxHp * FURY.below ? FURY.mul : 1;     // Rage d'Arès
    const exec = att.execPow && def.hp < def.maxHp * 0.45 ? 1 + att.execPow : 1;
    const vsBoss = def.boss && att.bossPow > 1 ? att.bossPow : 1;
    // coups critiques (Œil de lynx, Faucheur…) ; Cœur de l'hiver : toujours critique sur un ennemi congelé
    const isCrit = (att.crit > 0 && this.rng.next() < Math.min(CAPS.crit, att.crit)) || (att.frzCrit > 0 && def.sFrz > 0);
    const critK = isCrit ? (att.critMul ?? 2) : 1;
    const aegis = spellShield(def);                                                   // sorts Rempart sacré, Peau de pierre
    const amp = hero && def.team !== hero.team ? this.heroMul(att, def) : 1;        // bonus des objets (états, Midas…)
    const armor = Math.min(CAPS.armor, def.armor ?? 0);
    dmg = Math.max(1, Math.round(dmg * att.pow * fury * exec * vsBoss * critK * amp * (1 - armor) * aegis));
    if (isCrit) {
      this.emit('pop', 'CRIT !', def.x, def.y + 2.15, def.z, 'spell');
      if (att.critHeal > 0) heal(att, att.critHeal);
    }
    if (att.leech) heal(att, Math.min(CAPS.leech, att.leech * (att.leechMul ?? 1)));
    // « Plume de phénix » : le coup qui l'aurait mis à terre le fait renaître (une fois)
    if (def.phoenix && def.hp - dmg <= 0) { this.rebirth(def); return; }
    if (def.boss) knock *= 0.4;               // le chef ne recule presque pas
    if (def.sp) this.armorHit(att, def, dmg, cx, cy, cz);
    else super.damage(att, def, dmg, knock, dur, cx, cy, cz);
    this.enrage(def);
    // « Épines de bronze » : une part des dégâts revient à l'attaquant
    if (def.thorns && att !== def && att.team !== def.team && att.state !== 'dead') this.thornsHit(def, att, Math.max(1, Math.round(dmg * def.thorns)));
    // objets : effets au coup porté (feu, poison, foudre…) et au coup reçu (Paratonnerre)
    if (hero && def.team !== hero.team) this.onHitItems(att, def, dmg, isCrit);
    if (this.isHero(def) && def.state !== 'dead') this.onHurtItems(def, att);
    // Bacchanale : un ennemi sous l'effet de la discorde qui frappe un allié soigne le héros
    if (att.team === 1 && def.team === 1 && att.sConf > 0) { const h = this.f[att.sConfBy]; if (h && h.confHeal && h.state !== 'dead') this.healPop(h, h.confHeal); }
  }

  // un héros à terre se relève (réanimé par son équipier, ou salle nettoyée)
  getUp(p, msg) {
    p.down = 0; p.revT = 0;
    p.hp = Math.max(1, Math.round(p.maxHp * REVIVE.hp));
    this.toIdle(p);
    this.emit('pop', msg, p.x, p.y + 2.1, p.z, 'parry');
    this.emit('sfx', 'parry');
    this.emit('ring', p.x, p.y + 0.1, p.z, 0x8fe36a, 2, 0.5, true);
    this.emit('emit', p.x, p.y + 0.8, p.z, 22, { color: [0x8fe36a, 0xd8ffc0, 0xffffff], speed: 2, up: 3, size: 0.07, life: 0.8, grav: 3 });
  }
  // réanimation : un équipier qui bloque à côté d'un héros à terre le relève peu à peu
  reviveTick(dt) {
    for (const p of this.heroes) {
      if (!p.down) continue;
      const helped = this.heroes.some((q) => q !== p && q.state === 'block' && hypot(q.x - p.x, q.z - p.z) < REVIVE.R);
      p.revT = helped ? p.revT + dt : Math.max(0, p.revT - dt * REVIVE.decay);
      if (p.revT >= REVIVE.time) this.getUp(p, 'RELEVÉ !');
    }
  }
  // le colosse, Cerbère et le Souverain d'Os enragent à la moitié de leurs PV
  enrage(e) {
    if (e.sp === undefined || e.state === 'dead') return;
    if (!e.rage && e.hp <= e.maxHp * BOSS.rage) { this.startSpecial(e, 'roar'); return; }
    // Souverain d'Os : seuils de mutation d'arène à 75 % et 25 % PV (hors attaque en cours)
    if (e.foe === 'squelette' && !e.sp) {
      if (!(e.spStage & 1) && e.hp <= e.maxHp * 0.75) { e.spStage |= 1; this.startSpecial(e, 'shift', 1); }
      else if (!(e.spStage & 4) && e.hp <= e.maxHp * 0.25) { e.spStage |= 4; this.startSpecial(e, 'shift', 2); }
    }
  }
  rebirth(p) {
    p.phoenix = 0;
    p.hp = Math.round(p.maxHp * PHOENIX);
    if (p.state !== 'air') this.toIdle(p);
    this.emit('pop', 'PHÉNIX !', p.x, p.y + 2.1, p.z, 'parry');
    this.emit('sfx', 'roar');
    this.emit('ring', p.x, p.y + 0.1, p.z, 0xffa020, 2.6, 0.6, true);
    this.emit('emit', p.x, p.y + 0.8, p.z, 40, { color: [0xffa020, 0xffe27a, 0xff5a20], speed: 3, up: 4, size: 0.1, life: 1, grav: -1 });
    this.emit('shake', 0.25);
    // Renaissance ardente (Plume de phénix + Cœur de forge) : on renaît en explosant
    if (p.phoenixBoom) this.blast(p, p.x, p.y, p.z, 40, 'fire', 2.8);
  }
  thornsHit(def, att, back) {
    att.hp = Math.max(0, att.hp - back);
    this.emit('fx', att.idx, 'hit');
    this.emit('pop', `-${back}`, att.x, att.y + 1.75 * (att.size ?? 1), att.z, 'dmg');
    this.emit('emit', att.x, att.y + 1, att.z, 8, { color: [0xd9a441, 0xffe27a], speed: 2.5, up: 2, size: 0.06, life: 0.4, grav: 8 });
    if (att.hp <= 0) { if (att.sp) att.sp = ''; this.die(att); this.onKO(def, att); return; }
    this.enrage(att);
  }
  // coup encaissé sans broncher (boss pendant une attaque spéciale)
  armorHit(att, def, dmg, cx, cy, cz) {
    def.hp = Math.max(0, def.hp - dmg);
    this.emit('fx', def.idx, 'hit');
    this.emit('emit', cx, cy, cz, 12, { color: [0xffffff, 0xffe27a, 0xff6a4a], speed: 4, up: 3, size: 0.09, life: 0.4, grav: 9 });
    this.emit('pop', `-${dmg}`, def.x, def.y + 1.75 * def.size, def.z, 'dmg');
    this.emit('sfx', 'clang');
    this.g.hitstop = Math.max(this.g.hitstop, 0.04);
    if (def.hp <= 0) { def.sp = ''; this.die(def); this.g.hitstop = 0.22; this.onKO(att, def); }
  }

  // ---------------- attaques spéciales du boss ----------------
  // le boss e lance-t-il une attaque spéciale ? (à chaque image du combat, avant son IA)
  bossThink(e, dt) {
    if (e.sp || e.state === 'dead') return;
    e.spCd -= dt;
    if (e.spCd > 0 || (e.state !== 'idle' && e.state !== 'walk')) return;
    const o = this.target(e.idx);
    if (!o) return;
    const d = hypot(o.x - e.x, o.z - e.z);
    if (FOES[e.foe].moves.includes('shift')) {
      // Souverain d'Os : seuils de PV prioritaires, sinon fauchage de près, éventail d'os de loin, ou mutation d'arène
      if (!(e.spStage & 1) && e.hp <= e.maxHp * 0.75) { e.spStage |= 1; this.startSpecial(e, 'shift', 1); return; }
      if (!(e.spStage & 4) && e.hp <= e.maxHp * 0.25) { e.spStage |= 4; this.startSpecial(e, 'shift', 2); return; }
      const u = this.rng.next();
      if (u < (e.rage ? 0.28 : 0.2)) { this.startSpecial(e, 'shift'); return; }
      this.startSpecial(e, d < 3.4 && u < 0.75 ? 'reap' : 'bones');
      return;
    }
    if (FOES[e.foe].moves.includes('fire')) {
      // Cerbère : loin, il charge ; à portée de flammes, il crache le feu ; collé, il bondit une fois sur deux
      this.startSpecial(e, d > BOSS.fire.R + 0.4 ? 'charge' : d < 2.4 && this.rng.next() < 0.5 ? 'slam' : 'fire');
      return;
    }
    // loin : charge ; près : saut écrasant ; entre les deux : au hasard (rng de la simulation)
    this.startSpecial(e, d > 4.2 ? 'charge' : d < 2.4 ? 'slam' : this.rng.next() < 0.5 ? 'charge' : 'slam');
  }
  startSpecial(e, kind, nextLayout = -1) {
    const o = this.target(e.idx), lim = ROOM_R - 1;
    this.setState(e, 'special');
    Object.assign(e, { sp: kind, spT: 0, spA: 0, spHit: 0, vx: 0, vz: 0, combo: 0, airAtk: false });
    if (kind === 'slam') {
      e.spX = clamp(o ? o.x : e.x, -lim, lim); e.spZ = clamp(o ? o.z : e.z, -lim, lim);
      this.play(e, 'crouch', { fade: 0.08 });
      this.emit('sfx', 'heavy');
    } else if (kind === 'charge') {
      e.spX = sin(e.yaw); e.spZ = cos(e.yaw);
      this.play(e, 'emote-no', { ts: 1.8, fade: 0.08 });
      this.emit('sfx', 'steam');
    } else if (kind === 'fire') {
      if (o) { e.yaw = atan2(o.x - e.x, o.z - e.z); e.visTarget = e.yaw; }
      e.spTick = 0;
      this.emit('sfx', 'growl');
    } else if (kind === 'shift') {
      // choisit la prochaine disposition d'arène (toujours différente de l'actuelle)
      const g = this.g, cur = g.arenaLayout | 0;
      let nxt = nextLayout;
      if (nxt < 0 || nxt === cur) {
        const pool = [0, 1, 2, 3].filter((k) => k !== cur);
        nxt = pool[(this.rng.next() * pool.length) | 0];
      }
      g.arenaNext = nxt;
      g.arenaQuake = e.rage ? BOSS.shift.windRage : BOSS.shift.wind;
      e.spTick = 0;
      this.play(e, 'emote-yes', { ts: 0.7, fade: 0.08, loop: false });
      this.emit('sfx', 'roar');
      this.emit('shake', 0.25);
      this.emit('announce', "L'ARÈNE TREMBLE !", 'ko', 1.4);
    } else if (kind === 'reap') {
      if (o) { e.yaw = atan2(o.x - e.x, o.z - e.z); e.visTarget = e.yaw; }
      this.play(e, 'crouch', { fade: 0.08 });
      this.emit('sfx', 'heavy');
    } else if (kind === 'bones') {
      if (o) { e.yaw = atan2(o.x - e.x, o.z - e.z); e.visTarget = e.yaw; }
      this.play(e, 'holding-right-shoot', { ts: 0.8, fade: 0.08, loop: false });
      this.emit('sfx', 'spell');
    } else {
      e.rage = 1;
      this.play(e, 'emote-yes', { ts: 0.8, fade: 0.08, loop: false });
      this.emit('sfx', 'roar');
      this.emit('announce', `${FOES[e.foe].name.toUpperCase()} ENRAGE !`, 'ko', 1.4);
    }
  }
  endSpecial(e) {
    if (e.sp === 'shift') { this.g.arenaNext = -1; this.g.arenaQuake = 0; }
    e.sp = ''; e.vx = e.vz = 0;
    e.spCd = (e.rage ? BOSS.cdRage : BOSS.cd) * (0.8 + 0.4 * this.rng.next()) * coop(this.g.np, 'bossCd');
    if (e.state === 'special') this.toIdle(e);
  }
  // Applique la nouvelle configuration d'arène du Sanctuaire mouvant (100 % déterministe)
  applyArenaLayout(idx, boss = null) {
    const g = this.g, L = arenaLayoutData(idx);
    this.room = { ...this.room, obs: L.obs, surf: L.surf, traps: L.traps };
    g.arenaLayout = idx;
    g.arenaNext = -1;
    g.arenaQuake = 0;
    g.arenaVer++;
    const S = BOSS.shift;
    // Piliers qui jaillissent du sol : repoussent et blessent ceux qui restent pile dessus (sauf saut/roulade)
    for (const o of L.obs) {
      this.emit('ring', o.x, 0.08, o.z, 0x6effb8, 1.5, 0.45, true);
      this.emit('emit', o.x, 0.2, o.z, 14, { color: [0xd8cdb0, 0x6effb8, 0x8a8090], speed: 3.2, up: 4.0, size: 0.1, life: 0.7, grav: 7 });
      if (!boss) continue;
      for (const d of this.f) {
        if (d.state === 'dead' || d.team === boss.team) continue;
        const dx = d.x - o.x, dz = d.z - o.z, dist = hypot(dx, dz);
        if (dist > S.pillarR) continue;
        if (d.y - this.groundY(d) > 0.3 || (d.state === 'roll' && d.stateT > 0.03 && d.stateT < 0.36)) continue;
        const nx = dist > 0.05 ? dx / dist : 1, nz = dist > 0.05 ? dz / dist : 0;
        this.damage(boss, d, S.dmg, 0, 0.4, d.x, d.y + 0.8, d.z);
        if (d.state !== 'dead') { d.vx = nx * S.knock * knockOf(d); d.vz = nz * S.knock * knockOf(d); }
      }
    }
    // Recale tous les combattants hors des nouveaux obstacles et à hauteur des nouvelles estrades
    for (const f of this.f) {
      if (f.state === 'dead') continue;
      this.bound(f);
      const gy = this.groundY(f);
      if (f.y < gy) { f.y = gy; f.vy = 0; }
    }
    this.emit('sfx', 'quake');
    this.emit('shake', 0.6);
    this.emit('announce', L.name.toUpperCase(), '', 1.6);
  }
  // Fauchage circulaire (un coup du double tourbillon du Souverain d'Os)
  reapHit(e) {
    const R = BOSS.reap;
    this.emit('ring', e.x, e.y + 0.9, e.z, 0x6effb8, R.R, 0.35, true);
    this.emit('emit', e.x, e.y + 0.9, e.z, 22, { color: [0x6effb8, 0xd8cdb0, 0xffffff], speed: 4.5, up: 1.5, size: 0.09, life: 0.5, grav: 2 });
    this.emit('sfx', 'swing');
    for (const d of this.f) {
      if (d.state === 'dead' || d.team === e.team) continue;
      const dx = d.x - e.x, dz = d.z - e.z, dist = hypot(dx, dz);
      if (dist > R.R + 0.3 * ((d.size ?? 1) - 1) || Math.abs(d.y - e.y) > 1.5) continue;
      if (d.state === 'roll' && d.stateT > 0.03 && d.stateT < 0.36) {
        this.emit('pop', 'ESQUIVE', d.x, d.y + 1.8, d.z, 'miss'); this.emit('sfx', 'dodge'); continue;
      }
      const nx = dist > 0.05 ? dx / dist : sin(e.yaw), nz = dist > 0.05 ? dz / dist : cos(e.yaw);
      if (d.state === 'block') {
        d.guard -= R.guard * guardOf(d); d.guardT = 0;
        d.vx = nx * 3.5 * knockOf(d); d.vz = nz * 3.5 * knockOf(d);
        this.emit('fx', d.idx, 'blocked');
        this.emit('sfx', 'clang');
        if (d.guard <= 0) this.guardBreak(e, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.damage(e, d, R.dmg, 0, 0.4, d.x, d.y + 1, d.z);
      if (d.state !== 'dead') { d.vx = nx * R.knock * knockOf(d); d.vz = nz * R.knock * knockOf(d); }
    }
  }
  // Salve d'os spectraux en éventail (projectiles k = 3, parables et renvoyables !)
  fireBones(e) {
    const B = BOSS.bones, n = e.rage ? B.countRage : B.count;
    const o = this.target(e.idx);
    if (o) { e.yaw = atan2(o.x - e.x, o.z - e.z); e.visTarget = e.yaw; }
    for (let k = 0; k < n; k++) {
      const a = e.yaw + (k - (n - 1) / 2) * B.spread;
      const dx = sin(a), dz = cos(a);
      this.pr.push({
        x: e.x + dx * 0.9, y: e.y + 1.05, z: e.z + dz * 0.9,
        vx: dx * B.speed, vy: 0, vz: dz * B.speed,
        o: e.idx, t: 0, k: 3, dmg: B.dmg, life: B.life,
      });
    }
    this.emit('sfx', 'spell');
    this.emit('ring', e.x, e.y + 1.0, e.z, 0x6effb8, 1.8, 0.35);
  }
  // une image d'attaque spéciale (avant le déplacement fait par updateFighter)
  special(e, canAct) {
    if (e.state !== 'special' || !canAct) { if (e.state === 'special') this.endSpecial(e); else e.sp = ''; return; }
    const dt = this.dt, rage = !!e.rage;
    e.spT += dt;
    if (e.sp === 'slam') {
      const S = BOSS.slam, wind = rage ? S.windRage : S.wind;
      if (e.spA === 0) {
        e.yaw = atan2(e.spX - e.x, e.spZ - e.z); e.visTarget = e.yaw;
        if (e.spT >= wind) {
          // bond calculé pour retomber sur le point visé
          const T = 2 * S.vy / 24;
          e.spA = 1; e.vy = S.vy; e.y += 0.01;
          e.vx = (e.spX - e.x) / T; e.vz = (e.spZ - e.z) / T;
          this.play(e, 'jump', { loop: false, fade: 0.06 });
          this.emit('sfx', 'jump');
          this.emit('emit', e.x, e.y + 0.05, e.z, 14, { color: [0xc8a070, 0xa88050], speed: 2.4, up: 1, size: 0.1, life: 0.6, grav: 3 });
        }
      } else if (e.spA === 1) {
        if (e.y <= this.groundY(e) + 0.001 && e.vy <= 0) { this.quake(e); e.spA = 2; e.spT = 0; e.vx = e.vz = 0; this.play(e, 'crouch', { fade: 0.05 }); }
      } else if (e.spT >= S.rest) this.endSpecial(e);
    } else if (e.sp === 'charge') {
      const C = BOSS.charge;
      if (e.spA === 0) {
        // il vise jusqu'au dernier moment, puis la direction est figée
        const o = this.target(e.idx), wind = rage ? C.windRage : C.wind;
        if (o && e.spT < wind - 0.15) { e.yaw = atan2(o.x - e.x, o.z - e.z); e.spX = sin(e.yaw); e.spZ = cos(e.yaw); }
        e.visTarget = e.yaw;
        if (e.spT >= wind) { e.spA = 1; e.spT = 0; this.play(e, 'sprint', { ts: 1.7, fade: 0.05 }); this.emit('sfx', 'heavy'); this.emit('shake', 0.15); }
      } else {
        const sp = C.speed * (rage ? BOSS.speedRage : 1) * (e.spT > C.dur - 0.2 ? Math.max(0.2, (C.dur - e.spT) / 0.2) : 1);
        e.vx = e.spX * sp; e.vz = e.spZ * sp;
        e.dustT -= dt;
        if (e.dustT < 0) { e.dustT = 0.05; this.emit('emit', e.x, e.y + 0.05, e.z, 2, { color: [0xc8a070, 0xa88050], speed: 1, up: 1, size: 0.1, life: 0.5, grav: 3 }); }
        this.chargeHits(e);
        if (this.chargeWall(e)) {
          // tête la première dans le mur : sonné
          e.vx = e.vz = 0; e.sp = '';
          this.stun(e, C.stun);
          e.spCd = (rage ? BOSS.cdRage : BOSS.cd) * coop(this.g.np, 'bossCd');
          this.emit('pop', 'SONNÉ !', e.x, e.y + 2.2 * e.size, e.z, 'brk');
          this.emit('sfx', 'brk');
          this.emit('shake', 0.4);
          this.emit('emit', e.x + e.spX * 0.6, e.y + 1.2, e.z + e.spZ * 0.6, 26, { color: [0xc0c0c8, 0x8a8090, 0xffe27a], speed: 4, up: 3, size: 0.1, life: 0.7, grav: 8 });
        } else if (e.spT >= C.dur) this.endSpecial(e);
      }
    } else if (e.sp === 'fire') {
      const F = BOSS.fire;
      if (e.spA === 0) {
        if (e.spT >= (rage ? F.windRage : F.wind)) { e.spA = 1; e.spT = 0; e.spTick = 0; this.emit('sfx', 'flame'); this.emit('shake', 0.12); }
      } else {
        // il pivote lentement vers sa cible pendant qu'il crache (on peut le contourner)
        const o = this.target(e.idx);
        if (o) {
          const want = atan2(o.x - e.x, o.z - e.z), turn = (rage ? F.turnRage : F.turn) * dt;
          let da = want - e.yaw;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          e.yaw += clamp(da, -turn, turn); e.visTarget = e.yaw;
        }
        e.spTick -= dt;
        if (e.spTick <= 0) { e.spTick += F.tick; this.flames(e); }
        if (e.spT >= F.dur) this.endSpecial(e);
      }
    } else if (e.sp === 'shift') {
      const S = BOSS.shift, wind = rage ? S.windRage : S.wind;
      if (e.spA === 0) {
        this.g.arenaQuake = Math.max(0, wind - e.spT);
        e.spTick -= dt;
        if (e.spTick <= 0) {
          e.spTick += 0.22;
          this.emit('shake', 0.16);
          const nextL = ARENA_LAYOUTS[this.g.arenaNext];
          if (nextL) for (const [i, j] of nextL.obs) this.emit('emit', i * TILE, 0.1, j * TILE, 3, { color: [0x6effb8, 0xd8cdb0], speed: 0.8, up: 2.2, size: 0.07, life: 0.5, grav: 2 });
        }
        if (e.spT >= wind) {
          e.spA = 1; e.spT = 0;
          this.applyArenaLayout(this.g.arenaNext >= 0 ? this.g.arenaNext : 1, e);
          this.play(e, 'crouch', { fade: 0.05 });
        }
      } else if (e.spT >= S.recover) this.endSpecial(e);
    } else if (e.sp === 'reap') {
      const R = BOSS.reap, wind = rage ? R.windRage : R.wind;
      if (e.spA === 0) {
        const o = this.target(e.idx);
        if (o && e.spT < wind - 0.1) { e.yaw = atan2(o.x - e.x, o.z - e.z); e.visTarget = e.yaw; }
        if (e.spT >= wind) { e.spA = 1; e.spT = 0; e.spHit = 0; this.play(e, 'attack-melee-right', { ts: 1.4, fade: 0.04, restart: true }); }
      } else {
        e.yaw += dt * 13; e.visTarget = e.yaw;
        for (let k = 0; k < R.hits.length; k++) {
          if (e.spT >= R.hits[k] && !(e.spHit & (1 << k))) { e.spHit |= 1 << k; this.reapHit(e); }
        }
        if (e.spT >= R.dur) this.endSpecial(e);
      }
    } else if (e.sp === 'bones') {
      const B = BOSS.bones, wind = rage ? B.windRage : B.wind;
      if (e.spA === 0) {
        const o = this.target(e.idx);
        if (o) { e.yaw = atan2(o.x - e.x, o.z - e.z); e.visTarget = e.yaw; }
        if (e.spT >= wind) { e.spA = 1; e.spT = 0; this.fireBones(e); }
      } else if (e.spT >= B.rest) this.endSpecial(e);
    } else if (e.sp === 'roar') {
      const R = BOSS.roar;
      if (e.spA === 0 && e.spT >= R.at) {
        e.spA = 1;
        this.emit('ring', e.x, e.y + 0.1, e.z, e.foe === 'squelette' ? 0x6effb8 : 0xff5a20, R.R * 1.2, 0.6, true);
        this.emit('ring', e.x, e.y + 1.2, e.z, e.foe === 'squelette' ? 0xd8cdb0 : 0xffb04a, R.R, 0.4);
        this.emit('shake', 0.35);
        for (const d of this.f) {
          if (d.state === 'dead' || d.team === e.team) continue;
          const dx = d.x - e.x, dz = d.z - e.z, dist = hypot(dx, dz);
          if (dist > R.R || dist < 0.01) continue;
          d.vx = dx / dist * R.knock * knockOf(d); d.vz = dz / dist * R.knock * knockOf(d);
          if (d.state !== 'air' && d.state !== 'roll') { this.setState(d, 'hit', 0.4); this.play(d, 'idle', { fade: 0.05 }); }
        }
        // renforts : un de plus à deux
        const add = FOES[e.foe].adds;
        if (add) for (let k = 0; k <= this.g.np; k++) {
          const a = e.yaw + Math.PI * 2 * (k + 0.5) / (this.g.np + 1);
          this.addFoe(add, e.x + sin(a) * 2.6, e.z + cos(a) * 2.6);
        }
      }
      if (e.spT >= R.dur) {
        if (e.foe === 'squelette' && !(e.spStage & 2)) { e.spStage |= 2; this.startSpecial(e, 'shift', 3); }
        else this.endSpecial(e);
      }
    }
  }
  // souffle de feu : brûlure de tous ceux qui sont dans le cône devant le boss (une fois par tick)
  flames(e) {
    const F = BOSS.fire, fx = sin(e.yaw), fz = cos(e.yaw), R = F.R * (e.size / FOES.cerbere.size);
    // flammes visibles : un jet par tête (gauche, milieu, droite)
    for (const a of [-0.32, 0, 0.32]) {
      const dx = sin(e.yaw + a), dz = cos(e.yaw + a);
      this.emit('emit', e.x + dx * 0.55 * e.size, e.y + 0.42 * e.size, e.z + dz * 0.55 * e.size, 6,
        { color: [0xffe27a, 0xff9a2e, 0xff4a1a], speed: 7.5, up: 0.6, size: 0.16, life: 0.6, dir: { x: dx, z: dz }, grav: -1.5 });
    }
    for (const d of this.f) {
      if (d.state === 'dead' || d.team === e.team) continue;
      const dx = d.x - e.x, dz = d.z - e.z, dist = hypot(dx, dz);
      if (dist > R + 0.3 || dist < 0.05 || Math.abs(d.y - e.y) > 1.6) continue;
      if ((dx * fx + dz * fz) / dist < cos(F.half)) continue;          // hors du cône
      if (d.state === 'roll' && d.stateT > 0.03 && d.stateT < 0.36) continue;
      if (d.state === 'block' && sin(d.yaw) * fx + cos(d.yaw) * fz < -0.2) {
        d.guard -= F.guard * guardOf(d); d.guardT = 0;
        this.emit('fx', d.idx, 'blocked');
        if (d.guard <= 0) this.guardBreak(e, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.src = 'fire';
      this.damage(e, d, F.dmg, F.knock, 0.15, d.x, d.y + 1, d.z);
      this.src = '';
    }
  }
  // retombée du saut : onde de choc autour du point d'impact
  quake(e) {
    const S = BOSS.slam, R = e.rage ? S.Rrage : S.R, g = this.g;
    this.emit('ring', e.x, e.y + 0.06, e.z, 0xffb04a, R * 1.15, 0.5, true);
    this.emit('ring', e.x, e.y + 0.1, e.z, 0xffffff, R * 0.6, 0.3, true);
    this.emit('emit', e.x, e.y + 0.1, e.z, 40, { color: [0xc8a070, 0xa88050, 0x8a8090, 0xffe27a], speed: 5, up: 3, size: 0.12, life: 0.8, grav: 7 });
    this.emit('sfx', 'quake');
    this.emit('shake', 0.55);
    g.hitstop = Math.max(g.hitstop, 0.06);
    for (const d of this.f) {
      if (d.state === 'dead' || d.team === e.team) continue;
      const dx = d.x - e.x, dz = d.z - e.z, dist = hypot(dx, dz);
      if (dist > R + 0.3 * ((d.size ?? 1) - 1)) continue;
      // en l'air (saut) ou en pleine roulade : l'onde passe dessous
      if (d.y - this.groundY(d) > 0.3 || (d.state === 'roll' && d.stateT > 0.03 && d.stateT < 0.36)) {
        this.emit('pop', 'ESQUIVE', d.x, d.y + 1.8, d.z, 'miss'); this.emit('sfx', 'dodge'); continue;
      }
      const nx = dist > 0.05 ? dx / dist : sin(e.yaw), nz = dist > 0.05 ? dz / dist : cos(e.yaw);
      if (d.state === 'block') {
        d.guard -= S.guard * guardOf(d); d.guardT = 0;
        d.vx = nx * 3 * knockOf(d); d.vz = nz * 3 * knockOf(d);
        this.emit('fx', d.idx, 'blocked');
        this.emit('sfx', 'clang');
        if (d.guard <= 0) this.guardBreak(e, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.damage(e, d, S.dmg, 0, 0.5, d.x, d.y + 0.6, d.z);
      if (d.state !== 'dead') { d.vx = nx * S.knock * knockOf(d); d.vz = nz * S.knock * knockOf(d); }
    }
  }
  // la charge renverse ceux qu'elle traverse (une fois chacun : spHit, un bit par combattant)
  chargeHits(e) {
    const C = BOSS.charge;
    for (const d of this.f) {
      if (d.state === 'dead' || d.team === e.team || (e.spHit & (1 << (d.idx & 31)))) continue;
      const dx = d.x - e.x, dz = d.z - e.z;
      if (hypot(dx, dz) > C.hitR * (e.size + (d.size ?? 1)) || Math.abs(d.y - e.y) > 1) continue;
      if (d.state === 'roll' && d.stateT > 0.03 && d.stateT < 0.36) continue;
      e.spHit |= 1 << (d.idx & 31);
      // projeté sur le côté de la trajectoire
      const side = dx * e.spZ - dz * e.spX >= 0 ? 1 : -1;
      const kx = e.spX * 0.8 + e.spZ * side * 0.6, kz = e.spZ * 0.8 - e.spX * side * 0.6;
      if (d.state === 'block' && sin(d.yaw) * e.spX + cos(d.yaw) * e.spZ < -0.2) {
        d.guard -= C.guard * guardOf(d); d.guardT = 0;
        d.vx = kx * 4 * knockOf(d); d.vz = kz * 4 * knockOf(d);
        this.emit('fx', d.idx, 'blocked');
        this.emit('sfx', 'clang');
        this.emit('shake', 0.15);
        if (d.guard <= 0) this.guardBreak(e, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.damage(e, d, C.dmg, 0, 0.55, d.x, d.y + 1, d.z);
      if (d.state !== 'dead') { d.vx = kx * C.knock * knockOf(d); d.vz = kz * C.knock * knockOf(d); }
    }
  }
  // la charge va-t-elle heurter un mur ou un obstacle ?
  chargeWall(e) {
    const x = e.x + e.spX * 0.35, z = e.z + e.spZ * 0.35, R = ROOM_R - BODY - 0.05;
    if (Math.abs(x) > R || Math.abs(z) > R) return true;
    for (const o of this.room.obs) if (hypot(o.x - x, o.z - z) < o.r + BODY) return true;
    for (const s of this.room.surf) if (inRect(s, x, z) && heightAt(s, x, z) - e.y > STEP) return true;
    return false;
  }

  // pics d'un piège
  trapHit(f) {
    if (f.god) return;
    const aegis = spellShield(f);
    const g = this.g, dmg = Math.max(1, Math.round(TRAP.dmg * (1 - f.armor) * aegis));
    f.trapT = 1.0;
    if (f.phoenix && f.hp - dmg <= 0) { this.rebirth(f); return; }
    f.hp = Math.max(0, f.hp - dmg);
    this.emit('fx', f.idx, 'hit');
    this.emit('pop', `-${dmg}`, f.x, f.y + 1.75, f.z, 'dmg');
    this.emit('sfx', 'hit');
    this.emit('emit', f.x, 0.3, f.z, 12, { color: [0xffffff, 0xff6a4a, 0xc0c0c8], speed: 2, up: 4, size: 0.08, life: 0.5, grav: 9 });
    if (f.hp <= 0) { this.die(f); this.onKO(null, f); return; }
    g.hitstop = Math.max(g.hitstop, 0.05);
    if (f.sp) return;                         // le boss ne s'arrête pas pour si peu
    if (f.state !== 'air') { this.setState(f, 'hit', 0.35); this.play(f, 'idle', { fade: 0.05 }); }
    f.vy = 4.5; f.y += 0.01;                  // petit bond de douleur
  }

  onKO(att, def) {
    const g = this.g;
    if (def.team === 0 && !this.isHero(def)) {
      // un chien invoqué disparaît dans un nuage violet
      this.emit('emit', def.x, def.y + 0.4, def.z, 18, { color: [0xb98aff, 0x7a4adf], speed: 2, up: 2.5, size: 0.08, life: 0.6, grav: 3 });
      this.emit('sfx', 'whine');
      return;
    }
    if (this.isHero(def)) {
      if (g.phase === 'dead') return;
      if (this.heroes.some((h) => h.state !== 'dead')) {
        // à deux : il tombe à quatre pattes, en attendant qu'on le relève (ou la fin de la salle)
        def.down = 1; def.revT = 0; def.vx = def.vz = 0;
        this.play(def, 'crouch', { fade: 0.1 });
        this.emit('announce', `J${def.idx + 1} À TERRE ! Bloque à côté de lui pour le relever`, 'ko', 2);
        this.emit('sfx', 'ko');
        return;
      }
      g.phase = 'dead'; g.t = 0; g.flagEnd = false;
      g.slow = 0.3; g.slowT = 1.2;
      this.emit('announce', 'VAINCU…', 'ko', 2);
      this.emit('sfx', 'ko');
      return;
    }
    g.kills++;
    // victime d'un héros, de son chien ou d'un ennemi qu'il a semé dans la discorde : comptée pour ses défis
    // (kills, remis à zéro à chaque donjon) et pour ses objets « à l'élimination »
    const k = !att ? -1 : this.isHero(att) ? att.idx : att.team === 0 ? att.owner : att.sConf > 0 ? att.sConfBy : -1;
    if (k >= 0 && k < g.np && this.f[k]) {
      const hero = this.f[k];
      hero.kills++;
      // Calice de sang : soin par élimination
      if (hero.onKillHeal > 0 && hero.state !== 'dead') this.healPop(hero, hero.onKillHeal);
      if (hero.onKillCd > 0 && hero.spellCd > 0) hero.spellCd = Math.max(0, hero.spellCd - hero.onKillCd);
      this.onKillItems(hero, def, att);
    }
    this.emit('sfx', 'coin');
    this.emit('emit', def.x, def.y + 1, def.z, 18, { color: [0xffd34a, 0xffe27a, 0xfff0a0], speed: 2.5, up: 4, size: 0.08, life: 0.9, grav: 9 });
    if (this.foesLeft === 0 && g.phase === 'fight') {
      g.arenaNext = -1; g.arenaQuake = 0;
      for (const p of this.heroes) if (p.down) this.getUp(p, 'DEBOUT !');     // salle nettoyée : les héros tombés se relèvent
      for (const e of this.f) { e.sBurnT = 0; e.sPsn = 0; e.sPsnT = 0; e.sChill = 0; e.sConf = 0; }
      this.dropLoot();
      const isFinalBoss = !g.endless && this.room.boss && (this.useMap ? g.act >= FINAL_ACT : g.room >= FINAL_ROOM);
      if (isFinalBoss) {
        g.victory = true; g.phase = 'victory'; g.t = 0; g.flagEnd = false;
        g.exitOpen = true;
        g.slow = 0.3; g.slowT = 1.2;
        this.emit('announce', FOES[this.room.bossId || 'squelette'].name.toUpperCase() + ' VAINCU !', '', 2.4);
        this.emit('sfx', 'cheer', 1);
        this.emit('clear');
        return;
      }
      g.phase = 'clear'; g.t = 0;
      g.exitOpen = true;
      // salle au trésor ensuite ? (jamais après un boss : il laisse déjà ses objets)
      const m = g.room % BOSS_EVERY;
      g.vaultNext = !this.useMap && !this.room.boss && (m === VAULT.always || (m === VAULT.maybe && this.rng.next() < VAULT.chance));
      g.slow = 0.35; g.slowT = 0.7;
      this.emit('announce', this.room.boss ? FOES[this.room.bossId || 'boss'].name.toUpperCase() + ' VAINCU !' : 'SALLE NETTOYÉE', '', 1.5);
      this.emit('sfx', 'cheer', 0.6);
      this.emit('clear');
    }
  }
  // Poursuivre après la victoire de la salle 20 (mode Infini)
  continueEndless() {
    const g = this.g;
    if (!g.victory || (g.phase !== 'end' && g.phase !== 'victory')) return false;
    g.endless = true; g.victory = false; g.flagEnd = false;
    g.phase = 'clear'; g.t = 0; g.exitOpen = true;
    this.emit('announce', 'MODE INFINI !', '', 1.6);
    this.emit('sfx', 'gong');
    return true;
  }

  updateFighter(i, canAct) {
    const f = this.f[i], dt0 = this.dt, wasAir = f.state === 'air', hero = this.isHero(f);
    // le froid ralentit tout le temps de l'ennemi ; la vitesse d'attaque accélère les coups du héros
    let k = f.sChill > 0 ? FX.chill.slow : 1;
    if (hero && (f.state === 'attack' || f.state === 'shoot')) k *= this.aspdOf(f);
    this.dt = dt0 * k;
    if (f.sp) this.special(f, canAct);
    super.updateFighter(i, canAct);
    this.dt = dt0;
    if (hero && this.g.phase === 'fight') {
      if (f.state === 'roll' && (f.rollDmg || f.rollBurn || f.rollFreeze)) this.rollTouch(f);
      if (wasAir && f.state !== 'air' && f.state !== 'dead') this.landItems(f);
    }

    // bénédiction « Second souffle » : récupération d'endurance supplémentaire
    if (f.staMul > 1 && f.staT > STA.delay && f.state !== 'roll') f.sta = Math.min(100, f.sta + STA.regen * this.dt * (f.staMul - 1));
    // bénédiction « Source d'immortalité » : régénération continue pendant les combats
    if (f.regen > 0 && this.g.phase === 'fight' && f.state !== 'dead' && f.hp < f.maxHp) f.hp = Math.min(f.maxHp, f.hp + f.regen * this.dt);
  }

  // retire proprement un héros qui quitte la partie en cours de donjon (passage fluide en solo)
  dropHero(idx) {
    const g = this.g;
    if (g.np <= 1 || idx < 0 || idx >= g.np) return false;
    // supprime le héros parti et ses chiens invoqués, puis réindexe tous les combattants et projectiles
    const keepIdx = [];
    const map = new Map();
    for (let i = 0; i < this.f.length; i++) {
      const e = this.f[i];
      if (i === idx || e.owner === idx) continue;
      map.set(i, keepIdx.length);
      keepIdx.push(i);
    }
    this.f = keepIdx.map((old, ni) => {
      const e = this.f[old];
      e.idx = ni;
      if (e.owner >= 0) e.owner = map.get(e.owner) ?? -1;
      // auteurs des états (brûlure, poison, discorde) ; masques de cibles déjà touchées : à refaire
      for (const key of ['sBurnBy', 'sPsnBy', 'sConfBy']) if (e[key] >= 0) e[key] = map.get(e[key]) ?? -1;
      e.rollHit = 0;
      return e;
    });
    this.inp = keepIdx.map((old) => this.inp[old]);
    this.ais = keepIdx.map((old, ni) => {
      const a = this.ais[old];
      if (a) a.me = ni;
      return a;
    });
    this.pr = this.pr.filter((a) => map.has(a.o)).map((a) => ({ ...a, o: map.get(a.o), hb: 0 }));
    if (this.unlocked) this.unlocked = [this.unlocked[1 - idx] ?? []];
    if (idx === 0) { g.mapVote0 = g.mapVote1; g.evPick0 = g.evPick1; }
    g.mapVote1 = ''; g.evPick1 = -1;
    g.np = 1;
    // si le héros restant était à terre en attendant son équipier, il se relève pour continuer seul
    const p = this.f[0];
    if (p && p.down) this.getUp(p, 'EN SOLO !');
    if (g.phase === 'event' && !this.mustPickEvent(0)) { g.phase = 'clear'; g.t = 0; g.exitOpen = true; }
    if (g.phase === 'map' && g.mapVote0 && this.map) {
      const node = advanceMap(this.map, g.mapVote0);
      if (node) this.newRoom(node);
    }
    // objets à ramasser : si le héros restant a déjà pris sa part, ce qui restait pour l'autre disparaît
    if (p) for (const grp of [PK_GRP.item, PK_GRP.minor]) if (p.took & (1 << grp)) this.pk = this.pk.filter((o) => o.grp !== grp);
    return true;

  }

  // ---------------- points d'accroche des objets dans la mécanique de combat ----------------
  resolve(att, def) { this.src = 'melee'; super.resolve(att, def); this.src = ''; }
  arrowHit(a, d) {
    // Écu poli : bloquer face à un projectile le renvoie (par trois avec le Miroir aux alouettes)
    if (d.blockReflect && d.state === 'block' && this.isHero(d)) {
      const sp = hypot(a.vx, a.vz) || 1;
      if (sin(d.yaw) * a.vx / sp + cos(d.yaw) * a.vz / sp < -0.2) {
        a.vx = -a.vx; a.vz = -a.vz; a.vy = -a.vy; a.o = d.idx; a.t = 0; a.hb = 0; a.it = 1;
        d.guard = Math.max(1, d.guard - 4 * guardOf(d)); d.guardT = 0;
        if (d.reflectSplit) for (const ang of [-0.3, 0.3]) {
          const s = sin(ang), c = cos(ang);
          this.pr.push({ ...a, vx: a.vx * c + a.vz * s, vz: -a.vx * s + a.vz * c });
        }
        this.emit('fx', d.idx, 'blocked');
        this.emit('ring', a.x, a.y, a.z, 0xffe066, 1.4, 0.3);
        this.emit('pop', 'RENVOI !', d.x, d.y + 2.0, d.z, 'parry');
        this.emit('sfx', 'clang');
        return false;
      }
    }
    this.src = 'shot';
    const r = super.arrowHit(a, d);
    this.src = '';
    return r;
  }
  // Lame fantôme : chaque coup d'arme lance une lame spectrale
  startAttack(f, chain = false) {
    super.startAttack(f, chain);
    if (f.blades && this.isHero(f)) this.blade(f, f.yaw, f.blades);
  }
  startShot(f) {
    super.startShot(f);
    if (f.blades && this.isHero(f) && !wpnOf(f).summon) this.blade(f, f.yaw, f.blades);
  }
  startRoll(f, mx, mz) {
    super.startRoll(f, mx, mz);
    if (this.isHero(f) && this.g.phase === 'fight') this.rollItems(f);
    else if (this.isHero(f) && f.rollBuff) f.rollBuffOn = 1;
  }
  parried(att, def, cx, cy, cz) {
    super.parried(att, def, cx, cy, cz);
    if (this.isHero(def) && att.team !== def.team) this.parryItems(def, att);
  }
  blocked(att, def, cost, cx, cy, cz) {
    super.blocked(att, def, cost, cx, cy, cz);
    // Égide d'Athéna : bloquer un coup blesse l'attaquant
    if (def.blockThorns && this.isHero(def) && att.team !== def.team && att.state !== 'dead') this.procHit(def, att, def.blockThorns, 'dmg');
  }
  startSpell(f, opp, mx, mz) {
    if (!super.startSpell(f, opp, mx, mz)) return false;
    if (!this.isHero(f)) return true;
    // Sablier brisé : chaque sort coûte des PV (sans descendre sous 1)
    if (f.hourglass) {
      const n = Math.min(f.hourglass, Math.max(0, Math.round(f.hp) - 1));
      if (n > 0) { f.hp -= n; this.emit('pop', `-${n}`, f.x + 0.3, f.y + 1.6, f.z, 'dmg'); }
    }
    // Surcharge : le sort déclenche un éclair
    if (f.spellZap && this.g.phase === 'fight') { const e = this.target(f.idx); if (e) this.zap(f, e, 3, FX.zap.dmg * f.zapMul * 1.5, true); }
    return true;
  }


  // frappe de att sur une liste de cibles : un même coup peut en toucher plusieurs
  strike(att, targets) {
    const done = att.hitDone;
    let hit = done;
    for (const d of targets) { att.hitDone = done; this.resolve(att, d); hit = hit || att.hitDone; }
    att.hitDone = hit;
  }

  // ---------------- outils de débogage (hors ligne seulement : ils modifient l'état directement) ----------------
  // va directement à la salle n (0 : salle d'armes) ; les héros tombés se relèvent
  debugGoto(n) {
    n = Math.max(0, Math.floor(n));
    for (const p of this.heroes) if (p.state === 'dead') { p.hp = Math.round(p.maxHp * 0.4); p.down = 0; p.revT = 0; this.toIdle(p); }
    if (n === 0) { this.startHub(); return; }
    this.g.room = n - 1;
    this.newRoom();
  }
  // élimine tous les ennemis (la salle est nettoyée : coffre et porte)
  debugKill() {
    const g = this.g;
    if (g.phase === 'intro') { g.phase = 'fight'; g.t = 0; }
    for (const e of this.f) if (e.team === 1 && e.state !== 'dead') { e.hp = 0; if (e.sp) e.sp = ''; this.die(e); this.onKO(null, e); }
  }
  debugHeal() { for (const p of this.heroes) { if (p.state === 'dead') this.toIdle(p); p.hp = p.maxHp; p.guard = 100; p.sta = 100; } }
  debugGod(on) { for (const p of this.heroes) p.god = !!on; }
  // un ennemi de type id apparaît près du héros 1
  debugSpawn(id) {
    if (!FOES[id] || (this.g.phase !== 'fight' && this.g.phase !== 'intro')) return null;
    const p = this.f[0], a = this.rng.next() * Math.PI * 2;
    return this.addFoe(id, p.x + sin(a) * 3, p.z + cos(a) * 3);
  }
  // téléporte le héros h au point (x, z)
  debugTp(h, x, z) {
    const p = this.f[h];
    if (!p) return;
    const lim = ROOM_R - BODY;
    Object.assign(p, { x: clamp(x, -lim, lim), z: clamp(z, -lim, lim), vx: 0, vz: 0, vy: 0 });
    p.y = this.groundY(p);
    this.bound(p);
    this.emit('ring', p.x, p.y + 0.05, p.z, 0x8fd8ff, 1.4, 0.4, true);
  }
  // donne l'objet id au héros h (ou un éclat : identifiant de MINORS)
  debugItem(h, id) {
    const p = this.f[h];
    if (!p || !this.isHero(p)) return false;
    if (MINOR_IDS.includes(id)) return this.giveMinor(p, id);
    if (!itemOf(id)) return false;
    if (id !== 'eclat' && !(',' + this.g.seen + ',').includes(',' + id + ',')) this.g.seen += (this.g.seen ? ',' : '') + id;
    return this.giveItem(p, id);
  }
  // va dans une salle au trésor (après la salle en cours)
  debugVault() {
    if (this.g.phase === 'hub' || this.g.phase === 'menu') this.g.room = Math.max(1, this.g.room);
    for (const p of this.heroes) if (p.state === 'dead') { p.hp = Math.round(p.maxHp * 0.4); p.down = 0; p.revT = 0; this.toIdle(p); }
    this.newVault();
  }
  // le boss de la salle lance tout de suite une attaque spéciale ('slam', 'charge'), ou enrage ('rage')

  debugBoss(kind) {
    const e = this.f.find((o) => o.sp !== undefined && o.state !== 'dead');
    if (e && this.g.phase === 'intro') { this.g.phase = 'fight'; this.g.t = 0; }
    if (!e || this.g.phase !== 'fight') return false;
    if (kind === 'rage') { e.hp = Math.min(e.hp, Math.floor(e.maxHp * BOSS.rage)); if (!e.rage) this.startSpecial(e, 'roar'); return true; }
    if (e.sp || !this.target(e.idx) || !FOES[e.foe].moves.includes(kind)) return false;   // une attaque qu'il connaît
    this.startSpecial(e, kind);
    return true;
  }

  // ---------------- une image ----------------
  // in0, in1 : entrées des héros 0 et 1 ({ mx, mz, blk, press }) ; les ennemis sont joués par leurs IA
  step(in0 = NEUTRAL, in1 = NEUTRAL) {
    const g = this.g, f = this.f, np = g.np;
    if (g.phase === 'menu' || g.phase === 'end') return;
    g.frame++;
    if (g.phase === 'map') {
      // choix du chemin sur la carte (en solo : immédiat ; à deux : vote)
      [in0, in1].forEach((src, h) => { if (h < np && g.phase === 'map') { const c = readMapIn(src); if (c >= 0) this.voteMap(h, c); } });
      return;
    }
    if (g.phase === 'event') {
      // choix dans un événement mystérieux '?'
      [in0, in1].forEach((src, h) => { if (g.phase === 'event' && this.mustPickEvent(h)) { const c = readEventIn(src); if (c >= 0) this.chooseEvent(h, c); } });
      return;
    }
    const adt = this.effectiveDt();
    let dt = DT * g.slow;
    if (g.hitstop > 0) { g.hitstop -= DT; dt = 0; }
    this.dt = this.wdt = dt;
    g.t += DT;
    if (g.slowT > 0) { g.slowT -= DT; if (g.slowT <= 0) g.slow = 1; }
    const ph = g.phase;

    // (un choix de carte/événement/boutique qui arrive hors phase est ignoré) ; un héros dans la boutique ne bouge pas
    const hin = (src, p) => {
      if (ph === 'hub' && p.shop) { this.shopStep(p, src); return NEUTRAL; }
      return readShop(src) >= 0 || readMapIn(src) >= 0 || readEventIn(src) >= 0 ? NEUTRAL : src;
    };
    // attaques spéciales des boss ; pendant l'une d'elles, le boss n'écoute plus son IA
    if (ph === 'fight') for (let i = np; i < f.length; i++) if (f[i].sp !== undefined) this.bossThink(f[i], adt);
    const srcs = f.map((e, i) => (i < np ? hin(i ? in1 : in0, e) : (ph === 'fight' && e.state !== 'dead' && !e.sp && this.ais[i] ? this.ais[i].update(adt) : NEUTRAL)));
    for (let p = 0; p < f.length; p++) {
      const src = srcs[p], inp = this.inp[p];
      inp.mx = src.mx / 127; inp.mz = src.mz / 127; inp.blk = !!src.blk;
      for (let k = 0; k < ACTS.length; k++) if (src.press & PRESS[ACTS[k]]) inp[ACTS[k]] = 0.18;
      for (const a of ACTS) inp[a] = Math.max(0, inp[a] - dt);
      // Ivresse de Dionysos : le héros titube (sa direction tourne d'avant en arrière)
      if (p < np && f[p].drunk && ph !== 'hub') {
        const a = 0.55 * sin(g.t * 1.9 + p * 2) + 0.25 * sin(g.t * 4.3), s = sin(a), c = cos(a);
        const mx = inp.mx, mz = inp.mz;
        inp.mx = mx * c + mz * s; inp.mz = -mx * s + mz * c;
      }
    }

    const heroAct = ph === 'intro' || ph === 'fight' || ph === 'clear' || ph === 'hub';
    for (let i = 0; i < f.length; i++) this.updateFighter(i, i < np ? heroAct : ph === 'fight');
    if (ph === 'fight') this.reviveTick(dt);

    // les combattants ne se traversent pas
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) {
      const a = f[i], b = f[j];
      if (a.state === 'dead' || b.state === 'dead' || Math.abs(a.y - b.y) > 1) continue;
      const dx = b.x - a.x, dz = b.z - a.z, d = hypot(dx, dz), min = 0.45 * (a.size + b.size), ov = min - d;
      if (ov <= 0) continue;
      const nx = d > 0.001 ? dx / d : 1, nz = d > 0.001 ? dz / d : 0;
      const wa = b.boss ? 0.85 : a.boss ? 0.15 : 0.5;     // le chef pousse plus qu'il n'est poussé
      a.x -= nx * ov * wa; a.z -= nz * ov * wa;
      b.x += nx * ov * (1 - wa); b.z += nz * ov * (1 - wa);
      this.bound(a); this.bound(b);
    }

    if (ph === 'hub') for (const p of this.heroes) this.hubPads(p);
    if (this.pr.length) this.itemizeShots();
    this.updateArrows();
    if (g.phase === 'fight') {
      // camp des héros (héros et chiens) contre les ennemis
      const heroes = f.filter((e) => e.team === 0), foes = f.filter((e) => e.team === 1);
      for (const h of heroes) if (h.state !== 'dead') this.strike(h, foes);
      // un ennemi semé dans la discorde frappe ses alliés
      for (const e of foes) if (g.phase === 'fight' && e.state !== 'dead') this.strike(e, e.sConf > 0 ? foes.filter((o) => o !== e) : heroes);
    }
    // objets : états des combattants (brûlure, poison, froid…) et effets permanents des héros (auras, orage…)
    if (g.phase === 'fight') {
      for (let i = 0; i < this.f.length; i++) this.statusTick(this.f[i], dt);
      for (const p of this.heroes) if (g.phase === 'fight') this.heroTick(p, dt);
    }
    if (g.phase === 'fight' || g.phase === 'clear') this.pickups();

    // pièges à pics
    if (ph === 'intro' || ph === 'fight' || ph === 'clear') {
      g.clock += dt;
      this.room.traps.forEach((t, k) => {
        if (!trapUp(g.clock, k)) return;
        for (const o of f) {
          if (o.state === 'dead' || o.trapT > 0 || o.y > 0.3) continue;
          if (Math.abs(o.x - t.x) < 0.7 && Math.abs(o.z - t.z) < 0.7) this.trapHit(o);
        }
      });
    }
    for (const o of f) o.trapT = Math.max(0, o.trapT - dt);

    switch (g.phase) {
      case 'intro':
        if (g.t > 1.1) { g.phase = 'fight'; g.t = 0; this.emit('announce', 'EN GARDE !', '', 0.8); }
        break;
      case 'exit':
        // avec la carte, c'est elle qui mène aux salles au trésor (g.vaultNext reste faux)
        if (g.t > 0.45) { if (this.useMap) this.openMap(); else if (g.vaultNext) this.newVault(); else this.newRoom(); }
        break;

      case 'victory':
        if (g.t > 2.2 && !g.flagEnd) { g.flagEnd = true; g.phase = 'end'; this.emit('end'); }
        break;
      case 'dead':
        if (g.t > 2.6 && !g.flagEnd) { g.flagEnd = true; g.phase = 'end'; this.emit('end'); }
        break;
    }
  }
}

// moteur des effets des objets (items.js) : méthodes ajoutées à la simulation du donjon
Object.assign(DungeonSim.prototype, ITEM_METHODS);
