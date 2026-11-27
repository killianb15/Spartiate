import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DungeonSim, BIOMES, biomeOrder, biomeOfAct, ARENA_LAYOUTS, BOSS, FOES,
  FINAL_ACT, FINAL_ROOM, mapInput, eventInput,
} from '../dungeon.js';
import { EVENTS } from '../events.js';
import { CoopHost, CoopGuest } from '../coop.js';
import { NEUTRAL, DT, PRESS } from '../sim.js';

const run = (s, n, i0 = () => NEUTRAL, i1 = () => NEUTRAL) => { for (let k = 0; k < n; k++) s.step(i0(k), i1(k)); };
const until = (s, cond, n = 600, i0 = () => NEUTRAL) => { for (let k = 0; k < n && !cond(); k++) s.step(i0(k)); return cond(); };

const skelRoom = (seed = 7, kinds = ['soldier']) => {
  const s = new DungeonSim(seed, kinds);
  s.start();
  s.debugGoto(FINAL_ROOM);
  while (s.g.phase !== 'fight') s.step();
  s.ev.length = 0;
  return s;
};
const skelBoss = (s) => s.f.find((f) => f.foe === 'squelette');

test('6 biomes (dont Nécropole et Citadelle) tirés aléatoirement de façon déterministe et sans doublon', () => {
  assert.equal(BIOMES.length, 6);
  assert.ok(BIOMES.includes('forge'));
  assert.ok(BIOMES.includes('necropole'));
  assert.ok(BIOMES.includes('citadelle'));

  // Déterministe par runSeed
  assert.deepEqual(biomeOrder(42), biomeOrder(42));
  assert.deepEqual(biomeOrder(1234), biomeOrder(1234));

  // Aucun doublon sur les 6 premiers actes d'une run, et variété entre graines
  const firstActs = new Set();
  const seenNew = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const order = biomeOrder(seed);
    assert.equal(new Set(order).size, 6, `seed ${seed} doit contenir les 6 biomes sans doublon`);
    firstActs.add(biomeOfAct(1, seed));
    for (let a = 1; a <= 4; a++) seenNew.add(biomeOfAct(a, seed));
  }
  assert.ok(firstActs.size >= 4, 'les biomes de départ varient bien selon la graine');
  assert.ok(seenNew.has('forge') && seenNew.has('necropole') && seenNew.has('citadelle'), 'les 3 biomes apparaissent bien dans les actes 1..4');
});

test('parcours complet 4 actes × 5 salles = 20 salles → Victoire face au Souverain d’Os, puis Mode Infini', () => {
  const s = new DungeonSim(42, ['soldier'], ['sword'], null, [], { useMap: true });
  s.startHub();
  s.openMap();

  for (let roomIdx = 1; roomIdx <= FINAL_ROOM; roomIdx++) {
    assert.equal(s.g.phase, 'map', `phase map attendue avant salle ${roomIdx}`);
    s.step(mapInput(0));
    assert.equal(s.g.room, roomIdx);
    if (s.g.phase === 'event') {
      const ev = EVENTS[s.g.eventId];
      s.step(eventInput(ev.choices.length - 1));
      if (s.g.phase === 'fight') s.debugKill();
    } else if (s.g.phase === 'intro' || s.g.phase === 'fight') {
      if (roomIdx === FINAL_ROOM) {
        assert.equal(s.room.bossId, 'squelette');
        assert.equal(s.room.lair, 'squelette');
      }
      s.debugKill();
    }
    if (roomIdx < FINAL_ROOM) {
      assert.equal(s.g.phase, 'clear');
      s.g.phase = 'exit'; s.g.t = 0;
      run(s, 35);
    }
  }

  // Victoire déclenchée après la salle 20 (Acte 4 Boss)
  assert.equal(s.g.act, FINAL_ACT);
  assert.equal(s.g.victory, true);
  assert.equal(s.g.phase, 'victory');
  run(s, 150);
  assert.equal(s.g.phase, 'end');
  assert.equal(s.g.victory, true);

  // Continuer en mode Infini
  assert.equal(s.continueEndless(), true);
  assert.equal(s.g.endless, true);
  assert.equal(s.g.victory, false);
  assert.equal(s.g.phase, 'clear');
  assert.equal(s.g.exitOpen, true);

  // Passer la porte ouvre l'Acte 5 (salle 21+)
  s.g.phase = 'exit'; s.g.t = 0;
  run(s, 35);
  assert.equal(s.g.phase, 'map');
  assert.equal(s.g.act, 5);
});

test('Souverain d’Os : shift fait trembler puis muter l’arène parmi les 4 configurations, et blesse sur un pilier', () => {
  const s = skelRoom(11);
  const e = skelBoss(s), p = s.f[0];
  assert.ok(e && e.boss && e.wpn === 'scythe');
  assert.equal(s.g.arenaLayout, 0);
  assert.equal(s.g.arenaVer, 0);

  // Déclenche une mutation vers le Labyrinthe d'Os (layout 1)
  s.startSpecial(e, 'shift', 1);
  assert.equal(e.sp, 'shift');
  assert.equal(s.g.arenaNext, 1);
  assert.ok(s.g.arenaQuake > 0);

  // Place le héros sur un futur pilier du Labyrinthe ([-3, -1.5]) pour vérifier le choc
  const [ti, tj] = ARENA_LAYOUTS[1].obs[0];
  p.x = ti * 1.5; p.z = tj * 1.5;
  const hp0 = p.hp;

  const shifted = until(s, () => s.g.arenaVer === 1, 200);
  assert.ok(shifted, 'l’arène a muté après le tremblement');
  assert.equal(s.g.arenaLayout, 1);
  assert.equal(s.g.arenaNext, -1);
  assert.equal(s.g.arenaQuake, 0);
  assert.equal(s.room.obs.length, ARENA_LAYOUTS[1].obs.length);
  assert.equal(s.room.traps.length, ARENA_LAYOUTS[1].traps.length);
  assert.ok(p.hp < hp0, 'rester sur un pilier qui surgit blesse le héros');
  assert.ok(Math.hypot(p.x - ti * 1.5, p.z - tj * 1.5) > 0.7, 'le héros est repoussé hors du pilier');

  // Test des Estrades du Jugement (layout 2) : les estrades et escaliers apparaissent
  until(s, () => !e.sp, 120);
  s.startSpecial(e, 'shift', 2);
  assert.ok(until(s, () => s.g.arenaVer === 2, 200));
  assert.equal(s.room.surf.length, ARENA_LAYOUTS[2].surf.length);
  assert.ok(s.room.surf.length >= 4);
});

test('Souverain d’Os : reap (fauchage), bones (salve renvoyable), rage (squelettes + Cercle Maudit) et déterminisme', () => {
  // 1) Fauchage tournoyant (reap)
  const s1 = skelRoom(13), e1 = skelBoss(s1), p1 = s1.f[0];
  e1.x = 0; e1.z = 0; p1.x = 0; p1.z = 2.0;
  const hpBefore = p1.hp;
  assert.ok(s1.debugBoss('reap'));
  assert.ok(until(s1, () => !e1.sp, 180));
  assert.ok(p1.hp < hpBefore, 'reap blesse un héros proche');

  // 2) Salve d'os (bones) -> projectiles spectraux k = 3
  const s2 = skelRoom(14), e2 = skelBoss(s2);
  assert.ok(s2.debugBoss('bones'));
  assert.ok(until(s2, () => s2.pr.some((a) => a.k === 3), 120), 'des projectiles spectraux k=3 sont tirés');
  assert.equal(s2.pr.filter((a) => a.k === 3).length, BOSS.bones.count);

  // 3) Rage (50 % PV) : invoque des squelettes (skel) puis mute l'arène vers le Cercle Maudit (layout 3)
  const s3 = skelRoom(15), e3 = skelBoss(s3);
  assert.ok(s3.debugBoss('rage'));
  assert.ok(until(s3, () => s3.f.some((f) => f.foe === 'skel'), 120), 'la rage invoque des squelettes');
  assert.ok(until(s3, () => s3.g.arenaLayout === 3, 260), 'la rage déclenche le Cercle Maudit');
  assert.equal(s3.room.traps.length, ARENA_LAYOUTS[3].traps.length);

  // 4) Déterminisme & save/load en plein tremblement
  const a = skelRoom(21), b = skelRoom(21);
  a.debugBoss('shift'); b.debugBoss('shift');
  run(a, 50); run(b, 50);
  const snap = JSON.parse(JSON.stringify(a.save()));
  const c = new DungeonSim(1);
  c.load(snap);
  run(a, 140); run(b, 140); run(c, 140);
  assert.equal(a.hash(), b.hash());
  assert.equal(a.hash(), c.hash());
});

test('coop réseau (CoopHost / CoopGuest) : mutation d’arène et Mode Infini synchronisés chez l’invité', () => {
  const sim = skelRoom(31, ['soldier', 'orc']);
  const qH = [], qG = [];
  const host = new CoopHost(sim, { sid: 11, send: (m) => qG.push(JSON.parse(JSON.stringify(m))) });
  const guest = new CoopGuest({ sid: 11, send: (m) => qH.push(JSON.parse(JSON.stringify(m))) });
  const pump = (n) => {
    for (let k = 0; k < n; k++) {
      host.tick(NEUTRAL);
      while (qG.length) guest.receive(qG.shift());
      guest.tick(NEUTRAL);
      while (qH.length) host.receive(qH.shift());
      guest.interpolate(DT);
    }
  };
  pump(10);
  assert.equal(guest.sim.g.arenaLayout, 0);

  // Mutation d'arène vers layout 2 (Estrades du Jugement)
  const e = skelBoss(sim);
  sim.startSpecial(e, 'shift', 2);
  pump(150);
  assert.equal(sim.g.arenaLayout, 2);
  assert.equal(guest.sim.g.arenaLayout, 2);
  assert.equal(guest.sim.g.arenaVer, sim.g.arenaVer);
  assert.equal(guest.sim.room.surf.length, ARENA_LAYOUTS[2].surf.length);

  // Victoire + reprise en mode Infini chez l'hôte -> propagée à l'invité
  sim.debugKill();
  pump(150);
  assert.equal(guest.sim.g.phase, 'end');
  assert.equal(guest.sim.g.victory, true);
  sim.continueEndless();
  pump(10);
  assert.equal(guest.sim.g.phase, 'clear');
  assert.equal(guest.sim.g.endless, true);
});
