import test from 'node:test';
import assert from 'node:assert/strict';
import { DT, NEUTRAL, PRESS, Sim } from '../sim.js';
import {
  DungeonSim, HEROES, WEAPON_IDS, HUB_PADS, MERCHANT, ROOM_R,
  shopInput,
} from '../dungeon.js';
import { CoopHost, CoopGuest, packFighter, unpackFighter } from '../coop.js';
import { Rollback } from '../rollback.js';

// =====================================================================
//  Simulateur de réseau paramétrable (latence, gigue, perte, doublons,
//  réordonnancement, fréquence asymétrique)
// =====================================================================
function makeNet({ latency = 0, jitter = 0, loss = 0, dup = 0, seed = 42 } = {}) {
  let rng = seed >>> 0;
  const rnd = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  };
  let now = 1000;
  const q = []; // [{ at, to, msg }]
  let dropped = 0;

  const send = (to, msg, reliable) => {
    // passe par JSON comme un vrai WebSocket / RTCDataChannel
    const wire = JSON.parse(JSON.stringify(msg));
    if (!reliable && loss > 0 && rnd() < loss) { dropped++; return; }
    const d = Math.max(0, latency + (jitter ? (rnd() * 2 - 1) * jitter : 0));
    q.push({ at: now + d, to, msg: wire });
    if (!reliable && dup > 0 && rnd() < dup) {
      q.push({ at: now + d + rnd() * 25, to, msg: JSON.parse(JSON.stringify(wire)) });
    }
  };

  const deliver = (peers) => {
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].at <= now) {
        const pkt = q.splice(i, 1)[0];
        peers[pkt.to]?.receive(pkt.msg);
      }
    }
  };

  return {
    get now() { return now; },
    advance(ms) { now += ms; },
    send,
    deliver,
    get dropped() { return dropped; },
    get pending() { return q.length; },
  };
}

function makePair(netOpts = {}, { seed = 101, heroes = ['soldier', 'knight'], wpns = ['sword', 'spear'], unlocks = null, sid = 77 } = {}) {
  const net = makeNet(netOpts);
  const sim = new DungeonSim(seed, heroes, wpns, unlocks);
  sim.startHub();
  sim.ev.length = 0;
  const peers = {};
  const host = new CoopHost(sim, {
    sid,
    now: () => net.now,
    send: (m, rel) => net.send('guest', m, rel),
  });
  const guest = new CoopGuest({
    sid,
    unlocked: unlocks,
    now: () => net.now,
    send: (m, rel) => net.send('host', m, rel),
  });
  peers.host = host;
  peers.guest = guest;
  const stepBoth = (i0 = NEUTRAL, i1 = NEUTRAL, gOpts = {}) => {
    net.advance(DT * 1000);
    net.deliver(peers);
    host.tick(i0);
    guest.tick(i1, gOpts);
    guest.interpolate(DT);
    net.deliver(peers);
  };
  return { net, sim, host, guest, peers, stepBoth };
}

test('coop : synchronisation initiale et ping/pong', () => {
  const { host, guest, stepBoth } = makePair({ latency: 45 });
  for (let i = 0; i < 120; i++) stepBoth();
  assert.ok(guest.ready, 'invité prêt');
  assert.equal(guest.sim.g.room, 0);
  assert.equal(guest.sim.f.length, 2);
  assert.equal(guest.sim.f[0].kind, 'soldier');
  assert.equal(guest.sim.f[1].kind, 'knight');
  assert.equal(host.guestRoomAck, host.roomVer, 'salle acquittée');
  assert.ok(guest.stats.ping >= 60 && guest.stats.ping <= 140, `ping mesuré (${guest.stats.ping} ms)`);
  assert.equal(guest.stats.stalled, false);
});

test('coop : aucune action perdue sous 40 % de perte de paquets, doublons et gigue', () => {
  const { sim, host, guest, stepBoth } = makePair({ latency: 60, jitter: 35, loss: 0.4, dup: 0.25, seed: 9 });
  for (let i = 0; i < 15; i++) stepBoth();

  // Invité entre en salle 1 : on force la salle 1 sur l'hôte puis on fait attaquer/sauter/rouler l'invité
  sim.debugGoto(1);
  for (let i = 0; i < 20; i++) stepBoth();
  assert.equal(guest.sim.g.room, 1, 'invité synchronisé sur salle 1 malgré la perte');

  // Envoie une séquence d'actions ponctuelles (saut, attaque, roulade)
  stepBoth(NEUTRAL, { mx: 0, mz: 0, blk: false, press: PRESS.jump });
  for (let i = 0; i < 40; i++) stepBoth();
  stepBoth(NEUTRAL, { mx: 0, mz: 0, blk: false, press: PRESS.roll });
  for (let i = 0; i < 40; i++) stepBoth();
  stepBoth(NEUTRAL, { mx: 0, mz: 0, blk: false, press: PRESS.atk });
  for (let i = 0; i < 40; i++) stepBoth();

  assert.equal(guest.actQueue.length, 0, 'toutes les actions ont été acquittées par l’hôte');
  assert.equal(host.guestActSeq, guest.actSeq, 'hôte a consommé exactement toutes les actions');
});

test('coop : fréquences asymétriques (hôte 60 FPS, invité 20 FPS et inversement)', () => {
  const { net, sim, host, guest, peers } = makePair({ latency: 35 });
  sim.debugGoto(1);
  // 1) Hôte 60 FPS, Invité 20 FPS (1 tick invité tous les 3 ticks hôte)
  for (let i = 0; i < 180; i++) {
    net.advance(DT * 1000);
    net.deliver(peers);
    host.tick({ mx: 80, mz: 0, blk: false, press: 0 });
    if (i % 3 === 0) {
      guest.tick({ mx: -80, mz: 0, blk: false, press: i === 30 ? PRESS.jump : 0 });
      guest.interpolate(DT * 3);
    }
    net.deliver(peers);
  }
  assert.equal(guest.sim.g.room, 1);
  assert.ok(Math.hypot(guest.sim.f[0].x - sim.f[0].x, guest.sim.f[0].z - sim.f[0].z) < 0.8, 'J1 converge');
  assert.ok(Math.hypot(guest.sim.f[1].x - sim.f[1].x, guest.sim.f[1].z - sim.f[1].z) < 0.8, 'J2 converge');
  assert.equal(guest.actQueue.length, 0, 'saut de l’invité reçu et acquitté');

  // 2) Hôte 30 FPS (ralenti), Invité 60 FPS : aucun blocage ni crash
  for (let i = 0; i < 120; i++) {
    net.advance(DT * 1000);
    net.deliver(peers);
    if (i % 2 === 0) host.tick(NEUTRAL);
    guest.tick(NEUTRAL);
    guest.interpolate(DT);
    net.deliver(peers);
  }
  assert.equal(guest.stats.stalled, false);
});

test('coop : salle d’armes — boutique simultanée, blocage porte pendant achat, puis entrée salle 1', () => {
  const { sim, guest, stepBoth } = makePair({ latency: 25 });
  for (let i = 0; i < 10; i++) stepBoth();

  const shopPad = HUB_PADS.find((pd) => pd.t === 'shop');
  // Les deux héros entrent en boutique en même temps : ils sont décalés sur x
  sim.enterShop(sim.f[0], shopPad);
  sim.enterShop(sim.f[1], shopPad);
  assert.ok(sim.f[0].shop > 0 && sim.f[1].shop > 0);
  assert.ok(Math.abs(sim.f[0].x - sim.f[1].x) > 0.3, 'les deux clients ne se superposent pas');

  // J1 quitte la boutique et fonce vers la porte pendant que J2 est encore en boutique : bloqué !
  sim.leaveShop(sim.f[0]);
  sim.f[0].x = 0; sim.f[0].z = -ROOM_R + 0.1;
  for (let i = 0; i < 10; i++) stepBoth({ mx: 0, mz: -127, blk: false, press: 0 }, NEUTRAL);
  assert.equal(sim.g.room, 0, 'impossible d’arracher J2 de la boutique en passant la porte');

  // J2 choisit la hache via l'action fiable `shop`
  const axeIdx = WEAPON_IDS.indexOf('axe');
  stepBoth(NEUTRAL, NEUTRAL, { shop: axeIdx });
  for (let i = 0; i < 20; i++) stepBoth();
  assert.equal(sim.f[1].wpn, 'axe', 'J2 a bien acheté la hache');
  assert.equal(sim.f[1].shop, 0, 'J2 est sorti de la boutique');
  assert.equal(guest.sim.f[1].wpn, 'axe', 'l’invité voit la nouvelle arme');

  // Maintenant que J2 a fini ses achats, J1 peut franchir la porte -> salle 1 (transition ~0,45 s)
  sim.f[0].x = 0; sim.f[0].z = -ROOM_R + 0.1;
  for (let i = 0; i < 80; i++) stepBoth({ mx: 0, mz: -127, blk: false, press: 0 }, NEUTRAL);
  assert.equal(sim.g.room, 1, 'passage en salle 1 réussi');
  assert.equal(guest.sim.g.room, 1, 'invité passé en salle 1');
});

test('coop : réanimation en ligne + déduplication des événements', () => {
  const { sim, guest, stepBoth } = makePair({ latency: 40, loss: 0.25, dup: 0.3 });
  sim.debugGoto(1);
  // Met J2 à terre (down = 1), place J1 à côté et neutralise les ennemis loin
  for (const e of sim.f.slice(2)) { e.x = 5; e.z = 5; }
  sim.f[0].x = 0; sim.f[0].z = 0;
  sim.f[1].x = 0.7; sim.f[1].z = 0;
  sim.f[1].hp = 0; sim.f[1].state = 'dead'; sim.f[1].down = 1; sim.f[1].revT = 0;

  let reviveAnnounces = 0;
  for (let i = 0; i < 260; i++) {
    stepBoth({ mx: 0, mz: 0, blk: true, press: 0 }, NEUTRAL);
    for (const ev of guest.takeEvents()) {
      if (ev[0] === 'pop' && ev[1] === 'RELEVÉ !') reviveAnnounces++;
    }
  }
  assert.equal(sim.f[1].down, 0, 'J2 réanimé côté hôte');
  assert.notEqual(sim.f[1].state, 'dead');
  assert.equal(guest.sim.f[1].down, 0, 'J2 réanimé côté invité');
  assert.equal(reviveAnnounces, 1, 'événement de réanimation joué exactement une fois malgré doublons/pertes');
});

test('coop : salle au trésor, l\'invité voit les piédestaux, chacun prend son objet (sans menu)', () => {
  const { sim, guest, stepBoth } = makePair({ latency: 30, loss: 0.2 });
  sim.debugGoto(2);
  sim.debugKill();
  for (let i = 0; i < 15; i++) stepBoth();
  assert.equal(sim.g.exitOpen, true, 'porte ouverte');
  assert.equal(guest.sim.g.exitOpen, true);
  sim.debugVault();
  for (let i = 0; i < 30; i++) stepBoth();
  assert.equal(guest.sim.g.vault, true, 'invité dans la salle au trésor');
  assert.equal(guest.sim.room.vault, true, 'descripteur de salle reçu');
  const items = sim.pk.filter((o) => o.t === 'item');
  assert.equal(items.length, 2);
  assert.deepEqual(guest.sim.pk.map((o) => o.v).sort(), items.map((o) => o.v).sort(), 'mêmes objets chez l’invité');
  // l'invité marche sur un piédestal (position imposée chez l'hôte, comme un déplacement)
  sim.f[1].x = items[1].x + 0.85; sim.f[1].z = items[1].z;
  for (let i = 0; i < 30; i++) stepBoth();
  assert.equal(sim.f[1].items, items[1].v, 'J2 a pris son objet');
  assert.equal(guest.sim.f[1].items, items[1].v, 'invité voit son objet');
  assert.equal(guest.sim.pk.filter((o) => o.t === 'item').length, 1, 'il reste celui de J1');
});

test('coop : fin de partie et relance avec nouveau sid (paquets périmés ignorés)', () => {
  const { net, sim, host, guest, peers, stepBoth } = makePair({ latency: 50 }, { sid: 10 });
  sim.debugGoto(2);
  for (let i = 0; i < 20; i++) stepBoth();

  // Tue les deux héros proprement via die + onKO -> phase 'dead' puis 'end'
  sim.f[0].hp = 0; sim.die(sim.f[0]); sim.onKO(sim.f[2], sim.f[0]);
  sim.f[1].hp = 0; sim.die(sim.f[1]); sim.onKO(sim.f[2], sim.f[1]);
  for (let i = 0; i < 220; i++) stepBoth();
  assert.equal(sim.g.phase, 'end');
  assert.equal(guest.sim.g.phase, 'end', 'invité voit la fin de partie');

  // Relance avec un nouveau sid = 11 : un vieux paquet sid = 10 envoyé après ne doit rien casser
  const sim2 = new DungeonSim(999, ['soldier', 'knight']);
  sim2.startHub();
  const host2 = new CoopHost(sim2, { sid: 11, now: () => net.now, send: (m, rel) => net.send('guest', m, rel) });
  const guest2 = new CoopGuest({ sid: 11, now: () => net.now, send: (m, rel) => net.send('host', m, rel) });
  peers.host = host2; peers.guest = guest2;
  // Injecte un paquet périmé de l'ancienne session (sid 10)
  guest2.receive({ t: 'cs', sid: 10, tk: 99999, g: { phase: 'end', room: 99 }, f: [], pr: [] });
  host2.receive({ t: 'ci', sid: 10, mx: 127, mz: 127, blk: true, acts: [[1, PRESS.atk, -1, -1]] });
  for (let i = 0; i < 20; i++) {
    net.advance(DT * 1000);
    net.deliver(peers);
    host2.tick(NEUTRAL);
    guest2.tick(NEUTRAL);
    net.deliver(peers);
  }
  assert.equal(guest2.sim.g.room, 0, 'paquet périmé ignoré');
  assert.equal(guest2.sim.g.phase, 'hub');
  assert.equal(host2.guestActSeq, 0, 'action périmée ignorée');
});

test('coop : déconnexion en pleine salle (dropHero) convertit proprement en solo', () => {
  // Cas 1 : en plein combat avec chien invoqué et J1 à terre -> J2 part, J1 est relevé et continue seul
  const sim = new DungeonSim(7, ['soldier', 'mage'], ['sword', 'tome']);
  sim.start();
  sim.debugGoto(3);
  // Invoque un chien appartenant à J2 (grimoire) et met J1 à terre
  for (let i = 0; i < 90; i++) sim.step(NEUTRAL, i === 60 ? { mx: 0, mz: 0, blk: false, press: PRESS.atk } : NEUTRAL);
  sim.f[0].hp = 0; sim.die(sim.f[0]); sim.onKO(sim.f[2], sim.f[0]);
  const dogsBefore = sim.f.filter((e) => e.kind === 'dog' && e.owner === 1).length;
  assert.ok(dogsBefore >= 1, 'J2 a invoqué un chien');

  assert.equal(sim.dropHero(1), true);
  assert.equal(sim.g.np, 1);
  assert.equal(sim.heroes.length, 1);
  assert.equal(sim.f[0].idx, 0);
  assert.equal(sim.f[0].down, 0, 'J1 relevé automatiquement');
  assert.notEqual(sim.f[0].state, 'dead');
  assert.equal(sim.f.filter((e) => e.kind === 'dog').length, 0, 'chien du joueur parti retiré');
  // La simulation continue sans erreur pendant 120 images
  for (let i = 0; i < 120; i++) sim.step(NEUTRAL, NEUTRAL);
  assert.equal(sim.g.room, 3);

  // Cas 2 : salle au trésor, J1 a pris son objet, J2 part : le reste des objets disparaît dès que J1 est seul
  // à décider (il ne peut toujours en prendre qu'un), la porte reste ouverte
  const simR = new DungeonSim(8, ['soldier', 'knight']);
  simR.start();
  simR.debugVault();
  const it = simR.pk.filter((o) => o.t === 'item');
  simR.step(NEUTRAL, NEUTRAL);
  simR.f[0].x
 = it[0].x - 0.85; simR.f[0].z = it[0].z;
  for (let i = 0; i < 3; i++) simR.step(NEUTRAL, NEUTRAL);
  assert.equal(simR.f[0].items, it[0].v);
  assert.equal(simR.pk.filter((o) => o.t === 'item').length, 1, 'l’objet de J2 attend');
  simR.dropHero(1);
  for (let i = 0; i < 3; i++) simR.step(NEUTRAL, NEUTRAL);
  assert.equal(simR.g.exitOpen, true);
  assert.equal(simR.pk.filter((o) => o.t === 'item').length, 0, 'la part de J2 disparaît');
  assert.equal(simR.f[0].items, it[0].v, 'J1 ne prend pas un second objet');

});


test('coop : paquets malformés ou hostiles ignorés sans crash', () => {
  const { host, guest } = makePair();
  for (const bad of [null, undefined, 42, 'x', {}, { t: 'cs', sid: 77 }, { t: 'cs', sid: 77, tk: 'nan' }, { t: 'ci', sid: 77, acts: ['bad', [null]] }]) {
    assert.doesNotThrow(() => host.receive(bad));
    assert.doesNotThrow(() => guest.receive(bad));
  }
  // packFighter / unpackFighter aller-retour
  const pf = packFighter(host.sim.f[0]);
  const uf = unpackFighter(pf);
  assert.equal(uf.kind, host.sim.f[0].kind);
  assert.equal(uf.wpn, host.sim.f[0].wpn);
});

test('rollback : aucun blocage permanent quand peerAck dépasse 24 images de retard + filtrage sid', () => {
  const sA = new Sim(123, ['soldier', 'orc']); sA.startMatch();
  const sB = new Sim(123, ['soldier', 'orc']); sB.startMatch();
  const qA = [], qB = [];
  let dropBtoA = true;
  const rbA = new Rollback(sA, { me: 0, sid: 55, send: (m) => qB.push(JSON.parse(JSON.stringify(m))) });
  const rbB = new Rollback(sB, { me: 1, sid: 55, send: (m) => { if (!dropBtoA) qA.push(JSON.parse(JSON.stringify(m))); } });

  // B avance pendant 40 frames (avec ses paquets vers A coupés), dépassant largement MAX_PACKET (24)
  for (let i = 0; i < 40; i++) {
    rbA.tick(NEUTRAL);
    rbB.tick(NEUTRAL);
    while (qB.length) rbB.receive(qB.shift());
  }
  // Rétablit le lien : A doit rattraper TOUTES les frames sans blocage
  dropBtoA = false;
  for (let i = 0; i < 120; i++) {
    rbA.tick(NEUTRAL);
    rbB.tick(NEUTRAL);
    while (qA.length) rbA.receive(qA.shift());
    while (qB.length) rbB.receive(qB.shift());
  }
  // Aligne les deux sur exactement la même image avant de comparer leurs empreintes
  while (sA.g.frame < sB.g.frame) { rbA.tick(NEUTRAL); while (qA.length) rbA.receive(qA.shift()); }
  while (sB.g.frame < sA.g.frame) { rbB.tick(NEUTRAL); while (qB.length) rbB.receive(qB.shift()); }
  assert.ok(sA.g.frame > 80 && sB.g.frame === sA.g.frame, `les deux pairs avancent sans blocage (${sA.g.frame} / ${sB.g.frame})`);
  assert.equal(sA.hash(), sB.hash(), 'états strictement synchronisés après reprise');

  // Paquet d'une autre session ignoré
  const before = rbA.peerAck;
  rbA.receive({ t: 'ri', sid: 99, ack: 99999, from: 0, list: [] });
  assert.equal(rbA.peerAck, before, 'sid étranger ignoré');
});
