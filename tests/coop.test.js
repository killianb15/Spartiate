import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim, COOP, FOES, BOSS } from '../dungeon.js';

// Adaptation au nombre de joueurs (réglée avec tools/equilibrage.mjs : à deux, chacun subit autant qu'en solo)
const room = (n, np) => {
  const s = new DungeonSim(3, np > 1 ? ['soldier', 'soldier'] : ['soldier']);
  s.start();
  s.debugGoto(n);
  return s;
};
const foes = (s) => s.f.filter((e) => e.team === 1);

test('à deux : plus d’ennemis (au plus COOP.cap) et plus de PV, sans inflation des dégâts', () => {
  for (const n of [1, 4, 8, 12]) {
    const a = room(n, 1), b = room(n, 2);
    const solo = Math.min(5, 1 + Math.floor(n / 2));
    assert.equal(foes(a).length, solo, `salle ${n} seul`);
    assert.equal(foes(b).length, Math.min(COOP.cap, Math.ceil(solo * COOP.count)), `salle ${n} à deux`);
    // même type d'ennemi : PV et dégâts adaptés
    const e1 = foes(a)[0], e2 = foes(b).find((e) => e.foe === e1.foe);
    if (e2) {
      assert.equal(e2.maxHp, Math.round(FOES[e1.foe].hp * (1 + 0.07 * (n - 1)) * COOP.hp));
      assert.ok(Math.abs(e2.pow / e1.pow - COOP.pow) < 1e-9);
    }
  }
});

test('à deux : boss adaptés (plus de PV, dégâts et rythme mesurés)', () => {
  for (const [n, id] of [[5, 'boss'], [10, 'colosse'], [15, 'cerbere'], [20, 'squelette']]) {
    const a = room(n, 1), b = room(n, 2);
    const e1 = a.f.find((e) => e.foe === id), e2 = b.f.find((e) => e.foe === id);
    assert.ok(Math.abs(e2.maxHp / e1.maxHp - COOP.bossHp) < 0.01, `${id} PV`);
    assert.ok(Math.abs(e2.pow / e1.pow - COOP.bossPow) < 1e-9, `${id} dégâts`);
    if (e1.sp !== undefined) assert.ok(Math.abs(e2.spCd / e1.spCd - COOP.bossCd) < 1e-9, `${id} rythme`);
  }
  // escorte du chef orc : salle 5 : 1 orc seul, 2 à deux ; salle 25 : 4 seul, 5 à deux
  assert.equal(foes(room(5, 1)).filter((e) => e.foe === 'grunt').length, 1);
  assert.equal(foes(room(5, 2)).filter((e) => e.foe === 'grunt').length, 2);
  assert.equal(foes(room(25, 1)).filter((e) => e.foe === 'grunt').length, 4);
  assert.equal(foes(room(25, 2)).filter((e) => e.foe === 'grunt').length, COOP.escortCap);
});

test('seul : rien ne change (aucun multiplicateur)', () => {
  const s = room(8, 1), e = foes(s)[0];
  assert.equal(e.maxHp, Math.round(FOES[e.foe].hp * (1 + 0.07 * 7)));
  const b = room(10, 1).f.find((x) => x.foe === 'colosse');
  assert.equal(b.spCd, BOSS.first);
});
