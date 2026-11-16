import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim } from '../dungeon.js';
import { PRESS, NEUTRAL, CAST, STA, quant } from '../sim.js';
import { Rollback } from '../rollback.js';
import { Rng } from '../dmath.js';

const ATK = { ...NEUTRAL, press: PRESS.atk };
const run = (s, n, i0 = NEUTRAL) => { for (let k = 0; k < n; k++) s.step(i0); };
const dogs = (s) => s.f.filter((e) => e.kind === 'dog');
// une salle de combat avec un héros au grimoire ; still : ennemis immobiles (ils ne frappent pas)
function room(seed = 3, still = true, minFoes = 2) {
  const s = new DungeonSim(seed, ['soldier'], ['tome']);
  s.start();
  while (s.f.length < 1 + minFoes) s.newRoom();
  let n = 0;
  while (s.g.phase !== 'fight' && n++ < 300) s.step();
  s.room = { ...s.room, obs: [], surf: [], traps: [] };
  if (still) {
    const idle = { update: () => NEUTRAL, save: () => null };
    s.ais = s.ais.map((a, i) => (i ? idle : null));
  }
  return s;
}
// le héros invoque un chien et attend la fin de l'incantation
const cast = (s) => { s.f[0].sta = 100; s.step(ATK); run(s, Math.ceil(CAST.dur * 60) + 2); };

test('grimoire : attaquer invoque un chien allié devant le héros', () => {
  const s = room();
  const n0 = s.f.length, sta0 = s.f[0].sta;
  s.step(ATK);
  assert.equal(s.f[0].state, 'shoot', 'incantation');
  assert.equal(s.f[0].sta, sta0 - STA.summon);
  run(s, Math.ceil(CAST.rel * 60) + 1);
  assert.equal(s.f.length, n0 + 1);
  const d = s.f[n0];
  assert.equal(d.kind, 'dog');
  assert.equal(d.team, 0);
  assert.equal(d.owner, 0);
  assert.ok(s.ais[n0], 'le chien a son IA');
  assert.equal(s.inp.length, s.f.length);
  assert.ok(Math.hypot(d.x - s.f[0].x, d.z - s.f[0].z) < 1.3, 'il apparaît près du héros');
  assert.equal(s.foesLeft, n0 - 1, 'un chien n\'est pas compté comme ennemi');
});

test('grimoire : deux chiens au plus, ensuite c\'est un coup de livre', () => {
  const s = room();
  cast(s); cast(s);
  assert.equal(dogs(s).length, 2);
  s.f[0].sta = 100;
  s.step(ATK);
  assert.equal(s.f[0].state, 'attack', 'coup de livre');
  run(s, 80);
  assert.equal(dogs(s).length, 2);
});

test('grimoire : les chiens attaquent les ennemis à la place du joueur', () => {
  const s = room(3, true, 2);
  cast(s); cast(s);
  // le héros reste loin, sans rien faire
  Object.assign(s.f[0], { x: 5.5, z: 5.5 });
  const foes = s.f.filter((e) => e.team === 1);
  const hp0 = foes.map((e) => e.hp);
  let n = 0;
  while (s.foesLeft > 0 && n++ < 60 * 40) { s.f[0].x = 5.5; s.f[0].z = 5.5; s.step(); }
  assert.ok(foes.some((e, i) => e.hp < hp0[i]), 'les ennemis sont blessés');
  assert.equal(s.foesLeft, 0, `les chiens finissent la salle seuls (${foes.map((e) => e.hp).join(', ')})`);
  assert.equal(s.g.phase, 'clear');
  assert.ok(s.g.kills >= foes.length);
});

test('grimoire : les ennemis s\'en prennent aussi aux chiens, un chien tombé ne fait pas perdre', () => {
  const s = room(5, false, 1);
  cast(s);
  const d = dogs(s)[0], e = s.f.find((x) => x.team === 1);
  Object.assign(s.f[0], { x: 5.5, z: 5.5 });
  Object.assign(d, { x: 0, z: 0 });
  Object.assign(e, { x: 0, z: -1.2 });
  assert.equal(s.target(e.idx), d, 'l\'ennemi vise le chien, plus proche que le héros');
  d.hp = 1;
  s.die(d); s.onKO(e, d);
  assert.notEqual(s.g.phase, 'dead');
  assert.equal(s.dogsOf(0), 0);
  cast(s);
  assert.equal(s.dogsOf(0), 1, 'on peut en invoquer un autre');
});

test('grimoire : les chiens disparaissent à la salle suivante', () => {
  const s = room();
  cast(s); cast(s);
  s.newRoom();
  assert.equal(dogs(s).length, 0);
  assert.ok(s.f.every((e, i) => e.idx === i));
  assert.equal(s.ais.length, s.f.length);
});

test('grimoire : invocation dans la salle d\'armes pour essayer, chiens laissés derrière la porte', () => {
  const s = new DungeonSim(2, ['soldier'], ['tome']);
  s.startHub();
  cast(s);
  assert.equal(dogs(s).length, 1);
  run(s, 30);                       // pas d'ennemi : le chien attend sans planter
  s.newRoom();
  assert.equal(dogs(s).length, 0);
});

test('grimoire : même graine + mêmes entrées => même partie, chiens compris', () => {
  const play = () => {
    const s = room(11, false, 2);
    const r = new Rng(4);
    const out = [];
    for (let k = 0; k < 1500; k++) {
      const press = r.next() < 0.03 ? PRESS.atk : 0;
      s.step({ mx: quant(r.range(-1, 1)), mz: quant(r.range(-1, 1)), blk: false, press });
      out.push(s.hash());
    }
    return [out, dogs(s).length + s.g.kills];
  };
  const [a, na] = play(), [b] = play();
  assert.deepEqual(a, b);
  assert.ok(na > 0, 'des chiens ont été invoqués');
});

test('grimoire en ligne : les deux navigateurs restent synchronisés (rollback)', () => {
  const sims = [new DungeonSim(21, ['soldier', 'soldier'], ['tome', 'tome']), new DungeonSim(21, ['soldier', 'soldier'], ['tome', 'tome'])];
  sims.forEach((s) => s.start());
  const q = [];
  let now = 0;
  let desync = 0;
  const rbs = sims.map((s, me) => new Rollback(s, { me, send: (m) => q.push({ at: now + 6, to: 1 - me, m: JSON.parse(JSON.stringify(m)) }), onDesync: () => desync++ }));
  const scripts = [0, 1].map((k) => {
    const r = new Rng(k + 31);
    let cur = NEUTRAL;
    return () => {
      if (r.next() < 0.05) cur = { mx: quant(r.range(-1, 1)), mz: quant(r.range(-1, 1)), blk: false, press: 0 };
      return { ...cur, press: r.next() < 0.04 ? PRESS.atk : 0 };
    };
  });
  let maxDogs = 0;
  for (now = 0; now < 1800; now++) {
    for (const m of q.filter((x) => x.at <= now)) rbs[m.to].receive(m.m);
    for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) q.splice(i, 1);
    rbs.forEach((rb, k) => rb.tick(scripts[k]()));
    maxDogs = Math.max(maxDogs, dogs(sims[0]).length);
  }
  for (let k = 0; k < 30; k++) { for (const m of q) rbs[m.to].receive(m.m); q.length = 0; rbs.forEach((rb) => rb.tick(NEUTRAL)); }
  assert.ok(maxDogs > 0, 'des chiens ont été invoqués');
  assert.equal(desync, 0, 'aucune désynchronisation');
  assert.equal(sims[0].f.length, sims[1].f.length);
  assert.deepEqual(sims[0].f.map((e) => e.kind + e.owner), sims[1].f.map((e) => e.kind + e.owner));
});
