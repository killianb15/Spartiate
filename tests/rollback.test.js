import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim, NEUTRAL, hashState } from '../sim.js';
import { Rollback, CHECK_EVERY } from '../rollback.js';
import { Rng } from '../dmath.js';

// Réseau simulé : latence (en images), gigue, perte, doublons, désordre. Les messages passent par JSON
// comme sur un vrai canal.
class Net {
  constructor({ latency = 3, jitter = 0, loss = 0, dup = 0 } = {}, seed = 1) {
    Object.assign(this, { latency, jitter, loss, dup }); this.q = []; this.rng = new Rng(seed); this.now = 0; this.sent = 0;
  }
  push(to, msg, reliable) {
    this.sent++;
    if (!reliable && this.rng.next() < this.loss) return;
    const copies = !reliable && this.rng.next() < this.dup ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const d = this.latency + Math.floor(this.rng.next() * (this.jitter + 1));
      this.q.push({ at: this.now + d, to, msg: JSON.parse(JSON.stringify(msg)) });
    }
  }
  deliver(peers) {
    const due = this.q.filter((m) => m.at <= this.now);
    this.q = this.q.filter((m) => m.at > this.now);
    // ordre volontairement mélangé : les paquets non ordonnés existent
    due.sort((a, b) => a.at - b.at || this.rng.next() - 0.5);
    for (const m of due) peers[m.to].receive(m.msg);
  }
}

// Entrées scriptées : un déplacement qui change de temps en temps, des touches parfois
function script(seed) {
  const rng = new Rng(seed);
  let cur = { mx: 0, mz: 0, blk: false };
  return () => {
    if (rng.next() < 0.08) cur = { mx: Math.round(rng.range(-127, 127)), mz: Math.round(rng.range(-127, 127)), blk: rng.next() < 0.25 };
    return { ...cur, press: rng.next() < 0.06 ? 1 << Math.floor(rng.range(0, 5)) : 0 };
  };
}

function makePair(netOpts, { delay = 2, maxPred = 10, seed = 1, skewEvery = 0 } = {}) {
  const net = new Net(netOpts, seed);
  const sims = [new Sim(seed), new Sim(seed)];
  const peers = [];
  const opts = (me) => ({ me, delay, maxPred, keep: 1e9, send: (m, rel) => net.push(1 - me, m, rel) });
  peers[0] = new Rollback(sims[0], opts(0));
  peers[1] = new Rollback(sims[1], opts(1));
  sims.forEach((s) => s.startMatch());
  const scr = [script(seed * 7 + 1), script(seed * 7 + 2)];
  const evCount = [{}, {}];
  const tickAll = (drive = true) => {
    net.now++;
    net.deliver(peers);
    peers.forEach((p, i) => {
      const n = (skewEvery && i === 1 && net.now % skewEvery === 0) ? 2 : 1;   // l'horloge de l'invité avance un peu plus vite
      for (let k = 0; k < n; k++) p.tick(drive ? scr[i]() : NEUTRAL);
      for (const e of p.takeEvents()) { const s = e[0] + (e[0] === 'sfx' ? ':' + e[1] : ''); evCount[i][s] = (evCount[i][s] || 0) + 1; }
    });
  };
  return { net, sims, peers, tickAll, evCount };
}

// Rejoue les entrées définitives dans une simulation de référence et compare l'état à l'image K
function verify(peers, extra = '') {
  const K = Math.min(peers[0].confirmedRem, peers[1].confirmedRem) - 5;
  assert.ok(K > 100, `trop peu d'images confirmées (${K}) ${extra}`);
  const ref = new Sim(peers[0].sim.rng.s && 1);
  // la graine de départ est la même pour les deux : on la retrouve en repartant d'un Sim neuf identique
  return { K, ref };
}

function reference(seed, peers, K) {
  const ref = new Sim(seed); ref.startMatch(); ref.ev.length = 0;
  for (let k = 0; k < K; k++) {
    const a = peers[0].inputs[0].get(k) ?? peers[1].inputs[0].get(k);
    const b = peers[0].inputs[1].get(k) ?? peers[1].inputs[1].get(k);
    assert.ok(a && b, `entrée manquante à l'image ${k}`);
    ref.step(a, b); ref.ev.length = 0;
  }
  return ref;
}

// dernier point de contrôle (image multiple de CHECK_EVERY) connu des deux pairs
function lastCommonCheck(peers) {
  const common = [...peers[0].checks.keys()].filter((k) => peers[1].checks.has(k));
  assert.ok(common.length > 0, 'aucun point de contrôle commun');
  return Math.max(...common);
}

function converge(netOpts, rbOpts = {}, frames = 3000) {
  const seed = rbOpts.seed ?? 1;
  const t = makePair(netOpts, rbOpts);
  for (let i = 0; i < frames; i++) t.tickAll();
  // on laisse le réseau se vider (plus d'actions, neutre) pour que tout devienne définitif
  for (let i = 0; i < 120; i++) t.tickAll(false);
  const K = lastCommonCheck(t.peers);
  assert.ok(K > frames / 2, `peu d'images confirmées : ${K}`);
  const hRef = reference(seed, t.peers, K).hash();
  for (const p of t.peers) assert.equal(p.checks.get(K), hRef, `l'état du pair ${p.me} diffère de la référence à l'image ${K}`);
  return { ...t, K };
}

test('latence nulle : les deux pairs restent identiques à la référence', () => {
  const t = converge({ latency: 0 });
  assert.equal(t.peers[0].stats.desyncs + t.peers[1].stats.desyncs, 0);
});

test('latence 50 ms + gigue : convergence, rollbacks utilisés, aucune désynchro', () => {
  const t = converge({ latency: 3, jitter: 2 });
  assert.ok(t.peers[0].stats.rollbacks + t.peers[1].stats.rollbacks > 0, 'des rollbacks étaient attendus');
  assert.equal(t.peers[0].stats.desyncs + t.peers[1].stats.desyncs, 0);
  assert.ok(Math.max(t.peers[0].stats.maxDepth, t.peers[1].stats.maxDepth) <= 12);
});

test('30 % de perte + doublons + désordre : convergence', () => {
  const t = converge({ latency: 4, jitter: 4, loss: 0.3, dup: 0.2 }, { seed: 3 });
  assert.equal(t.peers[0].stats.desyncs + t.peers[1].stats.desyncs, 0);
});

test('60 % de perte : convergence (les paquets répètent les entrées non acquittées)', () => {
  converge({ latency: 2, jitter: 2, loss: 0.6 }, { seed: 4 }, 2000);
});

test('latence 200 ms : l\'adversaire attendu (stall) mais jamais plus de maxPred images prédites', () => {
  const t = converge({ latency: 12 }, { maxPred: 8, seed: 5 }, 2500);
  assert.ok(t.peers[0].stats.stalls + t.peers[1].stats.stalls > 0, 'des attentes étaient attendues');
  for (const p of t.peers) assert.ok(p.stats.maxDepth <= 9, `profondeur ${p.stats.maxDepth}`);
});

test('horloges légèrement différentes : convergence', () => {
  converge({ latency: 3, jitter: 1 }, { seed: 6, skewEvery: 40 }, 3000);
});

test('plusieurs graines et réglages : toujours identique à la référence', () => {
  for (const seed of [11, 12, 13, 14]) converge({ latency: 1 + (seed % 5), jitter: seed % 3, loss: 0.1 * (seed % 4), dup: 0.1 }, { seed, delay: seed % 3 + 1 }, 1800);
});

test('réactivité locale : ses propres touches agissent sans attendre le réseau', () => {
  const net = new Net({ latency: 1000 });                  // réseau « mort »
  const sim = new Sim(1);
  const rb = new Rollback(sim, { me: 0, delay: 2, send: (m, r) => net.push(1, m, r) });
  sim.startMatch();
  // l'adversaire est connu pour rester neutre pendant 400 images : aucun paquet n'est attendu ensuite
  for (let f = 0; f < 400; f += 24) rb.receive({ t: 'ri', f, i: Array(24).fill([0, 0, 0]), a: 0 });
  for (let i = 0; i < 300 && sim.g.phase !== 'fight'; i++) rb.tick(NEUTRAL);
  assert.equal(sim.g.phase, 'fight');
  sim.f[1].x = 1.2; sim.f[0].x = 0;                        // à portée
  const before = sim.g.frame;
  rb.tick({ mx: 0, mz: 0, blk: false, press: 1 });         // attaque
  for (let i = 0; i < 3 && sim.f[0].state !== 'attack'; i++) rb.tick(NEUTRAL);
  assert.equal(sim.f[0].state, 'attack');
  assert.ok(sim.g.frame - before <= 4, 'l\'action doit apparaître en ≤ delay+1 images');
});

test('sans nouvelles de l\'adversaire, on s\'arrête au bout de maxPred images', () => {
  const sim = new Sim(1);
  const rb = new Rollback(sim, { me: 0, delay: 2, maxPred: 6, send: () => {} });
  sim.startMatch();
  let n = 0; for (let i = 0; i < 100; i++) n += rb.tick(NEUTRAL);
  assert.ok(n <= 6 + 2 + 1, `${n} images simulées sans nouvelles`);
  assert.ok(rb.stats.stalls > 0);
});

test('désynchronisation provoquée : détectée puis réparée par l\'hôte', () => {
  const t = makePair({ latency: 3, jitter: 1 }, { seed: 8 });
  for (let i = 0; i < 300; i++) t.tickAll();
  // corruption volontaire côté invité, aussi dans ses sauvegardes (sinon un rollback l'effacerait par hasard)
  for (const o of [t.sims[1], ...t.peers[1].snaps.values()]) { const f = o.f; f[0].x += 0.37; f[1].hp -= 13; }
  for (let i = 0; i < 400; i++) t.tickAll();
  for (let i = 0; i < 120; i++) t.tickAll(false);
  assert.ok(t.peers[0].stats.desyncs + t.peers[1].stats.desyncs > 0, 'désynchro non détectée');
  assert.ok(t.peers[1].stats.resyncs > 0, 'l\'invité n\'a pas été resynchronisé');
  const K = lastCommonCheck(t.peers);
  assert.ok(K > 500, `point de contrôle ${K}`);
  assert.equal(t.peers[0].checks.get(K), t.peers[1].checks.get(K), 'les états ne sont pas redevenus identiques');
});

test('événements : les coups réels sont tous joués, pas de doublons massifs', () => {
  const seed = 21;
  const t = makePair({ latency: 4, jitter: 3, loss: 0.15 }, { seed });
  for (let i = 0; i < 2400; i++) t.tickAll();
  for (let i = 0; i < 120; i++) t.tickAll(false);
  const K = Math.min(t.peers[0].confirmedRem, t.peers[1].confirmedRem) - 1;
  // référence : combien de coups ont réellement eu lieu
  const ref = new Sim(seed); ref.startMatch();
  let hits = 0;
  for (let k = 0; k < K; k++) {
    ref.step(t.peers[0].inputs[0].get(k), t.peers[0].inputs[1].get(k));
    hits += ref.ev.filter((e) => e[0] === 'sfx' && e[1] === 'hit').length; ref.ev.length = 0;
  }
  assert.ok(hits > 3, `peu de coups dans le scénario (${hits})`);
  for (const i of [0, 1]) {
    const played = t.evCount[i]['sfx:hit'] || 0;
    assert.ok(played >= hits * 0.9, `pair ${i} : ${played} sons de coup joués pour ${hits} réels (coups manquants)`);
    assert.ok(played <= hits * 1.6 + 3, `pair ${i} : ${played} sons de coup pour ${hits} réels (doublons)`);
  }
});

test('messages malformés ou hostiles ignorés sans planter', () => {
  const t = makePair({ latency: 1 }, { seed: 2 });
  const rb = t.peers[0];
  for (const bad of [null, 5, 'x', {}, { t: 'ri' }, { t: 'ri', f: 'a', i: [] }, { t: 'ri', f: 0, i: 'zz' }, { t: 'ri', f: 0, i: [[1], 7, null] },
    { t: 'ri', f: 1e12, i: [[0, 0, 0]] }, { t: 'rs', k: 5, s: {} }, { t: 'rs', k: -1, s: null }, { t: 'zzz' }])
    rb.receive(bad);
  for (let i = 0; i < 200; i++) t.tickAll();
  assert.ok(rb.frame > 100);
});
