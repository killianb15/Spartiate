// =====================================================================
//  Générateur et modèle de carte par actes (style Slay the Spire).
//
//  Logique 100 % pure et déterministe :
//  - Utilise uniquement Rng (mulberry32) de dmath.js (aucun aléatoire natif JS).
//  - Produit un état plat sérialisable JSON (compatible rollback, coop et localStorage).
//  - Aucun lien avec Three.js ni le DOM.
// =====================================================================
import { Rng } from './dmath.js';
import { MAP_CONFIG } from './map-config.js';

export const nodeId = (floor, col) => `${floor}-${col}`;

// Graine déterministe dérivée pour un acte donné à partir de la graine de la run
export function actSeed(runSeed, act = 1) {
  const s = ((runSeed >>> 0) ^ Math.imul((act | 0) + 1, 0x9e3779b9)) >>> 0;
  return s || 1;
}

// =====================================================================
//  Génération du graphe d'un acte
// =====================================================================
export function generateMap(runSeed = 1, act = 1, config = MAP_CONFIG) {
  const seed = actSeed(runSeed, act);
  const rng = new Rng(seed);
  const floors = config.floors;
  const cols = config.cols;
  const paths = Math.max(config.minStartNodes ?? 2, config.paths ?? 5);

  // Grille temporaire : nodesByKey[id] = { id, floor, col, type, next: Set, parents: Set }
  const mapNodes = new Map();
  const ensureNode = (floor, col) => {
    const id = nodeId(floor, col);
    let n = mapNodes.get(id);
    if (!n) {
      n = { id, floor, col, type: 'combat', next: new Set(), parents: new Set(), roomSeed: 0 };
      mapNodes.set(id, n);
    }
    return n;
  };

  // Vérifie si l'arête (floor, c) -> (floor+1, nc) croiserait une arête déjà existante
  const crosses = (floor, c, nc) => {
    if (nc === c + 1) {
      const right = mapNodes.get(nodeId(floor, c + 1));
      return !!right && right.next.has(nodeId(floor + 1, c));
    }
    if (nc === c - 1) {
      const left = mapNodes.get(nodeId(floor, c - 1));
      return !!left && left.next.has(nodeId(floor + 1, c));
    }
    return false;
  };

  // 1. Tracé de K chemins aléatoires du bas (étage 0) vers le haut (étage floors - 1)
  const startCols = [];
  const minStarts = Math.min(cols, config.minStartNodes ?? 2);
  for (let p = 0; p < paths; p++) {
    let col;
    if (p < minStarts) {
      const free = [];
      for (let c = 0; c < cols; c++) if (!startCols.includes(c)) free.push(c);
      col = free[(rng.next() * free.length) | 0];
    } else {
      col = (rng.next() * cols) | 0;
    }
    startCols.push(col);

    for (let f = 0; f < floors - 1; f++) {
      const cur = ensureNode(f, col);
      // Voisins possibles à l'étage suivant : col-1, col, col+1 (sans croisement)
      const choices = [];
      for (const dc of [-1, 0, 1]) {
        const nc = col + dc;
        if (nc < 0 || nc >= cols) continue;
        if (crosses(f, col, nc)) continue;
        choices.push(nc);
      }
      const nextCol = choices.length ? choices[(rng.next() * choices.length) | 0] : col;
      const nxt = ensureNode(f + 1, nextCol);
      cur.next.add(nxt.id);
      nxt.parents.add(cur.id);
      col = nextCol;
    }
    ensureNode(floors - 1, col);
  }

  // 2. Nœud Boss unique au sommet (étage = floors) relié à tous les nœuds du dernier étage jouable
  const bossCol = Math.floor((cols - 1) / 2);
  const boss = ensureNode(floors, bossCol);
  boss.type = config.rules.bossFloorType ?? 'boss';
  for (const n of mapNodes.values()) {
    if (n.floor === floors - 1) {
      n.next.add(boss.id);
      boss.parents.add(n.id);
    }
  }

  // Tri canonique (étage croissant, puis colonne croissante) pour un ordre 100 % déterministe
  const ordered = [...mapNodes.values()].sort((a, b) => a.floor - b.floor || a.col - b.col);

  // 3. Attribution des types de salles selon les poids et contraintes de MAP_CONFIG
  const types = config.roomTypes;
  const distinct = new Set(config.rules.distinctSiblings ?? []);
  const counts = Object.fromEntries(Object.keys(types).map((k) => [k, 0]));
  const weightOf = (id) => {
    const base = types[id].weight ?? 0;
    const scale = config.rules.actWeightScale?.[id] ?? 0;
    return base * (1 + Math.max(0, act - 1) * scale);
  };

  // Vérifie si le type t est autorisé sur le nœud n (parents déjà assignés, frères déjà assignés)
  const canPlace = (n, t, checkChildren = false) => {
    const rule = types[t];
    if (!rule || rule.weight <= 0) return false;
    if (n.floor < (rule.minFloor ?? 0)) return false;
    if (rule.maxFloor !== undefined && n.floor > rule.maxFloor) return false;
    if (rule.maxPerAct !== undefined && counts[t] >= rule.maxPerAct) return false;
    if (rule.noConsecutive) {
      for (const pid of n.parents) if (mapNodes.get(pid)?.type === t) return false;
      if (checkChildren) for (const cid of n.next) if (mapNodes.get(cid)?.type === t) return false;
    }
    if (distinct.has(t)) {
      for (const pid of n.parents) {
        const par = mapNodes.get(pid);
        for (const sid of par.next) {
          if (sid === n.id) continue;
          const sib = mapNodes.get(sid);
          if (sib && sib.assigned && sib.type === t) return false;
        }
      }
    }
    return true;
  };

  for (const n of ordered) {
    if (n.floor === floors) {
      n.type = config.rules.bossFloorType ?? 'boss';
      n.assigned = true;
      counts[n.type] = (counts[n.type] ?? 0) + 1;
      continue;
    }
    if (n.floor === 0) {
      n.type = config.rules.firstFloorType ?? 'combat';
      n.assigned = true;
      counts[n.type] = (counts[n.type] ?? 0) + 1;
      continue;
    }
    const cands = Object.keys(types).filter((t) => canPlace(n, t, false));
    let chosen = 'combat';
    if (cands.length) {
      const total = cands.reduce((acc, t) => acc + weightOf(t), 0);
      let u = rng.next() * total;
      chosen = cands[cands.length - 1];
      for (const t of cands) {
        u -= weightOf(t);
        if (u <= 0) { chosen = t; break; }
      }
    }
    n.type = chosen;
    n.assigned = true;
    counts[chosen] = (counts[chosen] ?? 0) + 1;
  }

  // 4. Garantie des quotas minimums par acte (minPerAct, ex. au moins 1 Trésor, 1 Élite, 1 Événement)
  for (const [t, rule] of Object.entries(types)) {
    const need = rule.minPerAct ?? 0;
    while (counts[t] < need) {
      const pool = ordered.filter((n) => n.floor > 0 && n.floor < floors && n.type === 'combat' && canPlace(n, t, true));
      if (!pool.length) break;
      const pick = pool[(rng.next() * pool.length) | 0];
      counts[pick.type]--;
      pick.type = t;
      counts[t]++;
    }
  }

  // 5. Graine individuelle déterministe par salle + export en objets plats sérialisables
  const nodes = ordered.map((n) => ({
    id: n.id,
    floor: n.floor,
    col: n.col,
    type: n.type,
    next: [...n.next].sort((a, b) => mapNodes.get(a).col - mapNodes.get(b).col),
    roomSeed: ((rng.next() * 4294967296) >>> 0) || 1,
  }));

  return {
    act,
    runSeed: runSeed >>> 0,
    seed,
    floors,
    cols,
    nodes,
    currentId: null,   // null = pas encore entré à l'étage 0 (sortie de la salle d'armes ou début d'acte)
    visited: [],       // ordre chronologique des salles visitées dans cet acte
  };
}

// =====================================================================
//  Opérations pures sur l'état de la carte
// =====================================================================
export const nodeById = (map, id) => (map && id ? map.nodes.find((n) => n.id === id) ?? null : null);

// Identifiants des salles actuellement accessibles au joueur
export function availableNextIds(map) {
  if (!map || !Array.isArray(map.nodes)) return [];
  if (map.currentId === null) return map.nodes.filter((n) => n.floor === 0).map((n) => n.id);
  const cur = nodeById(map, map.currentId);
  return cur ? [...cur.next] : [];
}

export function canMoveTo(map, id) {
  return availableNextIds(map).includes(id);
}

// Avance sur le nœud choisi (mute map en place, retourne le nœud ou null si invalide)
export function advanceMap(map, id) {
  if (!canMoveTo(map, id)) return null;
  const target = nodeById(map, id);
  if (!target) return null;
  map.currentId = target.id;
  if (!map.visited.includes(target.id)) map.visited.push(target.id);
  return target;
}

export const isBossNode = (map, id = map?.currentId) => nodeById(map, id)?.type === 'boss';

// Copie profonde plate (pour save/load rollback & localStorage)
export function cloneMap(map) {
  if (!map) return null;
  return {
    act: map.act,
    runSeed: map.runSeed,
    seed: map.seed,
    floors: map.floors,
    cols: map.cols,
    currentId: map.currentId,
    visited: [...map.visited],
    nodes: map.nodes.map((n) => ({ id: n.id, floor: n.floor, col: n.col, type: n.type, next: [...n.next], roomSeed: n.roomSeed })),
  };
}

export const serializeMap = (map) => JSON.stringify(cloneMap(map));

// Carte venue de l'extérieur (équipier en ligne, localStorage) : on n'accepte que des nombres entiers bornés,
// des identifiants « étage-colonne » et des types de salle connus (sinon null). Elle finit dans du HTML
// (map-ui.js) : rien d'autre ne doit pouvoir passer.
const ROOM_TYPES = ['combat', 'elite', 'event', 'treasure', 'boss'];
const ID_RE = /^\d{1,2}-\d{1,2}$/;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
export function sanitizeMap(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.nodes) || m.nodes.length > 200) return null;
  if (!int(m.act, 1, 999) || !int(m.floors, 1, 30) || !int(m.cols, 1, 12)) return null;
  if (!int(m.runSeed, 0, 0xffffffff) || !int(m.seed, 0, 0xffffffff)) return null;
  const nodes = [];
  for (const n of m.nodes) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !ID_RE.test(n.id) || !ROOM_TYPES.includes(n.type)) return null;
    if (!int(n.floor, 0, m.floors) || !int(n.col, 0, m.cols - 1) || !int(n.roomSeed, 0, 0xffffffff)) return null;
    if (!Array.isArray(n.next) || n.next.length > 12 || !n.next.every((id) => typeof id === 'string' && ID_RE.test(id))) return null;
    nodes.push({ id: n.id, floor: n.floor, col: n.col, type: n.type, next: [...n.next], roomSeed: n.roomSeed });
  }
  const ids = new Set(nodes.map((n) => n.id));
  if (m.currentId !== null && !ids.has(m.currentId)) return null;
  if (!Array.isArray(m.visited) || !m.visited.every((id) => ids.has(id))) return null;
  if (!nodes.every((n) => n.next.every((id) => ids.has(id)))) return null;
  return { act: m.act, runSeed: m.runSeed, seed: m.seed, floors: m.floors, cols: m.cols, currentId: m.currentId, visited: [...m.visited], nodes };
}

export function deserializeMap(raw) {
  let m = raw;
  if (typeof raw === 'string') { try { m = JSON.parse(raw); } catch { return null; } }
  return sanitizeMap(m);
}

// =====================================================================
//  Affichage ASCII en console (pour vérifier facilement les cartes générées)
// =====================================================================
export function formatMapAscii(map, config = MAP_CONFIG) {
  const byPos = new Map(map.nodes.map((n) => [`${n.floor},${n.col}`, n]));
  const avail = new Set(availableNextIds(map));
  const visited = new Set(map.visited);
  const cellW = 5;
  const lines = [];
  lines.push(`=== ACTE ${map.act} (seed run=${map.runSeed}, acte=${map.seed}) ===`);

  for (let f = map.floors; f >= 0; f--) {
    // Ligne des nœuds de l'étage f
    let row = `${String(f === map.floors ? 'B' : f).padStart(2)} | `;
    if (f === map.floors) {
      const b = map.nodes.find((n) => n.floor === f);
      const pad = ' '.repeat(Math.floor(((map.cols - 1) * cellW) / 2));
      const sym = config.roomTypes[b.type]?.short ?? 'B';
      const mark = map.currentId === b.id ? `@${sym}` : avail.has(b.id) ? `[${sym}]` : visited.has(b.id) ? `*${sym}*` : ` ${sym} `;
      row += pad + mark;
    } else {
      for (let c = 0; c < map.cols; c++) {
        const n = byPos.get(`${f},${c}`);
        if (!n) { row += ' '.repeat(cellW); continue; }
        const sym = config.roomTypes[n.type]?.short ?? '?';
        const txt = map.currentId === n.id ? `@${sym}@` : avail.has(n.id) ? `[${sym}]` : visited.has(n.id) ? `*${sym}*` : ` ${sym} `;
        row += txt.padEnd(cellW);
      }
    }
    lines.push(row.trimEnd());

    // Ligne des liaisons entre l'étage f-1 et l'étage f
    if (f > 0) {
      let conn = '   | ';
      if (f === map.floors) {
        for (let c = 0; c < map.cols; c++) {
          const below = byPos.get(`${f - 1},${c}`);
          conn += below ? '  |  ' : '     ';
        }
      } else {
        const buf = Array(map.cols * cellW).fill(' ');
        for (let c = 0; c < map.cols; c++) {
          const below = byPos.get(`${f - 1},${c}`);
          if (!below) continue;
          const x0 = c * cellW + 1;
          for (const nid of below.next) {
            const top = nodeById(map, nid);
            if (!top) continue;
            if (top.col === c) buf[x0] = '|';
            else if (top.col === c + 1) buf[x0 + 2] = '/';
            else if (top.col === c - 1) buf[x0 - 2] = '\\';
          }
        }
        conn += buf.join('');
      }
      lines.push(conn.trimEnd());
    }
  }

  // Résumé des types générés
  const counts = {};
  for (const n of map.nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${config.roomTypes[k]?.name ?? k}: ${v}`).join(' · ');
  lines.push(`Légende : C=Combat, E=Élite, ?=Événement, T=Trésor, B=Boss, [X]=accessible, @X@=actuel`);
  lines.push(`Salles (${map.nodes.length}) : ${summary}`);
  return lines.join('\n');
}
