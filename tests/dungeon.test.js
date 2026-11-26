import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim, BOONS, ROOM_R, PLAT_H, pickInput, trapUp, TRAP, biomeOf, BIOMES } from '../dungeon.js';
import { PRESS, NEUTRAL, quant, hashState } from '../sim.js';
import { Rollback } from '../rollback.js';
import { AI } from '../ai.js';
import { Rng } from '../dmath.js';

const started = (seed = 1, kinds = ['soldier']) => { const s = new DungeonSim(seed, kinds); s.start(); s.ev.length = 0; return s; };
const run = (s, n, i0 = () => NEUTRAL, i1 = () => NEUTRAL) => { for (let k = 0; k < n; k++) s.step(i0(k), i1(k)); };
const toFight = (s) => { let n = 0; while (s.g.phase !== 'fight' && n++ < 200) s.step(); assert.equal(s.g.phase, 'fight'); };
const killAll = (s) => { for (let i = s.g.np; i < s.f.length; i++) { s.f[i].hp = 0; s.die(s.f[i]); s.onKO(s.f[0], s.f[i]); } };
const walk = (mx, mz) => () => ({ mx: quant(mx), mz: quant(mz), blk: false, press: 0 });
const toExit = (s) => (s.room.exit === 'z' ? [0, -1] : [-1, 0]);
// salle sans estrade ni piège (pour les tests qui ne s'en occupent pas)
const flat = (s) => { s.room = { ...s.room, surf: [], traps: [] }; return s; };

test('une salle contient des ennemis, le héros entre par le mur opposé à la sortie', () => {
  const s = started(3);
  assert.equal(s.g.room, 1);
  assert.equal(s.g.phase, 'intro');
  assert.ok(s.f.length >= 2);
  s.f.forEach((f, i) => assert.equal(f.idx, i));
  const p = s.f[0];
  assert.ok((s.room.exit === 'z' ? p.z : p.x) > ROOM_R - 1);
});

test('même graine + mêmes entrées => même partie (IA comprises)', () => {
  const play = () => {
    const s = started(42, ['soldier', 'orc']);
    const a0 = new AI(s, 0, 2, 7), a1 = new AI(s, 1, 2, 8);
    const out = [];
    for (let k = 0; k < 2000; k++) {
      const dt = s.effectiveDt();
      s.step(a0.update(dt), a1.update(dt));
      out.push(s.hash());
    }
    return out;
  };
  const a = play();
  assert.deepEqual(a, play());
  assert.ok(new Set(a).size > 100);
});

test('save/load rejoue exactement (y compris en passant par JSON)', () => {
  const s = started(7, ['soldier', 'human']);
  const rng = new Rng(3);
  const inputs = [];
  for (let k = 0; k < 900; k++) inputs.push([0, 1].map(() => ({ mx: quant(rng.range(-1, 1)), mz: quant(rng.range(-1, 1)), blk: rng.next() < 0.2, press: rng.next() < 0.08 ? 1 << ((rng.next() * 5) | 0) : 0 })));
  run(s, 200);
  const snap = JSON.parse(JSON.stringify(s.save()));
  const first = inputs.map((x) => { s.step(...x); return s.hash(); });
  s.load(snap);
  const second = inputs.map((x) => { s.step(...x); return s.hash(); });
  assert.deepEqual(first, second);
});

test('on reste dans la salle tant que la porte est fermée', () => {
  const s = flat(started(1));
  toFight(s);
  for (const e of s.f.slice(1)) { e.x = 5; e.z = 5; }
  s.ais = [];
  s.f[0].x = 0; s.f[0].z = 0;
  run(s, 300, walk(...toExit(s)));
  const p = s.f[0];
  assert.ok(Math.abs(p.x) <= ROOM_R && Math.abs(p.z) <= ROOM_R);
  assert.equal(s.g.room, 1);
});

test('salle nettoyée => coffre, bénédiction (choisie par une entrée), porte, salle suivante', () => {
  const s = flat(started(5));
  toFight(s);
  killAll(s);
  assert.equal(s.g.phase, 'clear');
  assert.ok(s.g.exitOpen && s.g.chest === 1);
  const p = s.f[0];
  p.x = s.g.chestX; p.z = s.g.chestZ;
  run(s, 40);
  assert.equal(s.g.phase, 'reward');
  assert.equal(s.offer[0], 'potion');
  const statsOf = (h) => ({
    pow: h.pow, maxHp: h.maxHp, staMul: h.staMul, leech: h.leech, armor: h.armor,
    crit: h.crit, spellCdMul: h.spellCdMul, spellPow: h.spellPow, runMul: h.runMul, guardMul: h.guardMul,
    execPow: h.execPow, bossPow: h.bossPow, riposte: h.riposte, onKillHeal: h.onKillHeal,
    phoenix: h.phoenix, thorns: h.thorns, berserk: h.berserk, regen: h.regen,
  });
  const before = statsOf(p);
  run(s, 3, () => pickInput(1));
  assert.equal(s.g.phase, 'clear');
  assert.equal(p.boons, s.offer[1]);
  assert.notDeepEqual(statsOf(p), before);
  // un choix qui arrive encore après la phase ne fait pas bouger le héros
  const [x0, z0] = [p.x, p.z];
  run(s, 3, () => pickInput(1));
  assert.ok(Math.abs(p.x - x0) < 1e-9 && Math.abs(p.z - z0) < 1e-9);
  p.x = 0; p.z = 0;
  run(s, 400, walk(...toExit(s)));
  assert.equal(s.g.room, 2);
  assert.equal(s.f[0], p, 'le héros garde son état d\'une salle à l\'autre');
});

test('à deux : chacun choisit sa bénédiction, la salle attend les deux', () => {
  const s = flat(started(5, ['soldier', 'orc']));
  assert.equal(s.g.np, 2);
  assert.ok(s.f.length >= 4, 'plus d\'ennemis à deux');
  toFight(s);
  killAll(s);
  s.f[0].x = s.g.chestX; s.f[0].z = s.g.chestZ;
  run(s, 40);
  assert.equal(s.g.phase, 'reward');
  run(s, 3, () => pickInput(2));
  assert.equal(s.g.phase, 'reward');
  run(s, 3, () => NEUTRAL, () => pickInput(0));
  assert.equal(s.g.phase, 'clear');
  assert.equal(s.f[1].boons, 'potion');
});

test('à deux : un héros tombé se relève à la salle suivante, la partie finit quand les deux tombent', () => {
  const s = flat(started(2, ['soldier', 'orc']));
  toFight(s);
  s.f[1].hp = 1;
  s.damage(s.f[2], s.f[1], 50, 3, 0.3, 0, 1, 0);
  assert.equal(s.f[1].state, 'dead');
  assert.equal(s.g.phase, 'fight');
  s.newRoom();
  assert.notEqual(s.f[1].state, 'dead');
  assert.ok(s.f[1].hp > 0);
  toFight(s);
  for (const h of [0, 1]) { s.f[h].hp = 1; s.damage(s.f[2], s.f[h], 50, 3, 0.3, 0, 1, 0); }
  assert.equal(s.g.phase, 'dead');
});

test('un coup peut toucher plusieurs ennemis à la fois', () => {
  const s = started(2);
  while (s.f.length < 3) s.newRoom();
  flat(s);
  toFight(s);
  const p = s.f[0];
  p.x = 0; p.z = 0; p.yaw = 0;
  s.f[1].x = -0.35; s.f[1].z = 1.0;
  s.f[2].x = 0.35; s.f[2].z = 1.0;
  for (const e of s.f.slice(3)) { e.x = 5; e.z = -5; }
  s.ais = [];
  s.target = (i) => (i ? s.f[0] : null);     // le héros reste face aux deux ennemis
  const hp = [s.f[1].hp, s.f[2].hp];
  s.step({ ...NEUTRAL, press: PRESS.atk });
  run(s, 20);
  assert.ok(s.f[1].hp < hp[0] && s.f[2].hp < hp[1]);
});

test('estrades : on bute sur le bord, on monte par l\'escalier ou en sautant', () => {
  const s = started(1);
  toFight(s);
  for (const e of s.f.slice(1)) { e.x = -5; e.z = -5; }
  s.ais = [];
  s.room = { ...s.room, obs: [], traps: [], surf: [
    { x0: 1.5, x1: 4.5, z0: 1.5, z1: 4.5, h: PLAT_H, ramp: '' },
    { x0: 0, x1: 1.5, z0: 1.5, z1: 4.5, h: PLAT_H, ramp: 'x', from: 0, to: 1.5 },
  ] };
  const p = s.f[0];
  // par le côté sans escalier : bloqué
  p.x = 3; p.z = 0; p.y = 0;
  run(s, 60, walk(0, 1));
  assert.ok(p.z < 1.5 && p.y === 0);
  // par l'escalier : on monte
  p.x = -0.5; p.z = 3;
  run(s, 60, walk(1, 0));
  assert.ok(p.x > 1.5 && Math.abs(p.y - PLAT_H) < 1e-9, `x=${p.x} y=${p.y}`);
  // on redescend en marchant dans le vide
  run(s, 90, walk(0, -1));
  assert.equal(p.y, 0);
  // en sautant contre le bord : on atterrit dessus
  p.x = 3; p.z = 0.9;
  s.step({ ...walk(0, 1)(), press: PRESS.jump });
  run(s, 40, walk(0, 1));
  assert.ok(p.z > 1.5 && Math.abs(p.y - PLAT_H) < 1e-9, `z=${p.z} y=${p.y}`);
});

test('les pièges à pics blessent quand ils sortent', () => {
  const s = started(1);
  toFight(s);
  for (const e of s.f.slice(1)) { e.x = -5; e.z = -5; }
  s.ais = [];
  s.room = { ...s.room, obs: [], surf: [], traps: [{ x: 3, z: 3 }] };
  const p = s.f[0];
  const hp = p.hp;
  let n = 0;
  while (!trapUp(s.g.clock, 0) && n++ < 400) { p.x = 3; p.z = 3; s.step(); }
  run(s, 2);
  assert.equal(p.hp, hp - TRAP.dmg);
});

test('bénédictions et dégâts des ennemis', () => {
  const s = started(1);
  const p = s.f[0];
  p.hp = 50; BOONS.potion.apply(p); assert.equal(p.hp, 90);
  BOONS.vita.apply(p); assert.equal(p.maxHp, 120); assert.equal(p.hp, 110);
  BOONS.peau.apply(p); assert.ok(Math.abs(p.armor - 0.15) < 1e-9);
  toFight(s);
  const e = s.f[1], before = p.hp;
  s.damage(e, p, 9, 0, 0.3, 0, 1, 0);
  assert.equal(p.hp, before - Math.max(1, Math.round(9 * e.pow * 0.85)));
});

test('la mort du héros seul termine la partie', () => {
  const s = started(1);
  toFight(s);
  const p = s.f[0];
  p.hp = 1;
  s.damage(s.f[1], p, 50, 3, 0.3, 0, 1, 0);
  assert.equal(s.g.phase, 'dead');
  let ended = false;
  for (let i = 0; i < 600 && !ended; i++) { s.step(); ended = s.ev.some((e) => e[0] === 'end'); s.ev.length = 0; }
  assert.ok(ended);
});

test('un chef garde la 5e salle ; les premières salles sont plates', () => {
  const s = started(9);
  assert.equal(s.room.surf.length, 0);
  while (s.g.room < 5) s.newRoom();
  assert.ok(s.room.boss);
  assert.ok(s.f.some((f) => f.boss));
  let plats = 0;
  for (let k = 0; k < 30; k++) { s.newRoom(); plats += s.room.surf.length ? 1 : 0; }
  assert.ok(plats > 5, 'des estrades apparaissent parfois');
});

test('en ligne : deux navigateurs restent synchronisés (rollback)', () => {
  const sims = [new DungeonSim(77, ['soldier', 'orc']), new DungeonSim(77, ['soldier', 'orc'])];
  sims.forEach((s) => s.start());
  const q = [];
  let now = 0;
  const rbs = sims.map((s, me) => new Rollback(s, { me, send: (m) => q.push({ at: now + 4, to: 1 - me, m: JSON.parse(JSON.stringify(m)) }) }));
  const scripts = [0, 1].map((k) => {
    const r = new Rng(k + 5);
    let cur = NEUTRAL;
    return () => {
      if (sims[k].mustPick(k)) return pickInput(k);
      if (r.next() < 0.08) cur = { mx: quant(r.range(-1, 1)), mz: quant(r.range(-1, 1)), blk: r.next() < 0.2, press: 0 };
      return { ...cur, press: r.next() < 0.07 ? 1 << ((r.next() * 5) | 0) : 0 };
    };
  });
  for (now = 0; now < 2400; now++) {
    for (const m of q.filter((x) => x.at <= now)) rbs[m.to].receive(m.m);
    for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) q.splice(i, 1);
    rbs.forEach((rb, k) => rb.tick(scripts[k]()));
  }
  assert.ok(rbs[0].stats.rollbacks > 0);
  assert.equal(rbs[0].stats.desyncs + rbs[1].stats.desyncs, 0);
  assert.ok(rbs[0].stats.received > 100);
});

test('biomes : un par tranche de 5 salles, le boss ferme la tranche, puis le cycle reprend', () => {
  assert.equal(biomeOf(0), 'crypt');                  // salle d'armes
  for (let n = 1; n <= 5; n++) assert.equal(biomeOf(n), 'crypt');
  for (let n = 6; n <= 10; n++) assert.equal(biomeOf(n), 'mine');
  assert.equal(biomeOf(11), 'ruins');
  assert.equal(biomeOf(20), 'forge');
  assert.equal(biomeOf(21), 'crypt');
  assert.deepEqual(BIOMES, ['crypt', 'mine', 'ruins', 'forge']);
});
