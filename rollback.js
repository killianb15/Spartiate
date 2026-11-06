// =====================================================================
//  Rollback netcode (façon GGPO) au-dessus de Sim.
//
//  Chaque joueur applique TOUT DE SUITE ses propres touches (avec un tout petit délai
//  fixe, `delay` images) et PRÉDIT celles de l'adversaire (même déplacement, pas de
//  nouvelle touche pressée). Quand la vraie entrée arrive et diffère de la prédiction,
//  on revient à l'image concernée et on re-simule jusqu'à maintenant. Résultat : aucun
//  retard sur ses propres actions, quelle que soit la latence.
//
//  Ce module ne connaît ni le DOM ni le réseau : il reçoit des messages (receive) et en
//  produit via la fonction `send(msg, reliable)` fournie. Il fonctionne aussi bien sur un
//  canal fiable (WebSocket) que non fiable/désordonné (WebRTC DataChannel) : chaque
//  paquet répète les dernières entrées pas encore acquittées.
//
//  Désynchronisation : toutes les CHECK_EVERY images, on compare une empreinte de l'état
//  (devenu définitif). En cas de différence, l'hôte renvoie sa sauvegarde et l'invité la
//  charge, puis re-simule : la partie continue sans coupure.
// =====================================================================
import { NEUTRAL, hashState } from './sim.js';

export const CHECK_EVERY = 30;
const MAX_PACKET = 24;       // entrées envoyées par paquet (redondance contre la perte)
const KEEP = 180;            // images d'historique conservées pour les entrées

const same = (a, b) => a.mx === b.mx && a.mz === b.mz && a.blk === b.blk && a.press === b.press;
const enc = (i) => [i.mx, i.mz, (i.blk ? 1 : 0) | (i.press << 1)];
const dec = (a) => ({ mx: a[0] | 0, mz: a[1] | 0, blk: (a[2] & 1) === 1, press: (a[2] >> 1) & 31 });
const clampI = (v) => Math.max(-127, Math.min(127, v | 0));
function clean(i) { return { mx: clampI(i.mx), mz: clampI(i.mz), blk: !!i.blk, press: i.press & 31 }; }

// signature d'un événement pour ne pas le rejouer après une correction
function sig(e) {
  const k = e[0];
  return k === 'sfx' || k === 'pop' || k === 'announce' ? k + ':' + e[1] : k === 'fx' ? k + ':' + e[1] + e[2] : k;
}

export class Rollback {
  // opts : me (0|1), send(msg, reliable), delay (images), maxPred (images), onDesync(info)
  constructor(sim, { me, send, delay = 2, maxPred = 10, onDesync = null, keep = KEEP }) {
    this.sim = sim; this.me = me; this.rem = 1 - me; this.send = send;
    this.keep = keep; this.delay = delay; this.maxPred = maxPred; this.onDesync = onDesync;
    this.inputs = [new Map(), new Map()];   // images -> entrée connue (définitive)
    this.used = new Map();                  // images -> entrée adverse PRÉDITE utilisée
    this.snaps = new Map();                 // images -> état au début de l'image
    this.checks = new Map();                // images de contrôle -> empreinte
    this.checkSnaps = new Map();            // images de contrôle -> sauvegarde (resynchronisation)
    this.peerChecks = new Map();
    this.peerCheckDone = -1;               // dernière empreinte adverse déjà comparée
    this.played = [];                       // événements déjà joués (déduplication)
    this.out = [];                          // événements à jouer maintenant
    this.confirmedRem = -1;                 // toutes les entrées adverses <= cette image sont connues
    this.lastRem = NEUTRAL;
    this.peerAck = -1;                      // dernière de nos images que l'adversaire possède
    this.rbFrame = null;
    this.nextCheck = CHECK_EVERY;
    this.localScheduled = -1;
    this.stats = { rollbacks: 0, maxDepth: 0, resimFrames: 0, stalls: 0, desyncs: 0, resyncs: 0, sent: 0, received: 0 };
    // les `delay` premières images sont forcément neutres pour tout le monde
    for (let f = 0; f < delay; f++) { this.inputs[me].set(f, NEUTRAL); this.inputs[this.rem].set(f, NEUTRAL); }
    this.localScheduled = delay - 1;
    this.confirmedRem = delay - 1;
    this.peerAck = delay - 1;
    this.sim.record = true;
  }

  get frame() { return this.sim.g.frame; }
  takeEvents() { const e = this.out; this.out = []; return e; }

  // Entrée adverse pour l'image k : la vraie si on l'a, sinon on prolonge le dernier déplacement.
  remoteInput(k) {
    const known = this.inputs[this.rem].get(k);
    if (known) return known;
    return { mx: this.lastRem.mx, mz: this.lastRem.mz, blk: this.lastRem.blk, press: 0 };
  }

  stepFrame(k, resim) {
    const sim = this.sim;
    this.snaps.set(k, sim.save());
    const mine = this.inputs[this.me].get(k) ?? NEUTRAL;
    const known = this.inputs[this.rem].get(k);
    const theirs = known ?? this.remoteInput(k);
    if (known) this.used.delete(k); else this.used.set(k, theirs);
    sim.ev.length = 0;
    this.me === 0 ? sim.step(mine, theirs) : sim.step(theirs, mine);
    const evs = sim.ev; sim.ev = [];
    for (const e of evs) {
      const s = sig(e);
      if (resim) {
        const m = this.played.find((p) => !p.used && p.sig === s && Math.abs(p.frame - k) <= 10);
        if (m) { m.used = true; continue; }
        this.played.push({ frame: k, sig: s, used: true });
      } else this.played.push({ frame: k, sig: s, used: false });
      this.out.push(e);
    }
  }

  // À appeler une fois par image de 1/60 s avec l'entrée locale courante.
  // Retourne le nombre d'images simulées (0 si on attend l'adversaire).
  tick(local) {
    const sim = this.sim;
    let c = sim.g.frame;

    // 1. envoyer d'abord (même à l'arrêt, pour que l'adversaire reçoive nos entrées)
    if (this.localScheduled < c + this.delay && c - this.confirmedRem <= this.maxPred) {
      this.localScheduled++;
      this.inputs[this.me].set(this.localScheduled, clean(local));
    }
    this.sendPacket();

    // 2. correction : retour à la première image mal prédite puis re-simulation
    if (this.rbFrame !== null) {
      const from = this.rbFrame, snap = this.snaps.get(from);
      this.rbFrame = null;
      if (snap) {
        sim.load(snap);
        this.stats.rollbacks++;
        this.stats.maxDepth = Math.max(this.stats.maxDepth, c - from);
        this.stats.resimFrames += c - from;
        for (let k = from; k < c; k++) this.stepFrame(k, true);
      }
    }
    this.checkpoints();

    // 3. attendre si l'adversaire est trop en retard (trop d'images prédites)
    if (c - this.confirmedRem > this.maxPred) { this.stats.stalls++; this.prune(); return 0; }
    this.stepFrame(c, false);
    this.checkpoints();
    this.prune();
    return 1;
  }

  // ---------------- réseau ----------------
  sendPacket() {
    const from = this.peerAck + 1, to = this.localScheduled;
    const lo = Math.max(from, to - MAX_PACKET + 1);
    const list = [];
    for (let f = lo; f <= to; f++) list.push(enc(this.inputs[this.me].get(f) ?? NEUTRAL));
    const msg = { t: 'ri', f: lo, i: list, a: this.confirmedRem };
    const ck = this.latestCheck();
    if (ck) { msg.k = ck[0]; msg.h = ck[1]; }
    this.send(msg, false);
    this.stats.sent++;
  }

  latestCheck() {
    let best = null;
    for (const [f, h] of this.checks) if (!best || f > best[0]) best = [f, h];
    return best;
  }

  receive(m) {
    if (!m || typeof m !== 'object') return;
    this.stats.received++;
    if (m.t === 'ri') this.receiveInputs(m);
    else if (m.t === 'rs') this.receiveResync(m);
  }

  receiveInputs(m) {
    if (!Array.isArray(m.i) || !Number.isInteger(m.f)) return;
    if (Number.isInteger(m.a)) this.peerAck = Math.max(this.peerAck, m.a);
    const c = this.sim.g.frame;
    m.i.slice(0, MAX_PACKET).forEach((raw, n) => {
      const f = m.f + n;
      if (!Array.isArray(raw) || f <= this.confirmedRem) return;   // déjà connue (ou paquet en double)
      if (f > c + 600) return;                   // absurde : ignoré
      const inp = clean(dec(raw));
      if (this.inputs[this.rem].has(f)) return;
      this.inputs[this.rem].set(f, inp);
      if (f < c) {
        const guess = this.used.get(f);
        if (guess && !same(guess, inp) && (this.rbFrame === null || f < this.rbFrame)) this.rbFrame = f;
      }
    });
    while (this.inputs[this.rem].has(this.confirmedRem + 1)) {
      this.confirmedRem++;
      this.lastRem = this.inputs[this.rem].get(this.confirmedRem);
    }
    if (Number.isInteger(m.k) && Number.isInteger(m.h) && m.k > this.peerCheckDone) this.peerChecks.set(m.k, m.h);
  }

  // Empreintes de contrôle : l'état au début de l'image k est définitif quand toutes les
  // entrées < k sont connues des deux côtés (confirmedRem >= k-1 et pas de rollback en attente).
  checkpoints() {
    const c = this.sim.g.frame;
    while (this.nextCheck < c && this.nextCheck - 1 <= this.confirmedRem && this.rbFrame === null) {
      const k = this.nextCheck, snap = this.snaps.get(k);
      if (!snap) { this.nextCheck += CHECK_EVERY; continue; }
      this.checks.set(k, hashState(snap));
      this.checkSnaps.set(k, snap);
      for (const old of [...this.checks.keys()]) if (old < k - CHECK_EVERY * 6) { this.checks.delete(old); this.checkSnaps.delete(old); }
      this.nextCheck += CHECK_EVERY;
    }
    for (const [k, h] of this.peerChecks) {
      const mine = this.checks.get(k);
      if (mine === undefined) { if (k < this.nextCheck - CHECK_EVERY * 6) this.peerChecks.delete(k); continue; }
      this.peerChecks.delete(k);
      this.peerCheckDone = Math.max(this.peerCheckDone, k);
      if (mine !== h) this.desync(k);
    }
  }

  desync(k) {
    this.stats.desyncs++;
    this.onDesync?.({ frame: k, me: this.me });
    if (this.me === 0 && this.checkSnaps.has(k)) {
      // l'hôte fait foi : il renvoie sa sauvegarde (canal fiable)
      this.send({ t: 'rs', k, s: this.checkSnaps.get(k) }, true);
    }
  }

  receiveResync(m) {
    if (this.me !== 1 || !Number.isInteger(m.k) || !m.s || !m.s.f || !m.s.g) return;
    const c = this.sim.g.frame;
    if (m.k > c) return;
    this.stats.resyncs++;
    this.snaps.set(m.k, m.s);
    this.checkSnaps.set(m.k, m.s);
    this.checks.set(m.k, hashState(m.s));
    for (const f of [...this.checks.keys()]) if (f > m.k) this.checks.delete(f);   // périmées : recalculées après la re-simulation
    this.nextCheck = m.k + CHECK_EVERY;
    this.rbFrame = this.rbFrame === null ? m.k : Math.min(this.rbFrame, m.k);
  }

  prune() {
    const c = this.sim.g.frame, keepFrom = Math.min(c, this.confirmedRem) - 2;
    for (const k of this.snaps.keys()) if (k < keepFrom && !this.checkSnaps.has(k)) this.snaps.delete(k);
    for (const k of this.used.keys()) if (k < keepFrom) this.used.delete(k);
    for (const p of this.inputs) for (const k of p.keys()) if (k < c - this.keep) p.delete(k);
    if (this.played.length > 400 || (this.played.length && this.played[0].frame < c - 90))
      this.played = this.played.filter((p) => p.frame >= c - 90);
  }
}
