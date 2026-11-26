import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim, BOONS, boonOdds } from '../dungeon.js';
import { NEUTRAL, guardOf } from '../sim.js';

// Bénédictions communes, rares et légendaires (coffre de fin de salle)
const fight = (seed = 1, kinds = ['soldier']) => {
  const s = new DungeonSim(seed, kinds);
  s.start();
  while (s.g.phase !== 'fight') s.step();
  s.ev.length = 0;
  return s;
};
const foe = (s) => s.f.find((e) => e.team === 1 && e.state !== 'dead');

test('coffre : la Potion, puis deux bénédictions tirées par rareté, plus généreuses en profondeur', () => {
  const count = (room) => {
    const s = fight(1);
    const tally = [0, 0, 0];
    for (let k = 0; k < 4000; k++) {
      s.g.room = room;
      s.rollOffer();
      const o = s.offer;
      assert.equal(o[0], 'potion');
      assert.equal(new Set(o).size, 3, 'pas de doublon');
      for (const id of o.slice(1)) tally[BOONS[id].rare]++;
    }
    return tally.map((n) => n / 8000);
  };
  const a = count(1), b = count(20);
  const oa = boonOdds(1), ob = boonOdds(20);
  assert.ok(Math.abs(a[1] - oa.rare) < 0.03 && Math.abs(a[2] - oa.legend) < 0.02, `salle 1 : ${a}`);
  assert.ok(Math.abs(b[1] - ob.rare) < 0.03 && Math.abs(b[2] - ob.legend) < 0.02, `salle 20 : ${b}`);
  assert.ok(b[2] > a[2] * 2 && b[1] > a[1], 'plus de rares et de légendaires en profondeur');
  // il y a bien des bénédictions de chaque rareté
  for (const r of [0, 1, 2]) assert.ok(Object.values(BOONS).filter((x) => x.rare === r).length >= 4);
});

test('bénédictions rares : dégâts, PV, soin par coup, garde, vitesse', () => {
  const s = fight(2), p = s.f[0];
  const pow = p.pow; BOONS.lame.apply(p); assert.ok(Math.abs(p.pow - pow * 1.35) < 1e-9);
  p.hp = 50; BOONS.cuirasse.apply(p); assert.equal(p.maxHp, 140); assert.equal(p.hp, 90);
  BOONS.vampire.apply(p); assert.equal(p.leech, 4);
  const g = guardOf(p); BOONS.fer.apply(p); assert.ok(Math.abs(guardOf(p) - g * 0.6) < 1e-9);
  // Pieds de vent : on court plus loin dans le même temps
  const run = (vent) => {
    const t = fight(3), h = t.f[0];
    if (vent) BOONS.vent.apply(h);
    Object.assign(h, { x: 0, z: 0 });
    for (const e of t.f) if (e.team === 1) e.x = e.z = 50;
    for (let k = 0; k < 30; k++) t.step({ mx: 127, mz: 0, blk: false, press: 0 });
    return h.x;
  };
  assert.ok(run(true) > run(false) * 1.12);
});

test('Plume de phénix : le coup fatal le fait renaître à 60 % PV, une seule fois', () => {
  const s = fight(4), p = s.f[0], e = foe(s);
  BOONS.phenix.apply(p);
  p.hp = 5;
  s.damage(e, p, 999, 0, 0.3, 0, 1, 0);
  assert.notEqual(p.state, 'dead');
  assert.equal(p.hp, Math.round(p.maxHp * 0.6));
  assert.ok(s.ev.some((ev) => ev[0] === 'pop' && ev[1] === 'PHÉNIX !'));
  s.damage(e, p, 999, 0, 0.3, 0, 1, 0);
  assert.equal(p.state, 'dead', 'la deuxième fois, il tombe');
});

test('Épines de bronze : l’attaquant perd 60 % des dégâts infligés ; s’il en meurt, la victime compte pour le héros', () => {
  const s = fight(5), p = s.f[0], e = foe(s);
  BOONS.epines.apply(p);
  const hp0 = e.hp;
  s.damage(e, p, 20, 0, 0.3, 0, 1, 0);
  const taken = 100 - p.hp;
  assert.equal(hp0 - e.hp, Math.max(1, Math.round(taken * 0.6)));
  e.hp = 1;
  s.damage(e, p, 20, 0, 0.3, 0, 1, 0);
  assert.equal(e.state, 'dead');
  assert.equal(p.kills, 1);
});

test('Égide divine et Fureur', () => {
  const s = fight(6), p = s.f[0], e = foe(s);
  BOONS.egide.apply(p);
  assert.ok(Math.abs(p.armor - 0.3) < 1e-9);
  // Fureur : +70 % de dégâts sous 40 % de PV
  const hit = (hp) => { const t = fight(7), h = t.f[0], x = foe(t); BOONS.fureur.apply(h); h.hp = hp; x.hp = x.maxHp = 9999; t.damage(h, x, 10, 0, 0.3, 0, 1, 0); return 9999 - x.hp; };
  assert.equal(hit(30), Math.round(10 * 1.7));
  assert.equal(hit(80), 10);
});

test('bénédictions uniques : une seule fois par héros, plus proposées quand tous l’ont', () => {
  const s = fight(8), p = s.f[0];
  s.g.phase = 'reward'; s.g.pick0 = -1;
  s.g.o0 = 'potion'; s.g.o1 = 'phenix'; s.g.o2 = 'force';
  assert.equal(s.choose(0, 1), true);
  s.g.pick0 = -1;
  assert.equal(s.choose(0, 1), false, 'déjà prise');
  for (let k = 0; k < 500; k++) { s.rollOffer(); assert.ok(!s.offer.includes('phenix')); }
});

test('même graine + mêmes choix : mêmes coffres (en ligne)', () => {
  const run = () => { const s = fight(9); const seen = []; for (let n = 1; n <= 30; n++) { s.g.room = n; s.rollOffer(); seen.push(s.offer.join()); } return seen; };
  assert.deepEqual(run(), run());
});
