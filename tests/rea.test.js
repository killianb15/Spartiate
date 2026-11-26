import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim, REVIVE } from '../dungeon.js';
import { NEUTRAL, hashState } from '../sim.js';

// Réanimation à deux : le héros tombé reste à quatre pattes ; son équipier le relève en bloquant à côté
const duo = (seed = 3) => {
  const s = new DungeonSim(seed, ['soldier', 'orc']);
  s.start();
  while (s.g.phase !== 'fight') s.step();
  // les ennemis loin et sans IA : le test ne mesure que la réanimation
  for (const e of s.f) if (e.team === 1) { e.x = 5; e.z = -5; s.ais[e.idx] = null; }
  s.ev.length = 0;
  return s;
};
// met le héros h à terre, au centre de la salle (loin des murs), et laisse passer le ralenti du K.O.
const knockDown = (s, h) => {
  const e = s.f.find((x) => x.team === 1);
  s.f[h].hp = 1; s.damage(e, s.f[h], 999, 0, 0.3, 0, 1, 0);
  Object.assign(s.f[h], { x: 0, z: 0, vx: 0, vz: 0 });
  for (let k = 0; k < 120 && (s.g.slow < 1 || s.g.hitstop > 0); k++) s.step();
};
const BLOCK = { mx: 0, mz: 0, blk: true, press: 0 };
const steps = (s, n, in0 = NEUTRAL, in1 = NEUTRAL) => { for (let k = 0; k < n; k++) s.step(in0, in1); };

test('à deux : le héros tombé reste à quatre pattes, la partie continue', () => {
  const s = duo();
  knockDown(s, 1);
  const p = s.f[1];
  assert.equal(p.state, 'dead');
  assert.equal(p.down, 1);
  assert.equal(p.anim, 'crouch');
  assert.equal(s.g.phase, 'fight');
  assert.ok(s.ev.some((e) => e[0] === 'announce' && /À TERRE/.test(e[1])));
});

test('son équipier le relève en bloquant à côté de lui pendant REVIVE.time s', () => {
  const s = duo();
  knockDown(s, 1);
  const p = s.f[1], q = s.f[0];
  Object.assign(q, { x: p.x + 1, z: p.z });
  steps(s, Math.round(REVIVE.time * 60) - 10, BLOCK);
  assert.equal(p.down, 1, 'pas encore');
  assert.ok(p.revT > REVIVE.time * 0.9);
  steps(s, 15, BLOCK);
  assert.equal(p.down, 0);
  assert.equal(p.state, 'idle');
  assert.equal(p.hp, Math.round(p.maxHp * REVIVE.hp));
  assert.ok(s.ev.some((e) => e[0] === 'pop' && e[1] === 'RELEVÉ !'));
});

test('trop loin ou sans bloquer : rien ; la jauge redescend quand il s’arrête', () => {
  const s = duo();
  knockDown(s, 1);
  const p = s.f[1], q = s.f[0];
  Object.assign(q, { x: p.x + REVIVE.R + 1, z: p.z });
  steps(s, 120, BLOCK);
  assert.equal(p.revT, 0, 'trop loin');
  Object.assign(q, { x: p.x + 1, z: p.z });
  steps(s, 120, NEUTRAL);
  assert.equal(p.revT, 0, 'sans bloquer');
  steps(s, 60, BLOCK);
  const t = p.revT;
  assert.ok(t > 0.9);
  steps(s, 15, NEUTRAL);
  assert.ok(p.revT < t, 'la jauge redescend');
});

test('salle nettoyée : les héros tombés se relèvent ; tous à terre : fin de partie', () => {
  const s = duo();
  knockDown(s, 1);
  s.debugKill();
  assert.equal(s.g.phase, 'clear');
  assert.equal(s.f[1].down, 0);
  assert.equal(s.f[1].state, 'idle');
  const t = duo(4);
  knockDown(t, 1);
  knockDown(t, 0);
  assert.equal(t.g.phase, 'dead');
});

test('seul : tomber reste la fin de la partie', () => {
  const s = new DungeonSim(3, ['soldier']);
  s.start();
  while (s.g.phase !== 'fight') s.step();
  knockDown(s, 0);
  assert.equal(s.g.phase, 'dead');
  assert.equal(s.f[0].down, 0);
});

test('réanimation : même partie des deux côtés (rollback)', () => {
  const run = () => { const s = duo(6); knockDown(s, 1); Object.assign(s.f[0], { x: s.f[1].x + 1, z: s.f[1].z }); steps(s, 200, BLOCK); return hashState(s.save()); };
  assert.equal(run(), run());
});
