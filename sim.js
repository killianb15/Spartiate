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
export const STA = { regen: 30, delay: 0.7, atk: 9, brk: 22, roll: 28, jump: 12, par: 10, tired: 15 };
export const HIT_W = 0.72;   // demi-largeur de la zone touchée : un pas de côté suffit pour esquiver
const BUF = 0.18;            // durée de mémorisation d'une touche pressée

// Entrée d'un joueur pour une image : déplacement quantifié (-127..127), blocage, touches pressées (bits)
export const PRESS = { atk: 1, par: 2, brk: 4, jump: 8, roll: 16 };
export const ACTS = ['atk', 'par', 'brk', 'jump', 'roll'];
export const NEUTRAL = Object.freeze({ mx: 0, mz: 0, blk: false, press: 0 });
export const quant = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));

const fx = (f) => sin(f.yaw);
const fz = (f) => cos(f.yaw);
export const canRoll = (f) => f.sta >= STA.roll;

function newFighter(idx) {
  return {
    idx, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, visTarget: 0,
    hp: 100, guard: 100, state: 'idle', stateT: 0, dur: 0, sta: 100, staT: 9, staFail: 0,
    hitDone: false, airAtk: false, airAtkT: 0, combo: 0, brkSfx: false, guardT: 9, dustT: 0, rdx: 0, rdz: 0,
    // description de l'animation demandée (la vue la lit quand animN change)
    anim: 'idle', animTs: 1, animLoop: true, animRestart: false, animFade: 0, animN: 0,
    animT: 0,    // temps d'animation écoulé depuis play() (la vue s'y recale après une correction réseau)
    resetN: 0,   // +1 à chaque remise à zéro (la vue réinitialise alors son squelette)
  };
}
const newInput = () => ({ mx: 0, mz: 0, blk: false, atk: 0, par: 0, brk: 0, jump: 0, roll: 0 });

export class Sim {
  constructor(seed = 1) {
    this.rng = new Rng(seed);
    this.f = [newFighter(0), newFighter(1)];
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

  // ---------------- sauvegarde / restauration / empreinte ----------------
  save() {
    return { f: [{ ...this.f[0] }, { ...this.f[1] }], g: { ...this.g }, inp: [{ ...this.inp[0] }, { ...this.inp[1] }], rng: this.rng.s };
  }
  load(s) {
    this.f = [{ ...s.f[0] }, { ...s.f[1] }];
    this.g = { ...s.g };
    this.inp = [{ ...s.inp[0] }, { ...s.inp[1] }];
    this.rng.s = s.rng;
  }
  // empreinte 32 bits de tout l'état de jeu (détection de désynchronisation)
  hash() { return hashState({ f: this.f, g: this.g, inp: this.inp, rng: this.rng.s }); }

  // ---------------- déroulement du match ----------------
  placeStart(gap) {
    this.reset(this.f[0], -gap, 0, Math.PI / 2);
    this.reset(this.f[1], gap, 0, -Math.PI / 2);
  }
  reset(f, x, z, yaw) {
    const n = f.resetN + 1, an = f.animN + 1;
    Object.assign(f, newFighter(f.idx), { x, z, yaw, visTarget: yaw, resetN: n, animN: an });
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
    if (name !== f.anim || o.restart) f.animT = 0;   // même règle que la vue : sinon l'animation continue
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
    this.emit('emit', f.x, 0.05, f.z, 6, { color: [0xc8a070, 0xa88050], speed: 1.4, up: 0.8, size: 0.08, life: 0.5, grav: 3 });
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
    this.emit('emit', f.x, 0.05, f.z, 7, { color: [0xc8a070, 0xa88050], speed: 1.6, up: 0.8, size: 0.08, life: 0.5, grav: 3 });
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

  updateFighter(i, canAct) {
    const f = this.f[i], opp = this.f[1 - i], inp = this.inp[i], dt = this.dt;
    f.stateT += dt;
    f.animT += dt;
    const st = f.state;
    const mx = canAct ? inp.mx : 0, mz = canAct ? inp.mz : 0;
    const moving = hypot(mx, mz) > 0.1;
    const grounded = f.y <= 0;
    const toOpp = atan2(opp.x - f.x, opp.z - f.z);
    const dOpp = hypot(opp.x - f.x, opp.z - f.z);
    const ffx = fx(f), ffz = fz(f);
    // verrouillage : on fait toujours face à l'adversaire, sauf pendant un coup déjà lancé
    const track = (st === 'idle' || st === 'walk' || st === 'block' || st === 'air' || st === 'parry' || (st === 'attack' && f.stateT < ATK.track));
    if (track && dOpp > 0.05) f.yaw = lerpAng(f.yaw, toOpp, Math.min(1, dt * 20));
    let visYaw = f.yaw;

    switch (st) {
      case 'idle': case 'walk': case 'block': {
        if (!canAct) { f.vx = f.vz = 0; if (st !== 'idle') this.toIdle(f); break; }
        if (this.take(i, 'roll') && this.spend(f, STA.roll)) { this.startRoll(f, mx, mz); break; }
        if (this.take(i, 'brk') && this.spend(f, STA.brk)) { this.startBreak(f); break; }
        if (this.take(i, 'atk') && this.spend(f, STA.atk)) { this.startAttack(f); break; }
        if (this.take(i, 'par') && this.spend(f, STA.par)) { this.startParry(f); break; }
        if (this.take(i, 'jump') && this.spend(f, STA.jump)) { this.doJump(f, mx, mz); break; }
        if (inp.blk) {
          if (st !== 'block') { this.setState(f, 'block'); this.play(f, 'idle', { ts: 0.5 }); }
          f.vx = mx * 1.1; f.vz = mz * 1.1;
          break;
        }
        const spd = f.sta < STA.tired ? 2.5 : 3.4;
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
          if (f.dustT < 0) { f.dustT = 0.22; this.emit('emit', f.x, 0.05, f.z, 1, { color: 0xc8a070, speed: 0.6, up: 0.6, size: 0.07, life: 0.45, grav: 2 }); }
        } else if (st !== 'idle') this.toIdle(f);
        break;
      }
      case 'attack': {
        const t = f.stateT;
        if (t > 0.06 && t < 0.2) { f.vx = ffx * 2.6; f.vz = ffz * 2.6; }
        else { const k = exp(-dt * 12); f.vx *= k; f.vz *= k; }
        if (canAct && t > ATK.chain && f.combo < 3 && this.take(i, 'atk') && this.spend(f, STA.atk)) { f.yaw = toOpp; this.startAttack(f, true); break; }
        if (canAct && t > ATK.end && this.take(i, 'roll') && this.spend(f, STA.roll)) { this.startRoll(f, mx, mz); break; }
        if (t >= ATK.dur) { f.combo = 0; this.toIdle(f); }
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
        if (f.dustT < 0) { f.dustT = 0.06; this.emit('emit', f.x, 0.05, f.z, 1, { color: 0xc8a070, speed: 0.5, up: 0.5, size: 0.08, life: 0.4, grav: 2 }); }
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
          if (!f.airAtk && this.take(i, 'atk') && this.spend(f, STA.atk)) {
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

    if (f.state === 'air' || f.y > 0) {
      f.vy -= 24 * dt;
      f.y += f.vy * dt;
      if (f.y <= 0) {
        f.y = 0; f.vy = 0;
        this.emit('emit', f.x, 0.05, f.z, 8, { color: [0xc8a070, 0xa88050], speed: 1.8, up: 0.7, size: 0.08, life: 0.5, grav: 3 });
        if (f.state === 'air') { f.airAtk = false; this.emit('sfx', 'land'); this.toIdle(f); }
      }
    }
    f.x += f.vx * dt;
    f.z += f.vz * dt;
    const r = hypot(f.x, f.z);
    if (r > FIGHT_R) { f.x *= FIGHT_R / r; f.z *= FIGHT_R / r; }

    f.guardT += dt;
    if (f.state !== 'block' && f.guardT > 0.9) f.guard = Math.min(100, f.guard + 24 * dt);
    f.staT += dt;
    f.staFail = Math.max(0, f.staFail - dt);
    if (f.staT > STA.delay && f.state !== 'roll') f.sta = Math.min(100, f.sta + STA.regen * dt * (f.state === 'block' ? 0.5 : 1));
  }

  // ---------------- résolution des coups ----------------
  resolve(att, def) {
    if (def.state === 'dead' || att.hitDone) return;
    if (def.state === 'roll' && def.stateT > ROLL.inv0 && def.stateT < ROLL.inv1) return;  // invincible pendant la roulade
    let kind = null;
    const t = att.stateT;
    if (att.state === 'attack' && t >= ATK.start && t <= ATK.end) kind = 'light';
    else if (att.state === 'brk' && t >= BRK.start && t <= BRK.end) kind = 'brk';
    else if (att.state === 'air' && att.airAtk && att.airAtkT >= 0.08 && att.airAtkT <= 0.32) kind = 'air';
    if (!kind) return;
    const afx = fx(att), afz = fz(att);
    const dx = def.x - att.x, dz = def.z - att.z, dy = def.y - att.y;
    const along = dx * afx + dz * afz, lateral = Math.abs(dx * afz - dz * afx);
    if (along < -0.25 || along > (kind === 'brk' ? 1.3 : 1.45)) return;
    if (kind === 'air' ? (dy > 0.6 || dy < -1.7) : Math.abs(dy) > 0.9) return;
    const reach = Math.min(Math.max(along, 0.3), 0.75);
    const cx = att.x + afx * reach, cy = Math.max(att.y, def.y) + 0.85, cz = att.z + afz * reach;
    if (lateral > HIT_W) {
      // le coup passe à côté : esquive par un pas de côté (seulement si on était à portée)
      if (along > 0.2 && lateral < HIT_W + 0.8) { att.hitDone = true; this.emit('pop', 'ESQUIVE', def.x, def.y + 1.8, def.z, 'miss'); this.emit('sfx', 'dodge'); }
      return;
    }
    att.hitDone = true;
    const facingOk = fx(def) * afx + fz(def) * afz < -0.2;

    if (kind === 'brk') {
      if (def.y > 0.35) { this.emit('pop', 'ESQUIVE', def.x, def.y + 1.8, def.z, 'miss'); this.emit('sfx', 'dodge'); return; }
      if (def.state === 'block' || def.state === 'parry') { this.guardBreak(att, def, cx, cy, cz, 6); return; }
      this.damage(att, def, 14, 5.5, 0.45, cx, cy, cz);
      return;
    }
    if (def.state === 'parry' && def.stateT <= PAR.win && facingOk) { this.parried(att, def, cx, cy, cz); return; }
    if (def.state === 'block' && facingOk) { this.blocked(att, def, kind === 'air' ? 34 : 22, cx, cy, cz); return; }
    this.damage(att, def, kind === 'air' ? 11 : 9, 3.2, 0.3, cx, cy, cz);
  }

  push(f, dirF, speed) { f.vx = fx(dirF) * speed; f.vz = fz(dirF) * speed; }

  damage(att, def, dmg, knock, dur, cx, cy, cz) {
    const g = this.g;
    if (def.state === 'stun') dmg = Math.round(dmg * 1.25);
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
      this.endRound(att.idx, 'K.O. !');
      return;
    }
    g.hitstop = 0.07;
    if (def.state === 'stun') def.dur = Math.max(def.dur, def.stateT + 0.35);
    else { this.setState(def, 'hit', dur); this.play(def, 'idle', { fade: 0.05 }); }
  }

  blocked(att, def, cost, cx, cy, cz) {
    const g = this.g;
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
    if (def.hp <= 0) { this.die(def); this.endRound(att.idx, 'K.O. !'); return; }
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
  for (const o of [s.f[0], s.f[1], s.g, s.inp[0], s.inp[1]]) for (const k in o) mix(o[k]);
  mix(s.rng);
  return h >>> 0;
}
