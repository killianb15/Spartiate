// IA de l'adversaire : lit l'état de la simulation et produit l'entrée de l'image
// ({ mx, mz, blk, press }). Elle a son propre générateur à graine (hors de l'état de la
// simulation) : un match IA contre IA est reproductible, et l'IA n'influence la
// simulation que par les entrées qu'elle produit.
import { hypot, Rng } from './dmath.js';
import { BRK, PRESS, canRoll, quant } from './sim.js';

export const AIL = [
  { react: 0.42, block: 0.28, parry: 0.05, dodge: 0.1, aggr: 0.3, brk: 0.3, roll: 0.12 },
  { react: 0.26, block: 0.42, parry: 0.16, dodge: 0.18, aggr: 0.45, brk: 0.5, roll: 0.3 },
  { react: 0.15, block: 0.48, parry: 0.3, dodge: 0.2, aggr: 0.6, brk: 0.72, roll: 0.45 },
];

export class AI {
  constructor(sim, me, lv, seed = 1) {
    this.rng = new Rng(seed); this.sim = sim; this.me = me; this.lv = lv; this.L = AIL[lv] ?? AIL[1];
    this.reset();
  }
  // état « plat » de l'IA, pour les sauvegardes du rollback (le donjon fait tourner ses IA dans la simulation)
  save() { return { lv: this.lv, rs: this.rng.s, think: this.think, blkT: this.blkT, move: this.move, moveT: this.moveT, sd: this.sd, arrowT: this.arrowT }; }
  static restore(sim, me, o) {
    const a = new AI(sim, me, o.lv, 1);
    a.rng.s = o.rs; a.think = o.think; a.blkT = o.blkT; a.move = o.move; a.moveT = o.moveT; a.sd = o.sd; a.arrowT = o.arrowT ?? 0;
    return a;
  }
  reset() { this.think = 0.4; this.blkT = 0; this.move = null; this.moveT = 0; this.sd = 1; this.arrowT = 0; }
  rand(a, b) { return this.rng.range(a, b); }
  rnd() { return this.rng.next(); }
  doRoll(out, ux, uz) {
    this.sd = this.rnd() < 0.5 ? 1 : -1;
    const side = this.rnd() < 0.6;
    this.go(side ? 'side' : 'out', 0.2);
    out.mx = side ? -uz * this.sd : -ux; out.mz = side ? ux * this.sd : -uz;
    out.press |= PRESS.roll;
  }
  go(kind, t) { this.move = kind; this.moveT = t; if (kind === 'side' && this.rnd() < 0.5) this.sd = -this.sd; }

  // dt : durée simulée de l'image à venir (sim.effectiveDt())
  update(dt) {
    const me = this.sim.f[this.me], o = this.sim.target(this.me), L = this.L;
    const out = { mx: 0, mz: 0, blk: false, press: 0 };
    if (!o) return out;   // personne à portée
    this.think -= dt; this.blkT -= dt; this.moveT -= dt; this.arrowT -= dt;
    if (this.moveT <= 0) this.move = null;
    const dx = o.x - me.x, dz = o.z - me.z, dist = hypot(dx, dz) || 0.001;
    const ux = dx / dist, uz = dz / dist;
    let mx = 0, mz = 0;
    if (this.move === 'in') { mx = ux; mz = uz; }
    else if (this.move === 'out') { mx = -ux; mz = -uz; }
    else if (this.move === 'side') { mx = -uz * this.sd; mz = ux * this.sd; }
    // près du bord : on tourne au lieu de reculer dans le mur
    if (this.sim.nearWall(me, mx, mz)) { mx = -uz * this.sd; mz = ux * this.sd; }
    out.mx = mx; out.mz = mz;
    out.blk = this.blkT > 0;
    // adversaire en hauteur (estrade) : on saute pour le rejoindre
    if (this.sim.groundY(o) - me.y > 0.5 && dist < 2.4 && (me.state === 'idle' || me.state === 'walk') && this.rnd() < 0.06) {
      out.mx = ux; out.mz = uz; out.press |= PRESS.jump;
      out.mx = quant(out.mx); out.mz = quant(out.mz);
      return out;
    }
    // une flèche arrive : bloquer, parer, s'écarter ou rouler (une réaction par flèche environ)
    if (this.arrowT <= 0 && ['idle', 'walk', 'block'].includes(me.state)) {
      for (const a of this.sim.pr) {
        if (!this.sim.foeOf(a.o, me)) continue;
        const sp = hypot(a.vx, a.vz) || 1, rx = me.x - a.x, rz = me.z - a.z;
        const along = (rx * a.vx + rz * a.vz) / sp, lat = Math.abs(rx * a.vz - rz * a.vx) / sp;
        if (along < 0 || along > sp * 0.4 || lat > 0.7) continue;
        this.arrowT = 0.45;
        // une flèche est rapide : on ne la remarque pas toujours (selon les réflexes du niveau)
        if (this.rnd() > 0.8 - L.react * 1.2) break;
        const p = this.rnd();
        if (p < L.parry * 0.5) out.press |= PRESS.par;
        else if (p < L.parry + L.block) { this.blkT = 0.35; out.blk = true; }
        else if (p < L.parry + L.block + L.dodge * 1.5) this.go('side', 0.3);
        else if (p < L.parry + L.block + L.dodge * 1.5 + L.roll * 0.4 && canRoll(me)) {
          this.sd = this.rnd() < 0.5 ? 1 : -1;
          out.mx = -a.vz / sp * this.sd; out.mz = a.vx / sp * this.sd; out.press |= PRESS.roll;
        }
        break;
      }
    }
    // grands corps (boss) : ils ne se rapprochent pas à moins de 0,45 x (somme des tailles) ; ce contact
    // compte comme le corps à corps (1,2) pour les distances de décision (rien ne change à taille normale)
    const touch = 0.45 * ((me.size ?? 1) + (o.size ?? 1));
    if (this.think <= 0) this.decide(out, me, o, L, Math.max(0.001, dist - Math.max(0, touch - 1.2)), ux, uz);
    out.mx = quant(out.mx); out.mz = quant(out.mz);
    return out;
  }

  decide(out, me, o, L, dist, ux, uz) {
    this.think = L.react * this.rand(0.7, 1.3);
    const p = this.rnd();
    // prise dans un enchaînement : roulade sur le côté ou en arrière
    if (me.state === 'hit' && canRoll(me) && p < L.roll) { this.doRoll(out, ux, uz); return; }
    if (!['idle', 'walk', 'block', 'air', 'attack'].includes(me.state)) return;
    if (me.state === 'air') { if ((me.arch ? dist > 2 && p < 0.4 : dist < 1.6 && p < 0.6)) out.press |= PRESS.atk; return; }
    const threat = (o.state === 'attack' && o.stateT < 0.17) || (o.state === 'air' && o.airAtk && o.airAtkT < 0.15);
    if (threat && dist < 2.0) {
      if (p < L.parry) out.press |= PRESS.par;
      else if (p < L.parry + L.block) { this.blkT = 0.45; out.blk = true; }
      else if (p < L.parry + L.block + L.dodge) this.go('side', 0.35);
      else if (p < L.parry + L.block + L.dodge + 0.1) this.go('out', 0.3);
      return;
    }
    if (o.state === 'brk' && o.stateT < BRK.start && dist < 2.0) {
      if (p < L.roll * 0.5 && canRoll(me)) this.doRoll(out, ux, uz);
      else if (p < L.block * 0.6) out.press |= PRESS.jump;
      else if (p < L.block) this.go('side', 0.45);
      else if (p < L.block + 0.25 && dist < 1.4) out.press |= PRESS.atk;
      else { this.blkT = 0.4; out.blk = true; }
      return;
    }
    if (me.arch) { this.decideArcher(out, me, o, L, dist, ux, uz, p); return; }
    if ((o.state === 'stun' || o.state === 'hit') && dist < 1.8) { if (dist > 1.3) this.go('in', 0.15); out.press |= PRESS.atk; return; }
    if (o.state === 'block' && dist < 1.5 && p < L.brk) { out.press |= PRESS.brk; return; }
    if (dist > 1.45) {
      this.go(this.rnd() < 0.25 ? 'side' : 'in', this.rand(0.2, 0.5));
      if (p < 0.05) out.press |= PRESS.jump;
      return;
    }
    if (dist < 0.85 && p < 0.2) { this.go('out', this.rand(0.15, 0.3)); return; }
    if (p < L.aggr) { out.press |= this.rnd() < 0.78 ? PRESS.atk : PRESS.brk; return; }
    if (p < L.aggr + 0.15) { this.blkT = this.rand(0.3, 0.7); out.blk = true; return; }
    if (p < L.aggr + 0.3) this.go('side', this.rand(0.3, 0.6));
    else if (p < L.aggr + 0.38) this.go('out', this.rand(0.2, 0.4));
  }

  // archer : garder ses distances (4 à 7 unités) et tirer
  decideArcher(out, me, o, L, dist, ux, uz, p) {
    if (me.state === 'attack' || me.state === 'shoot') return;
    if (dist < 2.0) {
      // trop près : coup d'arc, roulade de côté pour se dégager, coup de pied ou repli
      if (dist < 1.45 && p < L.aggr) { out.press |= PRESS.atk; return; }
      if (p < L.aggr + L.roll && canRoll(me)) { this.sd = this.rnd() < 0.5 ? 1 : -1; out.mx = -ux * 0.5 - uz * this.sd; out.mz = -uz * 0.5 + ux * this.sd; out.press |= PRESS.roll; this.go('out', 0.3); }
      else if (o.state === 'block' && p < 0.8) out.press |= PRESS.brk;
      else this.go(this.rnd() < 0.5 ? 'out' : 'side', this.rand(0.3, 0.5));
      return;
    }
    if (dist < 3.6) { if (p < L.aggr + 0.1) out.press |= PRESS.atk; else this.go(this.rnd() < 0.5 ? 'out' : 'side', this.rand(0.25, 0.45)); return; }
    if (o.state === 'stun' || o.state === 'hit' || p < L.aggr + 0.15) { out.press |= PRESS.atk; return; }
    this.go(dist > 7 ? 'in' : 'side', this.rand(0.3, 0.6));
  }
}
