import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim, HUB_PADS, HEROES, ROOM_R, WEAPON_IDS, MERCHANT, shopInput } from '../dungeon.js';
import { Sim, PRESS, NEUTRAL, WEAPONS, quant } from '../sim.js';
import { Rollback } from '../rollback.js';
import { Rng } from '../dmath.js';

const hub = (kinds = ['soldier'], seed = 5) => { const s = new DungeonSim(seed, kinds); s.startHub(); s.ev.length = 0; return s; };
// avance le héros h vers (x, z) en marchant, jusqu'à y être
function walkTo(s, h, x, z, max = 600) {
  for (let k = 0; k < max; k++) {
    const p = s.f[h], dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
    if (d < 0.1) return true;
    const inp = { mx: quant(dx / Math.max(d, 0.4)), mz: quant(dz / Math.max(d, 0.4)), blk: false, press: 0 };
    s.step(h ? NEUTRAL : inp, h ? inp : NEUTRAL);
  }
  return false;
}
const pad = (t, id) => HUB_PADS.find((p) => p.t === t && p.id === id);
const SHOP = HUB_PADS.find((p) => p.t === 'shop');
const R = { mx: 127, mz: 0, blk: false, press: 0 }, L = { mx: -127, mz: 0, blk: false, press: 0 };
const ATK = { ...NEUTRAL, press: PRESS.atk };
// le héros h va voir le marchand (en passant devant le comptoir) et y achète l'arme id avec ← → et attaque
function buy(s, h, id) {
  const me = (inp) => s.step(h ? NEUTRAL : inp, h ? inp : NEUTRAL);
  walkTo(s, h, SHOP.x, SHOP.z + 1.2);
  assert.ok(walkTo(s, h, SHOP.x, SHOP.z));
  assert.ok(s.f[h].shop > 0, 'dans la boutique');
  me(NEUTRAL);
  for (let k = 0; k < 20 && WEAPON_IDS[s.f[h].shop - 1] !== id; k++) { me(R); me(NEUTRAL); }
  assert.equal(WEAPON_IDS[s.f[h].shop - 1], id);
  me(ATK);
  me(NEUTRAL);
  assert.equal(s.f[h].shop, 0, 'sorti de la boutique');
}

test('salle d\'armes : aucun ennemi, porte ouverte, une dalle par héros et par arme', () => {
  const s = hub();
  assert.equal(s.g.phase, 'hub');
  assert.equal(s.g.room, 0);
  assert.equal(s.f.length, 1);
  assert.ok(s.g.exitOpen);
  assert.equal(HUB_PADS.filter((p) => p.t === 'hero').length, Object.keys(HEROES).length);
  assert.equal(HUB_PADS.filter((p) => p.t === 'shop').length, 1);
  assert.equal(WEAPON_IDS.length, Object.keys(WEAPONS).filter((k) => !WEAPONS[k].hidden).length);
  // les dalles ne se chevauchent pas
  for (const a of HUB_PADS) for (const b of HUB_PADS) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 1.1);
});

test('marcher sur une dalle change de héros (avec son talent) puis d\'arme', () => {
  const s = hub();
  const k = pad('hero', 'knight');
  assert.ok(walkTo(s, 0, k.x, k.z));
  assert.equal(s.f[0].kind, 'knight');
  assert.equal(s.f[0].armor, 0.15);
  const o = pad('hero', 'orc');
  assert.ok(walkTo(s, 0, o.x, o.z));
  assert.equal(s.f[0].kind, 'orc');
  assert.equal(s.f[0].armor, 0);
  assert.equal(s.f[0].maxHp, 120);
  buy(s, 0, 'bow');
  assert.equal(s.f[0].wpn, 'bow');
  assert.ok(s.f[0].arch);
  walkTo(s, 0, SHOP.x, SHOP.z + 1.5);
  buy(s, 0, 'spear');
  assert.equal(s.f[0].wpn, 'spear');
  assert.ok(!s.f[0].arch);
  assert.equal(s.f[0].kind, 'orc');
});

test('l\'archère prend son arc, et le garde-t-on en changeant de héros ? seulement si on l\'avait choisi', () => {
  const s = hub();
  const a = pad('hero', 'archer');
  walkTo(s, 0, a.x, a.z);
  assert.equal(s.f[0].wpn, 'bow');         // arme par défaut de l'archère
  const r = pad('hero', 'robot');
  walkTo(s, 0, r.x, r.z);
  assert.equal(s.f[0].wpn, 'sword');       // l'arc n'avait pas été choisi : retour au glaive
  buy(s, 0, 'tower');
  walkTo(s, 0, 0, 0);
  walkTo(s, 0, a.x, a.z);
  assert.equal(s.f[0].wpn, 'tower');       // une arme choisie est gardée
});

test('franchir la porte mène à la salle 1 avec le héros et l\'arme choisis', () => {
  const s = hub(['soldier', 'soldier']);
  const z = pad('hero', 'zombie');
  walkTo(s, 0, z.x, z.z); walkTo(s, 0, 0, 0); buy(s, 0, 'spear');
  walkTo(s, 0, SHOP.x, -2.5); walkTo(s, 0, 0, -2.5);
  let n = 0;
  while (s.g.room === 0 && n++ < 600) s.step({ mx: 0, mz: -127, blk: false, press: 0 }, NEUTRAL);
  assert.equal(s.g.room, 1);
  assert.equal(s.f[0].kind, 'zombie');
  assert.equal(s.f[0].wpn, 'spear');
  assert.equal(s.f[0].leech, 1);
  assert.equal(s.f[1].kind, 'soldier');
  assert.ok(s.f.length > 2, 'des ennemis');
  assert.ok((s.room.exit === 'z' ? s.f[0].z : s.f[0].x) > ROOM_R - 1);
});

test('on ne traverse pas les statues', () => {
  const s = hub();
  const k = pad('hero', 'knight');
  walkTo(s, 0, k.x, k.z);
  for (const [mx, mz] of [[-127, 0], [-127, 40], [-127, -40]]) {
    for (let i = 0; i < 120; i++) s.step({ mx, mz, blk: false, press: 0 }, NEUTRAL);
    assert.ok(s.f[0].x > -5.9 + 0.7, `x = ${s.f[0].x}`);
  }
  // ni le comptoir du marchand (on longe ses côtés sans passer derrière)
  for (const sx of [-1, 1]) {
    walkTo(s, 0, SHOP.x + sx * 2, -3);
    for (let i = 0; i < 120; i++) s.step({ mx: 0, mz: -127, blk: false, press: 0 }, NEUTRAL);
    for (let i = 0; i < 200; i++) {
      s.step({ mx: -sx * 127, mz: -40, blk: false, press: 0 }, NEUTRAL);
      const p = s.f[0];
      if (Math.abs(p.x - SHOP.x) < 1.2) assert.ok(p.z > MERCHANT.counterZ + 0.6, `x = ${p.x}, z = ${p.z}`);
    }
    s.f[0].shop = 0;
  }
});

test('boutique : on y entre sur la dalle, face au marchand, sans bouger ; ← → font défiler les armes', () => {
  const s = hub();
  walkTo(s, 0, SHOP.x, SHOP.z + 1.2);
  walkTo(s, 0, SHOP.x, SHOP.z);
  const p = s.f[0];
  assert.equal(p.shop, 1 + WEAPON_IDS.indexOf('sword'));
  assert.equal(p.yaw, Math.PI);
  // la direction tenue en arrivant ne compte pas tant qu'on ne l'a pas relâchée
  for (let k = 0; k < 10; k++) s.step(R);
  assert.equal(p.shop, 1);
  s.step(NEUTRAL);
  s.step(R); s.step(R); s.step(NEUTRAL); s.step(R);
  assert.equal(WEAPON_IDS[p.shop - 1], WEAPON_IDS[2], "une flèche tenue ne compte qu'une fois");
  s.step(NEUTRAL); s.step(L); s.step(NEUTRAL); s.step(L); s.step(NEUTRAL); s.step(L);
  assert.equal(p.shop, WEAPON_IDS.length, 'on fait le tour');
  const x = p.x, z = p.z;
  for (let k = 0; k < 30; k++) s.step({ mx: 0, mz: -127, blk: false, press: 0 });
  assert.equal(p.x, x); assert.equal(p.z, z);
  assert.equal(p.wpn, 'sword', 'rien acheté');
  // reculer : on s'en va sans rien prendre, et on ne rentre pas tant qu'on n'a pas quitté la dalle
  for (let k = 0; k < 40; k++) s.step({ mx: 0, mz: 127, blk: false, press: 0 });
  assert.equal(p.shop, 0);
  assert.equal(p.wpn, 'sword');
  assert.ok(p.z > SHOP.z + 0.5);
});

test('boutique : choix direct (clic ou touches 1 à 8), bloquer pour partir ; ignoré hors de la boutique', () => {
  const s = hub();
  s.step(shopInput(WEAPON_IDS.indexOf('hammer')));
  assert.equal(s.f[0].wpn, 'sword', 'hors de la boutique : sans effet');
  assert.equal(s.f[0].x, 1);
  walkTo(s, 0, SHOP.x, SHOP.z + 1.2);
  walkTo(s, 0, SHOP.x, SHOP.z);
  s.step(shopInput(WEAPON_IDS.indexOf('hammer')));
  assert.equal(s.f[0].wpn, 'hammer');
  assert.equal(s.f[0].shop, 0);
  walkTo(s, 0, SHOP.x, SHOP.z + 1.5);
  walkTo(s, 0, SHOP.x, SHOP.z);
  s.step(NEUTRAL);
  s.step(R); s.step({ ...NEUTRAL, blk: true });
  assert.equal(s.f[0].shop, 0);
  assert.equal(s.f[0].wpn, 'hammer');
});

// ---------- armes ----------
function duel(w0, w1 = 'sword', gap = 1.5) {
  const s = new Sim(1, ['soldier', 'orc']);
  s.f[0].wpn = w0; s.f[1].wpn = w1;
  s.startMatch();
  let n = 0;
  while (s.g.phase !== 'fight' && n++ < 400) s.step();
  s.f[0].x = -gap / 2; s.f[1].x = gap / 2; s.f[0].z = s.f[1].z = 0;
  s.f[0].yaw = Math.PI / 2; s.f[1].yaw = -Math.PI / 2;
  return s;
}
const hit = (s) => { const hp = s.f[1].hp; s.step({ ...NEUTRAL, press: PRESS.atk }); for (let k = 0; k < 30; k++) s.step(); return hp - s.f[1].hp; };

test('la lance touche de plus loin que le glaive', () => {
  assert.equal(hit(duel('sword', 'sword', 2.3)), 0);
  assert.ok(hit(duel('spear', 'sword', 2.3)) > 0);
  assert.ok(hit(duel('sword', 'sword', 1.3)) > 0);
});

test('la lance n\'enchaîne que deux coups, le glaive trois', () => {
  const combo = (w) => {
    const s = duel(w, 'sword', 1.2);
    s.f[1].hp = 999;
    let max = 0;
    for (let k = 0; k < 90; k++) { s.step({ ...NEUTRAL, press: k % 6 === 0 ? PRESS.atk : 0 }); max = Math.max(max, s.f[0].combo); s.f[1].x = s.f[0].x + 1.2; }
    return max;
  };
  assert.equal(combo('spear'), 2);
  assert.equal(combo('sword'), 3);
});

test('le pavois perd moins de garde au blocage, l\'arc davantage', () => {
  const guardLoss = (w) => {
    const s = duel('sword', w, 1.3);
    s.step({ ...NEUTRAL, press: PRESS.atk }, { ...NEUTRAL, blk: true });
    for (let k = 0; k < 30; k++) s.step(NEUTRAL, { ...NEUTRAL, blk: true });
    return 100 - s.f[1].guard;
  };
  const sw = guardLoss('sword'), tw = guardLoss('tower'), bw = guardLoss('bow');
  assert.ok(sw > 0);
  assert.ok(tw < sw && bw > sw, `${tw} < ${sw} < ${bw}`);
});

test('en ligne : la salle d\'armes reste synchronisée (rollback)', () => {
  const sims = [new DungeonSim(31, ['soldier', 'soldier']), new DungeonSim(31, ['soldier', 'soldier'])];
  sims.forEach((s) => s.startHub());
  const q = [];
  let now = 0;
  const rbs = sims.map((s, me) => new Rollback(s, { me, send: (m) => q.push({ at: now + 5, to: 1 - me, m: JSON.parse(JSON.stringify(m)) }) }));
  // chaque joueur va d'une dalle tirée au hasard à une autre, en passant par le centre
  const scripts = [0, 1].map((k) => {
    const r = new Rng(k + 11);
    let goal = null, center = true;
    return () => {
      const p = sims[k].f[k];
      if (!goal || Math.hypot(goal.x - p.x, goal.z - p.z) < 0.15) {
        center = !center;
        const pd = HUB_PADS[(r.next() * HUB_PADS.length) | 0];
        goal = center ? { x: 1, z: 1 } : r.next() < 0.4 ? SHOP : pd;
      }
      if (p.shop) {   // chez le marchand : on fait défiler, on achète ou on s'en va
        const x = r.next();
        if (x < 0.03) goal = { x: 1, z: 1 };
        return x < 0.03 ? { mx: 0, mz: 127, blk: false, press: 0 } : x < 0.3 ? { mx: 127, mz: 0, blk: false, press: 0 }
          : x < 0.33 ? { ...NEUTRAL, press: PRESS.atk } : x < 0.35 ? shopInput((r.next() * 8) | 0) : NEUTRAL;
      }
      const dx = goal.x - p.x, dz = goal.z - p.z, d = Math.max(0.4, Math.hypot(dx, dz));
      return { mx: quant(dx / d), mz: quant(dz / d), blk: false, press: r.next() < 0.02 ? PRESS.jump : 0 };
    };
  });
  const kinds = new Set();
  let shopped = 0;
  for (now = 0; now < 3000; now++) {
    for (const m of q.filter((x) => x.at <= now)) rbs[m.to].receive(m.m);
    for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= now) q.splice(i, 1);
    rbs.forEach((rb, k) => rb.tick(scripts[k]()));
    sims.forEach((s) => s.heroes.forEach((h) => { kinds.add(h.kind + h.wpn); if (h.shop) shopped++; }));
  }
  for (let k = 0; k < 20; k++) { for (const m of q) rbs[m.to].receive(m.m); q.length = 0; rbs.forEach((rb) => rb.tick(NEUTRAL)); }
  const f = Math.min(rbs[0].confirmed ?? 0, rbs[1].confirmed ?? 0);
  assert.ok(kinds.size > 1, 'les héros ont changé d\'équipement');
  assert.ok(shopped > 0, "quelqu'un est passé chez le marchand");
  assert.deepEqual(sims[0].f.map((h) => h.kind + h.wpn), sims[1].f.map((h) => h.kind + h.wpn), `image ${f}`);
});

test('hache : 2 coups plus forts ; marteau : 1 seul coup qui ruine la garde', () => {
  assert.ok(hit(duel('axe', 'sword', 1.3)) > hit(duel('sword', 'sword', 1.3)));
  assert.ok(hit(duel('hammer', 'sword', 1.3)) > hit(duel('axe', 'sword', 1.3)));
  const guardLoss = (w) => {
    const s = duel(w, 'sword', 1.3);
    s.step({ ...NEUTRAL, press: PRESS.atk }, { ...NEUTRAL, blk: true });
    for (let k = 0; k < 30; k++) s.step(NEUTRAL, { ...NEUTRAL, blk: true });
    return 100 - s.f[1].guard;
  };
  assert.ok(guardLoss('hammer') > guardLoss('sword') * 1.5);
});

// ---------- sceptre de feu ----------
import { FIRE } from '../sim.js';
import { DungeonSim as DS } from '../dungeon.js';
// salle de donjon vide avec le héros au sceptre face à des ennemis groupés à distance
function fireRoom(blk = false) {
  const s = new DS(3, ['soldier'], ['staff']);
  s.start();
  while (s.f.length < 4) s.newRoom();          // une salle avec au moins 3 ennemis
  let n = 0;
  while (s.g.phase !== 'fight' && n++ < 300) s.step();
  s.room = { ...s.room, obs: [], surf: [], traps: [] };
  const [h, ...foes] = s.f;
  Object.assign(h, { x: 0, z: 3, y: 0, yaw: Math.PI, vx: 0, vz: 0, sta: 100 });
  foes.forEach((e, i) => Object.assign(e, { x: i < 2 ? (i ? 0.6 : -0.6) : 5.5, z: i < 2 ? -1 : 5.5, y: 0, yaw: 0, vx: 0, vz: 0,
    hp: 200, maxHp: 200, boss: false, size: 1, state: 'idle' }));
  // ennemis immobiles (qui tiennent leur garde si blk)
  const still = { update: () => ({ mx: 0, mz: 0, blk, press: 0 }), save: () => null };
  s.ais = s.ais.map((a, i) => (i ? still : null));
  return { s, h, foes };
}
const shoot = (s) => { s.step({ ...NEUTRAL, press: PRESS.atk }); for (let k = 0; k < 90; k++) s.step(); };

test('sceptre : la boule de feu explose et blesse tous les ennemis proches', () => {
  const { s, foes } = fireRoom();
  assert.ok(s.f[0].arch, 'arme à distance');
  let fired = false;
  s.step({ ...NEUTRAL, press: PRESS.atk });
  for (let k = 0; k < 90; k++) { s.step(); if (s.pr.some((a) => a.k === 1)) fired = true; }
  assert.ok(fired, 'une boule de feu part');
  assert.ok(foes[0].hp < 200 && foes[1].hp < 200, `les deux ennemis groupés sont touchés (${foes[0].hp}, ${foes[1].hp})`);
  if (foes[2]) assert.equal(foes[2].hp, 200, 'un ennemi loin de l\'explosion n\'est pas touché');
  assert.equal(s.pr.length, 0);
});

test("sceptre : bloquer face à l'explosion protège (la garde encaisse), cadence plus lente que l'arc", () => {
  const { s, foes } = fireRoom(true);
  shoot(s);
  assert.equal(foes[0].hp, 200, 'pas de dégâts en bloquant');
  assert.ok(foes[0].guard < 100, 'garde entamée');
  assert.ok(FIRE.chain > 0.5);
});

test("sceptre : une roulade traverse l'explosion", () => {
  const { s, foes } = fireRoom();
  s.step({ ...NEUTRAL, press: PRESS.atk });
  for (let k = 0; k < 90; k++) {
    // les ennemis roulent au moment où la boule arrive
    const a = s.pr[0];
    if (a && Math.abs(a.z - foes[0].z) < 1.2 && foes[0].state !== 'roll') for (const e of foes.slice(0, 2)) { e.sta = 100; s.startRoll(e, 1, 0); }
    s.step();
  }
  assert.equal(foes[0].hp, 200);
  assert.equal(foes[1].hp, 200);
});

test('sceptre : la boule de feu explose contre un mur', () => {
  const s = new DS(3, ['soldier'], ['staff']);
  s.start();
  let n = 0;
  while (s.g.phase !== 'fight' && n++ < 300) s.step();
  s.room = { ...s.room, obs: [{ x: 0, z: 0, r: 0.4, kind: 'column' }], surf: [], traps: [] };
  s.pr = [{ x: 0, y: 1, z: 2, vx: 0, vy: 0, vz: -FIRE.speed, o: 0, t: 0, k: 1 }];
  s.ev.length = 0;
  for (let k = 0; k < 30; k++) s.step();
  assert.equal(s.pr.length, 0);
  assert.ok(s.ev.some((e) => e[0] === 'sfx' && e[1] === 'boom'));
});
