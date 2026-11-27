// =====================================================================
//  Configuration déclarative de la génération de carte (style Slay the Spire).
//  Toutes les règles, poids et contraintes d'un acte vivent ici :
//  aucun nombre magique en dur dans le générateur (map.js).
// =====================================================================

export const MAP_CONFIG = {
  // 6 étages jouables (0 à 5) + 1 étage final réservé au Boss (étage 6) = 7 salles par acte
  floors: 6,
  cols: 4,
  paths: 5,
  minStartNodes: 2,

  // Métadonnées, poids et contraintes par type de salle
  roomTypes: {
    combat: {
      id: 'combat',
      name: 'Combat',
      short: 'C',
      color: '#d9a441',
      desc: 'Affronte un groupe d’ennemis : un cœur ou un petit bonus peut tomber.',
      weight: 48,
      minFloor: 0,
      noConsecutive: false,
    },
    elite: {
      id: 'elite',
      name: 'Élite',
      short: 'E',
      color: '#e8533f',
      desc: 'Combat redoutable contre un champion et son escorte. Récompense : un objet Rare ou mieux.',
      weight: 22,
      minFloor: 2,          // jamais d'élite sur les deux premiers étages
      noConsecutive: true,  // jamais deux élites d'affilée sur un même chemin
      minPerAct: 1,
      maxPerAct: 4,
    },
    event: {
      id: 'event',
      name: 'Événement',
      short: '?',
      color: '#9b7cff',
      desc: 'Rencontre mystérieuse ou autel ancien : choix risqués, surprises et objets inattendus.',
      weight: 22,
      minFloor: 1,
      noConsecutive: true,
      minPerAct: 1,
      maxPerAct: 4,
    },
    treasure: {
      id: 'treasure',
      name: 'Trésor',
      short: 'T',
      color: '#f6d47d',
      desc: 'Salle sans combat : des objets t’attendent sur des piédestaux.',
      weight: 8,
      minFloor: 2,
      noConsecutive: true,
      minPerAct: 1,
      maxPerAct: 2,
    },
    boss: {
      id: 'boss',
      name: 'Boss',
      short: 'B',
      color: '#ff4a2a',
      desc: 'Le gardien de cet acte. Le vaincre ouvre l’acte suivant et un nouveau biome.',
      weight: 0,            // placé uniquement sur l'étage final
    },
  },

  // Règles structurelles globales
  rules: {
    firstFloorType: 'combat',
    bossFloorType: 'boss',
    // Deux destinations issues d'une même salle évitent de proposer le même type spécial côte à côte
    distinctSiblings: ['elite', 'treasure', 'event'],
    // Ajustement léger des poids à partir de l'acte 2 (un peu plus d'élites dans les profondeurs)
    actWeightScale: {
      elite: 0.15,   // +15 % de poids par acte au-delà de l'acte 1
    },
  },
};
