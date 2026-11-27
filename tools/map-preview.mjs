// Utilitaire console pour inspecter des cartes générées :
//   node tools/map-preview.mjs [seed] [acte]
import { generateMap, formatMapAscii } from '../map.js';

const seed = +(process.argv[2] ?? 42);
const act = +(process.argv[3] ?? 1);
const map = generateMap(seed, act);
console.log(formatMapAscii(map));
