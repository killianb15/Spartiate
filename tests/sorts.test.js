// Sorts au choix : Peau de pierre, Totem de vie, et le sorcier de la salle d'armes qui apprend
// n'importe quel sort à n'importe quel héros.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim, PRESS, NEUTRAL, SPELLS, SPELL_IDS, spellOf, quant } from '../sim.js';
import { DungeonSim, HUB_PADS, HERO_IDS, SORCERER, shopInput, spellKey, equip } from '../dungeon.js';
import { packFighter, unpackFighter } from '../coop.js';

const press = (a) => ({ ...NEUTRAL, press: PRESS[a] });
const run = (s, n, i0 = NEUTRAL, i1 = NEUTRAL) => { for (let k = 0; k < n; k++) s.step(i0, i1); };
const hub = (kinds = ['soldier'], seed = 5, spells) => { const s = new DungeonSim(seed, kinds, [], null, spells); s.startHub(); s.ev.length = 0; return s; };
function walkTo(s, h, x, z, max = 600) {
  for (let k = 0; k < max; k++) {
    const p = s.f[h], dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
    if (d < 0.1) return true;
    const inp = { mx: quant(dx / Math.max(d, 0.4)), mz: quant(dz / Math.max(d, 0.4)), blk: false, press: 0 };
    s.step(h ? NEUTRAL : inp, h ? inp : NEUTRAL);
  }
  return false;
}
const SPAD = HUB_PADS.find((p) => p.t === 'spell');
const R = { mx: 127, mz: 0, blk: false, press: 0 };
// le héros h va voir le sorcier et apprend le sort id avec → et attaque
function learn(s, h, id) {
  const me = (inp) => s.step(h ? NEUTRAL : inp, h ? inp : NEUTRAL);
  walkTo(s, h, SPAD.x, SPAD.z + 1.2);
  assert.ok(walkTo(s, h, SPAD.x, SPAD.z));
  assert.ok(s.f[h].shop > 0 && s.f[h].shopK === 1, 'chez le sorcier');
  me(NEUTRAL);
  for (let k = 0; k < 20 && SPELL_IDS[s.f[h].shop - 1] !== id; k++) { me(R); me(NEUTRAL); }
  assert.equal(SPELL_IDS[s.f[h].shop - 1], id);
  me(press('atk'));
  me(NEUTRAL);
  assert.equal(s.f[h].shop, 0, 'reparti');
}
// salle 1 avec les ennemis écartés (on les place soi-même)
function fightRoom(kinds = ['soldier'], spells = []) {
  const s = new DungeonSim(3, kinds, [], null, spells);
  s.start();
  s.debugGoto(1);
  while (s.g.phase !== 'fight') s.step(NEUTRAL, NEUTRAL);
  for (let i = s.g.np; i < s.f.length; i++) { s.f[i].x = 5.5; s.f[i].z = 5.5 - i * 0.01; s.ais[i] = null; }
  return s;
}

test('tous les sorts sont listés chez le sorcier, dont les deux nouveaux', () => {
  assert.deepEqual(SPELL_IDS.slice(0, HERO_IDS.length), HERO_IDS);
  assert.ok(SPELL_IDS.includes('stone') && SPELL_IDS.includes('totem'));
  const ids = new Set(SPELL_IDS.map((k) => SPELLS[k].id));
  assert.equal(ids.size, SPELL_IDS.length, 'identifiants uniques');
  // sort choisi > sort du personnage
  assert.equal(spellOf({ kind: 'orc', spell: '' }).id, 'slam');
  assert.equal(spellOf({ kind: 'orc', spell: 'totem' }).id, 'totem');
  assert.equal(spellOf({ kind: 'orc', spell: 'nimporte' }).id, 'slam');
});

test('Peau de pierre : −60 % de dégâts, recul réduit, deux fois plus lent, 5 s', () => {
  const s = new Sim(7, ['soldier', 'orc']);
  s.f[0].spell = 'stone';
  s.startMatch();
  while (s.g.phase !== 'fight') s.step();
  s.f[0].x = -3; s.f[1].x = 3;
  // vitesse de marche normale
  run(s, 20, { mx: 0, mz: 127, blk: false, press: 0 });
  const v0 = Math.hypot(s.f[0].vx, s.f[0].vz);
  run(s, 10);
  s.step(press('spell'));
  assert.equal(s.f[0].state, 'spell');
  assert.ok(s.f[0].spellCd > SPELLS.stone.cd - 0.1);
  run(s, 40);
  assert.ok(s.f[0].stoneT > SPELLS.stone.buff - 1, 'en pierre');
  run(s, 20, { mx: 0, mz: 127, blk: false, press: 0 });
  const v1 = Math.hypot(s.f[0].vx, s.f[0].vz);
  assert.ok(Math.abs(v1 / v0 - SPELLS.stone.slow) < 0.02, `ralenti (${v0.toFixed(2)} → ${v1.toFixed(2)})`);
  // coup reçu : 40 % des dégâts, à peine repoussé
  const hp = s.f[0].hp;
  s.damage(s.f[1], s.f[0], 20, 4, 0.3, 0, 1, 0);
  assert.equal(hp - s.f[0].hp, 8);
  assert.ok(Math.hypot(s.f[0].vx, s.f[0].vz) <= 4 * SPELLS.stone.knock + 1e-9);
  // fin de l'effet
  run(s, Math.ceil(SPELLS.stone.buff * 60) + 5);
  assert.equal(s.f[0].stoneT, 0);
  const hp2 = s.f[0].hp;
  s.damage(s.f[1], s.f[0], 20, 4, 0.3, 0, 1, 0);
  assert.equal(hp2 - s.f[0].hp, 20, 'plein tarif une fois redevenu chair');
});

test('Peau de pierre au donjon : se cumule avec l\'armure, protège aussi des pièges', () => {
  const s = fightRoom(['knight'], ['stone']);
  const p = s.f[0], e = s.f[1];
  p.x = 0; p.z = 0;
  s.step(press('spell'));
  run(s, 30);
  assert.ok(p.stoneT > 0);
  e.crit = 0;
  const hit = () => { const hp = p.hp; s.damage(e, p, 50, 3, 0.3, 0, 1, 0); const d = hp - p.hp; p.hp = p.maxHp; return d; };
  const stone = hit();
  p.stoneT = 0;
  const flesh = hit();
  // la pierre s'ajoute à l'armure du chevalier : 40 % de ce qu'il aurait pris
  assert.ok(Math.abs(stone / flesh - 0.4) < 0.06, `${stone} contre ${flesh}`);
  // pièges
  p.stoneT = 3;
  let hp = p.hp; s.trapHit(p); const tStone = hp - p.hp;
  p.stoneT = 0; p.hp = p.maxHp;
  hp = p.hp; s.trapHit(p); const tFlesh = hp - p.hp;
  assert.ok(tStone < tFlesh * 0.5, `piège : ${tStone} contre ${tFlesh}`);
});

test('Totem de vie : soigne chaque seconde les alliés autour (lanceur compris), pas les ennemis, pendant 8 s', () => {
  const s = fightRoom(['soldier', 'archer'], ['totem', '']);
  const a = s.f[0], b = s.f[1], e = s.f[2];
  a.x = 0; a.z = 0; b.x = 1.5; b.z = 0;
  e.x = -1.2; e.z = 0; e.state = 'idle';
  a.hp = 50; b.hp = 50; e.hp = 10; const eMax = e.maxHp;
  s.step(press('spell'), NEUTRAL);
  assert.equal(a.state, 'spell');
  run(s, 30);
  assert.ok(a.totT > SPELLS.totem.life - 0.5, 'totem planté');
  assert.ok(Math.hypot(a.totX, a.totZ) < 0.2, 'à ses pieds');
  run(s, 3 * 60);
  const heal = SPELLS.totem.heal;
  assert.ok(a.hp >= 50 + 3 * heal && a.hp <= 50 + 4 * heal, `lanceur soigné (${a.hp})`);
  assert.ok(b.hp >= 50 + 3 * heal, `équipier soigné (${b.hp})`);
  assert.ok(e.hp <= 10 && e.maxHp === eMax, 'ennemi pas soigné');
  // hors de portée : plus de soin
  b.x = 5; b.z = -5;
  const hb = b.hp;
  run(s, 2 * 60);
  assert.equal(b.hp, hb, 'trop loin du totem');
  // le totem s'éteint
  run(s, 6 * 60);
  assert.equal(a.totT, 0);
  const ha = a.hp;
  a.hp = 40;
  run(s, 2 * 60);
  assert.ok(a.hp <= 40, 'plus de soin après la fin du totem');
  assert.ok(ha > 0);
});

test('Totem de vie : jamais au-delà des PV max, disparaît à la salle suivante', () => {
  const s = fightRoom(['soldier'], ['totem']);
  const a = s.f[0];
  a.hp = a.maxHp - 2;
  s.step(press('spell'));
  run(s, 3 * 60);
  assert.equal(a.hp, a.maxHp);
  assert.ok(a.totT > 0);
  s.debugKill();
  s.debugGoto(2);
  assert.equal(s.f[0].totT, 0);
  assert.equal(s.f[0].spell, 'totem', 'le sort reste appris');
});

test('sorcier : sa dalle ouvre la liste des sorts, ← → la font défiler, attaque apprend le sort', () => {
  const s = hub();
  assert.ok(SPAD, 'dalle du sorcier');
  // la dalle ne touche ni une autre dalle ni les obstacles
  for (const o of s.room.obs) assert.ok(Math.hypot(o.x - SPAD.x, o.z - SPAD.z) > o.r + 0.5, `dalle libre (${o.kind})`);
  learn(s, 0, 'totem');
  assert.equal(s.f[0].spell, 'totem');
  assert.equal(spellOf(s.f[0]).id, 'totem');
  assert.equal(s.f[0].spellMax, SPELLS.totem.cd);
  assert.ok(s.ev.some((e) => e[0] === 'pop' && e[1] === 'Totem de vie'));
  // le sort reste en changeant de héros ou d'arme
  const orc = HUB_PADS.find((p) => p.t === 'hero' && p.id === 'orc');
  walkTo(s, 0, 0, 0); assert.ok(walkTo(s, 0, orc.x, orc.z));
  assert.equal(s.f[0].kind, 'orc');
  assert.equal(s.f[0].spell, 'totem');
  // reprendre le sort de son héros = revenir au sort par défaut ('')
  walkTo(s, 0, 0, 0);
  learn(s, 0, 'orc');
  assert.equal(s.f[0].spell, '');
  assert.equal(spellKey(s.f[0]), 'orc');
});

test('sorcier : choix direct (shopInput), bloquer pour partir sans rien changer', () => {
  const s = hub(['knight']);
  walkTo(s, 0, SPAD.x, SPAD.z + 1.2);
  walkTo(s, 0, SPAD.x, SPAD.z);
  assert.equal(s.f[0].shopK, 1);
  assert.equal(SPELL_IDS[s.f[0].shop - 1], 'knight', 'on commence sur son sort actuel');
  s.step(NEUTRAL);
  s.step({ ...NEUTRAL, blk: true });
  assert.equal(s.f[0].shop, 0);
  assert.equal(s.f[0].spell, '');
  walkTo(s, 0, SPAD.x, SPAD.z + 1.2);
  walkTo(s, 0, SPAD.x, SPAD.z);
  s.step(shopInput(SPELL_IDS.indexOf('stone')));
  assert.equal(s.f[0].spell, 'stone');
  assert.equal(s.f[0].shop, 0);
  // un numéro au-delà de la liste ne fait rien
  walkTo(s, 0, SPAD.x, SPAD.z + 1.2);
  walkTo(s, 0, SPAD.x, SPAD.z);
  s.step(shopInput(SPELL_IDS.length + 3));
  assert.equal(s.f[0].spell, 'stone');
});

test('le sort choisi suit le héros dans le donjon et se lance', () => {
  const s = new DungeonSim(9, ['robot'], ['hammer'], null, ['stone']);
  s.startHub();
  assert.equal(s.f[0].spell, 'stone');
  s.start();
  s.debugGoto(1);
  while (s.g.phase !== 'fight') s.step(NEUTRAL);
  assert.equal(spellOf(s.f[0]).id, 'stone');
  s.step(press('spell'));
  assert.equal(s.f[0].state, 'spell');
  // equip garde le sort (objets, changement de héros)
  equip(s.f[0], 'zombie', 'sword');
  assert.equal(s.f[0].spell, 'stone');
  equip(s.f[0], 'zombie', 'sword', '');
  assert.equal(s.f[0].spell, '');
  // un sort inconnu est ignoré
  const t = new DungeonSim(9, ['robot'], [], null, ['boum']);
  assert.equal(t.f[0].spell, '');
});

test('déterminisme : mêmes entrées => même partie avec pierre et totem', () => {
  const play = () => {
    const s = fightRoom(['orc', 'archer'], ['stone', 'totem']);
    for (let k = 0; k < 900; k++) {
      const i0 = k % 200 === 5 ? press('spell') : { mx: quant(Math.sin(k / 40) * 0.8), mz: 0, blk: false, press: 0 };
      const i1 = k % 300 === 7 ? press('spell') : NEUTRAL;
      s.step(i0, i1);
    }
    return s.hash();
  };
  assert.equal(play(), play());
});

test('coop : le sort choisi, la pierre et le totem passent dans les instantanés', () => {
  const s = fightRoom(['soldier'], ['totem']);
  s.step(press('spell'));
  run(s, 30);
  const f = s.f[0];
  f.stoneT = 1.5;
  const g = unpackFighter(JSON.parse(JSON.stringify(packFighter(f))));
  assert.equal(g.spell, 'totem');
  assert.equal(g.stoneT, 1.5);
  assert.ok(g.totT > 0);
  assert.ok(Math.abs(g.totX - f.totX) < 0.01 && Math.abs(g.totZ - f.totZ) < 0.01);
  assert.equal(SORCERER.x, SPAD.x);
});

test('la vitesse d\'attaque du lanceur n\'accélère ni le totem ni la pierre (temps du monde)', () => {
  for (const id of ['totem', 'stone']) {
    const s = fightRoom(['soldier'], [id]);
    const a = s.f[0], key = id === 'totem' ? 'totT' : 'stoneT';
    s.step(press('spell'));
    run(s, 50);
    assert.ok(a[key] > 2, id + ' actif');
    a.aspd = 2;                                 // coups deux fois plus rapides
    const t0 = a[key];
    for (let k = 0; k < 60; k++) s.step(k % 6 ? NEUTRAL : press('atk'));
    assert.ok(Math.abs(t0 - a[key] - 1) < 0.02, `${id} : ${(t0 - a[key]).toFixed(3)} s écoulées pour 1 s`);
  }
});

test('coop : les ennemis n\'emportent pas les champs de sort des héros', () => {
  const s = fightRoom(['soldier']);
  const o = packFighter(s.f[s.g.np]);
  assert.ok(!('spell' in o) && !('shopK' in o) && !('stoneT' in o) && !('totT' in o));
  assert.equal(unpackFighter(JSON.parse(JSON.stringify(o))).spell, '');
});
