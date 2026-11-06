// Empreintes de matchs complets IA contre IA : doivent être identiques dans TOUS les moteurs
// JavaScript (V8/Chrome/Node, SpiderMonkey/Firefox, JavaScriptCore/Safari). Utilisé par
// tests/sim.test.js (Node) et par le test navigateur (Firefox).
import { Sim } from '../sim.js';
import { AI } from '../ai.js';

export function fingerprint(seeds = [1, 2, 3, 4, 5, 6, 7, 8], maxFrames = 12000) {
  const out = [];
  for (const seed of seeds) {
    const sim = new Sim(seed);
    sim.startMatch();
    const ais = [new AI(sim, 0, 2, seed * 3 + 1), new AI(sim, 1, (seed % 3), seed * 3 + 2)];
    const trace = [];
    for (let k = 0; k < maxFrames && sim.g.phase !== 'end'; k++) {
      const dt = sim.effectiveDt();
      const [a, b] = ais.map((ai) => ai.update(dt));
      sim.step(a, b);
      sim.ev.length = 0;
      if (k % 500 === 0) trace.push(sim.hash());
    }
    out.push({ seed, frames: sim.g.frame, wins: sim.wins, hash: sim.hash(), trace });
  }
  return out;
}
