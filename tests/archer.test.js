import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim, PRESS, NEUTRAL, SHOT } from '../sim.js';
import { DungeonSim } from '../dungeon.js';
import { AI } from '../ai.js';

const press = (a) => ({ ...NEUTRAL, press: PRESS[a] });
const hold = { ...NEUTRAL, blk: true };
function duel(kinds = ['archer', 'orc'], gap = 5) {
  const s = new Sim(1, kinds);
  s.startMatch();
  let n = 0;
  while (s.g.phase !== 'fight' && n++ < 400) s.step();
  s.f[0].x = -gap / 2; s.f[1].x = gap / 2; s.f[0].z = s.f[1].z = 0;
  s.f[0].yaw = Math.PI / 2; s.f[1].yaw = -Math.PI / 2;
  return s;
}
const run = (s, n, i0 = NEUTRAL, i1 = NEUTRAL) => { for (let k = 0; k < n; k++) s.step(i0, i1); };

test('l\'archer tire une flèche qui touche à distance', () => {
  const s = duel();
  assert.ok(s.f[0].arch && !s.f[1].arch);
  s.step(press('atk'));
  run(s, Math.ceil(SHOT.rel * 60) + 2);
  assert.equal(s.pr.length, 1);
  run(s, 30);
  assert.equal(s.f[1].hp, 100 - SHOT.dmg);
  assert.equal(s.pr.length, 0);
});

test('bloquer une flèche use la garde ; une roulade la laisse passer', () => {
  let s = duel();
  s.step(press('atk'), hold);
  run(s, 40, NEUTRAL, hold);
  assert.equal(s.f[1].hp, 100);
  assert.equal(s.f[1].guard, 100 - SHOT.guard);
  s = duel();
  s.step(press('atk'));
  run(s, 12);
  s.step(NEUTRAL, { mx: 0, mz: 127, blk: false, press: PRESS.roll });   // roulade sur le côté, au moment de l'impact
  run(s, 30);
  assert.equal(s.f[1].hp, 100);
});

test('une parade renvoie la flèche vers le tireur', () => {
  const s = duel(['archer', 'soldier'], 4);
  s.step(press('atk'));
  // la flèche part à SHOT.rel et met ~3.5/15 s à arriver : parade juste avant l'impact
  run(s, Math.round((SHOT.rel + 0.2) * 60) - 3);
  s.step(NEUTRAL, press('par'));
  run(s, 40);
  assert.equal(s.f[1].hp, 100);
  assert.equal(s.f[0].hp, 100 - SHOT.dmg, 'le tireur prend sa propre flèche');
});

test('archer contre archer (IA) : partie déterministe, des flèches tirées des deux côtés', () => {
  const play = () => {
    const s = new Sim(9, ['archer', 'archer']);
    s.startMatch();
    const a = [new AI(s, 0, 2, 3), new AI(s, 1, 1, 4)];
    let shots = 0;
    const hashes = [];
    for (let k = 0; k < 4000; k++) {
      const dt = s.effectiveDt();
      s.step(a[0].update(dt), a[1].update(dt));
      shots += s.ev.filter((e) => e[0] === 'sfx' && e[1] === 'bow').length;
      s.ev.length = 0;
      hashes.push(s.hash());
    }
    return { hashes, shots };
  };
  const x = play(), y = play();
  assert.deepEqual(x.hashes, y.hashes);
  assert.ok(x.shots > 10, `tirs : ${x.shots}`);
});

test('équilibrage : l’archer gagne une bonne part des rounds contre les combattants au corps à corps', () => {
  let won = 0, total = 0;
  for (let seed = 1; seed <= 12; seed++) for (const foe of ['soldier', 'orc']) {
    const me = seed % 2 ? 0 : 1, kinds = me ? [foe, 'archer'] : ['archer', foe];
    const s = new Sim(seed * 13, kinds);
    s.startMatch();
    const a = [new AI(s, 0, 1, seed * 7), new AI(s, 1, 1, seed * 7 + 1)];
    for (let k = 0; k < 60 * 400 && s.g.phase !== 'end'; k++) { const dt = s.effectiveDt(); s.step(a[0].update(dt), a[1].update(dt)); s.ev.length = 0; }
    won += s.wins[me]; total += s.wins[0] + s.wins[1];
  }
  assert.ok(won / total > 0.2 && won / total < 0.8, `archer : ${won} rounds gagnés sur ${total}`);
});

test('donjon : héros archer, archers ennemis, flèches arrêtées par les murs et les colonnes', () => {
  const s = new DungeonSim(4, ['archer']);
  s.start();
  assert.ok(s.f[0].arch);
  let archers = 0;
  for (let k = 0; k < 15; k++) { s.newRoom(); archers += s.f.filter((f) => f.foe === 'archer').length; }
  assert.ok(archers > 3);
  s.room = { ...s.room, obs: [{ x: 0, z: -2, r: 0.4, kind: 'column' }], surf: [], traps: [] };
  s.pr = [{ x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: -15, o: 0, t: 0 }];
  s.dt = 1 / 60;
  for (let k = 0; k < 20; k++) s.updateArrows();
  assert.equal(s.pr.length, 0);
  // une flèche ennemie ne blesse pas les autres ennemis
  const e = s.f.find((f) => f.idx >= s.g.np);
  assert.equal(s.foeOf(e.idx, s.f[s.g.np === 1 && s.f.length > 2 ? 2 : 0]), s.f.length > 2 ? false : true);
  assert.equal(s.foeOf(e.idx, s.f[0]), true);
});
