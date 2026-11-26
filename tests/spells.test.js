import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim, DT, PRESS, NEUTRAL, SPELLS, spellOf } from '../sim.js';
import { DungeonSim, HERO_IDS, equip } from '../dungeon.js';
import { Rollback } from '../rollback.js';
import { CoopHost, CoopGuest } from '../coop.js';

const press = (a) => ({ ...NEUTRAL, press: PRESS[a] });
const hold = { ...NEUTRAL, blk: true };
const run = (s, n, i0 = NEUTRAL, i1 = NEUTRAL) => { for (let k = 0; k < n; k++) s.step(i0, i1); };

function duel(k0, k1 = 'soldier', gap = 1.6) {
  const s = new Sim(7, [k0, k1]);
  s.startMatch();
  let n = 0;
  while (s.g.phase !== 'fight' && n++ < 400) s.step();
  s.f[0].x = -gap / 2; s.f[1].x = gap / 2; s.f[0].z = s.f[1].z = 0;
  s.f[0].yaw = Math.PI / 2; s.f[1].yaw = -Math.PI / 2;
  return s;
}

test('chaque personnage jouable possède un sort unique avec un cooldown positif', () => {
  const ids = new Set();
  for (const k of HERO_IDS) {
    const sp = SPELLS[k];
    assert.ok(sp, `sort défini pour ${k}`);
    assert.ok(sp.cd >= 5 && sp.cd <= 12, `cooldown cohérent pour ${k} (${sp.cd} s)`);
    assert.ok(!ids.has(sp.id), `identifiant de sort unique (${sp.id})`);
    ids.add(sp.id);
  }
});

test('Gladiateur (Tourbillon) : 3 coups AoE tout autour + cooldown strict', () => {
  const s = new DungeonSim(11, ['soldier']);
  s.start();
  s.debugGoto(1);
  // 2 ennemis : un devant, un derrière
  s.f[0].x = 0; s.f[0].z = 0;
  s.f[1].x = 1.4; s.f[1].z = 0;
  s.addFoe('guard', -1.4, 0);
  // neutralise d'autres ennemis loin
  for (let i = 3; i < s.f.length; i++) { s.f[i].x = 5; s.f[i].z = 5; }
  // laisse passer l'intro
  while (s.g.phase !== 'fight') s.step(NEUTRAL, NEUTRAL);
  s.f[0].x = 0; s.f[0].z = 0;
  s.f[1].x = 1.4; s.f[1].z = 0;
  s.f[2].x = -1.4; s.f[2].z = 0;
  const hp1 = s.f[1].hp, hp2 = s.f[2].hp;

  s.step(press('spell'), NEUTRAL);
  assert.equal(s.f[0].state, 'spell');
  assert.ok(s.f[0].spellCd > SPELLS.soldier.cd - 0.1, 'cooldown lancé');
  for (let n = 0; s.f[0].state === 'spell' && n < 200; n++) s.step(NEUTRAL, NEUTRAL);
  assert.notEqual(s.f[0].state, 'spell', 'Tourbillon terminé');
  assert.ok(s.f[1].hp < hp1, 'ennemi devant touché par le Tourbillon');
  assert.ok(s.f[2].hp < hp2, 'ennemi derrière aussi touché (AoE 360°)');

  // Impossible de relancer pendant le cooldown
  assert.ok(s.f[0].spellCd > 1, 'encore en cooldown');
  s.step(press('spell'), NEUTRAL);
  assert.notEqual(s.f[0].state, 'spell', 'bloqué pendant le cooldown');

  // Nettoie la salle pour vérifier l'écoulement exact du cooldown sans interruption ennemie
  s.debugKill();
  // Après expiration du cooldown, on peut relancer
  run(s, Math.ceil(SPELLS.soldier.cd * 60) + 20);
  assert.equal(s.f[0].spellCd, 0);
  s.step(press('spell'), NEUTRAL);
  assert.equal(s.f[0].state, 'spell', 'relançable une fois rechargé');
});

test('Mirmillon (Estoc fulgurant) : percée rapide qui touche sur sa trajectoire', () => {
  const s = duel('human', 'orc', 2.4);
  const x0 = s.f[0].x, hp1 = s.f[1].hp;
  s.step(press('spell'));
  run(s, 30);
  assert.ok(s.f[0].x > x0 + 1.5, 'le Mirmillon a bondi en avant');
  assert.equal(s.f[1].hp, hp1 - SPELLS.human.dmg, 'cible transpercée une seule fois');
});

test('Orc (Frappe sismique) : onde de choc étourdissante, esquivable en sautant', () => {
  const s = duel('orc', 'soldier', 2.2);
  s.step(press('spell'));
  run(s, 26);
  assert.equal(s.f[1].hp, 100 - SPELLS.orc.dmg, 'dégâts sismiques infligés');
  assert.equal(s.f[1].state, 'stun', 'adversaire étourdi par le choc');

  // En sautant juste avant l'impact, on esquive l'onde
  const s2 = duel('orc', 'soldier', 2.2);
  s2.step(press('spell'));
  run(s2, 12);
  s2.step(NEUTRAL, press('jump'));
  run(s2, 20);
  assert.equal(s2.f[1].hp, 100, 'saut esquive la Frappe sismique');
});

test('Archère (Pluie de flèches) : recule et tire 5 flèches en éventail', () => {
  const s = duel('archer', 'orc', 4.5);
  const x0 = s.f[0].x;
  s.step(press('spell'));
  run(s, Math.ceil(SPELLS.archer.hitAt * 60) + 2);
  assert.equal(s.pr.length, 5, '5 flèches tirées en éventail');
  assert.ok(s.f[0].x < x0 - 0.3, 'l’archère a reculé');
  run(s, 30);
  assert.ok(s.f[1].hp < 100, 'au moins une flèche de la salve a touché');
});

test('Chevalier (Rempart sacré) : repousse, restaure la garde et réduit de 50 % les dégâts', () => {
  const s = duel('knight', 'soldier', 1.6);
  s.f[0].guard = 20;
  const hp1 = s.f[1].hp;
  s.step(press('spell'));
  run(s, 14);
  assert.equal(s.f[0].guard, 100, 'garde restaurée à 100');
  assert.ok(s.f[0].spellBuffT > 3, 'buff défensif actif');
  assert.equal(s.f[1].hp, hp1 - SPELLS.knight.dmg, 'onde repousse et blesse autour');

  // Pendant le buff, un coup normal de glaive (9 dégâts) ne fait que ~5 dégâts (arrondi de 4.5)
  const hpBefore = s.f[0].hp;
  s.damage(s.f[1], s.f[0], 10, 0, 0.2, 0, 1, 0);
  assert.equal(s.f[0].hp, hpBefore - 5, 'dégâts réduits de 50 % en arène');

  // Même réduction cumulée à l'armure en Donjon (15 % armure + 50 % Rempart sacré)
  const d = new DungeonSim(3, ['knight']);
  d.start();
  d.debugGoto(1);
  while (d.g.phase !== 'fight') d.step(NEUTRAL, NEUTRAL);
  d.f[0].spellBuffT = 3;
  const foe = d.f[1];
  const dHp = d.f[0].hp;
  d.damage(foe, d.f[0], 20, 0, 0.2, 0, 1, 0);
  const expected = Math.max(1, Math.round(20 * foe.pow * (1 - d.f[0].armor) * (1 - SPELLS.knight.reduce)));
  assert.equal(d.f[0].hp, dHp - expected, 'réduction exacte en donjon sans double application');
});

test('Zombie (Nuée putride) : dégâts AoE et vol de vie plafonné à maxHp', () => {
  const s = duel('zombie', 'soldier', 2.0);
  s.f[0].hp = 60;
  s.step(press('spell'));
  run(s, 20);
  assert.equal(s.f[1].hp, 100 - SPELLS.zombie.dmg);
  assert.equal(s.f[0].hp, 60 + SPELLS.zombie.heal, 'soin +7 PV pour 1 cible touchée');
});

test('Automate (Décharge d’arc) : brise la garde en blocage et étourdit', () => {
  const s = duel('robot', 'knight', 2.0);
  s.step(press('spell'), hold);
  run(s, 22, NEUTRAL, hold);
  assert.equal(s.f[1].guard, 0, 'garde brisée instantanément');
  assert.equal(s.f[1].state, 'stun', 'adversaire étourdi');
  assert.ok(s.f[1].hp < 100);
});

test('donjon : seuls les héros lancent des sorts ; cooldown remis à zéro au changement de salle ou héros', () => {
  const s = new DungeonSim(5, ['soldier']);
  s.start();
  s.debugGoto(1);
  assert.equal(s.canCastSpell(s.f[0]), true);
  assert.equal(s.canCastSpell(s.f[1]), false, 'ennemi ne lance pas de sort de héros');

  s.f[0].spellCd = 5;
  s.newRoom();
  assert.equal(s.f[0].spellCd, 0, 'cooldown remis à zéro à la salle suivante');

  s.f[0].spellCd = 4;
  equip(s.f[0], 'knight', 'sword');
  assert.equal(s.f[0].spellCd, 0, 'cooldown remis à zéro au changement de héros');
  assert.equal(s.f[0].spellMax, SPELLS.knight.cd);
});

test('réseau : le bit PRESS.spell (32) traverse Rollback et CoopHost/CoopGuest sans perte', () => {
  // 1) Rollback (Arène 1v1 en ligne)
  const sA = new Sim(42, ['soldier', 'robot']); sA.startMatch();
  const sB = new Sim(42, ['soldier', 'robot']); sB.startMatch();
  const qA = [], qB = [];
  const rbA = new Rollback(sA, { me: 0, send: (m) => qB.push(JSON.parse(JSON.stringify(m))) });
  const rbB = new Rollback(sB, { me: 1, send: (m) => qA.push(JSON.parse(JSON.stringify(m))) });
  for (let i = 0; i < 140; i++) {
    const i0 = i === 105 ? press('spell') : NEUTRAL;
    const i1 = i === 110 ? press('spell') : NEUTRAL;
    rbA.tick(i0); rbB.tick(i1);
    while (qA.length) rbA.receive(qA.shift());
    while (qB.length) rbB.receive(qB.shift());
  }
  assert.ok(sA.f[0].spellCd > 0 && sA.f[1].spellCd > 0, 'les deux sorts ont été déclenchés en arène en ligne');
  assert.equal(sA.hash(), sB.hash(), 'empreintes identiques après sorts en rollback');

  // 2) CoopHost / CoopGuest (Donjon à 2 en ligne)
  const d = new DungeonSim(12, ['soldier', 'knight']);
  d.startHub();
  let t = 1000;
  const qH = [], qG = [];
  const host = new CoopHost(d, { sid: 9, now: () => t, send: (m) => qG.push(JSON.parse(JSON.stringify(m))) });
  const guest = new CoopGuest({ sid: 9, now: () => t, send: (m) => qH.push(JSON.parse(JSON.stringify(m))) });
  for (let i = 0; i < 40; i++) {
    t += DT * 1000;
    while (qH.length) host.receive(qH.shift());
    while (qG.length) guest.receive(qG.shift());
    host.tick(i === 5 ? press('spell') : NEUTRAL);
    guest.tick(i === 8 ? press('spell') : NEUTRAL);
    guest.interpolate(DT);
  }
  assert.ok(d.f[0].spellCd > 0, 'sort hôte lancé en coop');
  assert.ok(d.f[1].spellCd > 0, 'sort invité reçu et lancé en coop');
  assert.ok(guest.sim.f[0].spellCd > 0 && guest.sim.f[1].spellCd > 0, 'cooldowns synchronisés côté invité');
  assert.ok(guest.sim.f[1].spellBuffT > 0, 'buff du Chevalier synchronisé côté invité');
});
