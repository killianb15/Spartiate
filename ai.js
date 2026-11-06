// IA de l'adversaire : lit l'état de la simulation et produit l'entrée de l'image
// ({ mx, mz, blk, press }). Elle a son propre générateur à graine (hors de l'état de la
// simulation) : un match IA contre IA est reproductible, et l'IA n'influence la
// simulation que par les entrées qu'elle produit.
import { hypot, Rng } from './dmath.js';
import { FIGHT_R, BRK, PRESS, canRoll, quant } from './sim.js';

export const AIL = [
  { react: 0.42, block: 0.28, parry: 0.05, dodge: 0.1, aggr: 0.3, brk: 0.3, roll: 0.12 },
  { react: 0.26, block: 0.42, parry: 0.16, dodge: 0.18, aggr: 0.45, brk: 0.5, roll: 0.3 },
  { react: 0.15, block: 0.48, parry: 0.3, dodge: 0.2, aggr: 0.6, brk: 0.72, roll: 0.45 },
];

export class AI {
  constructor(sim, me, lv, seed = 1) {
    this.rng = new Rng(seed); this.sim = sim; this.me = me; this.L = AIL[lv] ?? AIL[1];
    this.reset();
  }
  reset() { this.think = 0.4; this.blkT = 0; this.move = null; this.moveT = 0; this.sd = 1; }
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
    const me = this.sim.f[this.me], o = this.sim.f[1 - this.me], L = this.L;
    const out = { mx: 0, mz: 0, blk: false, press: 0 };
    this.think -= dt; this.blkT -= dt; this.moveT -= dt;
    if (this.moveT <= 0) this.move = null;
    const dx = o.x - me.x, dz = o.z - me.z, dist = hypot(dx, dz) || 0.001;
    const ux = dx / dist, uz = dz / dist;
    let mx = 0, mz = 0;
    if (this.move === 'in') { mx = ux; mz = uz; }
    else if (this.move === 'out') { mx = -ux; mz = -uz; }
    else if (this.move === 'side') { mx = -uz * this.sd; mz = ux * this.sd; }
    // près du bord : on tourne au lieu de reculer dans le mur
    const r = hypot(me.x, me.z);
    if (r > FIGHT_R - 0.8 && (mx * me.x + mz * me.z) > 0) { mx = -uz * this.sd; mz = ux * this.sd; }
    out.mx = mx; out.mz = mz;
    out.blk = this.blkT > 0;
    if (this.think <= 0) this.decide(out, me, o, L, dist, ux, uz);
    out.mx = quant(out.mx); out.mz = quant(out.mz);
    return out;
  }

  decide(out, me, o, L, dist, ux, uz) {
    this.think = L.react * this.rand(0.7, 1.3);
    const p = this.rnd();
    // prise dans un enchaînement : roulade sur le côté ou en arrière
    if (me.state === 'hit' && canRoll(me) && p < L.roll) { this.doRoll(out, ux, uz); return; }
    if (!['idle', 'walk', 'block', 'air', 'attack'].includes(me.state)) return;
    if (me.state === 'air') { if (dist < 1.6 && p < 0.6) out.press |= PRESS.atk; return; }
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
}
