// =====================================================================
//  Affichage de l'écran de carte par actes (style Slay the Spire).
//  Rendu hybride : arêtes en SVG animées + nœuds HTML positionnés en %
//  + infobulle riche au survol / focus.
// =====================================================================
import { MAP_CONFIG } from './map-config.js';
import { availableNextIds, nodeById } from './map.js';
import { biomeOfAct, FINAL_ACT } from './dungeon.js';

export const BIOME_NAMES = {
  crypt: 'Les Cryptes',
  mine: 'Les Mines de Cristal',
  ruins: 'Les Ruines Envahies',
  forge: 'La Forge Volcanique',
  necropole: "La Nécropole d'Émeraude",
  citadelle: 'La Citadelle Gelée',
};

const ACT_BOSSES = ['Chef orc', "Colosse d'airain", 'Cerbère', "Souverain d'Os"];

const ROOM_REWARD_TAG = {
  combat: 'Cœur ou petit bonus',
  elite: 'Objet Rare ou mieux',
  event: 'Choix mystère & surprises',
  treasure: 'Objets sur des piédestaux',
  boss: 'Ouvre l’acte suivant',
};

export const ROOM_ICONS = {
  combat: '<svg viewBox="0 0 24 24"><path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M9.5 17.5L21 6V3h-3L6.5 14.5M11 19l-6-6M8 16l-4 4"/></svg>',
  elite: '<svg viewBox="0 0 24 24"><path d="M5 17l-2-9 5 4 4-7 4 7 5-4-2 9z"/><path d="M6 20h12"/></svg>',
  event: '<svg viewBox="0 0 24 24"><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><circle cx="12" cy="17.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
  treasure: '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 12h18M7 8V6a5 5 0 0 1 10 0v2"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/></svg>',
  boss: '<svg viewBox="0 0 24 24"><path d="M12 3c4.5 0 8 3 8 7.5 0 2.5-1.2 4.7-3 6V20H7v-3.5c-1.8-1.3-3-3.5-3-6C4 6 7.5 3 12 3z"/><path d="M9 12h.01M15 12h.01M10 17v3M14 17v3"/></svg>',
};

const W = 540;
const H = 470;
const PAD_X = 82;
const TOP_Y = 48;
const BOT_Y = 424;

// Calcule la position (x, y) d'un nœud dans le repère 540×470 (déterministe via roomSeed)
function nodePos(map, n) {
  const stepY = (BOT_Y - TOP_Y) / map.floors;
  const y = BOT_Y - n.floor * stepY;
  if (n.floor === map.floors) return { x: W / 2, y: TOP_Y };
  const spanX = W - PAD_X * 2;
  const baseX = map.cols > 1 ? PAD_X + (n.col / (map.cols - 1)) * spanX : W / 2;
  const jx = (((n.roomSeed & 0xff) / 255) - 0.5) * 26;
  const jy = ((((n.roomSeed >>> 8) & 0xff) / 255) - 0.5) * 14;
  return { x: Math.round(baseX + jx), y: Math.round(y + jy) };
}

// Ensemble des nœuds encore atteignables à partir des prochains choix
function reachableFrom(map, startIds) {
  const seen = new Set();
  const stack = [...startIds];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = nodeById(map, id);
    if (n) for (const nid of n.next) stack.push(nid);
  }
  return seen;
}

const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function renderMap(root, map, {
  interactive = true,
  onPick = null,
  votes = [],
  duoKeys = false,
  statusText = '',
  canClose = false,
  onClose = null,
  previewControls = null,
} = {}) {
  const biomeId = biomeOfAct(map.act, map.runSeed);
  const biome = BIOME_NAMES[biomeId] ?? BIOME_NAMES.crypt;
  const bossName = ACT_BOSSES[(Math.max(1, map.act) - 1) % ACT_BOSSES.length];
  const availIds = availableNextIds(map);
  const avail = new Set(availIds);
  const visited = new Set(map.visited);
  const future = reachableFrom(map, availIds);
  const pos = new Map(map.nodes.map((n) => [n.id, nodePos(map, n)]));

  // Paires d'arêtes déjà parcourues (visited[k] -> visited[k+1])
  const doneEdges = new Set();
  for (let i = 0; i < map.visited.length - 1; i++) doneEdges.add(`${map.visited[i]}>${map.visited[i + 1]}`);

  // Arêtes SVG
  const lines = [];
  for (const n of map.nodes) {
    const p0 = pos.get(n.id);
    for (const nid of n.next) {
      const p1 = pos.get(nid);
      if (!p1) continue;
      let cls = 'edge-dead';
      if (doneEdges.has(`${n.id}>${nid}`)) cls = 'edge-done';
      else if (n.id === map.currentId && avail.has(nid)) cls = 'edge-avail';
      else if (future.has(n.id) && future.has(nid)) cls = 'edge-future';
      // Légère courbure naturelle pour un tracé moins mécanique
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const cx = (p0.x + p1.x) / 2 + (dx === 0 ? 0 : dy * 0.04);
      const cy = (p0.y + p1.y) / 2;
      lines.push(`<path class="${cls}" d="M ${p0.x} ${p0.y} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${p1.x} ${p1.y}"/>`);
    }
  }

  // Nœuds interactifs HTML (positionnés en % sur la zone du graphe)
  const nodesHtml = map.nodes.map((n) => {
    const p = pos.get(n.id);
    const isCur = n.id === map.currentId;
    const isVis = visited.has(n.id);
    const isAv = avail.has(n.id);
    const isDead = !isVis && !isCur && !future.has(n.id);
    const cls = [
      'mnode', `t-${esc(n.type)}`,
      isCur ? 'is-current' : '',
      isVis ? 'is-visited' : '',
      isAv && interactive ? 'is-avail' : '',
      isDead ? 'is-dead' : '',
    ].filter(Boolean).join(' ');
    const keyIdx = isAv && interactive ? availIds.indexOf(n.id) + 1 : 0;
    const vBadges = votes
      .map((vid, idx) => (vid === n.id ? `<i class="mvote vp${idx + 1}">J${idx + 1}</i>` : ''))
      .filter(Boolean).join('');
    const left = (p.x / W * 100).toFixed(2);
    const top = (p.y / H * 100).toFixed(2);
    return `<button type="button" class="${cls}" data-id="${esc(n.id)}" data-avail="${isAv && interactive ? '1' : '0'}" style="left:${left}%;top:${top}%">`
      + `<span class="mico">${ROOM_ICONS[n.type] ?? ROOM_ICONS.combat}</span>`
      + (keyIdx ? `<span class="mkey">${keyIdx}</span>` : '')
      + (isVis && !isCur ? '<span class="mcheck">✓</span>' : '')
      + (vBadges ? `<span class="mvotes">${vBadges}</span>` : '')
      + `</button>`;
  }).join('');

  // Légende des 5 types
  const legendHtml = Object.values(MAP_CONFIG.roomTypes).map((t) =>
    `<span class="mleg t-${t.id}"><i class="mleg-ico">${ROOM_ICONS[t.id]}</i>${esc(t.name)}</span>`
  ).join('');

  const curNode = nodeById(map, map.currentId);
  const floorLbl = curNode
    ? (curNode.floor === map.floors ? `Boss : ${bossName}` : `Étage ${curNode.floor + 1} / ${map.floors}`)
    : `Départ · 0 / ${map.floors}`;

  const defaultFoot = interactive && availIds.length
    ? (duoKeys
      ? `J1 : ${availIds.length > 1 ? 'touches 1–' + availIds.length : 'touche 1'} · J2 : ${availIds.length > 1 ? 'touches ' + '8907'.slice(0, availIds.length).split('').join('/') : 'touche 8'} (ou clic) · Survol pour les détails`
      : `Choisis la prochaine salle (clic ou ${availIds.length > 1 ? 'touches 1 à ' + availIds.length : 'touche 1'}) · Survol d’une icône pour les détails`)
    : 'Carte en lecture seule · Appuie sur M ou Échap pour fermer';

  root.innerHTML = `
    <div class="map-panel">
      <div class="map-head">
        <div>
          <h3>ACTE ${esc(map.act)} — ${esc(biome.toUpperCase())}</h3>
          <div class="map-sub">${esc(floorLbl)} · Boss : ${esc(bossName)} · Seed #${esc(map.runSeed)}</div>
        </div>
        <div class="map-head-acts">
          ${previewControls ? '<button type="button" class="tool-btn" data-mact="reroll">Nouvelle seed</button><button type="button" class="tool-btn" data-mact="nextAct">Acte suivant</button>' : ''}
          ${canClose ? '<button type="button" class="tool-btn" data-mact="close">Fermer</button>' : ''}
        </div>
      </div>
      <div class="map-legend">${legendHtml}</div>
      <div class="map-stage">
        <svg class="map-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${lines.join('')}</svg>
        <div class="map-nodes">${nodesHtml}</div>
        <div class="map-tip hidden" id="mapTip"></div>
      </div>
      <div class="map-foot">${esc(statusText || defaultFoot)}</div>
    </div>
  `;

  // Infobulle riche au survol / focus de n'importe quel nœud
  const tip = root.querySelector('#mapTip');
  const stage = root.querySelector('.map-stage');
  const showTip = (btn) => {
    if (!tip || !stage) return;
    const n = nodeById(map, btn.dataset.id);
    if (!n) return;
    const meta = MAP_CONFIG.roomTypes[n.type] ?? MAP_CONFIG.roomTypes.combat;
    const isCur = n.id === map.currentId;
    const isVis = visited.has(n.id);
    const isAv = avail.has(n.id) && interactive;
    const isDead = !isVis && !isCur && !future.has(n.id);
    const keyIdx = isAv ? availIds.indexOf(n.id) + 1 : 0;
    const title = n.type === 'boss' ? `Boss — ${bossName}` : `${meta.name} · Étage ${n.floor + 1}`;
    const stateTag = isCur ? 'Position actuelle'
      : isVis ? 'Salle déjà visitée'
      : isAv ? `Accessible · Touche ${keyIdx}`
      : isDead ? 'Hors de ton chemin'
      : 'Plus haut dans l’acte';
    const rewardTag = n.type === 'boss' && map.act === FINAL_ACT ? 'Boss final · Victoire !' : (ROOM_REWARD_TAG[n.type] ?? '');
    tip.className = `map-tip t-${esc(n.type)}`;
    tip.innerHTML = `<div class="mt-head"><span class="mt-ico">${ROOM_ICONS[n.type] ?? ROOM_ICONS.combat}</span><b>${esc(title)}</b><span class="mt-st">${esc(stateTag)}</span></div>`
      + `<div class="mt-desc">${esc(meta.desc)}</div>`
      + (rewardTag ? `<div class="mt-tag">${esc(rewardTag)}</div>` : '');
    // Positionne au-dessus ou en dessous du nœud pour ne jamais sortir du cadre
    const p = pos.get(n.id);
    const leftPct = Math.max(22, Math.min(78, p.x / W * 100));
    const above = p.y > H * 0.42;
    tip.style.left = `${leftPct}%`;
    tip.style.top = above ? `${Math.max(4, p.y / H * 100 - 11)}%` : `${Math.min(92, p.y / H * 100 + 11)}%`;
    tip.classList.toggle('below', !above);
  };
  const hideTip = () => { if (tip) tip.classList.add('hidden'); };

  root.querySelectorAll('.mnode').forEach((b) => {
    b.onmouseenter = () => showTip(b);
    b.onfocus = () => showTip(b);
    b.onmouseleave = hideTip;
    b.onblur = hideTip;
    if (b.dataset.avail === '1' && onPick) {
      b.onclick = () => onPick(b.dataset.id);
    }
  });
  if (canClose && onClose) {
    const cb = root.querySelector('[data-mact="close"]');
    if (cb) cb.onclick = onClose;
  }
  if (previewControls) {
    const rb = root.querySelector('[data-mact="reroll"]');
    if (rb) rb.onclick = previewControls.onReroll;
    const ab = root.querySelector('[data-mact="nextAct"]');
    if (ab) ab.onclick = previewControls.onNextAct;
  }
}
