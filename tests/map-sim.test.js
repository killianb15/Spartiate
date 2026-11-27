import test from 'node:test';
import assert from 'node:assert/strict';
import { DungeonSim, mapInput, eventInput } from '../dungeon.js';
import { availableNextIds, generateMap, sanitizeMap, deserializeMap } from '../map.js';
import { ITEMS, itemList } from '../items.js';
import { EVENTS, EVENT_IDS } from '../events.js';
import { CoopHost, CoopGuest } from '../coop.js';
import { NEUTRAL, DT } from '../sim.js';

const run = (s, n, i0 = () => NEUTRAL, i1 = () => NEUTRAL) => { for (let k = 0; k < n; k++) s.step(i0(k), i1(k)); };

test('parcours complet d’un acte avec la carte : salle d’armes → carte → 4 étages → boss → acte 2', () => {
  const s = new DungeonSim(42, ['soldier'], ['sword'], null, { useMap: true });
  s.startHub();
  assert.equal(s.g.phase, 'hub');
  assert.ok(s.map && s.map.act === 1 && s.map.currentId === null);

  // Franchir la porte de la salle d'armes -> phase 'map'
  s.g.phase = 'exit'; s.g.t = 0;
  run(s, 35);
  assert.equal(s.g.phase, 'map');
  assert.ok(availableNextIds(s.map).length >= 2);

  // Remonte les 4 étages + le boss (5 salles)
  const visitedTypes = [];
  for (let stepIdx = 0; stepIdx < 5; stepIdx++) {
    assert.equal(s.g.phase, 'map', `attend phase map à l'étape ${stepIdx}`);
    s.step(mapInput(0));
    visitedTypes.push(s.g.roomType);
    if (s.g.phase === 'event') {
      // Choisit la dernière option (sûre / neutre) pour terminer l'événement
      const ev = EVENTS[s.g.eventId];
      assert.ok(ev, 'événement valide');
      s.step(eventInput(ev.choices.length - 1));
      if (s.g.phase === 'fight') s.debugKill();
    } else if (s.g.phase === 'intro' || s.g.phase === 'fight') {
      s.debugKill();
    }
    assert.equal(s.g.phase, 'clear');
    assert.equal(s.g.exitOpen, true);
    // Quitte la salle -> retour sur la carte
    s.g.phase = 'exit'; s.g.t = 0;
    run(s, 35);
  }

  assert.equal(visitedTypes[0], 'combat');
  assert.equal(visitedTypes[4], 'boss');
  // Après le boss de l'acte 1, on est passé à l'acte 2 avec une nouvelle carte
  assert.equal(s.g.phase, 'map');
  assert.equal(s.g.act, 2);
  assert.equal(s.map.act, 2);
  assert.equal(s.map.currentId, null);
  assert.equal(s.g.room, 5);
});

test('reproductibilité complète : même seed + mêmes choix de carte => même suite de salles et même état', () => {
  const play = () => {
    const s = new DungeonSim(999, ['soldier'], ['sword'], null, { useMap: true });
    s.startHub();
    s.openMap();
    const trace = [];
    for (let k = 0; k < 4; k++) {
      s.step(mapInput(0));
      trace.push([s.g.roomType, s.g.eventId, s.room.exit, s.f.length, s.map.currentId]);
      if (s.g.phase === 'event') s.step(eventInput(EVENTS[s.g.eventId].choices.length - 1));
      if (s.g.phase === 'intro' || s.g.phase === 'fight') s.debugKill();
      s.openMap();
    }
    return { trace, hash: s.hash() };
  };
  assert.deepEqual(play(), play());
});

test('salle Élite (champion renforcé + objet Rare ou mieux) et salle Trésor (objets sur piédestaux, sans combat)', () => {
  const s = new DungeonSim(42, ['soldier'], ['sword'], null, { useMap: true });
  s.startHub();
  // Force l'entrée dans un nœud Élite de la carte
  const eliteNode = s.map.nodes.find((n) => n.type === 'elite');
  assert.ok(eliteNode);
  s.newRoom(eliteNode);
  assert.equal(s.g.roomType, 'elite');
  assert.equal(s.g.lootKind, 'elite');
  const champ = s.f.find((e) => e.eliteChamp);
  assert.ok(champ && champ.size > 1.2, 'champion d’élite agrandi présent');
  s.debugKill();
  assert.equal(s.g.phase, 'clear');
  const loot = s.pk.filter((o) => o.t === 'item');
  assert.equal(loot.length, 1, 'un objet par héros sur un piédestal');
  assert.ok(loot.every((o) => ITEMS[o.v] && ITEMS[o.v].q >= 1), 'élite : objet Rare ou mieux');
  assert.ok(s.pk.some((o) => o.t === 'heart'), 'élite : un cœur en plus');

  // Force l'entrée dans un nœud Trésor : pas d'ennemi, porte ouverte, objets déjà posés
  const treasNode = s.map.nodes.find((n) => n.type === 'treasure');
  assert.ok(treasNode);
  s.newRoom(treasNode);
  assert.equal(s.g.roomType, 'treasure');
  assert.equal(s.g.phase, 'clear');
  assert.equal(s.g.exitOpen, true);
  assert.equal(s.foesLeft, 0);
  const vault = s.pk.filter((o) => o.t === 'item');
  assert.ok(vault.length >= 1 && vault.every((o) => ITEMS[o.v]), 'trésor : objets sur des piédestaux');
  assert.ok(!vault.some((o) => loot.some((l) => l.v === o.v && o.v !== 'eclat')), 'pas deux fois le même objet dans la partie');
});

test('la salle au trésor automatique (sans carte) est remplacée par les nœuds Trésor quand la carte est active', () => {
  const s = new DungeonSim(7, ['soldier'], ['sword'], null, { useMap: true });
  s.startHub();
  for (let k = 0; k < 6; k++) {
    s.newRoom({ id: `${k}-0`, floor: k, col: 0, type: 'combat', next: [], roomSeed: 50 + k });
    s.debugKill();
    assert.equal(s.g.vaultNext, false, `salle ${s.g.room} : pas de salle au trésor surprise`);
  }
});

test('un événement peut donner un objet (autel de sang : Épique ou Légendaire, jamais maudit)', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const s = new DungeonSim(seed, ['soldier'], ['sword'], null, { useMap: true });
    s.startHub();
    s.newRoom({ id: '2-0', floor: 2, col: 0, type: 'event', next: [], roomSeed: 300 + seed });
    s.g.eventId = 'autel';
    assert.equal(s.chooseEvent(0, 0), true);
    const got = itemList(s.f[0]);
    assert.equal(got.length, 1, 'un objet reçu');
    const it = ITEMS[got[0]];
    assert.ok(it.q >= 2 && !it.curse, `${got[0]} : Épique ou mieux, non maudit`);
    assert.match(s.g.eventLog, /^−\d+ PV · Objet obtenu : /, 'le sang a coulé');
    assert.ok((',' + s.g.seen + ',').includes(',' + got[0] + ','), 'objet marqué comme sorti');
  }
});

test('Coffre maudit chanceux : objets sur piédestaux ; malchanceux : embuscade avec butin d’élite', () => {
  let luck = 0, ambush = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const s = new DungeonSim(seed, ['soldier'], ['sword'], null, { useMap: true });
    s.startHub();
    s.newRoom({ id: '2-0', floor: 2, col: 0, type: 'event', next: [], roomSeed: 400 + seed });
    s.g.eventId = 'coffre';
    s.chooseEvent(0, 0);
    if (s.g.phase === 'fight') {
      ambush++;
      assert.equal(s.g.lootKind, 'elite');
      s.debugKill();
      assert.ok(s.pk.filter((o) => o.t === 'item').every((o) => ITEMS[o.v].q >= 1));
    } else {
      luck++;
      assert.ok(s.pk.some((o) => o.t === 'item'), 'objets posés');
    }
  }
  assert.ok(luck > 0 && ambush > 0, `les deux issues arrivent (${luck} / ${ambush})`);
});

test('sanitizeMap : la carte reçue de l’hôte est validée (types, identifiants, liens)', () => {
  const m = generateMap(1234, 1);
  const ok = sanitizeMap(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(ok, m, 'une carte valide passe sans changement');
  const bad = (f) => { const c = JSON.parse(JSON.stringify(m)); f(c); return sanitizeMap(c); };
  assert.equal(bad((c) => { c.nodes[0].type = '"><img src=x onerror=alert(1)>'; }), null, 'type inconnu');
  assert.equal(bad((c) => { c.nodes[0].type = 'constructor'; }), null, 'type hérité de Object');
  assert.equal(bad((c) => { c.nodes[0].id = '<b>'; }), null, 'identifiant invalide');
  assert.equal(bad((c) => { c.nodes[0].next = ['99-99']; }), null, 'lien vers un nœud absent');
  assert.equal(bad((c) => { c.currentId = 'x'; }), null, 'nœud courant absent');
  assert.equal(sanitizeMap(null), null);
  assert.equal(sanitizeMap('carte'), null);
  assert.equal(deserializeMap('{pas du json'), null);
});

test('les 8 événements "?" fonctionnent tous sans erreur (y compris embuscades et coffres)', () => {
  assert.equal(EVENT_IDS.length, 8);
  for (const id of EVENT_IDS) {
    const ev = EVENTS[id];
    for (let c = 0; c < ev.choices.length; c++) {
      const s = new DungeonSim(17 + c, ['soldier'], ['sword'], null, { useMap: true });
      s.startHub();
      s.newRoom({ id: '2-0', floor: 2, col: 0, type: 'event', next: [], roomSeed: 100 + c });
      s.g.eventId = id;
      s.f[0].hp = 60;
      const ok = s.chooseEvent(0, c);
      assert.equal(ok, true, `événement ${id} choix ${c}`);
      assert.ok(['clear', 'fight'].includes(s.g.phase), `phase finale valide après ${id}[${c}] : ${s.g.phase}`);
      assert.ok(s.f[0].hp >= 1, 'un événement ne tue pas directement');
    }
  }
});

test('coop Option B : vote sur la carte (accord immédiat, désaccord tranché de façon déterministe, dropHero)', () => {
  const s = new DungeonSim(42, ['soldier', 'orc'], ['sword', 'axe'], null, { useMap: true });
  s.startHub();
  s.openMap();
  const avail = availableNextIds(s.map);
  assert.ok(avail.length >= 2);

  // J1 vote pour l'option 0 : on attend J2
  s.step(mapInput(0), NEUTRAL);
  assert.equal(s.g.phase, 'map');
  assert.equal(s.g.mapVote0, avail[0]);
  assert.equal(s.g.mapVote1, '');

  // J2 vote pour la même option -> départ immédiat vers avail[0]
  s.step(NEUTRAL, mapInput(0));
  assert.notEqual(s.g.phase, 'map');
  assert.equal(s.map.currentId, avail[0]);

  // Désaccord : test sur deux copies identiques -> même gagnant déterministe
  const runDisagree = () => {
    const d = new DungeonSim(42, ['soldier', 'orc'], ['sword', 'axe'], null, { useMap: true });
    d.startHub();
    d.openMap();
    const opts = availableNextIds(d.map);
    d.step(mapInput(0), NEUTRAL);
    d.step(NEUTRAL, mapInput(1));
    assert.notEqual(d.g.phase, 'map');
    assert.ok([opts[0], opts[1]].includes(d.map.currentId));
    return d.map.currentId;
  };
  assert.equal(runDisagree(), runDisagree());

  // Déconnexion d'un joueur pendant la phase 'map' après le vote de J1 -> avance aussitôt en solo
  const d2 = new DungeonSim(42, ['soldier', 'orc'], ['sword', 'axe'], null, { useMap: true });
  d2.startHub();
  d2.openMap();
  d2.step(mapInput(0), NEUTRAL);
  d2.dropHero(1);
  assert.equal(d2.g.np, 1);
  assert.notEqual(d2.g.phase, 'map');
});

test('coop réseau (CoopHost / CoopGuest) : synchronisation de la carte, vote et événements', () => {
  const sim = new DungeonSim(55, ['soldier', 'orc'], ['sword', 'axe'], null, { useMap: true });
  sim.startHub();
  sim.openMap();
  const qH = [], qG = [];
  const host = new CoopHost(sim, { sid: 7, send: (m) => qG.push(JSON.parse(JSON.stringify(m))) });
  const guest = new CoopGuest({ sid: 7, send: (m) => qH.push(JSON.parse(JSON.stringify(m))) });
  const pump = (n, i0 = NEUTRAL, gOpts = {}) => {
    for (let k = 0; k < n; k++) {
      host.tick(k === 0 ? i0 : NEUTRAL);
      while (qG.length) guest.receive(qG.shift());
      guest.tick(NEUTRAL, k === 0 ? gOpts : {});
      while (qH.length) host.receive(qH.shift());
      guest.interpolate(DT);
    }
  };
  pump(10);
  assert.ok(guest.sim.map && guest.sim.map.act === 1, 'invité a reçu la carte');
  assert.equal(guest.sim.g.phase, 'map');

  // Hôte vote 0, invité vote 0 -> les deux entrent dans la même salle
  pump(15, mapInput(0), { map: 0 });
  assert.equal(sim.g.room, 1);
  assert.equal(guest.sim.g.room, 1);
  assert.equal(guest.sim.map.currentId, sim.map.currentId);
});

test('sauvegarde et rechargement JSON en cours de run préservent la carte, les PV et les objets', () => {
  const s = new DungeonSim(88, ['soldier'], ['sword'], null, { useMap: true });
  s.startHub();
  s.openMap();
  s.step(mapInput(0));
  s.giveItem(s.f[0], 'eclat');
  s.f[0].hp = 73;
  s.f[0].pow += 0.15;
  const json = JSON.stringify(s.save());

  const s2 = new DungeonSim(1, ['soldier'], ['sword'], null, { useMap: true });
  s2.load(JSON.parse(json));
  assert.equal(s2.runSeed, 88);
  assert.deepEqual(s2.map, s.map);
  assert.equal(s2.f[0].hp, 73);
  assert.equal(s2.f[0].items, s.f[0].items);
  assert.equal(s2.f[0].pow, s.f[0].pow);
  assert.equal(s2.hash(), s.hash());
});
