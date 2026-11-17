import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim, BOSS, FOES, ROOM_R, bossOf } from '../dungeon.js';
import { NEUTRAL, quant } from '../sim.js';
import { AI } from '../ai.js';

// salle du colosse (salle 10), sans estrade, obstacle ni piège, combat commencé
const colosseRoom = (seed = 1, kinds = ['soldier']) => {
  const s = new DungeonSim(seed, kinds);
  s.start();
  s.debugGoto(10);
  s.room = { ...s.room, surf: [], traps: [], obs: [] };
  while (s.g.phase !== 'fight') s.step();
  s.ev.length = 0;
  return s;
};
const boss = (s) => s.f.find((f) => f.foe === 'colosse');
// fait avancer jusqu'à ce que cond soit vraie (ou n images)
const until = (s, cond, n = 600, i0 = () => NEUTRAL) => { for (let k = 0; k < n && !cond(); k++) s.step(i0(k)); return cond(); };

test('les boss alternent : chef orc (salles 5, 15…), colosse (salles 10, 20…)', () => {
  assert.equal(bossOf(5), 'boss');
  assert.equal(bossOf(10), 'colosse');
  assert.equal(bossOf(15), 'boss');
  assert.equal(bossOf(20), 'colosse');
  const s = colosseRoom();
  assert.equal(s.room.bossId, 'colosse');
  const e = boss(s);
  assert.ok(e && e.boss && e.kind === 'robot' && e.wpn === 'hammer');
  assert.equal(s.foesLeft, 1, 'le colosse arrive seul');
  assert.ok(e.maxHp > FOES.colosse.hp);
});

test('saut écrasant : l\'onde de choc blesse dans la zone, pas au-delà, et le saut l\'évite', () => {
  for (const [dist, airborne, hurt] of [[1.8, false, true], [BOSS.slam.R + 1.2, false, false], [1.8, true, false]]) {
    const s = colosseRoom(), e = boss(s), p = s.f[0];
    Object.assign(e, { x: 0, z: -2 });
    Object.assign(p, { x: 0, z: -2 + 1.8 });
    assert.ok(s.debugBoss('slam'));
    assert.equal(e.state, 'special');
    // le héros s'écarte (ou non) une fois la zone visée
    Object.assign(p, { x: e.spX + (dist - 1.8 ? dist : 0), z: e.spZ });
    const hp0 = p.hp;
    let jumped = false;
    const landed = until(s, () => e.spA === 2, 300, () => {
      // saut juste avant l'impact
      if (airborne && !jumped && e.spA === 1 && e.vy < 2) { jumped = true; return { mx: 0, mz: 0, blk: false, press: 8 }; }
      return NEUTRAL;
    });
    assert.ok(landed, 'le colosse retombe');
    assert.ok(Math.hypot(e.x - e.spX, e.z - e.spZ) < 0.6, 'il retombe sur le point visé');
    assert.equal(p.hp < hp0, hurt, `distance ${dist}, en l'air : ${airborne}`);
    until(s, () => !e.sp, 120);
    assert.equal(e.state, 'idle');
  }
});

test('charge : renverse le héros sur son passage, et le colosse s\'assomme contre le mur', () => {
  const s = colosseRoom(), e = boss(s), p = s.f[0];
  Object.assign(e, { x: 0, z: 2, yaw: Math.PI });
  Object.assign(p, { x: 0, z: -1.5 });
  assert.ok(s.debugBoss('charge'));
  const hp0 = p.hp;
  assert.ok(until(s, () => e.spA === 1, 120));
  assert.ok(until(s, () => p.hp < hp0, 60), 'le héros est touché');
  assert.ok(Math.abs(p.x) > 0.3 || p.state === 'hit', 'projeté sur le côté');
  // il continue tout droit vers le mur z = -R
  assert.ok(until(s, () => e.state === 'stun', 120), 'sonné contre le mur');
  assert.ok(e.z < -ROOM_R + 1.2);
  assert.equal(e.sp, '');
});

test('pendant une attaque spéciale, le colosse encaisse sans être interrompu', () => {
  const s = colosseRoom(), e = boss(s), p = s.f[0];
  Object.assign(p, { x: e.x + 4, z: e.z });
  s.debugBoss('slam');
  const hp0 = e.hp;
  s.damage(p, e, 10, 3, 0.3, e.x, 1, e.z);
  assert.ok(e.hp < hp0);
  assert.equal(e.state, 'special');
  assert.equal(e.sp, 'slam');
});

test('à la moitié de ses PV, le colosse enrage et appelle des zombies (un de plus à deux)', () => {
  for (const kinds of [['soldier'], ['soldier', 'orc']]) {
    const s = colosseRoom(3, kinds), e = boss(s), p = s.f[0];
    const n0 = s.foesLeft;
    e.hp = Math.floor(e.maxHp * 0.55);
    s.damage(p, e, 20, 3, 0.3, e.x, 1, e.z);
    assert.equal(e.sp, 'roar');
    assert.equal(e.rage, 1);
    assert.ok(s.ev.some((v) => v[0] === 'announce' && /ENRAGE/.test(v[1])));
    until(s, () => !e.sp, 200);
    assert.equal(s.foesLeft, n0 + kinds.length + 1);
    assert.ok(s.f.filter((f) => f.foe === 'zombie').every((z) => z.team === 1 && s.ais[z.idx]));
    // une seule rage
    s.damage(p, e, 5, 3, 0.3, e.x, 1, e.z);
    assert.notEqual(e.sp, 'roar');
  }
});

test('le colosse lance seul ses attaques spéciales pendant le combat, et le battre ouvre la salle', () => {
  const s = colosseRoom(5), e = boss(s);
  s.debugGod(true);
  const seen = new Set();
  until(s, () => { if (e.sp) seen.add(e.sp); return seen.size >= 2; }, 60 * 40);
  assert.ok(seen.has('slam') || seen.has('charge'), 'au moins une attaque spéciale');
  s.debugKill();
  assert.equal(s.g.phase, 'clear');
  assert.ok(s.ev.some((v) => v[0] === 'announce' && v[1] === "COLOSSE D'AIRAIN VAINCU !"));
});

test('combat contre le colosse : déterministe, et save/load en pleine attaque spéciale', () => {
  const play = () => {
    const s = colosseRoom(11, ['soldier', 'archer']);
    const a0 = new AI(s, 0, 2, 7), a1 = new AI(s, 1, 2, 8);
    const out = [];
    for (let k = 0; k < 1800; k++) { const dt = s.effectiveDt(); s.step(a0.update(dt), a1.update(dt)); out.push(s.hash()); }
    return out;
  };
  assert.deepEqual(play(), play());
  const s = colosseRoom(4);
  s.debugBoss('slam');
  for (let k = 0; k < 20; k++) s.step();
  const snap = s.save(), h = [];
  for (let k = 0; k < 90; k++) { s.step(); h.push(s.hash()); }
  s.load(snap);
  for (let k = 0; k < 90; k++) { s.step(); assert.equal(s.hash(), h[k]); }
});

test('outils de débogage : aller à une salle, tuer, soigner, invincible, téléporter, faire apparaître', () => {
  const s = new DungeonSim(2, ['soldier']);
  s.startHub();
  s.debugGoto(7);
  assert.equal(s.g.room, 7);
  assert.equal(s.g.phase, 'intro');
  s.debugGoto(0);
  assert.equal(s.g.phase, 'hub');
  assert.equal(s.f.length, 1);
  s.debugGoto(3);
  const p = s.f[0];
  s.debugTp(0, 2, -3);
  assert.deepEqual([p.x, p.z], [2, -3]);
  s.debugTp(0, 50, 0);
  assert.ok(p.x < ROOM_R);
  const n = s.f.length;
  assert.ok(s.debugSpawn('elite'));
  assert.equal(s.f.length, n + 1);
  assert.equal(s.ais.length, s.f.length);
  s.debugGod(true);
  const hp = p.hp;
  s.damage(s.f[1], p, 50, 3, 0.3, 0, 1, 0);
  assert.equal(p.hp, hp);
  s.debugGod(false);
  p.hp = 10;
  s.debugHeal();
  assert.equal(p.hp, p.maxHp);
  s.debugKill();
  assert.equal(s.foesLeft, 0);
  assert.equal(s.g.phase, 'clear');
  // un héros à terre se relève en changeant de salle
  p.hp = 0; s.die(p);
  s.debugGoto(4);
  assert.notEqual(p.state, 'dead');
  assert.ok(p.hp > 0);
});
