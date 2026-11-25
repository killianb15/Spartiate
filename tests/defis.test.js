import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim } from '../dungeon.js';
import { hashState } from '../sim.js';

// Défis des héros : chaque héros compte ses propres victimes (kills), y compris celles de ses chiens
const started = (kinds = ['soldier'], wpns = []) => { const s = new DungeonSim(7, kinds, wpns); s.start(); s.ev.length = 0; return s; };
const toFight = (s) => { let n = 0; while (s.g.phase !== 'fight' && n++ < 200) s.step(); assert.equal(s.g.phase, 'fight'); };
const foes = (s) => s.f.filter((e) => e.team === 1);
const finish = (s, att, e) => s.damage(att, e, 9999, 0, 0.3, e.x, 1, e.z);

test('défis : chaque héros compte ses victimes, celles de ses chiens comprises', () => {
  const s = started(['soldier', 'archer'], ['tome', 'bow']);
  toFight(s);
  const [a, b] = s.heroes;
  assert.equal(a.kills, 0);
  assert.equal(b.kills, 0);
  const e = foes(s);
  finish(s, a, e[0]);
  assert.equal(a.kills, 1);
  assert.equal(s.g.kills, 1);
  // un chien invoqué par le héros 0 : sa victime compte pour son maître
  s.summon(a);
  const dog = s.f.find((f) => f.owner === a.idx);
  assert.ok(dog);
  const more = foes(s).filter((f) => f.state !== 'dead');
  if (more.length) {
    finish(s, dog, more[0]);
    assert.equal(a.kills, 2);
  }
  // victime sans tueur (piège) : comptée pour l'équipe seulement
  const last = foes(s).find((f) => f.state !== 'dead');
  if (last) {
    const before = a.kills + b.kills;
    last.hp = 0; s.die(last); s.onKO(null, last);
    assert.equal(a.kills + b.kills, before);
  }
});

test('défis : le boss abattu pendant une attaque spéciale est crédité au héros', () => {
  const s = started(['knight']);
  s.debugGoto(10);
  toFight(s);
  const boss = s.f.find((f) => f.boss);
  assert.ok(boss && boss.sp !== undefined);
  s.startSpecial(boss, 'roar');
  assert.ok(boss.sp);
  finish(s, s.f[0], boss);
  assert.equal(boss.state, 'dead');
  assert.equal(s.f[0].kills, 1);
});

test('défis : compteur remis à zéro à chaque nouveau donjon, et dans l’état sauvegardé (rollback)', () => {
  const s = started();
  toFight(s);
  finish(s, s.f[0], foes(s)[0]);
  assert.equal(s.f[0].kills, 1);
  const saved = s.save();
  assert.equal(saved.f[0].kills, 1);
  const h = hashState(saved);
  s.f[0].kills = 5;
  assert.notEqual(hashState(s.save()), h, 'compté dans l’empreinte de l’état');
  s.load(saved);
  assert.equal(s.f[0].kills, 1);
  s.startHub();
  assert.equal(s.f[0].kills, 0);
  s.f[0].kills = 3;
  s.start();
  assert.equal(s.f[0].kills, 0);
});
