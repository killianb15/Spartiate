// =====================================================================
//  Mode Donjon (rogue-like) : on enchaîne des salles remplies d'ennemis, seul ou à deux.
//
//  Reprend toute la mécanique de combat de sim.js (attaque, blocage, parade, brise-garde,
//  roulade, endurance…) ; seuls changent l'aire de jeu (salle carrée avec obstacles,
//  estrades, escaliers, pièges et porte), le nombre de combattants (1 ou 2 héros contre
//  plusieurs ennemis) et le déroulement (salle → coffre → bénédiction → salle suivante).
//
//  Comme sim.js : logique pure et déterministe (dmath.js, this.rng, aucun Math.random) ;
//  les IA des ennemis tournent DANS la simulation et sont sauvegardées avec elle, ce qui
//  permet de jouer en ligne avec le rollback de rollback.js (step(entrée0, entrée1)).
// =====================================================================
import { Sim, DT, ACTS, PRESS, NEUTRAL, STA, CAST, WEAPONS, wpnOf, defaultWeapon, newFighter, newInput, hashState } from './sim.js';
import { hypot, atan2, clamp, sin, cos } from './dmath.js';
import { AI } from './ai.js';

export const TILE = 1.5;
export const ROOM_T = 6;           // centre des dalles du bord (sol de -6.75 à 6.75)
export const ROOM_R = 6.75;        // bord du sol : les murs commencent là
export const PLAT_H = 0.9;         // hauteur des estrades (on peut y sauter)
const BODY = 0.42;                 // rayon d'un personnage contre les murs et obstacles
const LANE = 0.55;                 // demi-largeur du passage de la porte
const LOCK_R = 5.5;                // un héros se tourne vers l'ennemi le plus proche à cette distance
const STEP = 0.35;                 // hauteur qu'on franchit sans sauter
const BOSS_EVERY = 5;

// Biomes : un par tranche de BOSS_EVERY salles (le boss ferme la tranche), puis on recommence.
// Purement décoratif pour l'instant (game.js), mais déduit de l'état : identique chez les deux joueurs.
export const BIOMES = ['crypt', 'mine', 'ruins', 'forge'];
export const biomeOf = (n) => (n <= 0 ? 'crypt' : BIOMES[Math.floor((n - 1) / BOSS_EVERY) % BIOMES.length]);

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
};
// boss de la salle n (une salle sur BOSS_EVERY) : chef orc, colosse, Cerbère, puis on recommence
const BOSS_ORDER = ['boss', 'colosse', 'cerbere'];
export const bossOf = (n) => BOSS_ORDER[(Math.max(1, Math.floor(n / BOSS_EVERY)) - 1) % BOSS_ORDER.length];

// Attaques spéciales du colosse (state 'special', f.sp = 'slam' | 'charge' | 'roar') :
//  - slam : il s'accroupit (wind), bondit et retombe sur la position visée (spX, spZ) : onde de choc de
//    rayon R (Rrage une fois enragé) ; on l'évite en sautant, en roulant ou en sortant de la zone ; bloquer
//    coûte de la garde ; il reste ensuite planté un instant (rest) ;
//  - charge : il gratte le sol (wind) puis fonce tout droit (dur) ; s'il heurte un mur ou un obstacle, il
//    reste sonné (stun) : c'est le moment de frapper ;
//  - roar : à la moitié de ses PV (rage), il rugit, repousse tout le monde et appelle des renforts ;
//  - fire (Cerbère) : les trois têtes se dressent (wind) puis crachent le feu dans un cône devant lui
//    (dur) en pivotant lentement vers sa cible ; brûlure toutes les tick s. On l'évite en passant
//    derrière ou sur le côté, en roulant ; bloquer face à lui coûte de la garde.
// Pendant une attaque spéciale, il encaisse les coups sans broncher (pas d'interruption).
export const BOSS = {
  cd: 4.2, cdRage: 2.8, first: 2.5, rage: 0.5, speedRage: 1.25,
  slam: { wind: 0.6, windRage: 0.42, vy: 10, R: 2.7, Rrage: 3.3, dmg: 22, knock: 6.5, guard: 45, rest: 0.75 },
  charge: { wind: 0.75, windRage: 0.5, dur: 0.9, speed: 10.5, dmg: 18, knock: 7, guard: 40, hitR: 0.6, stun: 1.7 },
  roar: { dur: 1.4, at: 0.45, R: 3.6, knock: 7.5 },
  fire: { wind: 0.75, windRage: 0.5, dur: 1.6, R: 4.8, half: 0.62, turn: 1.0, turnRage: 1.5, tick: 0.2, dmg: 6, guard: 9, knock: 1.2 },
};

// Adaptation au nombre de joueurs (à deux) : chacun doit subir autant qu'en solo (dégâts reçus par héros,
// durée des salles). Réglée avec tools/equilibrage.mjs (héros joués par l'IA, mêmes salles seul et à deux).
// count/cap : nombre d'ennemis des salles normales ; hp, pow : PV et dégâts des ennemis ; boss* : boss ;
// escort/escortCap : escorte du chef orc
export const COOP = { count: 2, cap: 10, hp: 1.3, pow: 1.25, bossHp: 2.2, bossPow: 2, bossCd: 0.6, escort: 1.5, escortCap: 6 };
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
export const HUB_PADS = [
  ...HERO_IDS.map((id, k) => ({ t: 'hero', id, x: -4.6, z: -2.4 + k * 1.35 })),
  { t: 'shop', id: 'shop', x: MERCHANT.x, z: -3.85 },
];
const HUB_WALL = -5.15;
// socle de la statue, derrière chaque dalle de héros (contre le mur)
export const padStand = (pd) => ({ x: -5.9, z: pd.z });

// Boutique : un héros sur la dalle du marchand choisit son arme (p.shop = 1 + arme montrée).
// ← → (selon l'écran) changent l'arme montrée, attaque ou saut la prend, reculer ou bloquer s'en va.
// Une arme peut aussi être prise directement (clic, touches 1 à 9) : entrée mx = SHOP + n, mz = 127,
// blk = vrai (un déplacement au clavier ne donne jamais mx entre 110 et 126).
const SHOP = 110;
export const shopInput = (n) => ({ mx: SHOP + n, mz: 127, blk: true, press: 0 });
const readShop = (s) => (s.blk && s.mz === 127 && s.mx >= SHOP && s.mx < SHOP + WEAPON_IDS.length ? s.mx - SHOP : -1);
const SHOP_DIR = 64;   // seuil d'une direction franche (sur 127)

const heal = (p, n) => { p.hp = Math.min(p.maxHp, p.hp + n); };
// Bénédictions proposées dans le coffre de chaque salle
export const BOONS = {
  potion: { name: 'Potion', desc: 'Soigne 40 PV', apply: (p) => heal(p, 40) },
  force: { name: 'Force du taureau', desc: '+20 % de dégâts', apply: (p) => { p.pow *= 1.2; } },
  vita: { name: 'Vitalité', desc: '+20 PV max et soigne 20 PV', apply: (p) => { p.maxHp += 20; heal(p, 20); } },
  souffle: { name: 'Second souffle', desc: '+35 % de récupération d\'endurance', apply: (p) => { p.staMul += 0.35; } },
  sang: { name: 'Soif de sang', desc: 'Chaque coup porté soigne 2 PV', apply: (p) => { p.leech += 2; } },
  peau: { name: 'Peau de bronze', desc: '−15 % de dégâts subis', apply: (p) => { p.armor = 1 - (1 - p.armor) * 0.85; } },
};

// Choix d'une bénédiction transmis comme une entrée (pour qu'il passe par le rollback en ligne) :
// pendant la phase 'reward', mx = PICK + 1 + n, mz = 127, blk = vrai. Un déplacement au clavier ne
// produit jamais mx entre 101 et 103 (ses composantes valent 0, ±90 ou ±127).
const PICK = 100;
export const pickInput = (n) => ({ mx: PICK + 1 + n, mz: 127, blk: true, press: 0 });
const readPick = (s) => (s.blk && s.mz === 127 && s.mx > PICK && s.mx <= PICK + 3 ? s.mx - PICK - 1 : -1);

const OBS_R = { column: 0.4, barrel: 0.45, rocks: 0.65, stand: 0.45 };
const OBS_H = { column: 1.8, barrel: 0.8, rocks: 0.75, stand: 1.8 };   // hauteur (les flèches passent au-dessus)

// donne au héros p son personnage et son arme (statistiques de base + trait du personnage)
export function equip(p, kind, wpn = defaultWeapon(kind)) {
  if (!HEROES[kind]) kind = 'soldier';
  if (!WEAPONS[wpn]) wpn = defaultWeapon(kind);
  Object.assign(p, { kind, wpn, maxHp: 100, pow: 1, armor: 0, leech: 0, staMul: 1 });
  p.arch = !!wpnOf(p).bow;
  HEROES[kind].apply(p);
  const tank = wpnOf(p).tank;                   // gants de boxe : se cumule avec l'armure du héros
  if (tank) p.armor = 1 - (1 - p.armor) * (1 - tank);
  p.hp = p.maxHp;
}
function newHero(i, kind, wpn) {
  // team : 0 = camp des héros (héros et chiens invoqués), 1 = ennemis ; owner : maître d'un chien
  const p = Object.assign(newFighter(i), { foe: '', size: 1, boss: false, boons: '', trapT: 0, pad: -1, shop: 0, shopIn: 0, team: 0, owner: -1, kills: 0 });
  equip(p, kind, wpn);
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
  constructor(seed = 1, kinds = ['soldier'], wpns = [], unlocked = null) {
    super(seed);
    if (!Array.isArray(kinds)) kinds = [kinds];
    this.unlocked = unlocked ? kinds.map((_, i) => (Array.isArray(unlocked[i]) ? unlocked[i].filter((k) => HEROES[k]) : [])) : null;
    this.f = kinds.map((k, i) => newHero(i, this.canPick(i, k) ? k : FIRST_HERO, wpns[i]));
    this.inp = this.f.map(() => newInput());
    this.g = { phase: 'menu', np: kinds.length, room: 0, kills: 0, t: 0, clock: 0, slow: 1, slowT: 0, hitstop: 0, frame: 0,
      exitOpen: false, chest: 0, chestX: 0, chestZ: 0, o0: '', o1: '', o2: '', pick0: -1, pick1: -1, flagEnd: false };
    // exit : mur de la porte de sortie ('z' : mur z = -R, 'x' : mur x = -R) ; on entre par le mur opposé
    this.room = { exit: 'z', obs: [], surf: [], traps: [], boss: false };
    this.ais = [];
  }

  isHero(f) { return f.idx < this.g.np; }
  // le joueur i peut-il prendre ce héros ?
  canPick(i, kind) { return !this.unlocked || kind === FIRST_HERO || this.unlocked[i]?.includes(kind); }
  get heroes() { return this.f.slice(0, this.g.np); }
  get foesLeft() { let n = 0; for (const e of this.f) if (e.team === 1 && e.state !== 'dead') n++; return n; }
  // chiens vivants invoqués par le héros h
  dogsOf(h) { let n = 0; for (const e of this.f) if (e.owner === h && e.state !== 'dead') n++; return n; }
  get offer() { return [this.g.o0, this.g.o1, this.g.o2]; }

  start() { this.g.room = 0; this.g.kills = 0; for (const p of this.heroes) p.kills = 0; this.newRoom(); }

  // ---------------- salle d'armes ----------------
  startHub() {
    const g = this.g;
    g.room = 0; g.kills = 0;
    for (const p of this.heroes) p.kills = 0;
    const obs = HUB_PADS.filter((pd) => pd.t === 'hero').map((pd) => ({ ...padStand(pd), r: OBS_R.stand, kind: 'stand' }));
    // comptoir du marchand (trois cercles côte à côte)
    for (const dx of [-0.8, 0, 0.8]) obs.push({ x: MERCHANT.x + dx, z: MERCHANT.counterZ, r: OBS_R.stand, kind: 'counter' });
    for (const [x, z] of [[5.3, -2.4], [5.3, -1.2], [5.3, 5.3]]) obs.push({ x, z, r: OBS_R.barrel, kind: 'barrel' });
    this.room = { exit: 'z', obs, surf: [], traps: [], boss: false, hub: true, pads: HUB_PADS };
    this.heroes.forEach((p, i) => {
      const x = this.g.np > 1 ? (i ? 1.6 : 0.4) : 1, yaw = Math.PI * 0.75;
      Object.assign(p, { x, y: 0, z: 2.5, vx: 0, vy: 0, vz: 0, yaw, visTarget: yaw, pad: -1, shop: 0, shopIn: 0 });
      p.resetN++;
      this.toIdle(p);
    });
    this.f = this.heroes;
    this.inp = this.f.map(() => newInput());
    this.ais = this.f.map(() => null);
    this.pr = [];
    g.phase = 'hub'; g.t = 0;
    g.exitOpen = true; g.chest = 0;
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
    if (pd.t === 'shop') { this.enterShop(p, pd); return; }
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
    p.shop = 1 + Math.max(0, WEAPON_IDS.indexOf(p.wpn));
    p.shopIn = 7;                       // ignore la direction tenue en arrivant, jusqu'à ce qu'on la relâche
    const yaw = Math.PI;                // face au marchand (vers −z)
    Object.assign(p, { x: pd.x, z: pd.z, vx: 0, vz: 0, yaw, visTarget: yaw });
    this.toIdle(p);
    this.emit('sfx', 'coin');
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
        const N = WEAPON_IDS.length;
        p.shop = 1 + ((p.shop - 1 + dir + N) % N);
        this.emit('sfx', 'tick');
      }
    }
    if (p.shopIn !== 7 && src.press & (PRESS.atk | PRESS.jump)) this.buy(p, p.shop - 1);
  }
  buy(p, n) {
    const id = WEAPON_IDS[n];
    this.leaveShop(p);
    if (id === p.wpn) return;
    equip(p, p.kind, id);
    this.emit('sfx', 'coin');
    this.equipped(p, WEAPONS[id].name);
  }

  // ---------------- sauvegarde (rollback en ligne) ----------------
  save() {
    return { f: this.f.map((o) => ({ ...o })), g: { ...this.g }, inp: this.inp.map((o) => ({ ...o })), rng: this.rng.s,
      room: this.room, ai: this.ais.map((a) => (a ? a.save() : null)), pr: this.pr.map((a) => ({ ...a })) };
  }
  load(s) {
    this.f = s.f.map((o) => ({ ...o }));
    this.g = { ...s.g };
    this.inp = s.inp.map((o) => ({ ...o }));
    this.rng.s = s.rng;
    this.room = s.room;            // jamais modifiée après sa création : partage sans risque
    this.ais = s.ai.map((a, i) => (a ? AI.restore(this, i, a) : null));
    this.pr = (s.pr ?? []).map((a) => ({ ...a }));
  }
  hash() { return hashState(this.save()); }

  // ---------------- génération d'une salle ----------------
  newRoom() {
    const g = this.g, r = this.rng, np = g.np;
    g.room++;
    const n = g.room, boss = n % BOSS_EVERY === 0, bossId = boss ? bossOf(n) : '';
    const exit = r.next() < 0.5 ? 'z' : 'x';
    const used = new Set();                       // dalles occupées « i,j »
    const key = (i, j) => i + ',' + j;

    // estrades avec un escalier tourné vers le centre (à partir de la 3e salle)
    const surf = [];
    const q = r.next();
    const lair = bossId === 'cerbere';            // antre de Cerbère : salle dédiée, arène dégagée
    const nPlat = n < 3 || lair ? 0 : boss ? 2 : q < 0.4 ? 1 : q < 0.6 ? 2 : 0;
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
    const obs = [];
    const nObs = lair ? 0 : boss ? 2 : (r.next() * 4) | 0;
    const kinds = ['column', 'column', 'barrel', 'rocks'];
    if (lair) for (const [i, j] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) obs.push({ x: i * TILE, z: j * TILE, r: OBS_R.column, kind: 'column' });
    for (let k = 0; k < nObs; k++) {
      const t = freeTile();
      if (!t) break;
      const kind = boss ? 'column' : kinds[(r.next() * kinds.length) | 0];
      obs.push({ x: t[0], z: t[1], r: OBS_R[kind], kind });
    }
    const traps = [];
    if (n >= 2 && !lair && r.next() < 0.45) {
      const nt = 2 + ((r.next() * 3) | 0);
      for (let k = 0; k < nt; k++) { const t = freeTile(); if (t) traps.push({ x: t[0], z: t[1] }); }
    }
    this.room = { exit, obs, surf, traps, boss, bossId, lair: lair ? 'cerbere' : '' };

    // les héros entrent par le mur opposé à la sortie (les héros tombés se relèvent)
    const ent = ROOM_R - 0.7;
    this.heroes.forEach((p, i) => {
      const off = np > 1 ? (i ? 0.8 : -0.8) : 0;
      const [px, pz, yaw] = exit === 'z' ? [off, ent, Math.PI] : [ent, off, -Math.PI / 2];
      if (p.state === 'dead') p.hp = Math.round(p.maxHp * 0.4);
      Object.assign(p, { x: px, y: 0, z: pz, vx: 0, vy: 0, vz: 0, yaw, visTarget: yaw, hitDone: false, combo: 0, airAtk: false, trapT: 0, pad: -1, shop: 0, shopIn: 0 });
      p.resetN++;
      this.toIdle(p);
    });

    // ennemis (plus nombreux à deux)
    const list = [];
    // le chef orc vient avec des orcs ; le colosse arrive seul (ses renforts viennent quand il enrage)
    // (à deux, son escorte grandit : x COOP.escort + 1, au plus COOP.escortCap)
    const escort = Math.min(4, n / BOSS_EVERY), escortN = np > 1 ? Math.min(COOP.escortCap, Math.ceil(escort * COOP.escort) + 1) : escort;
    if (boss) { list.push(bossId); if (bossId === 'boss') for (let k = 0; k < escortN; k++) list.push('grunt'); }
    else {
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
    for (const id of list) {
      const T = FOES[id];
      let x = 0, z = 0;
      for (let tries = 0; tries < 40; tries++) {
        // dans la moitié de la salle côté sortie, loin des héros
        const a = r.range(-ROOM_T + 0.5, ROOM_T - 0.5), b = r.range(-ROOM_T + 0.5, 0.5);
        [x, z] = exit === 'z' ? [a, b] : [b, a];
        if (T.boss) [x, z] = exit === 'z' ? [0, -3] : [-3, 0];
        const free = obs.every((o) => hypot(o.x - x, o.z - z) > o.r + 0.8) && foes.every((e) => hypot(e.x - x, e.z - z) > 1.4) &&
          surf.every((s) => !s.ramp || !inRect(s, x, z, 0.3));
        if (free && hypot(px - x, pz - z) > 4) break;
      }
      foes.push(this.newFoe(id, np + foes.length, x, z, atan2(px - x, pz - z)));
    }
    this.f = [...this.heroes, ...foes];
    this.inp = this.f.map(() => newInput());
    this.pr = [];
    const aseed = (r.next() * 4294967296) >>> 0;
    this.ais = this.f.map((e, i) => (i < np ? null : new AI(this, i, FOES[e.foe].lv, (aseed + i * 104729) >>> 0)));

    g.phase = 'intro'; g.t = 0;
    g.exitOpen = false; g.chest = 0; g.pick0 = g.pick1 = -1;
    g.slow = 1; g.slowT = 0; g.hitstop = 0;
    this.emit('room', n);
    this.emit('announce', boss ? FOES[bossId].name.toUpperCase() + ' !' : `SALLE ${n}`, boss ? 'ko' : '', 1.3);
    this.emit('sfx', 'gong');
  }
  // ennemi n° idx de type id (PV et dégâts selon la profondeur et le nombre de héros)
  newFoe(id, idx, x, z, yaw) {
    const T = FOES[id], n = Math.max(1, this.g.room);
    const np = this.g.np, hp = Math.round(T.hp * (1 + 0.07 * (n - 1)) * coop(np, T.boss ? 'bossHp' : 'hp'));
    const e = Object.assign(newFighter(idx), { x, z, yaw, visTarget: yaw, kind: T.kind, wpn: T.wpn ?? defaultWeapon(T.kind), foe: id, size: T.size,
      boss: !!T.boss, hp, maxHp: hp, pow: T.pow * (1 + 0.04 * (n - 1)) * coop(np, T.boss ? 'bossPow' : 'pow'), armor: 0, leech: 0, staMul: 1, boons: '', trapT: 0, team: 1, owner: -1 });
    e.arch = !!wpnOf(e).bow;
    if (T.moves) Object.assign(e, { sp: '', spT: 0, spA: 0, spX: 0, spZ: 0, spHit: 0, spCd: BOSS.first * coop(np, 'bossCd'), rage: 0, spTick: 0 });
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

  // ---------------- points d'extension de Sim ----------------
  target(i) {
    const me = this.f[i], hero = this.isHero(me);
    let best = null, bd = hero ? LOCK_R : 1e9;
    for (const o of this.f) {
      if (o === me || o.state === 'dead' || o.team === me.team) continue;
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

  // ---------------- grimoire : chiens invoqués ----------------
  canSummon(f) {
    const ph = this.g.phase;
    return this.isHero(f) && (ph === 'fight' || ph === 'intro' || ph === 'clear' || ph === 'hub') && this.dogsOf(f.idx) < CAST.max;
  }
  // un chien apparaît devant le héros p et se bat avec lui (piloté par une IA, dans la simulation)
  summon(p) {
    if (!this.canSummon(p)) return;
    const g = this.g, T = FOES.dog, n = Math.max(1, g.room), idx = this.f.length;
    const lim = ROOM_R - 0.6;
    const x = clamp(p.x + sin(p.yaw), -lim, lim), z = clamp(p.z + cos(p.yaw), -lim, lim);
    const hp = Math.round(T.hp * (1 + 0.07 * (n - 1)));
    const d = Object.assign(newFighter(idx), { x, z, yaw: p.yaw, visTarget: p.yaw, kind: 'dog', wpn: 'bite', arch: false, foe: 'dog', size: T.size,
      boss: false, hp, maxHp: hp, pow: T.pow * (1 + 0.04 * (n - 1)), armor: 0, leech: 0, staMul: 1, boons: '', trapT: 0, pad: -1, team: 0, owner: p.idx });
    d.y = this.groundY(d);
    this.f.push(d);
    this.inp.push(newInput());
    this.ais.push(new AI(this, idx, T.lv, (this.rng.next() * 4294967296) >>> 0));
    this.emit('emit', x, d.y + 0.4, z, 26, { color: [0xb98aff, 0x7a4adf, 0xffffff], speed: 2.4, up: 3, size: 0.08, life: 0.7, grav: 4 });
    this.emit('ring', x, d.y + 0.05, z, 0xa070ff, 1.6, 0.5, true);
    this.emit('sfx', 'bark');
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
      if (a < -ROOM_R - 0.5 && (g.phase === 'clear' || g.phase === 'hub')) { g.phase = 'exit'; g.t = 0; this.emit('exit'); }
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
    dmg = Math.max(1, Math.round(dmg * att.pow * (1 - def.armor)));
    if (att.leech) heal(att, att.leech);
    if (def.boss) knock *= 0.4;               // le chef ne recule presque pas
    if (def.sp) this.armorHit(att, def, dmg, cx, cy, cz);
    else super.damage(att, def, dmg, knock, dur, cx, cy, cz);
    // le colosse enrage à la moitié de ses PV
    if (def.sp !== undefined && !def.rage && def.state !== 'dead' && def.hp <= def.maxHp * BOSS.rage) this.startSpecial(def, 'roar');
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
    if (FOES[e.foe].moves.includes('fire')) {
      // Cerbère : loin, il charge ; à portée de flammes, il crache le feu ; collé, il bondit une fois sur deux
      this.startSpecial(e, d > BOSS.fire.R + 0.4 ? 'charge' : d < 2.4 && this.rng.next() < 0.5 ? 'slam' : 'fire');
      return;
    }
    // loin : charge ; près : saut écrasant ; entre les deux : au hasard (rng de la simulation)
    this.startSpecial(e, d > 4.2 ? 'charge' : d < 2.4 ? 'slam' : this.rng.next() < 0.5 ? 'charge' : 'slam');
  }
  startSpecial(e, kind) {
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
    } else {
      e.rage = 1;
      this.play(e, 'emote-yes', { ts: 0.8, fade: 0.08, loop: false });
      this.emit('sfx', 'roar');
      this.emit('announce', `${FOES[e.foe].name.toUpperCase()} ENRAGE !`, 'ko', 1.4);
    }
  }
  endSpecial(e) {
    e.sp = ''; e.vx = e.vz = 0;
    e.spCd = (e.rage ? BOSS.cdRage : BOSS.cd) * (0.8 + 0.4 * this.rng.next()) * coop(this.g.np, 'bossCd');
    if (e.state === 'special') this.toIdle(e);
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
    } else if (e.sp === 'roar') {
      const R = BOSS.roar;
      if (e.spA === 0 && e.spT >= R.at) {
        e.spA = 1;
        this.emit('ring', e.x, e.y + 0.1, e.z, 0xff5a20, R.R * 1.2, 0.6, true);
        this.emit('ring', e.x, e.y + 1.2, e.z, 0xffb04a, R.R, 0.4);
        this.emit('shake', 0.35);
        for (const d of this.f) {
          if (d.state === 'dead' || d.team === e.team) continue;
          const dx = d.x - e.x, dz = d.z - e.z, dist = hypot(dx, dz);
          if (dist > R.R || dist < 0.01) continue;
          d.vx = dx / dist * R.knock; d.vz = dz / dist * R.knock;
          if (d.state !== 'air' && d.state !== 'roll') { this.setState(d, 'hit', 0.4); this.play(d, 'idle', { fade: 0.05 }); }
        }
        // renforts : un de plus à deux
        const add = FOES[e.foe].adds;
        if (add) for (let k = 0; k <= this.g.np; k++) {
          const a = e.yaw + Math.PI * 2 * (k + 0.5) / (this.g.np + 1);
          this.addFoe(add, e.x + sin(a) * 2.6, e.z + cos(a) * 2.6);
        }
      }
      if (e.spT >= R.dur) this.endSpecial(e);
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
        d.guard -= F.guard * wpnOf(d).guard; d.guardT = 0;
        this.emit('fx', d.idx, 'blocked');
        if (d.guard <= 0) this.guardBreak(e, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.damage(e, d, F.dmg, F.knock, 0.15, d.x, d.y + 1, d.z);
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
        d.guard -= S.guard * wpnOf(d).guard; d.guardT = 0;
        d.vx = nx * 3; d.vz = nz * 3;
        this.emit('fx', d.idx, 'blocked');
        this.emit('sfx', 'clang');
        if (d.guard <= 0) this.guardBreak(e, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.damage(e, d, S.dmg, 0, 0.5, d.x, d.y + 0.6, d.z);
      if (d.state !== 'dead') { d.vx = nx * S.knock; d.vz = nz * S.knock; }
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
        d.guard -= C.guard * wpnOf(d).guard; d.guardT = 0;
        d.vx = kx * 4; d.vz = kz * 4;
        this.emit('fx', d.idx, 'blocked');
        this.emit('sfx', 'clang');
        this.emit('shake', 0.15);
        if (d.guard <= 0) this.guardBreak(e, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.damage(e, d, C.dmg, 0, 0.55, d.x, d.y + 1, d.z);
      if (d.state !== 'dead') { d.vx = kx * C.knock; d.vz = kz * C.knock; }
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
    const g = this.g, dmg = Math.max(1, Math.round(TRAP.dmg * (1 - f.armor)));
    f.trapT = 1.0;
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
        this.emit('announce', `J${def.idx + 1} À TERRE !`, 'ko', 1.3);
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
    // victime d'un héros ou de son chien : comptée pour ses défis (kills, remis à zéro à chaque donjon)
    const k = att ? (this.isHero(att) ? att.idx : att.owner) : -1;
    if (k >= 0 && this.f[k]) this.f[k].kills++;
    this.emit('sfx', 'coin');
    this.emit('emit', def.x, def.y + 1, def.z, 18, { color: [0xffd34a, 0xffe27a, 0xfff0a0], speed: 2.5, up: 4, size: 0.08, life: 0.9, grav: 9 });
    if (this.foesLeft === 0 && g.phase === 'fight') {
      g.phase = 'clear'; g.t = 0;
      g.exitOpen = true;
      g.chest = 1; g.chestX = 0; g.chestZ = 0;
      // le coffre apparaît au centre, ou à côté si un héros s'y trouve
      if (this.heroes.some((p) => hypot(p.x, p.z) < 1.5)) g.chestX = this.f[0].x > 0 ? -1.5 : 1.5;
      g.slow = 0.35; g.slowT = 0.7;
      this.emit('announce', this.room.boss ? FOES[this.room.bossId || 'boss'].name.toUpperCase() + ' VAINCU !' : 'SALLE NETTOYÉE', '', 1.5);
      this.emit('sfx', 'cheer', 0.6);
      this.emit('clear');
    }
  }

  updateFighter(i, canAct) {
    if (this.f[i].sp) this.special(this.f[i], canAct);
    super.updateFighter(i, canAct);
    const f = this.f[i];
    // bénédiction « Second souffle » : récupération d'endurance supplémentaire
    if (f.staMul > 1 && f.staT > STA.delay && f.state !== 'roll') f.sta = Math.min(100, f.sta + STA.regen * this.dt * (f.staMul - 1));
  }

  // ---------------- coffre et bénédictions ----------------
  rollOffer() {
    const pool = Object.keys(BOONS).filter((k) => k !== 'potion');
    const out = ['potion'];
    while (out.length < 3 && pool.length) out.push(pool.splice((this.rng.next() * pool.length) | 0, 1)[0]);
    [this.g.o0, this.g.o1, this.g.o2] = out;
  }
  // le héros h prend la bénédiction n° c du coffre
  choose(h, c) {
    const g = this.g, p = this.f[h], id = this.offer[c];
    if (g.phase !== 'reward' || !BOONS[id] || g['pick' + h] >= 0) return false;
    BOONS[id].apply(p);
    p.boons += (p.boons ? ',' : '') + id;
    g['pick' + h] = c;
    this.emit('pop', BOONS[id].name, p.x, p.y + 2.1, p.z, 'parry');
    this.emit('sfx', 'parry');
    this.emit('ring', p.x, p.y + 1, p.z, 0xffd34a, 2.2, 0.5);
    return true;
  }
  // vrai si le héros h doit encore choisir
  mustPick(h) { return this.g.phase === 'reward' && h < this.g.np && this.f[h].state !== 'dead' && this.g['pick' + h] < 0; }

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
    for (const p of this.heroes) if (p.state === 'dead') { p.hp = Math.round(p.maxHp * 0.4); this.toIdle(p); }
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
    if (g.phase === 'reward') {
      // le temps est suspendu pendant que chacun choisit sa bénédiction
      [in0, in1].forEach((src, h) => { if (this.mustPick(h)) { const c = readPick(src); if (c >= 0) this.choose(h, c); } });
      if (!this.heroes.some((p, h) => this.mustPick(h))) { g.phase = 'clear'; g.t = 0; }
      return;
    }
    const adt = this.effectiveDt();
    let dt = DT * g.slow;
    if (g.hitstop > 0) { g.hitstop -= DT; dt = 0; }
    this.dt = dt;
    g.t += DT;
    if (g.slowT > 0) { g.slowT -= DT; if (g.slowT <= 0) g.slow = 1; }
    const ph = g.phase;

    // (un choix de bénédiction qui arrive encore après la phase 'reward' est ignoré)
    // (de même pour un choix d'arme hors de la boutique) ; un héros dans la boutique ne bouge pas
    const hin = (src, p) => {
      if (ph === 'hub' && p.shop) { this.shopStep(p, src); return NEUTRAL; }
      return readPick(src) >= 0 || readShop(src) >= 0 ? NEUTRAL : src;
    };
    // attaques spéciales des boss ; pendant l'une d'elles, le boss n'écoute plus son IA
    if (ph === 'fight') for (let i = np; i < f.length; i++) if (f[i].sp !== undefined) this.bossThink(f[i], adt);
    const srcs = f.map((e, i) => (i < np ? hin(i ? in1 : in0, e) : (ph === 'fight' && e.state !== 'dead' && !e.sp && this.ais[i] ? this.ais[i].update(adt) : NEUTRAL)));
    for (let p = 0; p < f.length; p++) {
      const src = srcs[p], inp = this.inp[p];
      inp.mx = src.mx / 127; inp.mz = src.mz / 127; inp.blk = !!src.blk;
      for (let k = 0; k < ACTS.length; k++) if (src.press & PRESS[ACTS[k]]) inp[ACTS[k]] = 0.18;
      for (const a of ACTS) inp[a] = Math.max(0, inp[a] - dt);
    }

    const heroAct = ph === 'intro' || ph === 'fight' || ph === 'clear' || ph === 'hub';
    for (let i = 0; i < f.length; i++) this.updateFighter(i, i < np ? heroAct : ph === 'fight');

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
    this.updateArrows();
    if (g.phase === 'fight') {
      // camp des héros (héros et chiens) contre les ennemis
      const heroes = f.filter((e) => e.team === 0), foes = f.filter((e) => e.team === 1);
      for (const h of heroes) if (h.state !== 'dead') this.strike(h, foes);
      for (const e of foes) if (g.phase === 'fight' && e.state !== 'dead') this.strike(e, heroes);
    }

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
      case 'clear':
        if (g.chest === 1 && g.t > 0.4 && this.heroes.some((p) => p.state !== 'dead' && hypot(p.x - g.chestX, p.z - g.chestZ) < 1.0)) {
          g.chest = 2;
          g.phase = 'reward';
          g.pick0 = g.pick1 = -1;
          this.rollOffer();
          this.emit('sfx', 'coin');
          this.emit('reward');
        }
        break;
      case 'exit':
        if (g.t > 0.45) this.newRoom();
        break;
      case 'dead':
        if (g.t > 2.6 && !g.flagEnd) { g.flagEnd = true; g.phase = 'end'; this.emit('end'); }
        break;
    }
  }
}
