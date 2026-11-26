// =====================================================================
//  Moteur réseau dédié au mode COOP (Donjon à 2 joueurs en ligne).
//
//  Architecture hôte-autoritaire, conçue de zéro pour le coop PvE :
//  - L'HÔTE (CoopHost) fait tourner l'unique DungeonSim de référence à 60 Hz :
//    jamais de gel, jamais de rollback sur 12 entités/IA, jamais de désynchronisation.
//  - L'INVITÉ (CoopGuest) envoie ses déplacements continus + une file d'actions
//    ponctuelles numérotées (coups, sauts, roulades, boutique, bénédictions) répétées
//    jusqu'à acquittement par l'hôte → aucune action perdue même sous forte perte de paquets.
//  - L'HÔTE diffuse à 30 Hz (et immédiatement sur chaque transition) des instantanés
//    compacts + les événements visuels/sonores numérotés (joués exactement une fois)
//    + le descripteur de salle jusqu'à acquittement par l'invité.
//  - L'INVITÉ interpole en douceur les positions et angles entre instantanés pour un
//    rendu fluide à 60/144 FPS même si les deux PC ont des fréquences différentes.
//  - Chaque session porte un identifiant unique `sid` : tout paquet périmé d'une
//    partie précédente est ignoré.
// =====================================================================
import { DT, NEUTRAL, PRESS, WEAPONS } from './sim.js';
import { BOONS, FIRST_HERO, HEROES, WEAPON_IDS, pickInput, shopInput } from './dungeon.js';
import { clamp, lerpAng, hypot } from './dmath.js';

const SNAP_EVERY = 2;       // instantané envoyé toutes les 2 images (30 Hz)
const HEARTBEAT_EVERY = 30; // maintien de vie même à l'arrêt / fin de partie (0,5 s)
const MAX_ACTS = 16;        // actions non acquittées répétées par paquet
const MAX_EV_BUF = 120;     // tampon d'événements en attente d'acquittement
const PING_MS = 1500;       // mesure de latence toutes les 1,5 s

const r3 = (v) => Math.round(v * 1000) / 1000;
const clampI = (v) => Math.max(-127, Math.min(127, v | 0));

// ---------- Sérialisation compacte des combattants et projectiles ----------
export function packFighter(f) {
  const o = {
    idx: f.idx, x: r3(f.x), y: r3(f.y), z: r3(f.z),
    vx: r3(f.vx), vy: r3(f.vy), vz: r3(f.vz),
    yaw: r3(f.yaw), visTarget: r3(f.visTarget),
    hp: Math.round(f.hp * 10) / 10, maxHp: f.maxHp,
    guard: Math.round(f.guard * 10) / 10,
    sta: Math.round(f.sta * 10) / 10, staFail: r3(f.staFail),
    state: f.state, stateT: r3(f.stateT),
    airAtk: f.airAtk ? 1 : 0, airAtkT: r3(f.airAtkT), combo: f.combo,
    rdx: r3(f.rdx), rdz: r3(f.rdz),
    anim: f.anim, animTs: r3(f.animTs), animLoop: f.animLoop ? 1 : 0,
    animRestart: f.animRestart ? 1 : 0, animFade: r3(f.animFade), animN: f.animN, resetN: f.resetN,
    kind: f.kind, wpn: f.wpn, arch: f.arch ? 1 : 0,
    foe: f.foe || '', size: f.size ?? 1, boss: f.boss ? 1 : 0,
    team: f.team ?? 0, owner: f.owner ?? -1, kills: f.kills ?? 0,
    down: f.down ? 1 : 0, revT: r3(f.revT ?? 0), shop: f.shop ?? 0,
    boons: f.boons || '', phoenix: f.phoenix ? 1 : 0,
    spellCd: r3(f.spellCd ?? 0), spellMax: f.spellMax ?? 7, spellBuffT: r3(f.spellBuffT ?? 0),
  };
  if (f.brute) o.brute = 1;
  if (f.sp !== undefined) {
    o.sp = f.sp; o.spT = r3(f.spT); o.spA = f.spA;
    o.spX = r3(f.spX); o.spZ = r3(f.spZ); o.rage = f.rage ? 1 : 0;
  }
  return o;
}

export function unpackFighter(p, prev = null) {
  const f = prev ?? {};
  const snap = !prev || prev.resetN !== p.resetN || prev.kind !== p.kind || hypot(p.x - prev.x, p.z - prev.z) > 2.6;
  f.idx = p.idx;
  f.tx = p.x; f.ty = p.y; f.tz = p.z;
  f.tyaw = p.yaw; f.tvis = p.visTarget;
  if (snap) {
    f.x = p.x; f.y = p.y; f.z = p.z;
    f.yaw = p.yaw; f.visTarget = p.visTarget;
  }
  f.vx = p.vx; f.vy = p.vy; f.vz = p.vz;
  f.hp = p.hp; f.maxHp = p.maxHp; f.guard = p.guard;
  f.sta = p.sta; f.staFail = p.staFail;
  f.state = p.state; f.stateT = p.stateT;
  f.airAtk = !!p.airAtk; f.airAtkT = p.airAtkT; f.combo = p.combo;
  f.rdx = p.rdx; f.rdz = p.rdz;
  f.anim = p.anim; f.animTs = p.animTs; f.animLoop = !!p.animLoop;
  f.animRestart = !!p.animRestart; f.animFade = p.animFade;
  f.animN = p.animN; f.resetN = p.resetN;
  f.kind = p.kind; f.wpn = p.wpn; f.arch = !!p.arch;
  f.foe = p.foe; f.size = p.size; f.boss = !!p.boss;
  f.team = p.team; f.owner = p.owner; f.kills = p.kills;
  f.down = p.down; f.revT = p.revT; f.shop = p.shop;
  f.boons = p.boons; f.phoenix = p.phoenix;
  f.spellCd = p.spellCd ?? 0; f.spellMax = p.spellMax ?? 7; f.spellBuffT = p.spellBuffT ?? 0;
  f.brute = p.brute ? 1 : 0;
  if (p.sp !== undefined) {
    f.sp = p.sp; f.spT = p.spT; f.spA = p.spA;
    f.spX = p.spX; f.spZ = p.spZ; f.rage = p.rage;
  } else {
    delete f.sp; delete f.spT; delete f.spA; delete f.spX; delete f.spZ; delete f.rage;
  }
  return f;
}

const packPr = (a) => [r3(a.x), r3(a.y), r3(a.z), r3(a.vx), r3(a.vy), r3(a.vz), a.k | 0, a.o | 0];
const unpackPr = (a) => ({ x: a[0], y: a[1], z: a[2], vx: a[3], vy: a[4], vz: a[5], k: a[6], o: a[7] });

// hauteur du sol (identique à DungeonSim.groundY, utilisée par l'affichage invité)
function roomGroundY(room, f) {
  let h = 0;
  const surf = room?.surf;
  if (!surf) return 0;
  for (let i = 0; i < surf.length; i++) {
    const s = surf[i];
    if (f.x > s.x0 && f.x < s.x1 && f.z > s.z0 && f.z < s.z1) {
      const sh = s.ramp ? s.h * clamp(((s.ramp === 'x' ? f.x : f.z) - s.from) / (s.to - s.from), 0, 1) : s.h;
      if (sh > h) h = sh;
    }
  }
  return h;
}

// =====================================================================
//  HÔTE COOP : exécute DungeonSim de manière autoritaire et diffuse l'état
// =====================================================================
export class CoopHost {
  constructor(sim, { sid, send, now = () => Date.now() }) {
    this.sim = sim;
    this.sid = sid;
    this.send = send;
    this.now = now;
    this.role = 'host';
    this.me = 0;
    this.tickN = 0;
    this.out = [];              // événements locaux à jouer chez l'hôte
    this.evId = 0;              // identifiant monotone d'événement
    this.evBuf = [];            // [[id, ev], ...] en attente d'acquittement invité
    this.guestHold = { mx: 0, mz: 0, blk: false };
    this.guestActSeq = 0;       // dernier seq d'action consommé de l'invité
    this.guestActs = [];        // actions en attente à injecter dans DungeonSim
    this.guestRoomAck = -1;     // dernier roomVer confirmé par l'invité
    this.guestEvAck = 0;        // dernier evId confirmé par l'invité
    this.roomVer = 1;
    this.lastRoom = sim.g.room;
    this.lastRoomRef = sim.room;
    this.lastPhase = sim.g.phase;
    this.lastChest = sim.g.chest;
    this.lastEquip = '';
    this.sentTick = -99;
    this.stats = { ping: 0, sent: 0, recv: 0, lastRecv: now(), stalled: false };
    this.sim.record = true;
    // premier instantané complet envoyé tout de suite (en fiable)
    this.broadcast(true);
  }

  takeEvents() { const e = this.out; this.out = []; return e; }

  receive(m) {
    if (!m || typeof m !== 'object' || m.sid !== this.sid) return;
    this.stats.recv++;
    this.stats.lastRecv = this.now();
    if (m.t === 'cp') {
      // réponse immédiate au ping de l'invité
      this.send({ t: 'cq', sid: this.sid, ts: m.ts }, false);
      return;
    }
    if (m.t === 'ci') {
      this.guestHold.mx = clampI(m.mx);
      this.guestHold.mz = clampI(m.mz);
      this.guestHold.blk = !!m.blk;
      if (Number.isInteger(m.rAck)) this.guestRoomAck = Math.max(this.guestRoomAck, m.rAck);
      if (Number.isInteger(m.eAck)) {
        this.guestEvAck = Math.max(this.guestEvAck, m.eAck);
        while (this.evBuf.length && this.evBuf[0][0] <= this.guestEvAck) this.evBuf.shift();
      }
      if (Array.isArray(m.acts)) {
        for (const a of m.acts) {
          if (!Array.isArray(a) || !Number.isInteger(a[0]) || a[0] <= this.guestActSeq) continue;
          this.guestActSeq = a[0];
          this.guestActs.push({ press: (a[1] | 0) & 63, shop: a[2] ?? -1, pick: a[3] ?? -1 });
        }
      }
    }
  }

  // Construit l'entrée de l'invité pour cette image de simulation
  nextGuestInput() {
    const g = this.sim.g;
    if (this.guestActs.length) {
      const a = this.guestActs.shift();
      if (a.pick >= 0 && g.phase === 'reward') return pickInput(a.pick);
      if (a.shop >= 0 && g.phase === 'hub') return shopInput(a.shop);
      return { mx: this.guestHold.mx, mz: this.guestHold.mz, blk: this.guestHold.blk, press: a.press };
    }
    return { mx: this.guestHold.mx, mz: this.guestHold.mz, blk: this.guestHold.blk, press: 0 };
  }

  // Avance la simulation d'une image (1/60 s) et diffuse l'état si nécessaire
  tick(hostInput) {
    const sim = this.sim;
    this.tickN++;
    const i1 = this.nextGuestInput();
    sim.ev.length = 0;
    sim.step(hostInput, i1);
    const evs = sim.ev;
    if (evs.length) {
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        this.out.push(e);
        this.evBuf.push([++this.evId, e]);
      }
      if (this.evBuf.length > MAX_EV_BUF) this.evBuf.splice(0, this.evBuf.length - MAX_EV_BUF);
      sim.ev = [];
    }
    const roomChanged = sim.g.room !== this.lastRoom || sim.room !== this.lastRoomRef;
    if (roomChanged) {
      this.roomVer++;
      this.lastRoom = sim.g.room;
      this.lastRoomRef = sim.room;
    }
    const eq = sim.f.slice(0, sim.g.np).map((h) => h.kind + ':' + h.wpn + ':' + h.shop).join('|');
    const urgent = roomChanged || sim.g.phase !== this.lastPhase || sim.g.chest !== this.lastChest || eq !== this.lastEquip;
    this.lastPhase = sim.g.phase;
    this.lastChest = sim.g.chest;
    this.lastEquip = eq;

    const needSend = urgent || (this.tickN - this.sentTick >= (sim.g.phase === 'end' ? HEARTBEAT_EVERY : SNAP_EVERY));
    if (needSend) this.broadcast(roomChanged || sim.g.phase === 'end');
    return 1;
  }

  broadcast(reliable = false) {
    const sim = this.sim;
    this.sentTick = this.tickN;
    const needRoom = this.guestRoomAck < this.roomVer;
    const msg = {
      t: 'cs',
      sid: this.sid,
      tk: this.tickN,
      ack: this.guestActSeq,
      rVer: this.roomVer,
      g: { ...sim.g },
      f: sim.f.map(packFighter),
      pr: sim.pr.map(packPr),
    };
    if (this.evBuf.length) msg.ev = this.evBuf;
    if (needRoom) msg.room = sim.room;
    this.send(msg, reliable || needRoom);
    this.stats.sent++;
  }
}

// =====================================================================
//  INVITÉ COOP : envoie ses entrées fiables et reconstruit une vue fluide
// =====================================================================
export class CoopGuest {
  constructor({ sid, send, unlocked = null, now = () => Date.now() }) {
    this.sid = sid;
    this.send = send;
    this.now = now;
    this.role = 'guest';
    this.me = 1;
    this.tickN = 0;
    this.actSeq = 0;
    this.actQueue = [];         // [[seq, press, shop, pick], ...] non acquittés
    this.hostAck = 0;
    this.lastSnapTick = -1;
    this.roomVer = 0;
    this.lastEvId = 0;
    this.out = [];
    this.lastPing = 0;
    this.lastSend = -99;
    this.lastHold = { mx: 0, mz: 0, blk: false };
    this.stats = { ping: 0, sent: 0, recv: 0, lastRecv: now(), stalled: false };

    // Façade compatible avec DungeonSim pour l'affichage (game.js)
    const guest = this;
    this.sim = {
      isCoopGuest: true,
      unlocked: unlocked ? unlocked.map((u) => (Array.isArray(u) ? u.filter((k) => HEROES[k]) : [])) : null,
      f: [],
      pr: [],
      ev: [],
      g: { phase: 'hub', np: 2, room: 0, kills: 0, t: 0, clock: 0, slow: 1, slowT: 0, hitstop: 0, frame: 0,
        exitOpen: true, chest: 0, chestX: 0, chestZ: 0, o0: '', o1: '', o2: '', pick0: -1, pick1: -1, flagEnd: false },
      room: { exit: 'z', obs: [], surf: [], traps: [], boss: false, hub: true, pads: [] },
      get heroes() { return this.f.slice(0, this.g.np); },
      get foesLeft() { let n = 0; for (let i = 0; i < this.f.length; i++) if (this.f[i].team === 1 && this.f[i].state !== 'dead') n++; return n; },
      get offer() { return [this.g.o0, this.g.o1, this.g.o2]; },
      isHero(f) { return f.idx < this.g.np; },
      canPick(i, kind) { return !this.unlocked || kind === FIRST_HERO || !!this.unlocked[i]?.includes(kind); },
      mustPick(h) { return this.g.phase === 'reward' && h < this.g.np && this.f[h]?.state !== 'dead' && this.g['pick' + h] < 0; },
      canChoose(h, c) {
        if (!this.mustPick(h)) return false;
        const id = this.offer[c], p = this.f[h];
        if (!BOONS[id] || !p) return false;
        return !(BOONS[id].unique && p.boons.split(',').includes(id));
      },
      groundY(f) { return roomGroundY(this.room, f); },
      effectiveDt() { return this.g.hitstop > 0 ? 0 : DT * this.g.slow; },
      _guest: guest,
    };
  }

  get ready() { return this.lastSnapTick >= 0 && this.sim.f.length >= 2; }
  takeEvents() { const e = this.out; this.out = []; return e; }

  receive(m) {
    if (!m || typeof m !== 'object' || m.sid !== this.sid) return;
    const tNow = this.now();
    this.stats.recv++;
    this.stats.lastRecv = tNow;
    if (m.t === 'cq') {
      if (Number.isFinite(m.ts)) {
        const rtt = Math.max(0, tNow - m.ts);
        this.stats.ping = this.stats.ping ? Math.round(this.stats.ping * 0.7 + rtt * 0.3) : Math.round(rtt);
      }
      return;
    }
    if (m.t !== 'cs') return;
    if (Number.isInteger(m.ack)) {
      this.hostAck = Math.max(this.hostAck, m.ack);
      while (this.actQueue.length && this.actQueue[0][0] <= this.hostAck) this.actQueue.shift();
    }
    // ignore un instantané plus ancien (paquets UDP dans le désordre)
    if (!Number.isInteger(m.tk) || m.tk < this.lastSnapTick) return;
    this.lastSnapTick = m.tk;
    const sim = this.sim;
    let roomChanged = false;
    if (Number.isInteger(m.rVer) && m.rVer > this.roomVer && m.room) {
      this.roomVer = m.rVer;
      sim.room = m.room;
      roomChanged = true;
    }
    if (m.g && typeof m.g === 'object') Object.assign(sim.g, m.g);
    if (Array.isArray(m.f)) {
      const next = [];
      for (let i = 0; i < m.f.length; i++) {
        const prev = !roomChanged && sim.f[i] && sim.f[i].kind === m.f[i].kind ? sim.f[i] : null;
        next.push(unpackFighter(m.f[i], prev));
      }
      sim.f = next;
    }
    if (Array.isArray(m.pr)) sim.pr = m.pr.map(unpackPr);
    if (Array.isArray(m.ev)) {
      for (let i = 0; i < m.ev.length; i++) {
        const item = m.ev[i];
        if (!Array.isArray(item) || !Number.isInteger(item[0]) || item[0] <= this.lastEvId) continue;
        this.lastEvId = item[0];
        this.out.push(item[1]);
      }
    }
  }

  // Enregistre l'entrée locale (touches maintenues + actions ponctuelles) et l'envoie à l'hôte
  tick(inp = NEUTRAL, { shop = -1, pick = -1 } = {}) {
    this.tickN++;
    const mx = clampI(inp.mx), mz = clampI(inp.mz), blk = !!inp.blk, press = (inp.press | 0) & 63;
    const hasAct = press !== 0 || shop >= 0 || pick >= 0;
    if (hasAct) {
      this.actQueue.push([++this.actSeq, press, shop, pick]);
      if (this.actQueue.length > MAX_ACTS) this.actQueue.shift();
    }
    const changed = hasAct || mx !== this.lastHold.mx || mz !== this.lastHold.mz || blk !== this.lastHold.blk;
    this.lastHold.mx = mx; this.lastHold.mz = mz; this.lastHold.blk = blk;
    // envoi immédiat dès qu'une touche change ou qu'une action est en attente, sinon maintien à 20 Hz
    if (changed || this.actQueue.length > 0 || this.tickN - this.lastSend >= 3) {
      this.lastSend = this.tickN;
      const msg = { t: 'ci', sid: this.sid, mx, mz, blk, rAck: this.roomVer, eAck: this.lastEvId };
      if (this.actQueue.length) msg.acts = this.actQueue;
      // shop/pick sont envoyés en fiable pour ne jamais rater un clic de menu
      this.send(msg, shop >= 0 || pick >= 0);
      this.stats.sent++;
    }
    const tNow = this.now();
    if (tNow - this.lastPing >= PING_MS) {
      this.lastPing = tNow;
      this.send({ t: 'cp', sid: this.sid, ts: tNow }, false);
    }
    this.stats.stalled = tNow - this.stats.lastRecv > 2000;
    return 1;
  }

  // Interpolation fluide des positions/angles et projectiles à la fréquence d'affichage (60/144 FPS)
  interpolate(dt) {
    const sim = this.sim;
    const k = Math.min(1, 1 - Math.exp(-dt * 24));
    for (let i = 0; i < sim.f.length; i++) {
      const f = sim.f[i];
      if (f.tx === undefined) continue;
      // légère avance selon la vitesse entre deux instantanés (évite l'impression de retard)
      f.tx += f.vx * dt * 0.5;
      f.tz += f.vz * dt * 0.5;
      f.x += (f.tx - f.x) * k;
      f.y += (f.ty - f.y) * k;
      f.z += (f.tz - f.z) * k;
      f.yaw = lerpAng(f.yaw, f.tyaw, k);
      f.visTarget = lerpAng(f.visTarget, f.tvis, k);
    }
    for (let i = 0; i < sim.pr.length; i++) {
      const a = sim.pr[i];
      a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt;
    }
  }
}
