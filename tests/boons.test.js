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

test('équilibrage des raretés : progression nette Commune < Rare < Légendaire sur chaque axe', () => {
  const byRare = [0, 1, 2].map((r) => Object.values(BOONS).filter((b) => b.rare === r));
  assert.ok(byRare[0].length >= 9, 'au moins 9 communes');
  assert.ok(byRare[1].length >= 10, 'au moins 10 rares');
  assert.ok(byRare[2].length >= 9, 'au moins 9 légendaires');

  const stat = (id, fn) => { const p = fight(10).f[0]; BOONS[id].apply(p); return fn(p); };
  // Dégâts : Force (+20 %) < Lame (+35 %) < Olympe (+55 % + crit)
  assert.ok(stat('force', (p) => p.pow) < stat('lame', (p) => p.pow));
  assert.ok(stat('lame', (p) => p.pow) < stat('olympe', (p) => p.pow));
  // Armure : Peau (15 %) < Carapace (22 %) < Égide (30 %)
  assert.ok(stat('peau', (p) => p.armor) < stat('carapace', (p) => p.armor));
  assert.ok(stat('carapace', (p) => p.armor) < stat('egide', (p) => p.armor));
  // PV max : Vitalité (120) < Cuirasse (140) < Titan (175)
  assert.ok(stat('vita', (p) => p.maxHp) < stat('cuirasse', (p) => p.maxHp));
  assert.ok(stat('cuirasse', (p) => p.maxHp) < stat('titan', (p) => p.maxHp));
  // Recharge sort : Hâte (0,85) > Maîtrise (0,75) > Cataclysme (0,62)
  assert.ok(stat('hate', (p) => p.spellCdMul) > stat('maitrise', (p) => p.spellCdMul));
  assert.ok(stat('maitrise', (p) => p.spellCdMul) > stat('cataclysme', (p) => p.spellCdMul));
  // Vitesse / garde : Élan < Vent, Bouclier ferme > Garde de fer
  assert.ok(stat('elan', (p) => p.runMul) < stat('vent', (p) => p.runMul));
  assert.ok(stat('pavois', (p) => p.guardMul) > stat('fer', (p) => p.guardMul));
});

test('nouvelles bénédictions : critiques, sorts, exécution, boss, riposte, trophée et immortalité', () => {
  // Critiques + soin par critique (Faucheur)
  const s1 = fight(11), p1 = s1.f[0], e1 = foe(s1);
  BOONS.assassin.apply(p1);
  p1.hp = 50; e1.hp = e1.maxHp = 9999;
  let crits = 0;
  for (let i = 0; i < 60; i++) {
    const before = e1.hp;
    s1.damage(p1, e1, 10, 0, 0.2, 0, 1, 0);
    if (before - e1.hp >= 22) crits++;
  }
  assert.ok(crits > 5 && crits < 45, `coups critiques déclenchés (${crits}/60)`);
  assert.ok(p1.hp > 50, 'Faucheur soigne sur critique');

  // Exécution (Coup de grâce) et Chasseur de géants (boss)
  const s2 = fight(12), p2 = s2.f[0], e2 = foe(s2);
  BOONS.bourreau.apply(p2);
  e2.maxHp = 100; e2.hp = 80;
  s2.damage(p2, e2, 10, 0, 0.2, 0, 1, 0);
  assert.equal(80 - e2.hp, 10, 'pas d’exécution au-dessus de 45 % PV');
  e2.hp = 40;
  s2.damage(p2, e2, 10, 0, 0.2, 0, 1, 0);
  assert.equal(40 - e2.hp, 15, '+50 % dégâts sous 45 % PV');

  const sBoss = fight(13); sBoss.debugGoto(5);
  while (sBoss.g.phase !== 'fight') sBoss.step();
  const pb = sBoss.f[0], boss = sBoss.f.find((x) => x.boss);
  BOONS.tueur.apply(pb);
  const bHp = boss.hp;
  sBoss.damage(pb, boss, 10, 0, 0.2, 0, 1, 0);
  assert.equal(bHp - boss.hp, Math.round(10 * 1.15 * 1.45), 'bonus contre les boss appliqué');

  // Sort : Cataclysme réduit le CD et augmente les dégâts du sort
  const sSp = fight(14), pSp = sSp.f[0], eSp = foe(sSp);
  BOONS.cataclysme.apply(pSp);
  pSp.x = 0; pSp.z = 0; eSp.x = 1.2; eSp.z = 0; eSp.hp = eSp.maxHp = 500;
  sSp.startSpell(pSp, eSp, 0, 0);
  assert.ok(pSp.spellCd < 5, `cooldown réduit par Cataclysme (${pSp.spellCd.toFixed(2)} s)`);
  for (let i = 0; i < 60; i++) sSp.step();
  assert.ok(500 - eSp.hp > 25, 'dégâts du Tourbillon amplifiés par Cataclysme');

  // Contre-riposte : parer soigne 12 PV et inflige 20 dégâts
  const sRip = fight(15), pRip = sRip.f[0], eRip = foe(sRip);
  BOONS.riposte.apply(pRip);
  pRip.hp = 70; eRip.hp = eRip.maxHp = 100;
  sRip.parried(eRip, pRip, 0, 1, 0);
  assert.equal(pRip.hp, 82, 'parade soigne +12 PV');
  assert.equal(eRip.hp, 80, 'parade inflige 20 dégâts à l’attaquant');

  // Trophée de victoire : élimination soigne +6 PV et réduit le CD du sort de 1,2 s
  const sKill = fight(16), pKill = sKill.f[0], eKill = foe(sKill);
  BOONS.pillage.apply(pKill);
  pKill.hp = 60; pKill.spellCd = 5; eKill.hp = 1;
  sKill.damage(pKill, eKill, 20, 0, 0.2, 0, 1, 0);
  assert.equal(pKill.hp, 66, '+6 PV à l’élimination');
  assert.ok(Math.abs(pKill.spellCd - 3.8) < 1e-6, '−1,2 s sur le cooldown du sort');

  // Source d'immortalité : régén en combat + soin entre les salles
  const sSrc = fight(17), pSrc = sSrc.f[0];
  BOONS.source.apply(pSrc);
  pSrc.hp = 50;
  for (const e of sSrc.f) if (e.team === 1) { e.x = 5; e.z = 5; }
  for (let i = 0; i < 60; i++) sSrc.step();
  assert.ok(pSrc.hp > 51.5, 'régénération +2 PV/s active en combat');
  pSrc.hp = 40;
  sSrc.newRoom();
  assert.equal(pSrc.hp, 75, '+35 % PV max restaurés à la nouvelle salle');
});
