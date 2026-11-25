import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim, BOSS, FOES, ROOM_R, bossOf } from '../dungeon.js';
import { NEUTRAL, hashState } from '../sim.js';

// antre de Cerbère (salle 15), combat commencé
const lair = (seed = 1, kinds = ['soldier']) => {
  const s = new DungeonSim(seed, kinds);
  s.start();
  s.debugGoto(15);
  while (s.g.phase !== 'fight') s.step();
  s.ev.length = 0;
  return s;
};
const cerb = (s) => s.f.find((f) => f.foe === 'cerbere');
const until = (s, cond, n = 600, i0 = () => NEUTRAL) => { for (let k = 0; k < n && !cond(); k++) s.step(i0(k)); return cond(); };
// place le héros 0 à (x, z), tourné vers le boss
const put = (s, x, z) => { const p = s.f[0], e = cerb(s); Object.assign(p, { x, z, vx: 0, vz: 0 }); p.yaw = p.visTarget = Math.atan2(e.x - x, e.z - z); };

test('Cerbère garde son antre : salle dédiée, seul, quatre colonnes, ni estrade ni piège', () => {
  assert.equal(bossOf(15), 'cerbere');
  const s = lair();
  assert.equal(s.room.bossId, 'cerbere');
  assert.equal(s.room.lair, 'cerbere');
  assert.equal(s.room.surf.length, 0);
  assert.equal(s.room.traps.length, 0);
  assert.equal(s.room.obs.filter((o) => o.kind === 'column').length, 4);
  const e = cerb(s);
  assert.ok(e && e.boss && e.kind === 'cerbere' && e.wpn === 'fangs' && e.size === FOES.cerbere.size);
  assert.equal(s.foesLeft, 1);
  assert.ok(e.sp !== undefined, 'il a des attaques spéciales');
});

test('souffle de feu : brûle devant lui, pas derrière ; roulade et blocage protègent', () => {
  const burn = (place, input = NEUTRAL) => {
    const s = lair(3);
    const e = cerb(s);
    Object.assign(e, { x: 0, z: 0, vx: 0, vz: 0 });
    e.yaw = e.visTarget = 0;                       // il regarde +z
    place(s);
    const hp0 = s.f[0].hp, g0 = s.f[0].guard;
    s.startSpecial(e, 'fire');
    e.yaw = e.visTarget = 0;
    until(s, () => !e.sp, 400, () => input);
    return { dhp: hp0 - s.f[0].hp, dg: g0 - s.f[0].guard, s };
  };
  const front = burn((s) => put(s, 0, 3));
  assert.ok(front.dhp >= 15, `devant : ${front.dhp} PV perdus`);
  assert.ok(front.s.ev.some((ev) => ev[0] === 'sfx' && ev[1] === 'flame'));
  const behind = burn((s) => put(s, 0, -3));
  assert.equal(behind.dhp, 0, 'derrière lui : rien');
  const far = burn((s) => put(s, 0, BOSS.fire.R + 2));
  assert.equal(far.dhp, 0, 'hors de portée : rien');
  const block = burn((s) => put(s, 0, 3), { mx: 0, mz: 0, blk: true, press: 0 });
  assert.equal(block.dhp, 0, 'bloquer face à lui protège');
  assert.ok(block.dg > 0, 'mais coûte de la garde');
});

test('Cerbère choisit ses attaques selon la distance, et enragé appelle des chiens des enfers', () => {
  const s = lair(5);
  const e = cerb(s);
  Object.assign(e, { x: 0, z: 0 });
  put(s, 0, 3.5);
  e.spCd = 0;
  s.bossThink(e, 0);
  assert.equal(e.sp, 'fire', 'à portée de flammes');
  s.endSpecial(e);
  put(s, 0, 6.5);
  e.spCd = 0;
  s.bossThink(e, 0);
  assert.equal(e.sp, 'charge', 'loin : il charge');
  s.endSpecial(e);
  s.debugBoss('rage');
  assert.equal(e.sp, 'roar');
  until(s, () => !e.sp, 300);
  const hounds = s.f.filter((f) => f.foe === 'hound' && f.state !== 'dead');
  assert.equal(hounds.length, 2, 'deux chiens des enfers en solo');
  assert.ok(hounds.every((h) => h.team === 1 && h.kind === 'dog' && h.wpn === 'bite'));
  // debugBoss accepte le souffle de feu
  s.f[0].x = 0; s.f[0].z = 3;
  until(s, () => !e.sp && e.state !== 'stun', 300);
  assert.ok(s.debugBoss('fire'));
  assert.equal(e.sp, 'fire');
});

test('combat contre Cerbère : même graine + mêmes entrées => même partie (rollback)', () => {
  const play = () => {
    const s = lair(9, ['soldier', 'orc']);
    for (let k = 0; k < 900; k++) s.step({ mx: k % 120 < 60 ? 60 : -60, mz: 40, blk: false, press: k % 40 === 0 ? 1 : 0 }, NEUTRAL);
    return [hashState(s.save()), cerb(s).hp, s.f.filter((f) => f.foe === 'hound').length];
  };
  assert.deepEqual(play(), play());
});

test('outil de débogage : chaque boss ne lance que ses propres attaques', () => {
  const s = new DungeonSim(2, ['soldier']);
  s.start();
  s.debugGoto(10);
  while (s.g.phase !== 'fight') s.step();
  assert.equal(s.debugBoss('fire'), false, 'le colosse ne crache pas de feu');
  assert.equal(s.debugBoss('slam'), true);
});

test('on touche les grands boss au contact, avec toutes les armes de corps à corps (bug : Cerbère intouchable)', () => {
  // collé au boss (aussi près que les corps le permettent), face à lui : le coup doit porter
  const hitAtContact = (room, foe, wpn) => {
    const s = new DungeonSim(4, ['soldier'], [wpn]);
    s.start();
    s.debugGoto(room);
    while (s.g.phase !== 'fight') s.step();
    const e = s.f.find((f) => f.foe === foe), p = s.f[0];
    e.spCd = 99;                                                      // pas d'attaque spéciale pendant le test
    const d = 0.45 * (p.size + e.size) + 0.02;
    Object.assign(e, { x: 0, z: 0, vx: 0, vz: 0 });
    Object.assign(p, { x: 0, z: d, vx: 0, vz: 0, yaw: Math.PI, visTarget: Math.PI });
    s.ais[e.idx] = null;                                              // le boss ne bouge pas
    const hp0 = e.hp;
    s.startAttack(p, false);
    for (let k = 0; k < 30; k++) s.step();
    return hp0 - e.hp;
  };
  for (const wpn of ['sword', 'gloves', 'spear', 'axe', 'hammer']) {
    assert.ok(hitAtContact(15, 'cerbere', wpn) > 0, `Cerbère touché au ${wpn}`);
    assert.ok(hitAtContact(10, 'colosse', wpn) > 0, `colosse touché au ${wpn}`);
  }
});

test('Cerbère mord : son IA attaque au contact (sinon il tournait autour du héros sans frapper)', () => {
  // 5 combats de 15 s contre un héros immobile : ~80 morsures avant la correction, ~190 après
  let bites = 0;
  for (const seed of [6, 7, 8, 9, 10]) {
    const s = new DungeonSim(seed, ['soldier']);
    s.start();
    s.debugGoto(15);
    while (s.g.phase !== 'fight') s.step();
    const e = s.f.find((f) => f.foe === 'cerbere'), p = s.f[0];
    s.debugGod(true);
    for (let k = 0; k < 900; k++) {
      e.spCd = 99;                                    // seulement ses morsures
      p.x = 0; p.z = 0; p.vx = p.vz = 0;              // le héros ne bouge pas
      s.step();
      if (e.state === 'attack' && e.stateT < s.dt * 1.5) bites++;
    }
  }
  assert.ok(bites >= 130, `${bites} morsures`);
});
