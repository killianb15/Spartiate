import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAP_CONFIG } from '../map-config.js';
import {
  generateMap, actSeed, nodeById, availableNextIds, canMoveTo, advanceMap,
  isBossNode, cloneMap, serializeMap, deserializeMap, formatMapAscii,
} from '../map.js';

test('reproductibilité par seed : même graine et même acte => carte strictement identique', () => {
  const a = generateMap(12345, 1);
  const b = generateMap(12345, 1);
  assert.deepEqual(a, b);
  // Graines ou actes différents => cartes différentes
  assert.notDeepEqual(generateMap(12345, 1), generateMap(12346, 1));
  assert.notDeepEqual(generateMap(12345, 1), generateMap(12345, 2));
  assert.notEqual(actSeed(12345, 1), actSeed(12345, 2));
});

test('map.js et map-config.js n’utilisent aucun Math.random (100 % déterministe)', () => {
  for (const file of ['map.js', 'map-config.js']) {
    const src = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.ok(!src.includes('Math.random'), `${file} ne doit pas utiliser Math.random`);
  }
});

test('invariants structurels sur 200 graines : 4 étages + Boss, 1..3 sorties, zéro croisement, zéro impasse', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const act = ((seed - 1) % 4) + 1;
    const map = generateMap(seed, act);
    assert.equal(map.floors, 4);

    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    const starts = map.nodes.filter((n) => n.floor === 0);
    const bosses = map.nodes.filter((n) => n.floor === map.floors);
    assert.ok(starts.length >= MAP_CONFIG.minStartNodes, `seed ${seed} : au moins 2 départs`);
    assert.equal(bosses.length, 1, `seed ${seed} : exactement 1 boss`);
    assert.equal(bosses[0].type, 'boss');
    assert.equal(bosses[0].next.length, 0);

    // Tous les départs sont des combats
    for (const s of starts) assert.equal(s.type, MAP_CONFIG.rules.firstFloorType);

    // Degrés sortants, accessibilité et unicité des arêtes
    const reachable = new Set(starts.map((s) => s.id));
    for (let f = 0; f < map.floors; f++) {
      const row = map.nodes.filter((n) => n.floor === f);
      assert.ok(row.length >= 1, `seed ${seed} étage ${f} vide`);
      for (const n of row) {
        assert.ok(reachable.has(n.id), `seed ${seed} nœud orphelin ${n.id}`);
        assert.ok(n.next.length >= 1 && n.next.length <= 3, `seed ${seed} degré invalide sur ${n.id}: ${n.next.length}`);
        for (const nid of n.next) {
          const t = byId.get(nid);
          assert.ok(t, `seed ${seed} cible inexistante ${nid}`);
          assert.equal(t.floor, f + 1, `seed ${seed} saut d'étage invalide ${n.id} -> ${nid}`);
          if (f < map.floors - 1) {
            assert.ok(Math.abs(t.col - n.col) <= 1, `seed ${seed} écart colonne > 1: ${n.id} -> ${nid}`);
          } else {
            assert.equal(t.id, bosses[0].id);
          }
          reachable.add(nid);
        }
      }
      // Zéro croisement d'arêtes entre étage f et f + 1
      if (f < map.floors - 1) {
        for (let c = 0; c < map.cols - 1; c++) {
          const left = byId.get(`${f}-${c}`);
          const right = byId.get(`${f}-${c + 1}`);
          if (left && right) {
            const cross = left.next.includes(`${f + 1}-${c + 1}`) && right.next.includes(`${f + 1}-${c}`);
            assert.ok(!cross, `seed ${seed} croisement détecté à l'étage ${f} entre col ${c} et ${c + 1}`);
          }
        }
      }
    }
    assert.ok(reachable.has(bosses[0].id), `seed ${seed} boss inatteignable`);
  }
});

test('règles de types respectées sur 200 graines : pas de repos/marchand, minFloor, noConsecutive, quotas', () => {
  const allowed = new Set(['combat', 'elite', 'event', 'treasure', 'boss']);
  for (let seed = 1; seed <= 200; seed++) {
    const map = generateMap(seed, ((seed - 1) % 3) + 1);
    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    const counts = { combat: 0, elite: 0, event: 0, treasure: 0, boss: 0 };

    for (const n of map.nodes) {
      assert.ok(allowed.has(n.type), `type interdit ${n.type}`);
      counts[n.type]++;
      const rule = MAP_CONFIG.roomTypes[n.type];
      if (rule.minFloor !== undefined) assert.ok(n.floor >= rule.minFloor, `seed ${seed} ${n.type} trop tôt étage ${n.floor}`);
      if (rule.noConsecutive) {
        for (const nid of n.next) {
          assert.notEqual(byId.get(nid).type, n.type, `seed ${seed} deux ${n.type} d'affilée: ${n.id} -> ${nid}`);
        }
      }
    }
    for (const [t, rule] of Object.entries(MAP_CONFIG.roomTypes)) {
      if (rule.minPerAct) assert.ok(counts[t] >= rule.minPerAct, `seed ${seed} quota min ${t} non atteint (${counts[t]})`);
      if (rule.maxPerAct) assert.ok(counts[t] <= rule.maxPerAct, `seed ${seed} quota max ${t} dépassé (${counts[t]})`);
    }
  }
});

test('navigation, sérialisation JSON et affichage ASCII', () => {
  const map = generateMap(77, 1);
  const starts = availableNextIds(map);
  assert.ok(starts.length >= 2);
  assert.equal(canMoveTo(map, '3-0'), false);

  // Parcours complet jusqu'au boss
  let steps = 0;
  while (!isBossNode(map)) {
    const opts = availableNextIds(map);
    assert.ok(opts.length >= 1);
    const chosen = advanceMap(map, opts[0]);
    assert.ok(chosen);
    steps++;
  }
  assert.equal(steps, map.floors + 1); // 4 étages + le boss = 5 salles
  assert.equal(map.visited.length, 5);
  assert.equal(availableNextIds(map).length, 0);

  // Sauvegarde / rechargement JSON fidèle et indépendant
  const restored = deserializeMap(serializeMap(map));
  assert.deepEqual(restored, map);
  restored.visited.push('x');
  assert.notEqual(cloneMap(map).visited.length, restored.visited.length);

  // Affichage ASCII lisible
  const ascii = formatMapAscii(generateMap(42, 1));
  assert.ok(ascii.includes('ACTE 1'));
  assert.ok(ascii.includes('B'));
});
