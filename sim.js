// =====================================================================
//  Simulation du combat : logique pure, sans Three.js, sans DOM, sans son.
//
//  - Pas fixe de 1/60 s : mêmes entrées => même résultat, bit pour bit, sur toutes
//    les machines (maths de dmath.js uniquement, aucun Math.random ni horloge).
//  - Tout l'état est « plat » (nombres, booléens, chaînes) : save()/load() copient
//    en quelques microsecondes, ce qui rend possible le rollback réseau.
//  - Ce qui doit être vu/entendu (sons, particules, textes) sort sous forme
//    d'événements dans sim.ev ; l'animation est décrite par des champs (anim*) que
//    la vue lit. La simulation ne sait rien de l'affichage.
// =====================================================================
import { sin, cos, atan2, exp, hypot, lerpAng, Rng } from './dmath.js';

export const DT = 1 / 60;
export const FIGHT_R = 7;
export const ROUND_TIME = 60;
export const ATK = { start: 0.13, end: 0.26, chain: 0.27, dur: 0.42, track: 0.09 };
export const BRK = { start: 0.34, end: 0.47, dur: 0.8 };
export const PAR = { win: 0.2, dur: 0.42 };
export const ROLL = { dur: 0.48, inv0: 0.03, inv1: 0.36, speed: 7.5 };
// endurance : chaque action en consomme, elle remonte quand on souffle un peu
export const STA = { regen: 30, delay: 0.7, atk: 9, brk: 22, roll: 28, jump: 12, par: 10, tired: 15, summon: 30 };
// archer : tir (relâche de la flèche à rel, nouveau tir possible à chain), flèche (vitesse, dégâts, durée de vol)
export const SHOT = { rel: 0.2, chain: 0.36, dur: 0.5, speed: 15, dmg: 10, life: 1.1, guard: 16, melee: 1.5, bash: 6, run: 1.12 };
// sceptre : boule de feu (plus lente qu'une flèche) qui explose en zone : rayon, dégâts, garde perdue
// au blocage, recul ; rel/chain/dur : comme SHOT mais pour l'incantation (cadence plus lente)
export const FIRE = { speed: 8.5, life: 1.3, radius: 1.7, dmg: 9, guard: 20, knock: 3.2, rel: 0.26, chain: 0.62, dur: 0.66, touch: 0.5 };
// grimoire : incantation qui invoque un chien (rel : le chien apparaît ; chain/dur : fin de l'incantation)
export const CAST = { rel: 0.4, chain: 0.85, dur: 0.85, max: 2 };
export const HIT_W = 0.72;
// Armes : portée du coup, dégâts, coups d'un enchaînement, vitesse de course, coût du blocage
// (multiplie la garde perdue), crush (multiplie la garde que fait perdre un coup bloqué).
// 'bow' tire des flèches (voir SHOT). Hache et marteau : modèles générés par tools/blender/weapons.py.
export const WEAPONS = {
  sword: { name: 'Glaive et bouclier', desc: 'Équilibré : enchaînement de 3 coups', reach: 1.45, dmg: 9, combo: 3, run: 1, guard: 1 },
  spear: { name: 'Lance', desc: 'Frappe de loin, mais 2 coups par enchaînement', reach: 2.0, dmg: 10, combo: 2, run: 1, guard: 1.15 },
  tower: { name: 'Épée et pavois', desc: 'Le grand bouclier encaisse mieux, mais on court moins vite', reach: 1.45, dmg: 9, combo: 3, run: 0.88, guard: 0.6 },
  axe: { name: 'Hache et bouclier', desc: 'Gros dégâts, 2 coups par enchaînement', reach: 1.5, dmg: 12, combo: 2, run: 1, guard: 1 },
  hammer: { name: 'Marteau de guerre', desc: 'Un seul coup écrasant, qui ruine la garde', reach: 1.6, dmg: 17, combo: 1, run: 0.94, guard: 1.3, crush: 1.8 },
  staff: { name: 'Sceptre de feu', desc: 'Boules de feu qui explosent et brûlent tout autour', reach: 1.45, dmg: 6, combo: 3, run: 1, guard: 1.4, bow: true, fire: true },
  tome: { name: 'Grimoire', desc: 'Invoque des chiens qui se battent pour toi (2 au plus)', reach: 1.3, dmg: 5, combo: 2, run: 1, guard: 1.3, summon: true },
  // tank : part des dégâts encaissée par les gants (donjon : s'ajoute à l'armure du héros, voir equip)
  gloves: { name: 'Gants de boxe', desc: 'Pour encaisser : −20 % de dégâts subis et la meilleure garde, mais petits coups de près', reach: 1.15, dmg: 6, combo: 3, run: 1, guard: 0.45, tank: 0.2 },
  // crocs des chiens invoqués (pas proposés dans la salle d'armes)
  bite: { name: 'Crocs', desc: '', reach: 1.25, dmg: 8, combo: 2, run: 1.25, guard: 1.5, hidden: true },
  // les trois gueules de Cerbère : un enchaînement de 3 morsures (une par tête), de loin (il est grand) ;
  // windup : il se ramasse avant chaque morsure (fenêtre d'esquive), puis se lance (lunge : vitesse du bond)
  fangs: { name: 'Trois gueules', desc: '', reach: 2.0, dmg: 13, combo: 3, run: 1.05, guard: 1, hidden: true, windup: 0.5, lunge: 6 },
  bow: { name: 'Arc', desc: 'Tire des flèches ; on court plus vite, mais on bloque mal', reach: 1.45, dmg: SHOT.bash, combo: 3, run: SHOT.run, guard: 1.6, bow: true },
};
export const wpnOf = (f) => WEAPONS[f.wpn] ?? WEAPONS.sword;
// temps de préparation du coup en cours (0 pour les armes normales ; plus court pour les coups enchaînés)
// coût du blocage : celui de l'arme, réduit par la bénédiction « Garde de fer » (guardMul)
export const guardOf = (f) => wpnOf(f).guard * (f.guardMul ?? 1);
export const windupOf = (f) => (wpnOf(f).windup ?? 0) * (f.combo > 1 ? 0.6 : 1);
// temps du tir (arc), de l'incantation de la boule de feu (sceptre) ou de l'invocation (grimoire)
const shotOf = (f) => (wpnOf(f).summon ? CAST : wpnOf(f).fire ? FIRE : SHOT);
// arme par défaut d'un personnage (l'archère a son arc)
export const defaultWeapon = (kind) => (kind === 'archer' ? 'bow' : 'sword');   // demi-largeur de la zone touchée : un pas de côté suffit pour esquiver
const BUF = 0.18;            // durée de mémorisation d'une touche pressée

// Sorts actifs propres à chaque personnage, avec temps de recharge (cd en secondes).
export const SPELLS = {
  soldier: {
    id: 'spin', name: 'Tourbillon',
    desc: 'Tourne sur lui-même et tranche tous les ennemis autour (3 coups)',
    cd: 7, dur: 0.75, radius: 2.45, dmg: 7, hits: 3, knock: 3.4, guard: 14, color: 0xffd34a,
  },
  human: {
    id: 'dash', name: 'Estoc fulgurant',
    desc: 'Fonce droit devant et transperce tous les ennemis sur sa trajectoire',
    cd: 6.5, dur: 0.42, dashDur: 0.25, speed: 13.5, radius: 1.05, dmg: 18, knock: 5.2, guard: 30, color: 0xffe27a,
  },
  orc: {
    id: 'slam', name: 'Frappe sismique',
    desc: 'Bondit et écrase le sol : onde de choc étourdissante autour de lui',
    cd: 8.5, dur: 0.72, hitAt: 0.34, vy: 6.5, radius: 3.1, dmg: 20, knock: 6.0, guard: 36, stun: 0.65, color: 0xff8a2e,
  },
  archer: {
    id: 'volley', name: 'Pluie de flèches',
    desc: 'Bondit en arrière en tirant une salve de 5 flèches en éventail',
    cd: 6.5, dur: 0.46, hitAt: 0.16, arrows: 5, spread: 0.17, back: 4.8, color: 0x9be8ff,
  },
  knight: {
    id: 'aegis', name: 'Rempart sacré',
    desc: 'Repousse autour, restaure la garde et réduit de 50 % les dégâts (3,5 s)',
    cd: 10, dur: 0.44, hitAt: 0.14, radius: 2.6, dmg: 10, knock: 6.8, guard: 24, buff: 3.5, reduce: 0.5, color: 0xffe066,
  },
  zombie: {
    id: 'nova', name: 'Nuée putride',
    desc: 'Explosion toxique autour de lui qui draine 7 PV par ennemi touché',
    cd: 8, dur: 0.54, hitAt: 0.22, radius: 2.9, dmg: 14, heal: 7, knock: 3.2, guard: 20, color: 0x7ae85a,
  },
  robot: {
    id: 'overload', name: "Décharge d'arc",
    desc: 'Onde électrique qui brise les gardes et étourdit les ennemis proches',
    cd: 7.5, dur: 0.58, hitAt: 0.26, radius: 2.8, dmg: 15, knock: 4.2, stun: 0.85, color: 0x6fc3ff,
  },
};
export const spellOf = (f) => SPELLS[f?.kind] ?? SPELLS.soldier;

// Entrée d'un joueur pour une image : déplacement quantifié (-127..127), blocage, touches pressées (bits)
export const PRESS = { atk: 1, par: 2, brk: 4, jump: 8, roll: 16, spell: 32 };
export const ACTS = ['atk', 'par', 'brk', 'jump', 'roll', 'spell'];
export const NEUTRAL = Object.freeze({ mx: 0, mz: 0, blk: false, press: 0 });
export const quant = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));

const fx = (f) => sin(f.yaw);
const fz = (f) => cos(f.yaw);
export const canRoll = (f) => f.sta >= STA.roll;

export function newFighter(idx) {
  return {
    idx, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, visTarget: 0,
    hp: 100, guard: 100, state: 'idle', stateT: 0, dur: 0, sta: 100, staT: 9, staFail: 0,
    hitDone: false, airAtk: false, airAtkT: 0, combo: 0, brkSfx: false, guardT: 9, dustT: 0, rdx: 0, rdz: 0,
    // description de l'animation demandée (la vue la lit quand animN change)
    anim: 'idle', animTs: 1, animLoop: true, animRestart: false, animFade: 0, animN: 0,
    resetN: 0,   // +1 à chaque remise à zéro (la vue réinitialise alors son squelette)
    kind: 'soldier', // personnage (détermine le sort actif)
    arch: false, // archer : l'attaque tire une flèche
    wpn: 'sword', // arme (clé de WEAPONS)
    // sort actif et temps de recharge
    spellCd: 0, spellMax: SPELLS.soldier.cd, spellTick: 0, spellHit: 0, spellBuffT: 0, spellDx: 0, spellDz: 0,
  };
}
export const newInput = () => ({ mx: 0, mz: 0, blk: false, atk: 0, par: 0, brk: 0, jump: 0, roll: 0, spell: 0 });

export class Sim {
  // kinds : personnage de chaque combattant ('archer' tire des flèches, chacun a son sort)
  constructor(seed = 1, kinds = ['soldier', 'orc']) {
    this.rng = new Rng(seed);
    this.f = [newFighter(0), newFighter(1)];
    this.f.forEach((f, i) => {
      f.kind = kinds[i] || 'soldier';
      f.wpn = defaultWeapon(f.kind);
      f.arch = !!wpnOf(f).bow;
      f.spellMax = spellOf(f).cd;
    });
    this.pr = [];           // flèches en vol (objets plats, sauvegardés avec le reste)
    this.inp = [newInput(), newInput()];
    this.g = { phase: 'menu', round: 1, w0: 0, w1: 0, timer: ROUND_TIME, t: 0, slow: 1, slowT: 0, hitstop: 0,
      roundWinner: -1, flagGo: false, flagPose: false, flagFade: false, frame: 0 };
    this.dt = DT;
    this.ev = [];
    this.record = true;     // false pendant une re-simulation : pas d'événements en double
    this.placeStart(1.4);
  }

  get wins() { return [this.g.w0, this.g.w1]; }
  emit(...e) { if (this.record) this.ev.push(e); }
  take(i, a) { const inp = this.inp[i]; if (inp[a] > 0) { inp[a] = 0; return true; } return false; }

  // ---------------- points d'extension (le donjon les redéfinit) ----------------
  // adversaire vers lequel le combattant i se tourne (null : aucun, il suit sa direction de marche)
  target(i) { return this.f[1 - i]; }
  // garde le combattant dans l'aire de jeu
  bound(f) {
    const r = hypot(f.x, f.z);
    if (r > FIGHT_R) { f.x *= FIGHT_R / r; f.z *= FIGHT_R / r; }
  }
  // hauteur du sol sous le combattant (le donjon a des estrades et des escaliers)
  groundY(f) { return 0; }
  // après le déplacement horizontal : monter/descendre une marche (rien dans l'arène)
  settle(f) {}
  // vrai si aller dans la direction (mx, mz) envoie f contre un bord (utilisé par l'IA)
  nearWall(f, mx, mz) { return hypot(f.x, f.z) > FIGHT_R - 0.8 && (mx * f.x + mz * f.z) > 0; }
  // def vient de tomber sous les coups de att
  onKO(att, def) { this.endRound(att.idx, 'K.O. !'); }
  // la flèche tirée par le combattant n° o peut-elle toucher f ?
  foeOf(o, f) { return o !== f.idx; }
  // invocation (grimoire) : l'arène n'en a pas, le donjon les ajoute
  canSummon(f) { return false; }
  summon(f) {}
  // la flèche heurte-t-elle le décor ?
  arrowWall(a) { return a.y < 0.02 || hypot(a.x, a.z) > 9.6; }
  // qui peut lancer le sort actif de son personnage ? (en arène : tout le monde ; en donjon : héros seulement)
  canCastSpell(f) { return !!SPELLS[f.kind]; }
  // réduction de dégâts du buff défensif (Rempart sacré) ; DungeonSim l'intègre à son calcul d'armure
  mitigateSpell(def, dmg) { return def.spellBuffT > 0 ? Math.max(1, Math.round(dmg * (1 - SPELLS.knight.reduce))) : dmg; }

  // ---------------- sauvegarde / restauration / empreinte ----------------
  save() {
    return { f: [{ ...this.f[0] }, { ...this.f[1] }], g: { ...this.g }, inp: [{ ...this.inp[0] }, { ...this.inp[1] }], rng: this.rng.s, pr: this.pr.map((a) => ({ ...a })) };
  }
  load(s) {
    this.f = [{ ...s.f[0] }, { ...s.f[1] }];
    this.g = { ...s.g };
    this.inp = [{ ...s.inp[0] }, { ...s.inp[1] }];
    this.rng.s = s.rng;
    this.pr = (s.pr ?? []).map((a) => ({ ...a }));
  }
  // empreinte 32 bits de tout l'état de jeu (détection de désynchronisation)
  hash() { return hashState({ f: this.f, g: this.g, inp: this.inp, rng: this.rng.s, pr: this.pr }); }

  // ---------------- déroulement du match ----------------
  placeStart(gap) {
    this.reset(this.f[0], -gap, 0, Math.PI / 2);
    this.reset(this.f[1], gap, 0, -Math.PI / 2);
  }
  reset(f, x, z, yaw) {
    const n = f.resetN + 1, an = f.animN + 1;
    Object.assign(f, newFighter(f.idx), { x, z, yaw, visTarget: yaw, resetN: n, animN: an, kind: f.kind, arch: f.arch, wpn: f.wpn, spellMax: spellOf(f).cd });
  }
  startMatch() {
    const g = this.g;
    g.round = 1; g.w0 = 0; g.w1 = 0;
    this.startRound();
  }
  startRound() {
    const g = this.g;
    this.placeStart(2.6);
    g.phase = 'intro'; g.t = 0;
    g.flagGo = g.flagPose = g.flagFade = false;
    g.timer = ROUND_TIME; g.slow = 1; g.slowT = 0; g.hitstop = 0;
    this.inp[0] = newInput(); this.inp[1] = newInput();
    this.pr = [];
    this.emit('round', g.round);
    this.emit('announce', g.round === 3 ? 'ROUND FINAL' : `ROUND ${g.round}`, '', 1.25);
    this.emit('sfx', 'gong');
  }
  endRound(winner, text) {
    const g = this.g;
    if (g.phase !== 'fight') return;
    g.phase = 'ko'; g.t = 0;
    g.flagGo = g.flagPose = g.flagFade = false;
    g.roundWinner = winner;
    if (winner === 0) g.w0++; else if (winner === 1) g.w1++;
    this.emit('announce', text, 'ko', 1.8);
    if (text === 'K.O. !') { this.emit('sfx', 'ko'); g.slow = 0.25; g.slowT = 1.1; this.emit('ko'); }
    this.emit('sfx', 'cheer', 1.2);
    this.emit('cheer', 1.4);
  }

  // Durée simulée par la prochaine image (ralenti et arrêt sur image compris).
  effectiveDt() { return this.g.hitstop > 0 ? 0 : DT * this.g.slow; }

  // Avance d'une image. in0/in1 : { mx, mz, blk, press } (voir NEUTRAL).
  step(in0 = NEUTRAL, in1 = NEUTRAL) {
    const g = this.g, f = this.f;
    let dt = DT * g.slow;
    if (g.hitstop > 0) { g.hitstop -= DT; dt = 0; }
    this.dt = dt;
    g.frame++;
    g.t += DT;
    if (g.slowT > 0) { g.slowT -= DT; if (g.slowT <= 0) g.slow = 1; }
    const ph = g.phase;

    [in0, in1].forEach((src, p) => {
      const inp = this.inp[p];
      inp.mx = src.mx / 127; inp.mz = src.mz / 127; inp.blk = !!src.blk;
      for (let k = 0; k < ACTS.length; k++) if (src.press & PRESS[ACTS[k]]) inp[ACTS[k]] = BUF;
      for (const a of ACTS) inp[a] = Math.max(0, inp[a] - dt);
    });

    const canAct = ph === 'fight';
    this.updateFighter(0, canAct);
    this.updateFighter(1, canAct);

    // les combattants ne se traversent pas au sol
    if (f[0].state !== 'dead' && f[1].state !== 'dead' && Math.abs(f[0].y - f[1].y) < 1.0) {
      const dx = f[1].x - f[0].x, dz = f[1].z - f[0].z, d = hypot(dx, dz), ov = 0.9 - d;
      if (ov > 0) {
        const nx = d > 0.001 ? dx / d : fx(f[0]), nz = d > 0.001 ? dz / d : fz(f[0]);
        f[0].x -= nx * ov / 2; f[0].z -= nz * ov / 2;
        f[1].x += nx * ov / 2; f[1].z += nz * ov / 2;
      }
    }

    this.updateArrows();
    if (ph === 'fight') {
      this.resolve(f[0], f[1]);
      this.resolve(f[1], f[0]);
      g.timer -= dt;
      if (g.phase === 'fight' && g.timer <= 0) {
        g.timer = 0;
        const [h0, h1] = [f[0].hp, f[1].hp];
        this.endRound(h0 === h1 ? -1 : (h0 > h1 ? 0 : 1), h0 === h1 ? 'ÉGALITÉ' : 'TEMPS !');
      }
    } else if (ph === 'intro') {
      if (g.t > 1.25 && !g.flagGo) { g.flagGo = true; this.emit('announce', 'COMBATTEZ !', '', 0.9); this.emit('cheer', 0.9); this.emit('sfx', 'cheer', 0.8); }
      if (g.t > 1.55) g.phase = 'fight';
    } else if (ph === 'ko') {
      if (g.t > 1.4 && !g.flagPose) {
        g.flagPose = true;
        const w = g.roundWinner;
        if (w >= 0 && f[w].state !== 'dead') this.win(f[w]);
        if (w < 0) for (const o of f) if (o.state !== 'dead') this.toIdle(o);
      }
      if (g.t > 3.4 && !g.flagFade) g.flagFade = true;
      if (g.t > 3.75) {
        if (g.w0 >= 2 || g.w1 >= 2 || g.round >= 3) { g.phase = 'end'; g.flagFade = false; this.emit('end'); }
        else { g.round++; this.startRound(); }
      }
    }
  }

  // ---------------- combattants ----------------
  play(f, name, o = {}) {
    f.animN++; f.anim = name; f.animTs = o.ts ?? 1; f.animLoop = o.loop !== false;
    f.animRestart = !!o.restart; f.animFade = o.fade ?? 0.12;
  }
  setState(f, s, dur = 0) { f.state = s; f.stateT = 0; f.dur = dur; }
  toIdle(f) { this.setState(f, 'idle'); this.play(f, 'idle', { fade: 0.15 }); }
  startAttack(f, chain = false) {
    f.combo = chain ? f.combo + 1 : 1;
    this.setState(f, 'attack');
    f.hitDone = false;
    this.play(f, f.combo === 2 ? 'attack-melee-left' : 'attack-melee-right', { loop: false, restart: true, fade: 0.05 });
    this.emit('sfx', 'swing');
  }
  // archer : bander l'arc (la flèche part à SHOT.rel, voir 'shoot')
  startShot(f) {
    this.setState(f, 'shoot');
    f.hitDone = false;
    if (wpnOf(f).summon) { this.play(f, 'holding-left-shoot', { loop: false, restart: true, ts: 0.9, fade: 0.05 }); this.emit('sfx', 'spell'); }
    else if (wpnOf(f).fire) this.play(f, 'holding-right-shoot', { loop: false, restart: true, ts: 1.1, fade: 0.05 });
    else this.play(f, 'holding-both-shoot', { loop: false, restart: true, ts: 1.4, fade: 0.05 });
  }
  // projectile : flèche (k = 0) ou boule de feu (k = 1, sceptre)
  fire(f, opp) {
    const k = wpnOf(f).fire ? 1 : 0, speed = k ? FIRE.speed : SHOT.speed;
    const sx = fx(f), sz = fz(f), y0 = f.y + 1.05;
    const x0 = f.x + sx * 0.5, z0 = f.z + sz * 0.5;
    // visée verticale vers la poitrine de la cible (estrades, sauts)
    let vy = 0;
    if (opp) {
      const d = hypot(opp.x - x0, opp.z - z0);
      if (d > 0.3) vy = Math.max(-8, Math.min(8, (opp.y + 0.95 - y0) / (d / speed)));
    }
    this.pr.push({ x: x0, y: y0, z: z0, vx: sx * speed, vy, vz: sz * speed, o: f.idx, t: 0, k });
    this.emit('sfx', k ? 'fireball' : 'bow');
  }
  // explosion de la boule de feu a : blesse tous les adversaires du lanceur dans le rayon
  explode(a) {
    const att = this.f[a.o], R = FIRE.radius;
    this.emit('emit', a.x, a.y, a.z, 34, { color: [0xffe27a, 0xff9a2e, 0xff4a1c, 0x5a3020], speed: 4.5, up: 3.5, size: 0.11, life: 0.6, grav: 3 });
    this.emit('ring', a.x, Math.max(0.05, a.y - 0.6), a.z, 0xff8a2e, R * 1.15, 0.4, true);
    this.emit('ring', a.x, a.y, a.z, 0xffe27a, 1.4, 0.25);
    this.emit('sfx', 'boom');
    this.emit('shake', 0.16);
    if (this.g.phase !== 'fight' || !att) return;
    for (const d of this.f) {
      if (d.state === 'dead' || !this.foeOf(a.o, d)) continue;
      const dx = d.x - a.x, dz = d.z - a.z, dist = hypot(dx, dz), sz = d.size ?? 1;
      if (dist > R + 0.3 * (sz - 1) || Math.abs(d.y + 0.8 - a.y) > 1.5) continue;
      if (d.state === 'roll' && d.stateT > ROLL.inv0 && d.stateT < ROLL.inv1) continue;   // roulade : on passe à travers
      // bloquer face à l'explosion : la garde encaisse
      if (d.state === 'block' && (dist < 0.05 || (fx(d) * dx + fz(d) * dz) / dist < -0.2)) {
        d.guard -= FIRE.guard * guardOf(d); d.guardT = 0;
        this.emit('fx', d.idx, 'blocked');
        this.emit('sfx', 'clang');
        if (d.guard <= 0) this.guardBreak(att, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.damage(att, d, FIRE.dmg, FIRE.knock, 0.3, d.x, d.y + 1, d.z);
      if (d.state !== 'dead' && dist > 0.05) { d.vx = dx / dist * FIRE.knock; d.vz = dz / dist * FIRE.knock; }   // soufflé loin du centre
    }
  }
  // déplace les flèches ; elles ne blessent que pendant le combat
  updateArrows() {
    const dt = this.dt, fight = this.g.phase === 'fight';
    for (let k = this.pr.length - 1; k >= 0; k--) {
      const a = this.pr[k];
      a.t += dt; a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt;
      const fb = a.k === 1;
      let gone = a.t > (fb ? FIRE.life : SHOT.life), boom = gone && fb;
      if (!gone && this.arrowWall(a)) {
        gone = true; boom = fb;
        if (!fb) {
          this.emit('emit', a.x, a.y, a.z, 5, { color: [0xc8a070, 0x8a5a2b], speed: 1.2, up: 1.2, size: 0.05, life: 0.4, grav: 6 });
          this.emit('sfx', 'thunk');
        }
      }
      if (!gone && fight) for (const d of this.f) {
        if (d.state === 'dead' || !this.foeOf(a.o, d)) continue;
        const sz = d.size ?? 1;
        if (hypot(d.x - a.x, d.z - a.z) > (fb ? FIRE.touch : 0.4) * sz || a.y < d.y + 0.15 || a.y > d.y + 1.55 * sz) continue;
        if (this.arrowHit(a, d)) { gone = true; boom = fb; break; }
      }
      if (gone) this.pr.splice(k, 1);
      if (boom) this.explode(a);
    }
  }
  // flèche a sur le combattant d ; vrai si la flèche s'arrête là
  arrowHit(a, d) {
    if (d.state === 'roll' && d.stateT > ROLL.inv0 && d.stateT < ROLL.inv1) return false;   // traverse la roulade
    const att = this.f[a.o] ?? d, g = this.g;
    const sp = hypot(a.vx, a.vz) || 1, facing = fx(d) * a.vx / sp + fz(d) * a.vz / sp < -0.2;
    if (d.state === 'parry' && d.stateT <= PAR.win && facing) {
      // parade : la flèche repart vers le tireur
      a.vx = -a.vx; a.vz = -a.vz; a.vy = -a.vy; a.o = d.idx; a.t = 0;
      this.emit('fx', d.idx, 'parried');
      this.emit('ring', a.x, a.y, a.z, 0x8fd8ff, 1.6, 0.35);
      this.emit('pop', 'RENVOI !', d.x, d.y + 2.0, d.z, 'parry');
      this.emit('sfx', 'parry');
      g.hitstop = 0.08;
      return false;
    }
    if (a.k === 1) return true;      // boule de feu : elle explose (dégâts de zone dans explode)
    if (d.state === 'block' && facing) {
      d.guard -= SHOT.guard * guardOf(d); d.guardT = 0;
      this.emit('fx', d.idx, 'blocked');
      this.emit('emit', a.x, a.y, a.z, 8, { color: [0xffe27a, 0xffffff], speed: 3, up: 2, size: 0.05, life: 0.3, grav: 10 });
      this.emit('sfx', 'clang');
      if (d.guard <= 0) this.guardBreak(att, d, a.x, a.y, a.z, 0);
      return true;
    }
    this.damage(att, d, SHOT.dmg, 1.6, 0.22, a.x, a.y, a.z);
    return true;
  }
  startBreak(f) {
    this.setState(f, 'brk');
    f.hitDone = false; f.brkSfx = false;
    this.play(f, 'attack-kick-right', { loop: false, restart: true, ts: 0.62, fade: 0.08 });
  }
  startParry(f) {
    this.setState(f, 'parry');
    this.emit('fx', f.idx, 'parryUp');
    this.play(f, 'idle', { fade: 0.05 });
  }
  doJump(f, mx, mz) {
    this.setState(f, 'air');
    f.vy = 8.2; f.vx = mx * 3.3; f.vz = mz * 3.3;
    f.airAtk = false;
    this.play(f, 'jump', { loop: false, fade: 0.06 });
    this.emit('sfx', 'jump');
    this.emit('emit', f.x, f.y + 0.05, f.z, 6, { color: [0xc8a070, 0xa88050], speed: 1.4, up: 0.8, size: 0.08, life: 0.5, grav: 3 });
  }
  spend(f, cost) {
    if (f.sta < cost) {
      if (f.staFail <= 0) this.emit('pop', 'ÉPUISÉ', f.x, f.y + 1.8, f.z, 'miss');
      f.staFail = 0.5;
      return false;
    }
    f.sta -= cost; f.staT = 0;
    return true;
  }
  startRoll(f, mx, mz) {
    let dx = mx, dz = mz;
    if (hypot(dx, dz) < 0.1) { dx = -fx(f); dz = -fz(f); }   // sans direction : roulade en arrière
    const n = hypot(dx, dz);
    f.rdx = dx / n; f.rdz = dz / n;
    this.setState(f, 'roll');
    f.airAtk = false;
    this.emit('fx', f.idx, 'noFlinch');
    this.play(f, 'crouch', { fade: 0.05 });
    this.emit('sfx', 'roll');
    this.emit('emit', f.x, f.y + 0.05, f.z, 7, { color: [0xc8a070, 0xa88050], speed: 1.6, up: 0.8, size: 0.08, life: 0.5, grav: 3 });
  }
  stun(f, d) {
    this.setState(f, 'stun', d);
    f.airAtk = false;
    this.play(f, 'emote-no', { ts: 0.55, fade: 0.08 });
  }
  die(f) {
    this.setState(f, 'dead');
    f.airAtk = false;
    this.play(f, 'die', { loop: false, fade: 0.06 });
  }
  win(f) { this.setState(f, 'win'); this.play(f, 'emote-yes', { fade: 0.2 }); }

  // ---------------- sorts actifs par personnage ----------------
  startSpell(f, opp, mx, mz) {
    if (!this.canCastSpell(f) || f.spellCd > 0) return false;
    const S = spellOf(f);
    f.spellCd = S.cd;
    f.spellMax = S.cd;
    f.spellTick = 0;
    f.spellHit = 0;
    f.airAtk = false;
    f.combo = 0;
    // direction du sort : vers la cible s'il y en a une, sinon vers la direction tenue ou devant soi
    let dx = fx(f), dz = fz(f);
    if (opp && hypot(opp.x - f.x, opp.z - f.z) > 0.05) {
      const d = hypot(opp.x - f.x, opp.z - f.z);
      dx = (opp.x - f.x) / d; dz = (opp.z - f.z) / d;
      f.yaw = atan2(dx, dz);
    } else if (hypot(mx, mz) > 0.1) {
      const d = hypot(mx, mz);
      dx = mx / d; dz = mz / d;
      f.yaw = atan2(dx, dz);
    }
    f.spellDx = dx; f.spellDz = dz;
    this.setState(f, 'spell', S.dur);
    this.emit('pop', S.name.toUpperCase() + ' !', f.x, f.y + 2.15, f.z, 'spell');
    if (S.id === 'spin') {
      this.play(f, 'attack-melee-right', { loop: true, restart: true, ts: 1.9, fade: 0.05 });
      this.emit('sfx', 'whirl');
      this.emit('ring', f.x, f.y + 0.1, f.z, S.color, S.radius * 0.9, 0.35, true);
    } else if (S.id === 'dash') {
      this.play(f, 'attack-melee-right', { loop: false, restart: true, ts: 1.2, fade: 0.04 });
      this.emit('sfx', 'dash');
      this.emit('emit', f.x, f.y + 0.8, f.z, 14, { color: [0xffffff, S.color], speed: 3, up: 1.5, size: 0.07, life: 0.35, grav: 2 });
    } else if (S.id === 'slam') {
      f.vy = S.vy;
      f.y += 0.01;
      this.play(f, 'jump', { loop: false, restart: true, ts: 1.3, fade: 0.05 });
      this.emit('sfx', 'jump');
    } else if (S.id === 'volley') {
      f.vx = -dx * S.back; f.vz = -dz * S.back;
      this.play(f, 'holding-both-shoot', { loop: false, restart: true, ts: 1.5, fade: 0.05 });
      this.emit('sfx', 'dodge');
    } else if (S.id === 'aegis') {
      this.play(f, 'emote-yes', { loop: false, restart: true, ts: 1.4, fade: 0.05 });
      this.emit('sfx', 'aegis');
      this.emit('fx', f.idx, 'parried');
    } else if (S.id === 'nova') {
      this.play(f, 'crouch', { loop: false, restart: true, ts: 1.2, fade: 0.05 });
      this.emit('sfx', 'nova');
    } else if (S.id === 'overload') {
      this.play(f, 'emote-yes', { loop: false, restart: true, ts: 1.1, fade: 0.05 });
      this.emit('sfx', 'spell');
    }
    return true;
  }

  // exécution à chaque image pendant l'état 'spell'
  updateSpell(f, opp, mx, mz, dt) {
    const S = spellOf(f), t = f.stateT;
    if (S.id === 'spin') {
      const spd = 2.4 * (f.runMul ?? 1);
      f.vx = mx * spd; f.vz = mz * spd;
      // 3 vagues de dégâts circulaires (à 0,10 s, 0,34 s, 0,58 s)
      const nextAt = 0.10 + f.spellTick * 0.24;
      if (f.spellTick < S.hits && t >= nextAt) {
        f.spellTick++;
        this.emit('ring', f.x, f.y + 0.75, f.z, S.color, S.radius, 0.24, true);
        this.emit('emit', f.x, f.y + 0.85, f.z, 12, { color: [0xffffff, S.color, 0xff9a2e], speed: 4.2, up: 1.2, size: 0.07, life: 0.3, grav: 3 });
        this.emit('sfx', 'swing');
        this.spellAoE(f, S.radius, S.dmg, S.knock, S.guard, { dur: 0.22 });
      }
    } else if (S.id === 'dash') {
      if (t < S.dashDur) {
        f.vx = f.spellDx * S.speed; f.vz = f.spellDz * S.speed;
        f.dustT -= dt;
        if (f.dustT <= 0) {
          f.dustT = 0.04;
          this.emit('emit', f.x, f.y + 0.65, f.z, 3, { color: [0xffffff, S.color], speed: 1.2, up: 0.8, size: 0.07, life: 0.3, grav: 1 });
        }
        this.spellDashHits(f, S);
      } else {
        const k = exp(-dt * 14); f.vx *= k; f.vz *= k;
      }
    } else if (S.id === 'slam') {
      const k = exp(-dt * 8); f.vx *= k; f.vz *= k;
      const gy = this.groundY(f);
      if (!f.spellTick && (t >= S.hitAt || (t > 0.12 && f.y <= gy + 0.04 && f.vy <= 0))) {
        f.spellTick = 1;
        f.y = gy; f.vy = 0;
        this.emit('ring', f.x, gy + 0.06, f.z, S.color, S.radius * 1.05, 0.45, true);
        this.emit('ring', f.x, gy + 0.1, f.z, 0xffffff, S.radius * 0.55, 0.28, true);
        this.emit('emit', f.x, gy + 0.15, f.z, 34, { color: [0xc8a070, 0xffe27a, S.color], speed: 4.8, up: 3.2, size: 0.1, life: 0.65, grav: 7 });
        this.emit('sfx', 'quake');
        this.emit('shake', 0.35);
        this.spellAoE(f, S.radius, S.dmg, S.knock, S.guard, { stun: S.stun, jumpEvade: true });
      }
    } else if (S.id === 'volley') {
      const k = exp(-dt * 7); f.vx *= k; f.vz *= k;
      if (!f.spellTick && t >= S.hitAt) {
        f.spellTick = 1;
        const half = (S.arrows - 1) / 2;
        const y0 = f.y + 1.05;
        let vy = 0;
        if (opp) {
          const d = hypot(opp.x - f.x, opp.z - f.z);
          if (d > 0.3) vy = Math.max(-8, Math.min(8, (opp.y + 0.95 - y0) / (d / SHOT.speed)));
        }
        for (let n = 0; n < S.arrows; n++) {
          const ang = f.yaw + (n - half) * S.spread;
          const sx = sin(ang), sz = cos(ang);
          this.pr.push({ x: f.x + sx * 0.5, y: y0, z: f.z + sz * 0.5, vx: sx * SHOT.speed, vy, vz: sz * SHOT.speed, o: f.idx, t: 0, k: 0 });
        }
        this.emit('sfx', 'bow');
        this.emit('emit', f.x + fx(f) * 0.6, y0, f.z + fz(f) * 0.6, 12, { color: [0xffffff, S.color], speed: 2.5, up: 1.5, size: 0.06, life: 0.3, grav: 2 });
      }
    } else if (S.id === 'aegis') {
      const k = exp(-dt * 12); f.vx *= k; f.vz *= k;
      if (!f.spellTick && t >= S.hitAt) {
        f.spellTick = 1;
        f.guard = 100;
        f.guardT = 9;
        f.spellBuffT = S.buff;
        this.emit('ring', f.x, f.y + 0.12, f.z, S.color, S.radius * 1.05, 0.45, true);
        this.emit('ring', f.x, f.y + 0.9, f.z, 0xffffff, 1.5, 0.3);
        this.emit('emit', f.x, f.y + 0.9, f.z, 24, { color: [0xffffff, S.color, 0xffb02e], speed: 4.5, up: 2.2, size: 0.08, life: 0.55, grav: 2 });
        this.emit('shake', 0.2);
        this.spellAoE(f, S.radius, S.dmg, S.knock, S.guard, { dur: 0.35 });
      }
    } else if (S.id === 'nova') {
      const k = exp(-dt * 10); f.vx *= k; f.vz *= k;
      if (!f.spellTick && t >= S.hitAt) {
        f.spellTick = 1;
        this.emit('ring', f.x, f.y + 0.1, f.z, S.color, S.radius * 1.05, 0.5, true);
        this.emit('emit', f.x, f.y + 0.6, f.z, 34, { color: [S.color, 0x3a9a2a, 0xd8ffc0], speed: 4.2, up: 2.6, size: 0.1, life: 0.7, grav: 1 });
        this.emit('sfx', 'boom');
        this.emit('shake', 0.22);
        const hits = this.spellAoE(f, S.radius, S.dmg, S.knock, S.guard, { dur: 0.3 });
        if (hits > 0 && f.state !== 'dead') {
          const cap = f.maxHp ?? 100;
          const gain = Math.min(cap - f.hp, hits * S.heal);
          if (gain > 0) {
            f.hp += gain;
            this.emit('pop', `+${Math.round(gain)} PV`, f.x, f.y + 1.9, f.z, 'heal');
            this.emit('emit', f.x, f.y + 0.8, f.z, 12, { color: [0x8fe36a, 0xffffff], speed: 1.6, up: 3, size: 0.07, life: 0.55, grav: -1 });
          }
        }
      }
    } else if (S.id === 'overload') {
      const k = exp(-dt * 12); f.vx *= k; f.vz *= k;
      if (!f.spellTick && t >= S.hitAt) {
        f.spellTick = 1;
        this.emit('ring', f.x, f.y + 0.1, f.z, S.color, S.radius * 1.05, 0.45, true);
        this.emit('ring', f.x, f.y + 0.9, f.z, 0xffffff, S.radius * 0.7, 0.25, true);
        this.emit('emit', f.x, f.y + 0.9, f.z, 32, { color: [0xffffff, S.color, 0x3a8aff], speed: 5.5, up: 2.4, size: 0.09, life: 0.5, grav: 2 });
        this.emit('sfx', 'zap');
        this.emit('shake', 0.28);
        this.spellAoE(f, S.radius, S.dmg, S.knock, 0, { stun: S.stun, breakGuard: true });
      }
    }
    if (t >= S.dur) this.toIdle(f);
  }

  // coup de zone radial d'un sort : retourne le nombre de cibles touchées (non bloquées)
  spellAoE(att, radius, dmg, knock, guardCost, opts = {}) {
    if (this.g.phase !== 'fight') return 0;
    let hits = 0;
    for (const d of this.f) {
      if (d === att || d.state === 'dead' || !this.foeOf(att.idx, d)) continue;
      const dx = d.x - att.x, dz = d.z - att.z, dist = hypot(dx, dz), sz = d.size ?? 1;
      if (dist > radius + 0.35 * (sz - 1) || Math.abs(d.y - att.y) > 1.35) continue;
      if (d.state === 'roll' && d.stateT > ROLL.inv0 && d.stateT < ROLL.inv1) continue;
      if (opts.jumpEvade && d.y - this.groundY(d) > 0.35) {
        this.emit('pop', 'ESQUIVE', d.x, d.y + 1.8, d.z, 'miss');
        this.emit('sfx', 'dodge');
        continue;
      }
      const nx = dist > 0.05 ? dx / dist : fx(att), nz = dist > 0.05 ? dz / dist : fz(att);
      if (opts.breakGuard && (d.state === 'block' || d.state === 'parry')) {
        this.guardBreak(att, d, d.x, d.y + 1, d.z, Math.round(dmg * 0.5));
        hits++;
        continue;
      }
      if (guardCost > 0 && d.state === 'block') {
        d.guard -= guardCost * guardOf(d); d.guardT = 0;
        d.vx = nx * 2.5; d.vz = nz * 2.5;
        this.emit('fx', d.idx, 'blocked');
        this.emit('sfx', 'clang');
        if (d.guard <= 0) this.guardBreak(att, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.damage(att, d, dmg, 0, opts.dur ?? 0.35, d.x, d.y + 0.9, d.z);
      hits++;
      if (d.state !== 'dead') {
        const kMul = d.boss ? 0.4 : 1;
        d.vx = nx * knock * kMul; d.vz = nz * knock * kMul;
        if (opts.stun && !d.sp) this.stun(d, d.boss ? opts.stun * 0.5 : opts.stun);
      }
    }
    return hits;
  }

  // percée du Mirmillon : touche chaque ennemi traversé une seule fois (masque de bits spellHit)
  spellDashHits(att, S) {
    if (this.g.phase !== 'fight') return;
    for (const d of this.f) {
      if (d === att || d.state === 'dead' || !this.foeOf(att.idx, d)) continue;
      const bit = 1 << (d.idx & 31);
      if (att.spellHit & bit) continue;
      const dx = d.x - att.x, dz = d.z - att.z, dist = hypot(dx, dz), sz = d.size ?? 1;
      if (dist > S.radius + 0.4 * (sz - 1) || Math.abs(d.y - att.y) > 1.2) continue;
      if (d.state === 'roll' && d.stateT > ROLL.inv0 && d.stateT < ROLL.inv1) continue;
      att.spellHit |= bit;
      if (d.state === 'block' && fx(d) * att.spellDx + fz(d) * att.spellDz < -0.2) {
        d.guard -= S.guard * guardOf(d); d.guardT = 0;
        d.vx = att.spellDx * 3.5; d.vz = att.spellDz * 3.5;
        this.emit('fx', d.idx, 'blocked');
        this.emit('sfx', 'clang');
        if (d.guard <= 0) this.guardBreak(att, d, d.x, d.y + 1, d.z, 0);
        continue;
      }
      this.damage(att, d, S.dmg, 0, 0.38, d.x, d.y + 0.9, d.z);
      if (d.state !== 'dead') {
        const kMul = d.boss ? 0.4 : 1;
        d.vx = att.spellDx * S.knock * kMul; d.vz = att.spellDz * S.knock * kMul;
      }
    }
  }

  updateFighter(i, canAct) {
    const f = this.f[i], opp = this.target(i), inp = this.inp[i], dt = this.dt;
    f.stateT += dt;
    const st = f.state;
    const mx = canAct ? inp.mx : 0, mz = canAct ? inp.mz : 0;
    const moving = hypot(mx, mz) > 0.1;
    const gy = this.groundY(f), grounded = f.y <= gy;
    // sans adversaire à portée, on se tourne dans le sens de la marche
    const toOpp = opp ? atan2(opp.x - f.x, opp.z - f.z) : (moving ? atan2(mx, mz) : f.yaw);
    const dOpp = opp ? hypot(opp.x - f.x, opp.z - f.z) : (moving ? 1 : 0);
    const ffx = fx(f), ffz = fz(f);
    // verrouillage : on fait toujours face à l'adversaire, sauf pendant un coup déjà lancé
    // (coup préparé : il vise pendant la préparation, puis sa direction se fige 0,25 s avant de se lancer)
    const track = (st === 'idle' || st === 'walk' || st === 'block' || st === 'air' || st === 'parry' || (st === 'attack' && f.stateT < ATK.track + Math.max(0, windupOf(f) - 0.25)) || (st === 'shoot' && f.stateT < shotOf(f).rel));
    if (track && dOpp > 0.05) f.yaw = lerpAng(f.yaw, toOpp, Math.min(1, dt * 20));
    let visYaw = f.yaw;

    switch (st) {
      case 'idle': case 'walk': case 'block': {
        if (!canAct) { f.vx = f.vz = 0; if (st !== 'idle') this.toIdle(f); break; }
        if (this.take(i, 'spell') && this.startSpell(f, opp, mx, mz)) break;
        if (this.take(i, 'roll') && this.spend(f, STA.roll)) { this.startRoll(f, mx, mz); break; }
        if (this.take(i, 'brk') && this.spend(f, STA.brk)) { this.startBreak(f); break; }
        // archer : tir, ou coup d'arc si l'adversaire est collé
        // grimoire : invocation (si on peut encore invoquer), sinon coup de livre
        if (wpnOf(f).summon && this.canSummon(f) && this.inp[i].atk > 0 && f.sta >= STA.summon) { this.take(i, 'atk'); this.spend(f, STA.summon); this.startShot(f); break; }
        if (this.take(i, 'atk') && this.spend(f, STA.atk)) { if (f.arch && !(opp && dOpp < SHOT.melee)) this.startShot(f); else this.startAttack(f); break; }
        if (this.take(i, 'par') && this.spend(f, STA.par)) { this.startParry(f); break; }
        if (this.take(i, 'jump') && this.spend(f, STA.jump)) { this.doJump(f, mx, mz); break; }
        if (inp.blk) {
          if (st !== 'block') { this.setState(f, 'block'); this.play(f, 'idle', { ts: 0.5 }); }
          f.vx = mx * 1.1; f.vz = mz * 1.1;
          break;
        }
        const spd = (f.sta < STA.tired ? 2.5 : 3.4) * wpnOf(f).run * (f.runMul ?? 1);   // l'archer est plus léger, le pavois plus lourd
        f.vx = mx * spd; f.vz = mz * spd;
        if (moving) {
          if (st !== 'walk') this.setState(f, 'walk');
          const fwd = mx * ffx + mz * ffz;
          const back = fwd < -0.35;
          this.play(f, 'walk', { ts: back ? -1.05 : 1.25 });
          // le corps s'oriente un peu dans le sens du pas de côté
          const k = back ? -0.35 : 0.35;
          visYaw = atan2(ffx + mx * k, ffz + mz * k);
          f.dustT -= dt;
          if (f.dustT < 0) { f.dustT = 0.22; this.emit('emit', f.x, f.y + 0.05, f.z, 1, { color: 0xc8a070, speed: 0.6, up: 0.6, size: 0.07, life: 0.45, grav: 2 }); }
        } else if (st !== 'idle') this.toIdle(f);
        break;
      }
      case 'attack': {
        // coup préparé (windup, Cerbère) : tout le coup est décalé d'autant, et il se lance plus loin
        const W = windupOf(f), t = f.stateT - W, run = wpnOf(f).lunge ?? 2.6;
        if (W > 0 && t >= 0.06 && t - dt < 0.06) this.emit('sfx', 'bark');
        if (t > 0.06 && t < 0.2) { f.vx = ffx * run; f.vz = ffz * run; }
        else { const k = exp(-dt * 12); f.vx *= k; f.vz *= k; }
        if (canAct && t > ATK.chain && f.combo < wpnOf(f).combo && this.take(i, 'atk') && this.spend(f, STA.atk)) { f.yaw = toOpp; this.startAttack(f, true); break; }
        if (canAct && t > ATK.end && this.take(i, 'spell') && this.startSpell(f, opp, mx, mz)) break;
        if (canAct && t > ATK.end && this.take(i, 'roll') && this.spend(f, STA.roll)) { this.startRoll(f, mx, mz); break; }
        if (t >= ATK.dur) { f.combo = 0; this.toIdle(f); }
        break;
      }
      case 'spell': {
        this.updateSpell(f, opp, mx, mz, dt);
        break;
      }
      case 'shoot': {
        const t = f.stateT, k = exp(-dt * 12);
        f.vx *= k; f.vz *= k;
        const S = shotOf(f);
        if (!f.hitDone && t >= S.rel) { f.hitDone = true; if (wpnOf(f).summon) this.summon(f); else this.fire(f, opp); }
        if (canAct && t > S.chain && !wpnOf(f).summon && this.take(i, 'atk') && this.spend(f, STA.atk)) { this.startShot(f); break; }
        if (canAct && t > S.rel && this.take(i, 'roll') && this.spend(f, STA.roll)) { this.startRoll(f, mx, mz); break; }
        if (t >= S.dur) this.toIdle(f);
        break;
      }
      case 'brk': {
        const t = f.stateT;
        if (t > 0.26 && t < 0.42) { f.vx = ffx * 3.2; f.vz = ffz * 3.2; }
        else { const k = exp(-dt * 12); f.vx *= k; f.vz *= k; }
        if (!f.brkSfx && t > 0.26) { f.brkSfx = true; this.emit('sfx', 'heavy'); }
        if (t >= BRK.dur) this.toIdle(f);
        break;
      }
      case 'parry': {
        const k = exp(-dt * 12); f.vx *= k; f.vz *= k;
        if (f.stateT >= PAR.dur) this.toIdle(f);
        break;
      }
      case 'hit': {
        const k = exp(-dt * 7); f.vx *= k; f.vz *= k;
        // on peut se sortir d'un enchaînement par une roulade
        if (canAct && grounded && f.stateT > 0.1 && this.take(i, 'roll') && this.spend(f, STA.roll)) { this.startRoll(f, mx, mz); break; }
        if (f.stateT >= f.dur && grounded) this.toIdle(f);
        break;
      }
      case 'roll': {
        const t = f.stateT, sp = ROLL.speed * (1 - 0.75 * t / ROLL.dur);
        f.vx = f.rdx * sp; f.vz = f.rdz * sp;
        f.dustT -= dt;
        if (f.dustT < 0) { f.dustT = 0.06; this.emit('emit', f.x, f.y + 0.05, f.z, 1, { color: 0xc8a070, speed: 0.5, up: 0.5, size: 0.08, life: 0.4, grav: 2 }); }
        if (t >= ROLL.dur) this.toIdle(f);
        break;
      }
      case 'stun': {
        const k = exp(-dt * 7); f.vx *= k; f.vz *= k;
        if (f.stateT >= f.dur && grounded) this.toIdle(f);
        break;
      }
      case 'air':
        if (canAct) {
          const k = Math.min(1, dt * 3);
          f.vx += (mx * 3.3 - f.vx) * k;
          f.vz += (mz * 3.3 - f.vz) * k;
          if (!f.airAtk && f.arch && this.take(i, 'atk') && this.spend(f, STA.atk)) {
            // tir en plein saut (airAtkT hors de la fenêtre de coup : pas de coup au corps à corps)
            f.airAtk = true; f.airAtkT = 9;
            if (opp) f.yaw = toOpp;
            this.play(f, wpnOf(f).fire ? 'holding-right-shoot' : 'holding-both-shoot', { loop: false, restart: true, ts: 1.6, fade: 0.04 });
            this.fire(f, opp);
          } else if (!f.airAtk && this.take(i, 'atk') && this.spend(f, STA.atk)) {
            f.airAtk = true; f.airAtkT = 0; f.hitDone = false;
            this.play(f, 'attack-melee-right', { loop: false, restart: true, fade: 0.04 });
            this.emit('sfx', 'swing');
          }
        }
        if (f.airAtk) f.airAtkT += dt;
        else if (f.vy < 0 && f.anim !== 'fall') this.play(f, 'fall', { fade: 0.15 });
        break;
      case 'dead': {
        const k = exp(-dt * 5); f.vx *= k; f.vz *= k;
        break;
      }
    }
    f.visTarget = visYaw;

    if (f.state === 'air' || f.y > gy) {
      f.vy -= 24 * dt;
      f.y += f.vy * dt;
      if (f.y <= gy) {
        f.y = gy; f.vy = 0;
        this.emit('emit', f.x, gy + 0.05, f.z, 8, { color: [0xc8a070, 0xa88050], speed: 1.8, up: 0.7, size: 0.08, life: 0.5, grav: 3 });
        if (f.state === 'air') { f.airAtk = false; this.emit('sfx', 'land'); this.toIdle(f); }
      }
    }
    f.x += f.vx * dt;
    f.z += f.vz * dt;
    this.bound(f);
    this.settle(f);

    f.guardT += dt;
    if (f.state !== 'block' && f.guardT > 0.9) f.guard = Math.min(100, f.guard + 24 * dt);
    f.staT += dt;
    f.staFail = Math.max(0, f.staFail - dt);
    if (f.spellCd > 0) f.spellCd = Math.max(0, f.spellCd - dt);
    if (f.spellBuffT > 0) f.spellBuffT = Math.max(0, f.spellBuffT - dt);
    if (f.staT > STA.delay && f.state !== 'roll') f.sta = Math.min(100, f.sta + STA.regen * dt * (f.state === 'block' ? 0.5 : 1));
  }

  // ---------------- résolution des coups ----------------
  resolve(att, def) {
    if (def.state === 'dead' || att.hitDone) return;
    if (def.state === 'roll' && def.stateT > ROLL.inv0 && def.stateT < ROLL.inv1) return;  // invincible pendant la roulade
    let kind = null;
    const t = att.stateT;
    if (att.state === 'attack' && t - windupOf(att) >= ATK.start && t - windupOf(att) <= ATK.end) kind = 'light';
    else if (att.state === 'brk' && t >= BRK.start && t <= BRK.end) kind = 'brk';
    else if (att.state === 'air' && att.airAtk && att.airAtkT >= 0.08 && att.airAtkT <= 0.32) kind = 'air';
    if (!kind) return;
    const afx = fx(att), afz = fz(att);
    const dx = def.x - att.x, dz = def.z - att.z, dy = def.y - att.y;
    const along = dx * afx + dz * afz, lateral = Math.abs(dx * afz - dz * afx);
    // une grande cible (boss) a un corps plus large : la portée compte depuis sa surface, pas son centre
    // (deux corps restent à 0,45 x (somme des tailles) l'un de l'autre, voir DungeonSim)
    const big = 0.45 * Math.max(0, (def.size ?? 1) - 1), hitW = HIT_W + big;
    if (along < -0.25 || along > (kind === 'brk' ? 1.3 : kind === 'light' ? wpnOf(att).reach : 1.45) + big) return;
    if (kind === 'air' ? (dy > 0.6 || dy < -1.7) : Math.abs(dy) > 0.9) return;
    const reach = Math.min(Math.max(along - big, 0.3), 0.75);
    const cx = att.x + afx * reach, cy = Math.max(att.y, def.y) + 0.85, cz = att.z + afz * reach;
    if (lateral > hitW) {
      // le coup passe à côté : esquive par un pas de côté (seulement si on était à portée)
      if (along > 0.2 && lateral < hitW + 0.8) { att.hitDone = true; this.emit('pop', 'ESQUIVE', def.x, def.y + 1.8, def.z, 'miss'); this.emit('sfx', 'dodge'); }
      return;
    }
    att.hitDone = true;
    const facingOk = fx(def) * afx + fz(def) * afz < -0.2;

    if (kind === 'brk') {
      if (def.y - this.groundY(def) > 0.35) { this.emit('pop', 'ESQUIVE', def.x, def.y + 1.8, def.z, 'miss'); this.emit('sfx', 'dodge'); return; }
      if (def.state === 'block' || def.state === 'parry') { this.guardBreak(att, def, cx, cy, cz, 6); return; }
      this.damage(att, def, 14, 5.5, 0.45, cx, cy, cz);
      return;
    }
    if (def.state === 'parry' && def.stateT <= PAR.win && facingOk) { this.parried(att, def, cx, cy, cz); return; }
    if (def.state === 'block' && facingOk) { this.blocked(att, def, kind === 'air' ? 34 : 22, cx, cy, cz); return; }
    this.damage(att, def, kind === 'air' && !att.arch ? 11 : wpnOf(att).dmg, 3.2, 0.3, cx, cy, cz);
  }

  push(f, dirF, speed) { f.vx = fx(dirF) * speed; f.vz = fz(dirF) * speed; }

  damage(att, def, dmg, knock, dur, cx, cy, cz) {
    const g = this.g;
    if (def.state === 'stun') dmg = Math.round(dmg * 1.25);
    dmg = this.mitigateSpell(def, dmg);
    def.hp = Math.max(0, def.hp - dmg);
    this.emit('fx', def.idx, 'hit');
    this.push(def, att, knock);
    def.airAtk = false;
    this.emit('emit', cx, cy, cz, 16, { color: [0xffffff, 0xffe27a, 0xff6a4a], speed: 4, up: 3, size: 0.09, life: 0.45, dir: { x: fx(att), z: fz(att) }, grav: 9 });
    this.emit('ring', cx, cy, cz, 0xffffff, 0.9, 0.18);
    this.emit('pop', `-${dmg}`, def.x, def.y + 1.75, def.z, 'dmg');
    this.emit('sfx', 'hit');
    this.emit('shake', 0.12);
    this.emit('cheer', 0.35 + dmg / 30);
    if (def.hp <= 0) {
      this.die(def);
      this.push(def, att, 5);
      g.hitstop = 0.22;
      this.onKO(att, def);
      return;
    }
    g.hitstop = 0.07;
    if (def.state === 'stun') def.dur = Math.max(def.dur, def.stateT + 0.35);
    else { this.setState(def, 'hit', dur); this.play(def, 'idle', { fade: 0.05 }); }
  }

  blocked(att, def, cost, cx, cy, cz) {
    const g = this.g;
    cost *= guardOf(def) * (wpnOf(att).crush ?? 1);     // on pare moins bien avec un arc qu'avec un bouclier, mieux avec un pavois
    def.guard -= cost; def.guardT = 0;
    this.push(def, att, 2.4); this.push(att, att, -1.4);
    this.emit('fx', def.idx, 'blocked');
    this.emit('emit', cx, cy, cz, 12, { color: [0xffe27a, 0xffffff, 0xffb02e], speed: 5, up: 2.5, size: 0.06, life: 0.35, dir: { x: -fx(att), z: -fz(att) }, grav: 12 });
    this.emit('sfx', 'clang');
    g.hitstop = 0.05;
    this.emit('shake', 0.06);
    if (def.guard <= 0) this.guardBreak(att, def, cx, cy, cz, 0);
    else this.emit('cheer', 0.15);
  }

  guardBreak(att, def, cx, cy, cz, dmg) {
    const g = this.g;
    def.guard = 0; def.guardT = 0;
    def.hp = Math.max(0, def.hp - dmg);
    this.push(def, att, 4);
    this.emit('fx', def.idx, 'gbreak');
    this.emit('emit', cx, cy, cz, 22, { color: [0x6fc3ff, 0xffffff, 0xffb04a], speed: 5, up: 3.5, size: 0.1, life: 0.7, dir: { x: fx(att), z: fz(att) }, grav: 10 });
    this.emit('ring', cx, cy, cz, 0xffb04a, 2, 0.4);
    this.emit('pop', 'GARDE BRISÉE !', def.x, def.y + 2.0, def.z, 'brk');
    this.emit('sfx', 'brk');
    g.hitstop = 0.13;
    this.emit('shake', 0.25);
    this.emit('cheer', 0.8);
    if (def.hp <= 0) { this.die(def); this.onKO(att, def); return; }
    this.stun(def, 1.15);
  }

  parried(att, def, cx, cy, cz) {
    const g = this.g;
    this.stun(att, 0.95);
    this.push(att, att, -2.6);
    this.toIdle(def);
    def.guard = Math.min(100, def.guard + 20);
    this.emit('fx', def.idx, 'parried');
    this.emit('emit', cx, cy, cz, 20, { color: [0x8fd8ff, 0xffffff], speed: 4.5, up: 2.5, size: 0.08, life: 0.5, grav: 4 });
    this.emit('ring', cx, cy, cz, 0x8fd8ff, 2.4, 0.45);
    this.emit('ring', cx, cy, cz, 0xffffff, 1.2, 0.25);
    this.emit('pop', 'PARADE !', def.x, def.y + 2.0, def.z, 'parry');
    this.emit('sfx', 'parry');
    g.hitstop = 0.14;
    g.slow = 0.4; g.slowT = 0.35;
    this.emit('shake', 0.1);
    this.emit('cheer', 0.7);
  }
}

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

// Empreinte d'un état (celui de save(), ou le vivant) : FNV-1a sur les bits de chaque valeur.
export function hashState(s) {
  let h = 0x811c9dc5;
  const mix = (v) => {
    if (typeof v === 'string') { for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 16777619); return; }
    F64[0] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    h = Math.imul(h ^ U32[0], 16777619); h = Math.imul(h ^ U32[1], 16777619);
  };
  for (const o of [...s.f, s.g, ...s.inp]) for (const k in o) mix(o[k]);
  mix(s.rng);
  if (s.ai) for (const a of s.ai) if (a) for (const k in a) mix(a[k]);   // état des IA (donjon)
  if (s.pr) for (const a of s.pr) for (const k in a) mix(a[k]);            // flèches en vol
  return h >>> 0;
}
