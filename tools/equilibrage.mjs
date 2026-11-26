// =====================================================================
//  Mesure de l'équilibrage seul / à deux : les héros sont joués par l'IA du jeu (niveau difficile),
//  sur les mêmes salles (mêmes graines), sans bénédiction. Pour chaque salle : temps pour la nettoyer,
//  PV perdus par les héros, salle perdue (tous les héros à terre) ou non.
//
//    node tools/equilibrage.mjs [nombre de graines] [salles, ex. 1,3,5,8,10,15] [tank] [hp=1.4,count=2…]
//  tank : héros à 5000 PV (ils ne tombent pas) : on compare alors les dégâts reçus PAR HÉROS (pression
//  sur chaque joueur) et le temps pour nettoyer la salle, aussi dans les salles profondes.
//  Les réglages hp=… count=… changent COOP (dungeon.js) le temps de la mesure, pour les essayer.
// =====================================================================
import { DungeonSim, COOP } from '../dungeon.js';
import { AI } from '../ai.js';
import { NEUTRAL } from '../sim.js';

const N = +(process.argv[2] ?? 12);
const ROOMS = (process.argv[3] ?? '1,3,5,8,10,12,15').split(',').map(Number);
const TANK = process.argv.includes('tank');
const LIMIT = (TANK ? 240 : 90) * 60;   // durée de combat au plus
for (const a of process.argv.slice(4)) for (const kv of a.split(',')) { const [k, v] = kv.split('='); if (k in COOP && v) COOP[k] = +v; }

function play(np, room, seed) {
  const s = new DungeonSim(seed, np > 1 ? ['soldier', 'soldier'] : ['soldier'], ['sword', 'sword']);
  s.start();
  s.debugGoto(room);
  while (s.g.phase !== 'fight') s.step();
  if (TANK) for (const p of s.heroes) p.hp = p.maxHp = 5000;
  const heroes = s.heroes, hp0 = heroes.reduce((a, p) => a + p.hp, 0), maxHp = heroes.reduce((a, p) => a + p.maxHp, 0);
  const ais = heroes.map((p, i) => new AI(s, i, 2, seed * 31 + i));
  let k = 0;
  // un héros à terre ne se relève qu'à la salle suivante : la salle est perdue si tous sont tombés
  for (; k < LIMIT && s.g.phase === 'fight'; k++) s.step(ais[0].update(s.dt), ais[1] ? ais[1].update(s.dt) : NEUTRAL);
  const lost = heroes.every((p) => p.state === 'dead');
  const hpLeft = heroes.reduce((a, p) => a + (p.state === 'dead' ? 0 : p.hp), 0);
  // tank : dégâts reçus par héros, en PV « normaux » (un héros a 100 PV)
  return { t: k / 60, lost, dmg: TANK ? (hp0 - hpLeft) / heroes.length / 100 : (hp0 - hpLeft) / maxHp };
}

const pct = (x) => `${Math.round(x * 100)} %`;
console.log(`${N} graines par salle, héros IA niveau difficile au glaive, sans bénédiction ; COOP ${JSON.stringify(COOP)}`);
console.log(TANK ? 'salle | seul : temps  dégâts reçus/héros | à deux : temps  dégâts reçus/héros | à deux / seul'
  : 'salle | seul : temps  PV perdus  défaites | à deux : temps  PV perdus  défaites');
const ratios = [];
for (const room of ROOMS) {
  const r = [1, 2].map((np) => {
    let t = 0, dmg = 0, lost = 0;
    for (let seed = 1; seed <= N; seed++) { const o = play(np, room, seed); t += o.t; dmg += o.dmg; lost += o.lost ? 1 : 0; }
    return { t: t / N, dmg: dmg / N, lost: lost / N };
  });
  const rt = r[1].t / r[0].t, rd = r[1].dmg / Math.max(1e-6, r[0].dmg);
  if (room > 1) ratios.push([rt, rd]);
  const line = TANK
    ? `${String(room).padStart(5)} | ${r[0].t.toFixed(1).padStart(7)} s ${pct(r[0].dmg).padStart(8)} | ${r[1].t.toFixed(1).padStart(9)} s ${pct(r[1].dmg).padStart(8)} | temps ${rt.toFixed(2)}  dégâts ${rd.toFixed(2)}`
    : `${String(room).padStart(5)} | ${r[0].t.toFixed(1).padStart(10)} s ${pct(r[0].dmg).padStart(10)} ${pct(r[0].lost).padStart(9)} | ${r[1].t.toFixed(1).padStart(12)} s ${pct(r[1].dmg).padStart(10)} ${pct(r[1].lost).padStart(9)}`;
  console.log(line);
}
if (TANK && ratios.length) {
  const g = (k) => Math.exp(ratios.reduce((a, x) => a + Math.log(x[k]), 0) / ratios.length);
  console.log(`moyenne (salles > 1) : temps ${g(0).toFixed(2)}, dégâts par héros ${g(1).toFixed(2)}   (objectif : 1 et 1)`);
}
