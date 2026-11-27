import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim, VAULT } from '../dungeon.js';
import { NEUTRAL, PRESS, quant } from '../sim.js';
import { Rng } from '../dmath.js';
import {
  ITEMS, ITEM_IDS, FAMILIES, COMBOS, MINORS, MINOR_IDS, QUALITY, ODDS, CAPS, FX, ITEM_BASE, TF_N,
  rollQuality, rollItem, oddsOf, has, itemList,
} from '../items.js';

// Objets façon Isaac : catalogue, raretés, transformations, combos, effets, ramassage
const fight = (seed = 1, kinds = ['soldier'], wpns = []) => {
  const s = new DungeonSim(seed, kinds, wpns);
  s.start();
  while (s.g.phase !== 'fight') s.step();
  s.ais = s.ais.map(() => null);             // ennemis immobiles : tests reproductibles
  s.ev.length = 0;
  return s;
};
const foes = (s) => s.f.filter((e) => e.team === 1 && e.state !== 'dead');
const tough = (e, hp = 1000) => { e.hp = e.maxHp = hp; return e; };
const run = (s, n, i0 = () => NEUTRAL, i1 = () => NEUTRAL) => { for (let k = 0; k < n; k++) s.step(i0(k), i1(k)); };
const evs = (s, name) => s.ev.filter((e) => e[0] === name);
// place les ennemis vivants en ligne loin du héros, sauf le premier, posé devant lui
const lineUp = (s, n = 3) => {
  while (foes(s).length < n) s.addFoe('grunt', 4, 4);
  s.ais = s.ais.map(() => null);
  const p = s.f[0], list = foes(s);

  Object.assign(p, { x: 0, z: 0, yaw: Math.PI });
  list.forEach((e, k) => Object.assign(e, { x: k ? -5 + k * 1.2 : 0, z: k ? 5 : -1, vx: 0, vz: 0 }));
  return list;
};

test('catalogue : ~60 objets complets, 9 familles de 5, combos valides, pas de NaN', () => {
  assert.ok(ITEM_IDS.length >= 60, `${ITEM_IDS.length} objets`);
  assert.ok(ITEM_IDS.filter((id) => ITEMS[id].q === 3).length >= 6, 'assez de légendaires');
  for (const id of ITEM_IDS) {
    const it = ITEMS[id];
    assert.ok(it.name && it.icon && it.desc && typeof it.apply === 'function', id);
    assert.ok(it.q >= 0 && it.q <= 3, id);
    if (it.fam) assert.ok(FAMILIES[it.fam], `${id} : famille ${it.fam}`);
  }
  for (const fam of Object.keys(FAMILIES)) assert.equal(ITEM_IDS.filter((id) => ITEMS[id].fam === fam).length, 5, fam);
  for (const [cid, c] of Object.entries(COMBOS)) assert.ok(ITEMS[c.a] && ITEMS[c.b] && c.a !== c.b, cid);
  assert.ok(Object.keys(COMBOS).length >= 15);
  // de chaque qualité, et quelques objets maudits
  for (const q of [0, 1, 2, 3]) assert.ok(ITEM_IDS.some((id) => ITEMS[id].q === q), `qualité ${q}`);
  assert.ok(ITEM_IDS.filter((id) => ITEMS[id].curse).length >= 4);
  // chaque objet appliqué seul à un héros neuf donne des champs numériques sains
  for (const id of ITEM_IDS) {
    const s = new DungeonSim(1, ['soldier']), p = s.f[0];
    s.giveItem(p, id);
    for (const k of Object.keys(ITEM_BASE)) if (typeof ITEM_BASE[k] === 'number') assert.ok(Number.isFinite(p[k]), `${id} : ${k} = ${p[k]}`);
    assert.ok(p.hp > 0 && p.hp <= p.maxHp, id);
  }
});

test('raretés : chances de la salle au trésor et du boss, glissement en profondeur, chance', () => {
  const tally = (src, room, luck = 0) => {
    const r = new Rng(7), t = [0, 0, 0, 0];
    for (let k = 0; k < 20000; k++) t[rollQuality(r, src, room, luck)]++;
    return t.map((n) => n / 20000);
  };
  const v1 = tally('vault', 1), v20 = tally('vault', 20), b = tally('boss', 5), l2 = tally('vault', 1, 2);
  ODDS.vault.forEach((o, q) => assert.ok(Math.abs(v1[q] - o) < 0.015, `salle 1, qualité ${q} : ${v1[q]}`));
  assert.equal(b[0], 0, 'un boss ne laisse jamais d’objet commun');
  assert.ok(b[3] > 0.07 && b[3] < 0.13);
  assert.ok(v20[3] > v1[3] && v20[2] > v1[2], 'plus généreux en profondeur');
  assert.ok(oddsOf('vault', 99)[3] <= ODDS.vault[3] + 0.04 + 1e-9, 'glissement plafonné');
  assert.ok(l2[0] < v1[0] - 0.15 && l2[3] > v1[3], 'la chance fait monter la qualité');
  // les légendaires restent rares : moins d'une salle au trésor sur 20 au début
  assert.ok(v1[3] < 0.05);
});

test('tirage : jamais deux fois le même objet dans une partie, objet de secours quand tout est sorti', () => {
  const r = new Rng(3);
  let seen = '';
  const got = new Set();
  for (let k = 0; k < ITEM_IDS.length; k++) {
    const id = rollItem(r, 'vault', 1 + k, 0, seen);
    assert.ok(id && !got.has(id), `doublon ou vide : ${id}`);
    got.add(id);
    seen += (seen ? ',' : '') + id;
  }
  assert.equal(rollItem(r, 'vault', 9, 0, seen), '', 'plus rien à tirer');
  // dans la simulation : l'objet de secours (éclat) prend le relais
  const s = new DungeonSim(1, ['soldier']);
  s.start();
  s.g.seen = seen;
  s.newVault();
  assert.equal(s.pk.filter((o) => o.t === 'item')[0].v, 'eclat');
});

test('ramassage : en marchant dessus, un seul objet par héros, le piédestal ne se prend pas à l’apparition', () => {
  const s = new DungeonSim(4, ['soldier']);
  s.start();
  s.f[0].choice = 2;                         // trois piédestaux, on n'en garde qu'un
  s.newVault();
  const items = s.pk.filter((o) => o.t === 'item');
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map((o) => o.v)).size, 3);
  const p = s.f[0];
  // posé sur un piédestal dès l'apparition : il faut d'abord s'en écarter (pas de prise par accident)
  p.x = items[0].x + 0.85; p.z = items[0].z;
  run(s, 5);
  assert.equal(p.items, '', 'pas armé tant que le héros est dessus');
  p.x = items[0].x + 3; run(s, 2);
  p.x = items[0].x + 0.85; p.z = items[0].z; run(s, 2);
  assert.equal(p.items, items[0].v);
  assert.equal(s.pk.length, 0, 'les autres choix disparaissent');
  assert.ok(evs(s, 'item').length === 1 && evs(s, 'take').length === 1);
});

test('ramassage : un cœur ne se prend que blessé, les éclats donnent un petit bonus', () => {
  const s = fight(5), p = s.f[0];
  s.addPk('heart', '', 2, 0);
  s.addPk('minor', 'mForce', -2, 0);
  const [hx, hz] = s.lanePos(2, 0), [mx, mz] = s.lanePos(-2, 0);
  p.x = hx; p.z = hz; run(s, 2);
  assert.equal(s.pk.filter((o) => o.t === 'heart').length, 1, 'PV pleins : le cœur reste');
  p.hp = 40; run(s, 1);
  assert.equal(p.hp, 40 + FX.heart);
  const pow = p.pow;
  p.x = mx; p.z = mz; run(s, 2);
  assert.ok(Math.abs(p.pow - pow - 0.05) < 1e-9);
  assert.equal(p.minors, 1);
  for (const id of MINOR_IDS) assert.ok(MINORS[id].name && MINORS[id].desc);
});

test('salles au trésor : après la salle 2 de chaque tranche, parfois après la 4e, jamais après un boss', () => {
  const after = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (let seed = 1; seed <= 60; seed++) {
    const s = new DungeonSim(seed, ['soldier']);
    s.start();
    for (let n = 1; n <= 5; n++) {
      s.debugKill();
      if (s.g.vaultNext) after[n]++;
      s.newRoom();
    }
  }
  assert.equal(after[2], 60);
  assert.ok(after[4] > 15 && after[4] < 45, `après la 4e : ${after[4]}`);
  assert.equal(after[1] + after[3] + after[5], 0);
  // le boss laisse ses objets (de qualité) et un cœur
  const s = new DungeonSim(2, ['soldier']);
  s.start();
  s.debugGoto(5);
  s.debugKill();
  const items = s.pk.filter((o) => o.t === 'item');
  assert.equal(items.length, 1);
  assert.ok(items[0].q >= 1, 'pas d’objet commun sur un boss');
  assert.ok(s.pk.some((o) => o.t === 'heart'));
  // la porte d'une salle au trésor mène à la salle suivante
  s.debugVault();
  assert.equal(s.g.vault, true);
  s.newRoom();
  assert.equal(s.g.room, 6);
  assert.equal(s.g.vault, false);
  assert.ok(VAULT.maxItems >= 3);
});

test('transformation : 3 objets d’une famille', () => {
  const s = fight(1), p = s.f[0];
  s.giveItem(p, 'silex');
  s.giveItem(p, 'braise');
  assert.equal(p.tf, '');
  s.giveItem(p, 'naphte');
  assert.equal(TF_N, 3);
  assert.equal(p.tf, 'feu');
  assert.equal(p.auraFire, 1);
  assert.equal(p.fireImmune, 1);
  assert.equal(evs(s, 'tf').length, 1);
  // Avatar d'Héphaïstos : l'aura enflamme les ennemis proches, le feu de Cerbère ne le brûle plus
  const e = tough(lineUp(s)[0]);
  run(s, 40);
  assert.ok(e.sBurnT > 0 || e.hp < 1000, 'aura de feu');
  const hp = p.hp;
  s.src = 'fire'; s.damage(e, p, 20, 0, 0.2, 0, 1, 0); s.src = '';
  assert.equal(p.hp, hp);
});

test('combos nommés : deux objets précis réunis', () => {
  const s = fight(1), p = s.f[0];
  s.giveItem(p, 'naphte');
  assert.equal(p.combos, '');
  s.giveItem(p, 'tonnerre');
  assert.equal(p.combos, 'naphteElec');
  assert.equal(p.zapBurn, 1);
  assert.equal(evs(s, 'combo').length, 1);
  // les éclairs enflamment
  const [a, b] = lineUp(s).map((e) => tough(e));
  b.x = 1; b.z = -1.5;
  s.zap(p, a, 1, 9, true);
  assert.ok(a.sBurnT > 0 && b.sBurnT > 0);
});

test('feu : brûlure (dégâts dans le temps), Cœur de forge : explosion à la mort', () => {
  const s = fight(2), p = s.f[0];
  s.giveItem(p, 'forge');
  p.burnCh = 1;
  const [e, o] = lineUp(s);
  tough(e); o.x = 1.2; o.z = -1.2; tough(o);
  s.damage(p, e, 10, 0, 0.2, 0, 1, 0);
  assert.ok(e.sBurnT > 0 && e.sBurnBy === 0);
  const hp = e.hp;
  run(s, 120);
  assert.ok(e.hp < hp - 5, `brûlure : ${hp} → ${e.hp}`);
  // mort en feu : explosion qui touche le voisin
  e.hp = 1; s.ev.length = 0;
  const ohp = o.hp;
  run(s, 60);
  assert.equal(e.state, 'dead');
  assert.ok(o.hp < ohp, 'explosion');
  assert.equal(s.f[0].kills >= 1, true, 'la brûlure compte pour le héros');
});

test('poison : piles plafonnées, Spores : se répand', () => {
  const s = fight(3), p = s.f[0];
  s.giveItem(p, 'spores');
  const [e, o] = lineUp(s);
  tough(e); o.x = 1; o.z = -1.5; tough(o);
  for (let k = 0; k < 20; k++) s.poison(p, e, 1);
  assert.equal(e.sPsn, FX.psn.max);
  e.hp = 1;
  run(s, 40);
  assert.equal(e.state, 'dead');
  assert.ok(o.sPsn >= 2, 'poison répandu');
});

test('froid : ralentit tout l’ennemi, le gel l’immobilise ; Cœur de glace : plus de dégâts', () => {
  const dist = (chill) => {
    const s = fight(4), e = lineUp(s)[0];
    tough(e);
    e.x = 0; e.z = -4;
    if (chill) e.sChill = 5;
    s.inp[e.idx].mz = 1;
    let z0 = e.z;
    s.ais[e.idx] = { update: () => ({ mx: 0, mz: 127, blk: false, press: 0 }) };
    run(s, 30);
    return e.z - z0;
  };
  const a = dist(false), b = dist(true);
  assert.ok(b < a * 0.7, `ralenti : ${b} contre ${a}`);
  const s = fight(4), p = s.f[0], e = tough(lineUp(s)[0]);
  s.freeze(p, e, 1.4);
  assert.equal(e.state, 'stun');
  assert.ok(e.sFrz > 0 && e.sChill > 0);
  s.giveItem(p, 'glace');
  const hp = e.hp;
  p.crit = 0;
  s.damage(p, e, 10, 0, 0.2, 0, 1, 0);
  // assommé (×1,25 dans Sim) et ralenti (+30 %)
  assert.equal(hp - e.hp, Math.round(Math.round(10 * p.pow * 1.3) * 1.25));
});

test('foudre : l’éclair rebondit sur les ennemis proches', () => {
  const s = fight(5, ['soldier', 'orc']), p = s.f[0];
  const list = lineUp(s).map((e) => tough(e));
  assert.ok(list.length >= 3);
  list[1].x = 1.5; list[1].z = -1; list[2].x = 3; list[2].z = -1;
  s.zap(p, list[0], 2, 9, true);
  assert.ok(list[0].hp < 1000 && list[1].hp < 1000 && list[2].hp < 1000);
  assert.equal(evs(s, 'bolt').length, 3);
});

test('lames tournoyantes, lame fantôme, projectiles doublés et perçants', () => {
  const s = fight(6), p = s.f[0];
  s.giveItem(p, 'anneau');
  const e = tough(lineUp(s)[0]);
  e.z = -FX.orbit.R;
  run(s, 120);
  assert.ok(e.hp < 1000, 'les lames tranchent');
  // lame fantôme : un coup d'arme lance une lame spectrale (k = 2)
  s.giveItem(p, 'fantome');
  s.startAttack(p);
  assert.ok(s.pr.some((a) => a.k === 2 && a.o === 0));
  // archère + carquois + adamantium : deux flèches, perçantes
  const t = fight(6, ['archer']), q = t.f[0];
  t.giveItem(q, 'carquois');
  t.giveItem(q, 'adamant');
  const f = lineUp(t)[0];
  f.z = -5;
  t.inp[0].atk = 0.2;
  run(t, 20);
  const shots = t.pr.filter((a) => a.k === 0 && a.o === 0);
  assert.equal(shots.length, 2);
  assert.ok(shots.every((a) => a.pc === 2));
});

test('Pomme de discorde : l’ennemi touché s’en prend à ses alliés (et compte pour le héros)', () => {
  const s = fight(7, ['soldier', 'orc']), p = s.f[0];
  const [a, b] = lineUp(s);
  tough(a); b.x = 2; b.z = -1;
  s.confuse(p, a);
  assert.equal(s.target(a.idx), b, 'il vise son allié');
  b.hp = 1;
  a.yaw = Math.PI / 2; a.x = 1; a.z = -1;
  s.startAttack(a);
  run(s, 30);
  assert.equal(b.state, 'dead');
  assert.equal(p.kills, 1);
});

test('géant, minuscule, rétrécissement', () => {
  const s = fight(8), p = s.f[0];
  s.giveItem(p, 'titan');
  assert.ok(p.size > 1.3 && p.reachMul > 1 && p.maxHp >= 140);
  const t = fight(8), q = t.f[0];
  t.giveItem(q, 'lilliput');
  assert.ok(q.size < 0.8 && q.maxHp === 85);
  const e = tough(lineUp(t)[0]);
  t.shrink(e);
  assert.ok(e.size < 0.7 && e.shrunk === 1 && e.maxHp === 600);
  // combo Goliath : retomber d'un saut écrase les ennemis rétrécis
  t.giveItem(q, 'titan');
  t.giveItem(q, 'retreci');
  assert.ok(q.combos.includes('goliath'));
  const hp = e.hp;
  t.landItems(q);
  assert.ok(e.hp < hp);
});

test('objets maudits : Cœur de verre, Pacte d’Hadès, Pacte de sang, Ivresse', () => {
  const s = fight(9), p = s.f[0];
  s.giveItem(p, 'verre');
  assert.equal(p.maxHp, 50);
  assert.ok(Math.abs(p.pow - 1.8) < 1e-9);
  const t = fight(9), q = t.f[0], e = t.f[1];
  t.giveItem(q, 'hades');
  const hp = q.hp;
  t.damage(e, q, 10, 0, 0.2, 0, 1, 0);
  assert.equal(hp - q.hp, Math.round(10 * e.pow * 1.4), 'dégâts subis +40 %');
  // pacte de sang : perd des PV en combat, jamais sous 1
  const u = fight(9), r = u.f[0];
  u.giveItem(r, 'pacte');
  r.hp = 1.5;
  run(u, 120);
  assert.equal(r.hp, 1);
  // ivresse : la direction tenue tourne
  const v = fight(9), w = v.f[0];
  v.giveItem(w, 'dionysos');
  run(v, 30, () => ({ mx: 0, mz: -127, blk: false, press: 0 }));
  assert.ok(Math.abs(v.inp[0].mx) > 0.05, 'il titube');
});

test('meute : un chien entre avec son maître à chaque salle ; Portée infernale', () => {
  const s = new DungeonSim(10, ['soldier']);
  s.start();
  const p = s.f[0];
  s.giveItem(p, 'sifflet');
  s.newRoom();
  assert.equal(s.dogsOf(0), 1);
  s.giveItem(p, 'oscerbere');
  s.newRoom();
  assert.equal(s.dogsOf(0), 2);
  assert.ok(p.combos.includes('portee'));
  const dog = s.f.find((d) => d.owner === 0);
  assert.equal(dog.hell, 1);
  // la salle au trésor n'a pas de chien
  s.newVault();
  assert.equal(s.dogsOf(0), 0);
});

test('plafonds : critique et armure bornés même en cumulant tout', () => {
  const s = fight(11), p = s.f[0];
  for (const id of ['lynx', 'faucheur', 'vipere', 'etoile', 'dionysos', 'glace', 'egide', 'bronze']) s.giveItem(p, id);
  p.crit = 5; p.armor = 0.99;
  const e = s.f[1];
  let crits = 0;
  tough(e, 1e9);
  for (let k = 0; k < 2000; k++) { s.ev.length = 0; s.damage(p, e, 1, 0, 0, 0, 1, 0); if (s.ev.some((v) => v[0] === 'pop' && v[1] === 'CRIT !')) crits++; }
  assert.ok(crits / 2000 < CAPS.crit + 0.04, `critiques : ${crits / 2000}`);
  const hp = p.hp;
  s.damage(e, p, 100, 0, 0.2, 0, 1, 0);
  assert.ok(hp - p.hp >= Math.round(100 * e.pow * (1 - CAPS.armor)) - 1);
});

test('tous les objets à la fois : la partie tourne sans erreur ni NaN, et reste déterministe', () => {
  const play = () => {
    const s = new DungeonSim(12, ['archer', 'soldier'], ['bow', 'tome']);
    s.start();
    for (const id of ITEM_IDS) s.giveItem(s.f[ITEM_IDS.indexOf(id) % 2], id);
    const r = new Rng(5);
    let cur = [NEUTRAL, NEUTRAL];
    for (let k = 0; k < 2400; k++) {
      cur = cur.map((c) => (r.next() < 0.08 ? { mx: quant(r.range(-1, 1)), mz: quant(r.range(-1, 1)), blk: r.next() < 0.2, press: 0 } : c));
      s.step(...cur.map((c) => ({ ...c, press: r.next() < 0.1 ? 1 << ((r.next() * 6) | 0) : 0 })));
      if (s.g.phase === 'clear') { s.f[0].x = 0; s.f[0].z = 0; s.g.phase = 'exit'; s.g.t = 0; }
      if (s.g.phase === 'dead' || s.g.phase === 'end') { for (const p of s.heroes) { p.hp = p.maxHp; p.down = 0; s.toIdle(p); } s.g.phase = 'fight'; }
      for (const f of s.f) for (const key of ['x', 'z', 'hp', 'y']) assert.ok(Number.isFinite(f[key]), `${key} de ${f.idx} à l'image ${k}`);
    }
    return s;
  };
  const a = play(), b = play();
  assert.ok(a.g.room >= 2, `salles traversées : ${a.g.room}`);
  assert.equal(a.hash(), b.hash());
  assert.ok(itemList(a.f[0]).length >= 30 && has(a.f[1], ITEM_IDS[1]));
  assert.ok(a.f[0].tf.split(',').length >= 3, 'transformations');
});

test('save/load (rollback) : objets, états et piédestaux rejoués à l’identique, y compris par JSON', () => {
  const s = new DungeonSim(13, ['soldier']);
  s.start();
  const p = s.f[0];
  for (const id of ['silex', 'dague', 'givre', 'tonnerre', 'anneau', 'orage', 'fantome']) s.giveItem(p, id);
  run(s, 80, (k) => ({ mx: 0, mz: -90, blk: false, press: k % 9 === 0 ? PRESS.atk : 0 }));
  s.addPk('heart', '', 0, 2);
  const snap = JSON.parse(JSON.stringify(s.save()));
  const h0 = s.hash();
  run(s, 200, (k) => ({ mx: 90, mz: 0, blk: false, press: k % 7 === 0 ? PRESS.atk : 0 }));
  const h1 = s.hash();
  s.load(snap);
  assert.equal(s.hash(), h0);
  run(s, 200, (k) => ({ mx: 90, mz: 0, blk: false, press: k % 7 === 0 ? PRESS.atk : 0 }));
  assert.equal(s.hash(), h1);
});

test('qualités : couleurs et noms pour l’affichage', () => {
  assert.equal(QUALITY.length, 4);
  for (const q of QUALITY) assert.ok(q.name && /^#/.test(q.col) && q.hex > 0);
});
