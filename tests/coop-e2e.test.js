import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DT, NEUTRAL, PRESS } from '../sim.js';
import { DungeonSim, HUB_PADS, ROOM_R, WEAPON_IDS } from '../dungeon.js';
import { CoopHost, CoopGuest } from '../coop.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitPort(port, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await new Promise((res, rej) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => { sock.end(); res(); });
        sock.on('error', rej);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  throw new Error('Le serveur ne démarre pas');
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    const waiters = [];
    const handlers = [];
    ws.addEventListener('open', () => resolve({
      ws,
      send(obj) { ws.send(JSON.stringify(obj)); },
      onMessage(fn) { handlers.push(fn); },
      next(pred = () => true, timeout = 4000) {
        for (let i = 0; i < inbox.length; i++) {
          if (pred(inbox[i])) return Promise.resolve(inbox.splice(i, 1)[0]);
        }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('Délai dépassé en attente d’un message WS')), timeout);
          waiters.push({ pred, res: (m) => { clearTimeout(timer); res(m); } });
        });
      },
      close() { try { ws.close(); } catch { /* ignoré */ } },
    }));
    ws.addEventListener('error', reject);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      for (const h of handlers) h(m);
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(m)) {
          const w = waiters.splice(i, 1)[0];
          w.res(m);
          return;
        }
      }
      inbox.push(m);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('coop E2E réel sur serveur.py : salon → salle d’armes → boutique → salle 1 → coffre → salle 2 → déconnexion', async () => {
  const port = await freePort();
  const proc = spawn('python3', [path.join(ROOT, 'serveur.py'), String(port), '--no-browser'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const clients = [];
  try {
    await waitPort(port);
    const hostWs = await connectWs(port); clients.push(hostWs);
    const guestWs = await connectWs(port); clients.push(guestWs);
    const obsWs = await connectWs(port); clients.push(obsWs);

    // 1. L'hôte ouvre un salon depuis sa salle d'armes
    hostWs.send({ t: 'open', kind: 'soldier', wpn: 'sword', name: 'Hote' });
    const created = await hostWs.next((m) => m.t === 'created');
    assert.equal(created.hall, true);
    const code = created.code;

    // 2. L'hôte change de héros et met à jour son salon ; l'observateur voit le changement
    hostWs.send({ t: 'hall_state', kind: 'knight', wpn: 'spear' });
    // deux sockets : le serveur peut traiter la liste avant la mise à jour, on la redemande
    let list1;
    for (let k = 0; k < 20; k++) {
      obsWs.send({ t: 'list' });
      list1 = await obsWs.next((m) => m.t === 'rooms');
      if (list1.rooms[0]?.kind === 'knight') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(list1.rooms.length, 1);
    assert.equal(list1.rooms[0].code, code);
    assert.equal(list1.rooms[0].kind, 'knight');
    assert.equal(list1.rooms[0].wpn, 'spear');

    // 3. L'invité rejoint le salon -> échange hello -> l'hôte démarre la session coop
    guestWs.send({ t: 'join', code });
    const joined = await guestWs.next((m) => m.t === 'joined');
    assert.equal(joined.code, code);
    await hostWs.next((m) => m.t === 'peer');

    guestWs.send({ t: 'hello', kind: 'orc', wpn: 'axe', name: 'Invite', unlocked: ['soldier', 'orc'] });
    const helloG = await hostWs.next((m) => m.t === 'hello');
    assert.equal(helloG.kind, 'orc');

    const sid = 2026;
    const startMsg = {
      t: 'start', mode: 'online', game: 'dungeon', sid, seed: 4242,
      p1: 'knight', w1: 'spear', p2: 'orc', w2: 'axe',
      u1: ['soldier', 'knight'], u2: ['soldier', 'orc'],
    };
    hostWs.send(startMsg);
    const gotStart = await guestWs.next((m) => m.t === 'start');
    assert.equal(gotStart.sid, sid);

    // 4. Instancie CoopHost et CoopGuest reliés au vrai WebSocket
    const sim = new DungeonSim(startMsg.seed, [startMsg.p1, startMsg.p2], [startMsg.w1, startMsg.w2], [startMsg.u1, startMsg.u2]);
    sim.startHub();
    sim.ev.length = 0;
    const host = new CoopHost(sim, { sid, send: (m) => hostWs.send(m) });
    const guest = new CoopGuest({ sid, unlocked: [startMsg.u1, startMsg.u2], send: (m) => guestWs.send(m) });

    hostWs.onMessage((m) => { if (m.t === 'ci' || m.t === 'cp') host.receive(m); });
    guestWs.onMessage((m) => { if (m.t === 'cs' || m.t === 'cq') guest.receive(m); });

    const pump = async (ticks, i0 = NEUTRAL, i1 = NEUTRAL, gOpts = {}) => {
      for (let i = 0; i < ticks; i++) {
        host.tick(typeof i0 === 'function' ? i0(i) : i0);
        guest.tick(typeof i1 === 'function' ? i1(i) : i1, i === 0 ? gOpts : {});
        guest.interpolate(DT);
        if (i % 2 === 0) await sleep(5);
      }
      await sleep(30);
    };

    // Attend la synchronisation de la salle d'armes
    await pump(20);
    assert.ok(guest.ready, 'invité prêt sur vrai WebSocket');
    assert.equal(guest.sim.g.room, 0);
    assert.equal(guest.sim.f[0].kind, 'knight');
    assert.equal(guest.sim.f[1].kind, 'orc');

    // 5. L'invité entre en boutique et achète le marteau via le réseau réel
    const shopPad = HUB_PADS.find((pd) => pd.t === 'shop');
    sim.enterShop(sim.f[1], shopPad);
    await pump(10);
    assert.ok(guest.sim.f[1].shop > 0, 'invité se voit en boutique');

    const hammerIdx = WEAPON_IDS.indexOf('hammer');
    await pump(20, NEUTRAL, NEUTRAL, { shop: hammerIdx });
    assert.equal(sim.f[1].wpn, 'hammer', 'hôte a équipé le marteau de l’invité');
    assert.equal(guest.sim.f[1].wpn, 'hammer', 'invité voit son marteau');

    // 6. Entrée en salle 1 : l'hôte retire le salon de la liste publique
    sim.f[0].x = 0; sim.f[0].z = -ROOM_R + 0.1;
    await pump(80, { mx: 0, mz: -127, blk: false, press: 0 }, NEUTRAL);
    assert.equal(sim.g.room, 1);
    hostWs.send({ t: 'hall_state', open: false });
    await pump(15);
    assert.equal(guest.sim.g.room, 1, 'invité synchronisé sur salle 1');
    assert.equal(guest.sim.f.length, sim.f.length, 'même nombre d’entités en salle 1');

    // 7. Combat, butin et passage en salle 2
    sim.debugKill();
    await pump(15);
    assert.equal(sim.g.phase, 'clear');
    assert.deepEqual(guest.sim.pk.map((o) => o.n), sim.pk.map((o) => o.n), 'invité voit le butin');

    assert.equal(guest.sim.g.phase, 'clear');
    assert.equal(guest.sim.g.exitOpen, true);

    // Franchit la porte vers la salle 2 (sortie en -z ou -x selon sim.room.exit)
    if (sim.room.exit === 'z') {
      sim.f[0].x = 0; sim.f[0].z = -ROOM_R + 0.1;
      await pump(80, { mx: 0, mz: -127, blk: false, press: 0 }, NEUTRAL);
    } else {
      sim.f[0].x = -ROOM_R + 0.1; sim.f[0].z = 0;
      await pump(80, { mx: -127, mz: 0, blk: false, press: 0 }, NEUTRAL);
    }
    assert.equal(sim.g.room, 2, 'salle 2 atteinte');
    assert.equal(guest.sim.g.room, 2, 'invité synchronisé sur salle 2');

    // 8. L'invité quitte en salle 2 -> l'hôte reçoit 'bye', le salon reste caché, l'hôte continue solo
    const byeP = hostWs.next((m) => m.t === 'bye');
    guestWs.send({ t: 'leave' });
    await byeP;
    obsWs.send({ t: 'list' });
    const listAfter = await obsWs.next((m) => m.t === 'rooms');
    assert.equal(listAfter.rooms.length, 0, 'salon non relisté après départ en salle 2');

    assert.equal(sim.dropHero(1), true);
    assert.equal(sim.g.np, 1);
    assert.equal(sim.g.room, 2);
  } finally {
    for (const c of clients) c.close();
    proc.kill('SIGTERM');
  }
});
