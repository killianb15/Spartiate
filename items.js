// =====================================================================
//  Objets du donjon (façon The Binding of Isaac) : catalogue, familles, combos, tirages et effets.
//
//  - On trouve les objets sur des piédestaux : salle au trésor (après certaines salles) et boss.
//    Les salles normales laissent un cœur, un petit éclat de bonus (MINORS) ou rien (dungeon.js).
//  - Chaque objet a une qualité q (QUALITY : commun, rare, épique, légendaire) qui fixe sa rareté.
//    Un objet ne sort qu'une fois par partie (g.seen) : pas de doublon, chaque partie est différente.
//  - 3 objets d'une même famille (FAMILIES) : transformation (gros bonus + apparence) ; deux objets
//    précis réunis (COMBOS) : synergie cachée, annoncée à l'écran.
//  - Les effets sont des champs « plats » du héros (ITEM_BASE), lus par le moteur (ITEM_METHODS,
//    mêlé à DungeonSim) aux moments clés : coup porté, ennemi vaincu, coup reçu, parade, roulade…
//    Les états des ennemis (brûlure, poison, froid, gel, discorde) sont aussi des champs plats (STATUS0).
//
//  Garde-fous contre les parties « cassées » à chaque fois :
//  - les bonus de dégâts s'additionnent (pow += x), ils ne se multiplient pas entre eux ;
//  - plafonds : critique (CAPS.crit), armure (CAPS.armor), vitesse d'attaque, vol de vie, chances d'effet ;
//  - un effet secondaire (brûlure, éclair, explosion…) ne déclenche jamais les effets « au coup porté » ;
//  - les légendaires sont rares (ODDS), surtout au début.
//
//  Comme sim.js : logique pure et déterministe (dmath.js, rng de la simulation).
// =====================================================================
import { sin, cos, hypot, atan2 } from './dmath.js';
import { BLADE, SHOT, spellCdOf } from './sim.js';

export const heal = (p, n) => { p.hp = Math.min(p.maxHp, p.hp + n); };
const reduce = (p, k) => { p.armor = 1 - (1 - p.armor) * (1 - k); };   // −k de dégâts subis (multiplicatif)

// Qualités : nom, couleur d'affichage
export const QUALITY = [
  { name: 'Commun', col: '#e4dccb', hex: 0xe4dccb },
  { name: 'Rare', col: '#5fb0ff', hex: 0x4aa0ff },
  { name: 'Épique', col: '#c58aff', hex: 0xb070ff },
  { name: 'Légendaire', col: '#ffb02e', hex: 0xffa020 },
];
// Chances de chaque qualité : salle au trésor (glissent un peu vers le haut en profondeur) et boss
export const ODDS = {
  vault: [0.47, 0.34, 0.16, 0.03],
  boss: [0, 0.52, 0.38, 0.1],
};
export function oddsOf(src, room) {
  if (src === 'boss') return ODDS.boss.slice();
  const o = ODDS.vault.slice(), k = Math.max(0, room - 1);
  const up2 = Math.min(0.07, 0.004 * k), up3 = Math.min(0.04, 0.0025 * k);
  o[2] += up2; o[3] += up3; o[0] -= up2 + up3;
  return o;
}
// Chance (Dé de Tyché…) : chaque point a LUCK de chances de faire monter la qualité d'un cran
export const LUCK = 0.35;
// Plafonds
export const CAPS = { crit: 0.6, armor: 0.75, aspd: 1.6, leech: 8, chance: 0.75, size: [0.6, 1.6], orbit: 6 };
export const TF_N = 3;            // objets d'une famille pour la transformation

// Réglages des effets
export const FX = {
  burn: { dur: 3, dps: 4 },                         // brûlure : durée (s), dégâts/s de base
  psn: { dur: 4, dps: 1.5, max: 6 },                // poison : durée, dégâts/s par pile, piles au plus
  chill: { dur: 2.5, slow: 0.55 },                  // froid : durée, vitesse de l'ennemi (tout son temps ralentit)
  frz: { dur: 1.4 },                                 // gel : immobile
  zap: { R: 4.5, n: 2, dmg: 9 },                    // éclair : portée d'un rebond, rebonds, dégâts
  boom: { R: 2.3 },                                  // explosions (forge, bris de glace…)
  conf: { dur: 4 },                                  // discorde : l'ennemi attaque ses alliés
  orbit: { R: 1.35, speed: 3.2, hit: 0.5, cd: 0.45, dmg: 6 },
  aura: { R: 2.4, tick: 0.6 },
  storm: { every: 3, dmg: 14 },
  zeus: { every: 6, dmg: 25, R: 2.2 },
  stomp: { R: 1.8, dmg: 40 },
  heart: 25,                                         // PV rendus par un cœur
  dot: 0.5,                                          // les dégâts des brûlures/poisons tombent toutes les dot s
};

// Champs du héros remis à zéro par equip() (statistiques, effets des objets, objets possédés)
export const ITEM_BASE = {
  maxHp: 100, pow: 1, armor: 0, leech: 0, staMul: 1, guardMul: 1, guardRegen: 1, runMul: 1, size: 1,
  phoenix: 0, thorns: 0, berserk: 0, crit: 0, critMul: 2, critHeal: 0, spellCdMul: 1, spellPow: 1,
  execPow: 0, bossPow: 1, riposte: 0, onKillHeal: 0, onKillCd: 0, regen: 0, roomHeal: 0,
  aspd: 1, reachMul: 1, rollCost: 1, jumpCost: 1, parryWin: 1,
  burnCh: 0, burnDps: FX.burn.dps, burnDur: 1, burnAmp: 0, burnBoom: 0, rollBurn: 0,
  psnCh: 0, psnAdd: 1, psnMax: 0, psnMul: 1, psnSpread: 0, psnAmp: 0, psnHeal: 0, critPsn: 0,
  zapCh: 0, zapN: FX.zap.n, zapMul: 1, zapHurt: 0, rollZap: 0, storm: 0, stormT: FX.storm.every,
  chillCh: 0, frzCh: 0, chillAmp: 0, shatter: 0, rollChill: 0, frzCrit: 0,
  leechMul: 1, aresSpd: 0, drain: 0, frenzy: 0, frenzyN: 0,
  dogRoom: 0, dogMul: 0, dogMax: 0, dogBurn: 0, packPow: 0, dogHeal: 0, dogInherit: 0, hellPack: 0,
  rollBuff: 0, rollBuffOn: 0, rollDmg: 0, rollHit: 0, airPow: 0, rollFan: 0, rollFreeze: 0,
  blockReflect: 0, parryStun: 0, parryWave: 0, parryFull: 0, blockThorns: 0, parryZap: 0,
  choice: 0, luck: 0, abund: 0, heartMul: 1, itemPow: 0, minorMul: 1,
  multi: 0, pierce: 0, homing: 0, blades: 0, bladeStorm: 0, orbit: 0, orbitBurn: 0,
  shrinkCh: 0, double: 0, hitN: 0, confCh: 0, confHeal: 0, drunk: 0, hourglass: 0, killHeart: 0,
  auraFire: 0, auraPsn: 0, auraChill: 0, auraT: 0, fireImmune: 0, zeus: 0, zeusN: 0,
  thermal: 0, zapBurn: 0, gas: 0, stomp: 0, phoenixBoom: 0, reflectSplit: 0, spellZap: 0,
  items: '', tf: '', combos: '', took: 0, minors: 0,
};
// États (statuts) d'un combattant, posés sur tous (ennemis, chiens, héros) pour un état plat et stable
export const STATUS0 = {
  sBurn: 0, sBurnT: 0, sBurnBy: -1, sPsn: 0, sPsnT: 0, sPsnK: 1, sPsnBy: -1, sChill: 0, sFrz: 0,
  sConf: 0, sConfBy: -1, sOrbT: 0, sDotT: 0, sAccB: 0, sAccP: 0, shrunk: 0, hell: 0,
};
export const has = (p, id) => !!p.items && (',' + p.items + ',').includes(',' + id + ',');
export const itemList = (p) => (p.items ? p.items.split(',') : []);
export const hasTf = (p, fam) => !!p.tf && (',' + p.tf + ',').includes(',' + fam + ',');

// ---------------------------------------------------------------------
//  Familles : 3 objets d'une famille = transformation
// ---------------------------------------------------------------------
export const FAMILIES = {
  feu: { name: 'Héphaïstos', tf: "Avatar d'Héphaïstos", icon: '🔥', hex: 0xff7a2e,
    desc: 'Aura de feu qui brûle les ennemis proches, insensible au feu, +20 % de dégâts contre les ennemis en feu',
    apply: (p) => { p.auraFire = 1; p.fireImmune = 1; p.burnAmp += 0.2; } },
  peste: { name: 'Peste', tf: 'Seigneur de la peste', icon: '☠️', hex: 0x7ae85a,
    desc: 'Aura de poison, poison deux fois plus mortel, chaque ennemi empoisonné vaincu soigne 3 PV',
    apply: (p) => { p.auraPsn = 1; p.psnMul += 1; p.psnHeal += 3; } },
  foudre: { name: 'Zeus', tf: 'Fils de Zeus', icon: '⚡', hex: 0x9fd8ff,
    desc: 'Tous les 6 coups, la foudre s’abat sur ta cible (25 dégâts autour) ; les éclairs rebondissent une fois de plus',
    apply: (p) => { p.zeus = 1; p.zapN += 1; } },
  givre: { name: 'Borée', tf: "Cœur de l'hiver", icon: '❄️', hex: 0x8fe0ff,
    desc: 'Aura de froid qui ralentit les ennemis proches ; coups critiques assurés sur les ennemis congelés',
    apply: (p) => { p.auraChill = 1; p.frzCrit = 1; } },
  sang: { name: 'Arès', tf: "Avatar d'Arès", icon: '🩸', hex: 0xe0303a,
    desc: 'Vol de vie doublé, +30 % de vitesse d’attaque sous 50 % de PV',
    apply: (p) => { p.leechMul = 2; p.aresSpd = 1; } },
  meute: { name: 'Meute', tf: 'Maître de la meute', icon: '🐺', hex: 0xb98aff,
    desc: 'Un chien de plus à chaque salle, et tes chiens profitent de tes effets (feu, poison, foudre…)',
    apply: (p) => { p.dogRoom += 1; p.dogMax += 1; p.dogInherit = 1; } },
  vent: { name: 'Hermès', tf: 'Messager des dieux', icon: '🪽', hex: 0xe8f4ff,
    desc: 'Chaque roulade lance 3 lames spectrales en éventail ; +15 % de vitesse',
    apply: (p) => { p.rollFan = 1; p.runMul += 0.15; } },
  rempart: { name: 'Athéna', tf: "Égide d'Athéna", icon: '🛡️', hex: 0xffe066,
    desc: 'Une parade rend toute la garde et recharge le sort de 2 s ; bloquer un coup blesse l’attaquant ; −15 % de dégâts subis',
    apply: (p) => { p.parryFull = 1; p.blockThorns += 6; reduce(p, 0.15); } },
  fortune: { name: 'Tyché', tf: 'Favori de Tyché', icon: '🍀', hex: 0x7aff9a,
    desc: 'Un choix de plus sur chaque piédestal, petits bonus doublés, +10 % de critique',
    apply: (p) => { p.choice += 1; p.minorMul += 1; p.crit += 0.1; } },
};

// ---------------------------------------------------------------------
//  Objets : name, icon, q (qualité), fam (famille), curse (maudit : fort, avec un vrai défaut), desc, apply
// ---------------------------------------------------------------------
export const ITEMS = {
  // ---- Héphaïstos (feu) ----
  silex: { name: 'Silex ardent', icon: '🔥', q: 0, fam: 'feu', desc: '20 % de chances d’enflammer l’ennemi touché (4 dégâts/s pendant 3 s)',
    apply: (p) => { p.burnCh += 0.2; } },
  naphte: { name: 'Huile de naphte', icon: '🛢️', q: 1, fam: 'feu', desc: '+35 % de dégâts contre les ennemis en feu ; +10 % de chances d’enflammer',
    apply: (p) => { p.burnAmp += 0.35; p.burnCh += 0.1; } },
  braise: { name: 'Braise éternelle', icon: '🕯️', q: 1, fam: 'feu', desc: 'Brûlure plus forte (+3 dégâts/s) et deux fois plus longue ; +5 % de chances d’enflammer',
    apply: (p) => { p.burnDps += 3; p.burnDur *= 2; p.burnCh += 0.05; } },
  forge: { name: 'Cœur de forge', icon: '🌋', q: 2, fam: 'feu', desc: 'Un ennemi qui meurt en feu explose : 14 dégâts autour et enflamme',
    apply: (p) => { p.burnBoom += 14; p.burnCh += 0.05; } },
  braises: { name: 'Sandales de braise', icon: '👣', q: 0, fam: 'feu', desc: 'Rouler à travers les ennemis les enflamme ; +10 % de vitesse de course',
    apply: (p) => { p.rollBurn = 1; p.runMul += 0.1; } },

  // ---- Peste (poison) ----
  dague: { name: 'Dague empoisonnée', icon: '🗡️', q: 0, fam: 'peste', desc: '25 % de chances d’empoisonner (une pile : 1,5 dégât/s pendant 4 s, jusqu’à 6 piles)',
    apply: (p) => { p.psnCh += 0.25; } },
  cigue: { name: 'Fiole de ciguë', icon: '🧪', q: 1, fam: 'peste', desc: 'Une pile de poison de plus par coup, 4 piles de plus au maximum ; +10 % de chances',
    apply: (p) => { p.psnAdd += 1; p.psnMax += 4; p.psnCh += 0.1; } },
  spores: { name: 'Spores', icon: '🍄', q: 1, fam: 'peste', desc: 'Un ennemi empoisonné qui meurt répand son poison sur ceux qui l’entourent',
    apply: (p) => { p.psnSpread = 1; p.psnCh += 0.05; } },
  vipere: { name: 'Crocs de vipère', icon: '🐍', q: 0, fam: 'peste', desc: '+8 % de critique ; chaque coup critique empoisonne (2 piles)',
    apply: (p) => { p.crit += 0.08; p.critPsn += 2; } },
  putride: { name: 'Chair putride', icon: '🦠', q: 2, fam: 'peste', desc: 'Chaque pile de poison fait subir +6 % de dégâts à l’ennemi ; poison +50 %',
    apply: (p) => { p.psnAmp += 0.06; p.psnMul += 0.5; p.psnCh += 0.05; } },

  // ---- Zeus (foudre) ----
  tonnerre: { name: 'Pierre de tonnerre', icon: '🌩️', q: 0, fam: 'foudre', desc: '15 % de chances qu’un éclair jaillisse et rebondisse sur 2 ennemis proches (9 dégâts)',
    apply: (p) => { p.zapCh += 0.15; } },
  cuivre: { name: 'Bracelet de cuivre', icon: '📿', q: 1, fam: 'foudre', desc: 'Les éclairs rebondissent une fois de plus et frappent 50 % plus fort ; +5 % de chances',
    apply: (p) => { p.zapN += 1; p.zapMul += 0.5; p.zapCh += 0.05; } },
  orage: { name: "Nuage d'orage", icon: '⛈️', q: 2, fam: 'foudre', desc: 'Toutes les 3 s de combat, la foudre frappe un ennemi au hasard (14 dégâts, rebondit)',
    apply: (p) => { p.storm += 1; } },
  tonnantes: { name: 'Sandales tonnantes', icon: '🥾', q: 1, fam: 'foudre', desc: 'Chaque roulade foudroie l’ennemi le plus proche (12 dégâts, rebondit)',
    apply: (p) => { p.rollZap += 1; } },
  paratonnerre: { name: 'Paratonnerre', icon: '⚜️', q: 1, fam: 'foudre', desc: 'Quand on te frappe : 50 % de chances de foudroyer l’attaquant (12 dégâts, rebondit)',
    apply: (p) => { p.zapHurt += 0.5; } },

  // ---- Borée (froid) ----
  givre: { name: 'Éclat de givre', icon: '🧊', q: 0, fam: 'givre', desc: '20 % de chances de ralentir l’ennemi touché (−45 % de vitesse pendant 2,5 s)',
    apply: (p) => { p.chillCh += 0.2; } },
  boree: { name: 'Souffle de Borée', icon: '🌬️', q: 1, fam: 'givre', desc: 'Frapper un ennemi ralenti : 25 % de chances de le congeler (immobile 1,4 s) ; +10 % de chances de ralentir',
    apply: (p) => { p.frzCh += 0.25; p.chillCh += 0.1; } },
  glace: { name: 'Cœur de glace', icon: '💎', q: 1, fam: 'givre', desc: '+30 % de dégâts contre les ennemis ralentis ou congelés ; −8 % de dégâts subis',
    apply: (p) => { p.chillAmp += 0.3; reduce(p, 0.08); } },
  bris: { name: 'Bris de glace', icon: '🔹', q: 2, fam: 'givre', desc: 'Un ennemi ralenti ou congelé qui meurt vole en éclats : 12 dégâts et ralentit autour',
    apply: (p) => { p.shatter += 12; p.chillCh += 0.05; } },
  patins: { name: 'Bottes de neige', icon: '⛸️', q: 0, fam: 'givre', desc: 'La roulade ralentit les ennemis proches ; +10 % de vitesse de course',
    apply: (p) => { p.rollChill = 1; p.runMul += 0.1; } },

  // ---- Arès (sang) ----
  croc: { name: 'Croc de loup', icon: '🦷', q: 0, fam: 'sang', desc: 'Chaque coup porté soigne 2 PV',
    apply: (p) => { p.leech += 2; } },
  calice: { name: 'Calice de sang', icon: '🍷', q: 1, fam: 'sang', desc: 'Chaque ennemi vaincu soigne 6 PV',
    apply: (p) => { p.onKillHeal += 6; } },
  fureur: { name: "Rage d'Arès", icon: '😡', q: 2, fam: 'sang', desc: '+70 % de dégâts sous 40 % de PV',
    apply: (p) => { p.berserk = 1; } },
  pacte: { name: 'Pacte de sang', icon: '🩸', q: 1, fam: 'sang', curse: true, desc: '+40 % de dégâts, mais tu perds 1 PV/s en combat (sans descendre sous 1 PV)',
    apply: (p) => { p.pow += 0.4; p.drain += 1; } },
  masque: { name: 'Masque de guerre', icon: '👺', q: 1, fam: 'sang', desc: 'Chaque ennemi vaincu donne +6 % de dégâts jusqu’à la fin de la salle (8 fois au plus)',
    apply: (p) => { p.frenzy += 8; } },

  // ---- Meute (chiens) ----
  sifflet: { name: 'Sifflet de berger', icon: '🎺', q: 1, fam: 'meute', desc: 'Un chien se bat à tes côtés dès le début de chaque salle',
    apply: (p) => { p.dogRoom += 1; } },
  collier: { name: 'Collier clouté', icon: '⛓️', q: 0, fam: 'meute', desc: 'Tes chiens ont +60 % de PV et de dégâts ; +15 PV max',
    apply: (p) => { p.dogMul += 0.6; p.maxHp += 15; heal(p, 15); } },
  oscerbere: { name: 'Os de Cerbère', icon: '🦴', q: 2, fam: 'meute', desc: 'Un chien de plus à chaque salle (un de plus au plus) ; leurs morsures enflamment',
    apply: (p) => { p.dogRoom += 1; p.dogMax += 1; p.dogBurn = 1; } },
  instinct: { name: 'Instinct de meute', icon: '🐾', q: 1, fam: 'meute', desc: '+10 % de dégâts par chien vivant à tes côtés ; +1 chien au plus',
    apply: (p) => { p.packPow += 0.1; p.dogMax += 1; } },
  hurlement: { name: 'Hurlement', icon: '🌕', q: 0, fam: 'meute', desc: 'Chaque ennemi tué par tes chiens te soigne 5 PV ; ton sort recharge 15 % plus vite',
    apply: (p) => { p.dogHeal += 5; p.spellCdMul *= 0.85; } },

  // ---- Hermès (vent) ----
  ailees: { name: 'Sandales ailées', icon: '👟', q: 0, fam: 'vent', desc: '+15 % de vitesse de course, +20 % d’endurance récupérée',
    apply: (p) => { p.runMul += 0.15; p.staMul += 0.2; } },
  petase: { name: "Pétase d'Hermès", icon: '🎩', q: 1, fam: 'vent', desc: 'Les roulades coûtent deux fois moins d’endurance ; +10 % de vitesse de course',
    apply: (p) => { p.rollCost *= 0.5; p.runMul += 0.1; } },
  echo: { name: 'Écho du messager', icon: '💨', q: 1, fam: 'vent', desc: 'Après une roulade, ton coup suivant inflige +60 % de dégâts',
    apply: (p) => { p.rollBuff += 0.6; } },
  caducee: { name: 'Caducée', icon: '⚕️', q: 2, fam: 'vent', desc: 'Rouler à travers un ennemi le blesse (14 dégâts) ; +20 % d’endurance récupérée',
    apply: (p) => { p.rollDmg += 14; p.staMul += 0.2; } },
  plume: { name: 'Plume légère', icon: '🎈', q: 0, fam: 'vent', desc: 'Sauter ne coûte plus d’endurance ; les coups en l’air infligent +50 % de dégâts',
    apply: (p) => { p.jumpCost = 0; p.airPow += 0.5; } },

  // ---- Athéna (garde) ----
  bronze: { name: 'Bouclier de bronze', icon: '🔰', q: 0, fam: 'rempart', desc: 'Bloquer coûte 30 % de garde en moins ; la garde remonte 30 % plus vite',
    apply: (p) => { p.guardMul *= 0.7; p.guardRegen += 0.3; } },
  ecu: { name: 'Écu poli', icon: '🪞', q: 1, fam: 'rempart', desc: 'Bloquer une flèche ou une boule de feu la renvoie à son tireur',
    apply: (p) => { p.blockReflect = 1; p.guardMul *= 0.9; } },
  chouette: { name: "Chouette d'Athéna", icon: '🦉', q: 1, fam: 'rempart', desc: 'Fenêtre de parade +60 % ; l’ennemi paré reste étourdi 50 % plus longtemps',
    apply: (p) => { p.parryWin += 0.6; p.parryStun += 0.5; } },
  riposte: { name: 'Contre-riposte', icon: '⚔️', q: 1, fam: 'rempart', desc: 'Chaque parade inflige 20 dégâts à l’attaquant et soigne 12 PV',
    apply: (p) => { p.riposte += 1; } },
  egide: { name: 'Égide', icon: '🌀', q: 2, fam: 'rempart', desc: 'Une parade libère une onde de choc : 18 dégâts et étourdit tout autour',
    apply: (p) => { p.parryWave += 18; } },

  // ---- Tyché (fortune) ----
  trefle: { name: 'Trèfle à quatre feuilles', icon: '☘️', q: 1, fam: 'fortune', desc: 'Un choix de plus sur les piédestaux (on n’en garde qu’un)',
    apply: (p) => { p.choice += 1; } },
  de: { name: 'Dé de Tyché', icon: '🎲', q: 1, fam: 'fortune', desc: 'Les objets trouvés sont de meilleure qualité',
    apply: (p) => { p.luck += 1; } },
  corne: { name: "Corne d'abondance", icon: '🧺', q: 0, fam: 'fortune', desc: 'Chaque salle nettoyée laisse un cœur ; les cœurs soignent 50 % de plus',
    apply: (p) => { p.abund = 1; p.heartMul += 0.5; } },
  midas: { name: 'Main de Midas', icon: '🪙', q: 2, fam: 'fortune', desc: '+4 % de dégâts par objet possédé',
    apply: (p) => { p.itemPow += 0.04; } },
  etoile: { name: 'Étoile filante', icon: '🌠', q: 0, fam: 'fortune', desc: '+8 % de critique ; objets un peu plus souvent rares',
    apply: (p) => { p.crit += 0.08; p.luck += 0.5; } },

  // ---- Sans famille ----
  ambroisie: { name: 'Ambroisie', icon: '🍯', q: 0, desc: '+25 PV max et soigne tous tes PV',
    apply: (p) => { p.maxHp += 25; p.hp = p.maxHp; } },
  halteres: { name: "Haltères d'Héraclès", icon: '🏋️', q: 1, desc: '+30 % de dégâts',
    apply: (p) => { p.pow += 0.3; } },
  phenix: { name: 'Plume de phénix', icon: '🌅', q: 2, desc: 'Une fois : au lieu de tomber, tu renais à 60 % de tes PV',
    apply: (p) => { p.phoenix = 1; } },
  epines: { name: 'Épines de bronze', icon: '🌵', q: 2, desc: 'Renvoie 60 % des dégâts reçus à l’attaquant',
    apply: (p) => { p.thorns += 0.6; } },
  lynx: { name: 'Œil de lynx', icon: '👁️', q: 0, desc: '+15 % de chances de coup critique (×2 dégâts)',
    apply: (p) => { p.crit += 0.15; } },
  faucheur: { name: 'Faucheur', icon: '💀', q: 3, desc: '+25 % de critique, critiques ×2,5, chaque critique soigne 4 PV',
    apply: (p) => { p.crit += 0.25; p.critMul = Math.max(p.critMul, 2.5); p.critHeal += 4; } },
  titan: { name: 'Ambroisie de Titan', icon: '🗿', q: 2, desc: 'Tu deviens géant : +40 PV max, +25 % de dégâts, plus d’allonge, mais −10 % de vitesse',
    apply: (p) => { p.size *= 1.35; p.maxHp += 40; heal(p, 40); p.pow += 0.25; p.reachMul += 0.25; p.runMul -= 0.1; } },
  lilliput: { name: 'Poudre de Lilliput', icon: '🐜', q: 1, desc: 'Tu rapetisses : plus dur à toucher, +20 % de vitesse, mais −15 PV max',
    apply: (p) => { p.size *= 0.72; p.runMul += 0.2; p.maxHp -= 15; } },
  retreci: { name: 'Rayon rétrécissant', icon: '🔬', q: 2, desc: '15 % de chances de rétrécir l’ennemi touché (moins de PV, moins de dégâts) ; les boss résistent',
    apply: (p) => { p.shrinkCh += 0.15; } },
  briaree: { name: 'Bras de Briarée', icon: '🖐️', q: 2, desc: 'Un coup d’arme sur trois frappe deux fois',
    apply: (p) => { p.double = 1; } },
  fantome: { name: 'Lame fantôme', icon: '👻', q: 1, desc: 'Chaque coup d’arme lance une lame spectrale (6 dégâts)',
    apply: (p) => { p.blades += BLADE.dmg; } },
  carquois: { name: 'Carquois sans fond', icon: '🏹', q: 1, desc: 'Chaque projectile (flèche, boule de feu, lame spectrale) part en double',
    apply: (p) => { p.multi += 1; } },
  adamant: { name: "Pointes d'adamantium", icon: '📌', q: 1, desc: 'Les projectiles transpercent 2 ennemis',
    apply: (p) => { p.pierce += 2; } },
  argos: { name: "Œil d'Argos", icon: '🧿', q: 2, desc: 'Les projectiles poursuivent les ennemis',
    apply: (p) => { p.homing = 1; } },
  anneau: { name: 'Anneau de lames', icon: '💫', q: 2, desc: 'Deux lames tournent autour de toi et tranchent les ennemis',
    apply: (p) => { p.orbit = Math.min(CAPS.orbit, p.orbit + 2); } },
  verre: { name: 'Cœur de verre', icon: '💔', q: 2, curse: true, desc: '+80 % de dégâts, mais tes PV max sont divisés par deux',
    apply: (p) => { p.pow += 0.8; p.maxHp = Math.max(20, Math.round(p.maxHp / 2)); } },
  sablier: { name: 'Sablier brisé', icon: '⏳', q: 1, curse: true, desc: 'Sort rechargé deux fois plus vite et +30 % de dégâts de sort, mais chaque sort coûte 8 PV',
    apply: (p) => { p.spellCdMul *= 0.5; p.spellPow += 0.3; p.hourglass += 8; } },
  dionysos: { name: 'Ivresse de Dionysos', icon: '🍇', q: 1, curse: true, desc: '+35 % de dégâts et +15 % de critique, mais tu titubes',
    apply: (p) => { p.pow += 0.35; p.crit += 0.15; p.drunk = 1; } },
  discorde: { name: 'Pomme de discorde', icon: '🍎', q: 2, desc: '12 % de chances de semer la discorde : l’ennemi touché attaque ses alliés pendant 4 s',
    apply: (p) => { p.confCh += 0.12; } },
  hades: { name: "Pacte d'Hadès", icon: '👹', q: 3, curse: true, desc: '+60 % de dégâts et 15 % de chances qu’un ennemi vaincu lâche un cœur, mais tu subis 40 % de dégâts en plus',
    apply: (p) => { p.pow += 0.6; p.killHeart += 0.15; p.armor -= 0.4 * (1 - p.armor); } },
  // ---- légendaires sans famille ----
  hydre: { name: "Sang de l'Hydre", icon: '🐉', q: 3, desc: '+40 PV max, régénère 2 PV/s en combat, chaque nouvelle salle rend 25 % des PV',
    apply: (p) => { p.maxHp += 40; heal(p, 40); p.regen += 2; p.roomHeal += 0.25; } },
  chronos: { name: 'Faux de Chronos', icon: '⌛', q: 3, desc: '+30 % de vitesse d’attaque, sort rechargé 30 % plus vite',
    apply: (p) => { p.aspd += 0.3; p.spellCdMul *= 0.7; } },
  promethee: { name: 'Feu de Prométhée', icon: '🔆', q: 3, desc: 'Presque tous tes coups enflamment (brûlure plus forte) ; +20 % de dégâts contre les ennemis en feu',
    apply: (p) => { p.burnCh += 0.75; p.burnDps += 2; p.burnAmp += 0.2; } },
  erinyes: { name: 'Fouet des Érinyes', icon: '🪢', q: 3, desc: '+50 % de dégâts contre les boss, +50 % contre les ennemis sous 45 % de PV',
    apply: (p) => { p.bossPow = Math.max(p.bossPow, 1) + 0.5; p.execPow += 0.5; } },
  atlas: { name: "Épaules d'Atlas", icon: '🌍', q: 3, desc: 'Bloquer ne coûte presque plus de garde ; bloquer un coup blesse l’attaquant (10 dégâts)',
    apply: (p) => { p.guardMul *= 0.25; p.blockThorns += 10; } },
};

export const ITEM_IDS = Object.keys(ITEMS);
// objet de secours quand tous les objets d'une qualité sont sortis (il peut sortir plusieurs fois)
export const FALLBACK = { name: 'Éclat de puissance', icon: '✨', q: 0, desc: '+8 % de dégâts et +8 PV max',
  apply: (p) => { p.pow += 0.08; p.maxHp += 8; heal(p, 8); } };

// ---------------------------------------------------------------------
//  Combos nommés : deux objets précis réunis
// ---------------------------------------------------------------------
export const COMBOS = {
  naphteElec: { name: 'Naphte électrique', a: 'naphte', b: 'tonnerre', desc: 'Les éclairs enflamment', apply: (p) => { p.zapBurn = 1; } },
  thermique: { name: 'Choc thermique', a: 'silex', b: 'givre', desc: 'Un ennemi à la fois en feu et ralenti subit +50 % de dégâts', apply: (p) => { p.thermal = 1; } },
  gaz: { name: 'Gaz inflammable', a: 'spores', b: 'forge', desc: 'Les explosions empoisonnent et le poison répandu enflamme', apply: (p) => { p.gas = 1; } },
  acier: { name: "Tempête d'acier", a: 'fantome', b: 'carquois', desc: 'Les lames spectrales partent par trois', apply: (p) => { p.bladeStorm = 1; } },
  roue: { name: 'Roue de feu', a: 'anneau', b: 'silex', desc: 'Les lames tournoyantes enflamment toujours', apply: (p) => { p.orbitBurn = 1; } },
  goliath: { name: 'Goliath', a: 'titan', b: 'retreci', desc: 'Retomber d’un saut écrase les ennemis rétrécis autour (40 dégâts)', apply: (p) => { p.stomp = 1; } },
  fourmi: { name: 'Fourmi enragée', a: 'lilliput', b: 'briaree', desc: '+35 % de vitesse d’attaque', apply: (p) => { p.aspd += 0.35; } },
  bacchanale: { name: 'Bacchanale', a: 'dionysos', b: 'discorde', desc: 'Discorde deux fois plus fréquente ; un ennemi qui frappe un allié te soigne 3 PV', apply: (p) => { p.confCh += 0.12; p.confHeal += 3; } },
  renaissance: { name: 'Renaissance ardente', a: 'phenix', b: 'forge', desc: 'En renaissant, tu exploses : 40 dégâts et enflamme tout autour', apply: (p) => { p.phoenixBoom = 1; } },
  portee: { name: 'Portée infernale', a: 'sifflet', b: 'oscerbere', desc: 'Tes chiens sont des chiens des enfers : plus grands et +50 % de dégâts', apply: (p) => { p.hellPack = 1; } },
  miroir: { name: 'Miroir aux alouettes', a: 'ecu', b: 'carquois', desc: 'Les projectiles renvoyés partent par trois', apply: (p) => { p.reflectSplit = 1; } },
  surcharge: { name: 'Surcharge', a: 'sablier', b: 'cuivre', desc: 'Lancer ton sort déclenche un éclair qui rebondit sur 4 ennemis', apply: (p) => { p.spellZap = 1; } },
  orageBouclier: { name: "Bouclier d'orage", a: 'paratonnerre', b: 'egide', desc: 'L’onde de parade foudroie aussi 3 ennemis', apply: (p) => { p.parryZap = 1; } },
  roiMidas: { name: 'Roi Midas', a: 'midas', b: 'de', desc: 'Un choix de plus sur les piédestaux et +2 % de dégâts par objet de plus', apply: (p) => { p.choice += 1; p.itemPow += 0.02; } },
  patinage: { name: 'Patinage artistique', a: 'caducee', b: 'patins', desc: 'La roulade congèle les ennemis traversés', apply: (p) => { p.rollFreeze = 1; } },
};

// ---------------------------------------------------------------------
//  Petits bonus des salles normales (éclats) : petits, sans synergie
// ---------------------------------------------------------------------
export const MINORS = {
  mForce: { name: 'Éclat de force', icon: '🗡️', desc: '+5 % de dégâts', apply: (p) => { p.pow += 0.05; } },
  mVie: { name: 'Éclat de vie', icon: '❤️', desc: '+8 PV max', apply: (p) => { p.maxHp += 8; heal(p, 8); } },
  mAirain: { name: "Éclat d'airain", icon: '🛡️', desc: '−4 % de dégâts subis', apply: (p) => { reduce(p, 0.04); } },
  mVitesse: { name: 'Éclat de vitesse', icon: '👟', desc: '+5 % de vitesse de course', apply: (p) => { p.runMul += 0.05; } },
  mArcane: { name: "Éclat d'arcane", icon: '✨', desc: '−6 % de recharge du sort', apply: (p) => { p.spellCdMul *= 0.94; } },
  mPrecision: { name: 'Éclat de précision', icon: '🎯', desc: '+4 % de critique', apply: (p) => { p.crit += 0.04; } },
  mSouffle: { name: 'Éclat de souffle', icon: '💨', desc: '+12 % d’endurance récupérée', apply: (p) => { p.staMul += 0.12; } },
};
export const MINOR_IDS = Object.keys(MINORS);
// Butin d'une salle normale nettoyée : cœur (heart), sinon éclats (un par héros) jusqu'à minor, sinon rien
export const LOOT = { heart: 0.5, minor: 0.88 };

// ---------------------------------------------------------------------
//  Tirages
// ---------------------------------------------------------------------
// qualité d'un objet : source 'vault' (salle au trésor) ou 'boss', salle n, chance des héros
export function rollQuality(rng, src, room, luck = 0) {
  const o = oddsOf(src, room);
  let u = rng.next(), q = 0;
  for (; q < 3; q++) { if (u < o[q]) break; u -= o[q]; }
  for (let k = 0; k < luck; k++) if (q < 3 && rng.next() < LUCK * Math.min(1, luck - k)) q++;
  return q;
}
// un objet pas encore sorti (seen : identifiants déjà sortis, séparés par des virgules) ; '' si plus rien
export function rollItem(rng, src, room, luck, seen) {
  const q0 = rollQuality(rng, src, room, luck), out = (',' + seen + ',');
  // qualité tirée ; s'il n'en reste plus, on descend d'un cran, puis on remonte
  for (const q of [q0, q0 - 1, q0 - 2, q0 - 3, q0 + 1, q0 + 2, q0 + 3]) {
    if (q < 0 || q > 3) continue;
    const pool = ITEM_IDS.filter((id) => ITEMS[id].q === q && !out.includes(',' + id + ','));
    if (pool.length) return pool[(rng.next() * pool.length) | 0];
  }
  return '';
}
export const itemOf = (id) => ITEMS[id] ?? (id === 'eclat' ? FALLBACK : null);

// ---------------------------------------------------------------------
//  Moteur des effets : méthodes ajoutées à DungeonSim (Object.assign(DungeonSim.prototype, ITEM_METHODS))
//  Elles s'appuient sur : this.f, this.g, this.rng, this.emit, this.heroes, this.isHero, this.die,
//  this.onKO, this.enrage, this.stun, this.spawnDog, this.dogsOf, this.pr, this.dropHeart.
// ---------------------------------------------------------------------
const bit = (f) => 1 << (f.idx & 31);
export const ITEM_METHODS = {
  // le héros dont les objets s'appliquent au coup porté par f : le héros lui-même, ou le maître d'un chien
  // (seulement avec la transformation « Maître de la meute » pour les effets au coup porté)
  itemHero(f) {
    if (!f) return null;
    if (this.isHero(f)) return f;
    if (f.team === 0 && f.owner >= 0) return this.f[f.owner] ?? null;
    return null;
  },
  chance(c) { return c > 0 && this.rng.next() < Math.min(CAPS.chance, c); },

  // ----- objets : prise, transformations, combos -----
  giveItem(p, id) {
    const it = itemOf(id);
    if (!it || !p) return false;
    p.items += (p.items ? ',' : '') + id;
    it.apply(p);
    this.itemRefresh(p);
    this.emit('item', p.idx, id);
    this.emit('pop', it.name, p.x, p.y + 2.2, p.z, 'parry');
    this.emit('sfx', it.q >= 2 ? 'spell' : 'parry');
    this.emit('ring', p.x, p.y + 1, p.z, QUALITY[it.q].hex, 2.2 + it.q * 0.4, 0.5);
    this.emit('emit', p.x, p.y + 1, p.z, 16 + 8 * it.q, { color: [QUALITY[it.q].hex, 0xffffff], speed: 2.5, up: 3, size: 0.08, life: 0.9, grav: 4 });
    // famille complète : transformation
    if (it.fam && !hasTf(p, it.fam) && itemList(p).filter((k) => ITEMS[k]?.fam === it.fam).length >= TF_N) {
      const F = FAMILIES[it.fam];
      p.tf += (p.tf ? ',' : '') + it.fam;
      F.apply(p);
      this.itemRefresh(p);
      this.emit('tf', p.idx, it.fam);
      this.emit('ring', p.x, p.y + 0.1, p.z, F.hex, 3.4, 0.8, true);
      this.emit('emit', p.x, p.y + 1, p.z, 50, { color: [F.hex, 0xffffff], speed: 4, up: 4, size: 0.1, life: 1.2, grav: 2 });
      this.emit('sfx', 'roar');
      this.emit('shake', 0.3);
    }
    for (const [cid, c] of Object.entries(COMBOS)) {
      if ((',' + p.combos + ',').includes(',' + cid + ',') || !has(p, c.a) || !has(p, c.b)) continue;
      p.combos += (p.combos ? ',' : '') + cid;
      c.apply(p);
      this.itemRefresh(p);
      this.emit('combo', p.idx, cid);
      this.emit('ring', p.x, p.y + 1.2, p.z, 0xff5ad8, 2.8, 0.6);
    }
    return true;
  },
  giveMinor(p, id) {
    const m = MINORS[id];
    if (!m) return false;
    for (let k = 0; k < p.minorMul; k++) m.apply(p);
    p.minors++;
    this.itemRefresh(p);
    this.emit('pop', m.name, p.x, p.y + 2.1, p.z, 'heal');
    this.emit('sfx', 'coin');
    this.emit('ring', p.x, p.y + 0.6, p.z, 0x8fe36a, 1.6, 0.4);
    return true;
  },
  // bornes après un changement d'objets
  itemRefresh(p) {
    p.size = Math.max(CAPS.size[0], Math.min(CAPS.size[1], p.size));
    p.maxHp = Math.max(20, Math.round(p.maxHp));
    p.hp = Math.min(p.hp, p.maxHp);
    p.runMul = Math.max(0.6, p.runMul);
    p.spellCdMul = Math.max(0.3, p.spellCdMul);
    p.spellMax = spellCdOf(p);
  },

  // ----- multiplicateur des dégâts d'un coup (attaquant du camp des héros) -----
  // direct : coup porté par le héros lui-même (sinon : chien, ou effet secondaire : seuls comptent les états)
  heroMul(att, def, direct = true) {
    const p = this.itemHero(att);
    if (!p) return 1;
    let m = 1;
    if (def.sBurnT > 0) m += p.burnAmp;
    if (def.sChill > 0 || def.sFrz > 0) m += p.chillAmp;
    if (def.sPsn > 0) m += p.psnAmp * def.sPsn;
    if (p.thermal && def.sBurnT > 0 && (def.sChill > 0 || def.sFrz > 0)) m += 0.5;
    if (direct && att === p) {
      if (p.frenzyN) m += 0.06 * p.frenzyN;
      if (p.itemPow) m += p.itemPow * itemList(p).length;
      if (p.packPow) m += p.packPow * this.dogsOf(p.idx);
      if (p.airPow && att.state === 'air') m += p.airPow;
      if (p.rollBuffOn) { m += p.rollBuff; p.rollBuffOn = 0; }
    }
    return m;
  },
  // vitesse d'attaque du héros (Arès sous 50 % PV, combos…)
  aspdOf(p) { return Math.min(CAPS.aspd, (p.aspd ?? 1) * (p.aresSpd && p.hp < p.maxHp * 0.5 ? 1.3 : 1)); },

  // ----- coup porté (dégâts déjà infligés) : effets « au coup porté » -----
  onHitItems(att, def, dmg, crit) {
    const p = this.itemHero(att);
    if (!p || def.team === p.team) return;
    const dog = att !== p;
    if (dog) {
      if (p.dogBurn) this.ignite(p, def, FX.burn.dps, FX.burn.dur);
      if (!p.dogInherit) return;
    }
    const alive = def.state !== 'dead';
    if (alive) {
      if (this.chance(p.burnCh)) this.ignite(p, def, p.burnDps, FX.burn.dur * p.burnDur);
      if (this.chance(p.psnCh)) this.poison(p, def, p.psnAdd);
      if (crit && p.critPsn) this.poison(p, def, p.critPsn);
      if (def.sChill > 0 && this.chance(p.frzCh)) this.freeze(p, def, FX.frz.dur);
      if (this.chance(p.chillCh)) this.chill(def, FX.chill.dur);
      if (p.shrinkCh && !def.boss && !def.shrunk && this.chance(p.shrinkCh)) this.shrink(def);
      if (p.confCh && !def.boss && def.sConf <= 0 && this.foesAlive() > 1 && this.chance(p.confCh)) this.confuse(p, def);
    }
    if (this.chance(p.zapCh)) this.zap(p, def, p.zapN, FX.zap.dmg * p.zapMul, false);
    if (dog) return;
    // Fils de Zeus : tous les 6 coups, la foudre tombe sur la cible
    if (p.zeus && ++p.zeusN >= FX.zeus.every) { p.zeusN = 0; this.thunder(p, def); }
    // Bras de Briarée : un coup d'arme sur trois frappe une seconde fois
    if (p.double && this.src === 'melee' && alive && ++p.hitN >= 3) {
      p.hitN = 0;
      this.procHit(p, def, Math.max(1, dmg / Math.max(0.01, p.pow)), 'echo', true);
    }
  },
  // ennemi vaincu par le héros p (ou ses chiens, ses effets) : effets « à l'élimination »
  onKillItems(p, e, att) {
    if (p.frenzy) p.frenzyN = Math.min(p.frenzy, p.frenzyN + 1);
    if (att && att !== p && att.team === 0 && p.dogHeal && p.state !== 'dead') this.healPop(p, p.dogHeal);
    if (p.psnHeal && e.sPsn > 0 && p.state !== 'dead') this.healPop(p, p.psnHeal);
    if (p.burnBoom && e.sBurnT > 0) this.blast(p, e.x, e.y, e.z, p.burnBoom, 'fire');
    if (p.psnSpread && e.sPsn > 0) this.spread(p, e);
    if (p.shatter && (e.sChill > 0 || e.sFrz > 0)) this.blast(p, e.x, e.y, e.z, p.shatter, 'ice');
    if (p.killHeart && this.chance(p.killHeart)) this.dropHeart(e.x, e.z);
  },
  // le héros p vient d'être blessé par att
  onHurtItems(p, att) {
    if (!att || att.team === p.team || att.state === 'dead') return;
    if (this.chance(p.zapHurt)) this.zap(p, att, p.zapN, 12 * p.zapMul, true);
  },
  healPop(p, n) {
    const gain = Math.min(p.maxHp - p.hp, n);
    if (gain <= 0) return;
    p.hp += gain;
    this.emit('pop', `+${Math.round(gain)} PV`, p.x, p.y + 1.9, p.z, 'heal');
  },

  // ----- dégâts secondaires : sans étourdir ni repousser, sans déclencher d'autres effets « au coup porté »
  // base : dégâts avant la puissance du héros (pow) ; kind : classe du nombre affiché
  procHit(p, def, base, kind, show = true) {
    if (!def || def.state === 'dead' || def.god || def.team === p?.team) return 0;
    if (def.fireImmune && kind === 'fire') return 0;
    const amp = p ? this.heroMul(p, def, false) : 1;
    const n = Math.max(1, Math.round(base * (p?.pow ?? 1) * amp * (1 - Math.min(CAPS.armor, def.armor ?? 0))));
    def.hp = Math.max(0, def.hp - n);
    if (show) this.emit('pop', `-${n}`, def.x + 0.25, def.y + 1.5 * (def.size ?? 1), def.z, kind);
    if (def.hp <= 0) {
      if (def.sp) def.sp = '';
      this.die(def);
      this.onKO(p, def);
    } else this.enrage(def);
    return n;
  },
  ignite(p, e, dps, dur) {
    if (e.state === 'dead' || e.team === p.team || e.fireImmune) return;
    if (e.sBurnT <= 0) this.emit('emit', e.x, e.y + 1, e.z, 8, { color: [0xffe27a, 0xff7a2e], speed: 1.5, up: 2, size: 0.07, life: 0.5, grav: -1 });
    e.sBurn = Math.max(e.sBurn, dps); e.sBurnT = Math.max(e.sBurnT, dur); e.sBurnBy = p.idx;
  },
  poison(p, e, n) {
    if (e.state === 'dead' || e.team === p.team) return;
    e.sPsn = Math.min(FX.psn.max + p.psnMax, e.sPsn + n); e.sPsnT = FX.psn.dur; e.sPsnK = p.psnMul; e.sPsnBy = p.idx;
  },
  chill(e, dur) { if (e.state !== 'dead') e.sChill = Math.max(e.sChill, dur); },
  freeze(p, e, dur) {
    if (e.state === 'dead' || e.sp) return;
    const d = e.boss ? dur * 0.5 : dur;
    e.sFrz = d; e.sChill = Math.max(e.sChill, d + 1);
    this.stun(e, d);
    this.emit('pop', 'GELÉ !', e.x, e.y + 2 * (e.size ?? 1), e.z, 'ice');
    this.emit('emit', e.x, e.y + 1, e.z, 14, { color: [0xd8f4ff, 0x8fe0ff, 0xffffff], speed: 2, up: 2, size: 0.08, life: 0.6, grav: 4 });
    this.emit('sfx', 'clang');
  },
  shrink(e) {
    e.shrunk = 1; e.size = Math.max(0.5, (e.size ?? 1) * 0.62); e.pow *= 0.6;
    e.maxHp = Math.max(1, Math.round(e.maxHp * 0.6)); e.hp = Math.min(e.hp, e.maxHp);
    this.emit('pop', 'RÉTRÉCI !', e.x, e.y + 1.6, e.z, 'spell');
    this.emit('ring', e.x, e.y + 0.6, e.z, 0xff8ae0, 1.4, 0.35);
    this.emit('sfx', 'tick');
  },
  confuse(p, e) {
    e.sConf = FX.conf.dur; e.sConfBy = p.idx;
    this.emit('pop', 'DISCORDE !', e.x, e.y + 2, e.z, 'conf');
    this.emit('sfx', 'growl');
  },
  foesAlive() { let n = 0; for (const e of this.f) if (e.team === 1 && e.state !== 'dead') n++; return n; },
  // éclair : part de from (exclu, sauf first : from est alors la première cible), puis rebondit n fois
  zap(p, from, n, dmg, first) {
    let mask = 0, cur = from;
    if (first) {
      this.emit('bolt', p.x, p.y + 1.2, p.z, from.x, from.y + 1, from.z, 0x9fd8ff);
      this.zapOne(p, from, dmg);
      mask |= bit(from);
    } else mask |= bit(from);
    for (let k = 0; k < n; k++) {
      let best = null, bd = FX.zap.R;
      for (const e of this.f) {
        if (e.state === 'dead' || e.team === p.team || (mask & bit(e))) continue;
        const d = hypot(e.x - cur.x, e.z - cur.z);
        if (d < bd) { bd = d; best = e; }
      }
      if (!best) break;
      this.emit('bolt', cur.x, cur.y + 1, cur.z, best.x, best.y + 1, best.z, 0x9fd8ff);
      mask |= bit(best);
      this.zapOne(p, best, dmg);
      cur = best;
    }
    this.emit('sfx', 'zap');
  },
  zapOne(p, e, dmg) {
    if (p.zapBurn) this.ignite(p, e, p.burnDps, FX.burn.dur * p.burnDur);
    this.procHit(p, e, dmg, 'zap');
  },
  // foudre de Zeus (transformation) ou du Nuage d'orage : frappe du ciel, puis zone
  thunder(p, e) {
    this.emit('bolt', e.x, e.y + 9, e.z, e.x, e.y + 0.2, e.z, 0xffffff);
    this.emit('shake', 0.2);
    this.blast(p, e.x, e.y, e.z, FX.zeus.dmg, 'zap', FX.zeus.R);
  },
  // explosion : kind 'fire' (enflamme), 'ice' (ralentit), 'zap', 'psn' ; gaz inflammable : empoisonne aussi
  blast(p, x, y, z, dmg, kind, R = FX.boom.R) {
    const col = { fire: [0xffe27a, 0xff7a2e, 0xff3a10], ice: [0xffffff, 0xbfefff, 0x6fc8ff], zap: [0xffffff, 0x9fd8ff, 0x4a8aff], psn: [0xc8ff8a, 0x7ae85a, 0x3a9a2a] }[kind];
    this.emit('ring', x, y + 0.1, z, col[1], R * 1.1, 0.4, true);
    this.emit('emit', x, y + 0.8, z, 26, { color: col, speed: 4, up: 3, size: 0.1, life: 0.6, grav: 3 });
    this.emit('sfx', kind === 'ice' ? 'clang' : 'boom');
    this.emit('shake', 0.14);
    for (const e of this.f) {
      if (e.state === 'dead' || e.team === p.team) continue;
      if (hypot(e.x - x, e.z - z) > R + 0.4 * ((e.size ?? 1) - 1) || Math.abs(e.y - y) > 1.6) continue;
      if (kind === 'fire') this.ignite(p, e, p.burnDps, FX.burn.dur * p.burnDur);
      if (kind === 'ice') this.chill(e, FX.chill.dur);
      if (p.gas && kind !== 'psn') this.poison(p, e, 2);
      this.procHit(p, e, dmg, kind);
    }
  },
  // poison répandu (Spores) par un ennemi qui meurt empoisonné
  spread(p, src) {
    const n = Math.max(2, Math.ceil(src.sPsn / 2));
    this.emit('emit', src.x, src.y + 0.6, src.z, 20, { color: [0xc8ff8a, 0x7ae85a, 0x3a9a2a], speed: 2, up: 1.5, size: 0.12, life: 0.9, grav: -0.5 });
    this.emit('ring', src.x, src.y + 0.1, src.z, 0x7ae85a, 2.5, 0.5, true);
    for (const e of this.f) {
      if (e === src || e.state === 'dead' || e.team === p.team || hypot(e.x - src.x, e.z - src.z) > 2.5) continue;
      this.poison(p, e, n);
      if (p.gas) this.ignite(p, e, p.burnDps, FX.burn.dur * p.burnDur);
    }
  },

  // ----- états qui s'écoulent (tous les combattants, pendant le combat) -----
  statusTick(e, dt) {
    if (e.sChill > 0) e.sChill = Math.max(0, e.sChill - dt);
    if (e.sFrz > 0) e.sFrz = Math.max(0, e.sFrz - dt);
    if (e.sConf > 0) e.sConf = Math.max(0, e.sConf - dt);
    if (e.sOrbT > 0) e.sOrbT = Math.max(0, e.sOrbT - dt);
    if (e.state === 'dead') { e.sBurnT = 0; e.sPsn = 0; e.sPsnT = 0; return; }
    if (e.sBurnT > 0) { e.sBurnT = Math.max(0, e.sBurnT - dt); e.sAccB += e.sBurn * dt; }
    if (e.sPsnT > 0) {
      e.sAccP += e.sPsn * FX.psn.dps * e.sPsnK * dt;
      e.sPsnT = Math.max(0, e.sPsnT - dt);
      if (e.sPsnT <= 0) e.sPsn = 0;
    }
    e.sDotT -= dt;
    if (e.sDotT > 0) return;
    e.sDotT = FX.dot;
    if (e.sAccB >= 1) { const n = Math.floor(e.sAccB); e.sAccB -= n; this.procHit(this.f[e.sBurnBy] ?? null, e, n, 'burn'); }
    if (e.state !== 'dead' && e.sAccP >= 1) { const n = Math.floor(e.sAccP); e.sAccP -= n; this.procHit(this.f[e.sPsnBy] ?? null, e, n, 'psn'); }
  },

  // ----- à chaque image de combat, pour chaque héros : auras, lames tournoyantes, orage, pacte -----
  heroTick(p, dt) {
    if (p.state === 'dead') return;
    if (p.drain && p.hp > 1) p.hp = Math.max(1, p.hp - p.drain * dt);
    if (p.orbit) this.orbitTick(p);
    if (p.storm) {
      p.stormT -= dt;
      if (p.stormT <= 0) {
        p.stormT = FX.storm.every / p.storm;
        const foes = this.f.filter((e) => e.team === 1 && e.state !== 'dead');
        if (foes.length) {
          const e = foes[(this.rng.next() * foes.length) | 0];
          this.emit('bolt', e.x, e.y + 9, e.z, e.x, e.y + 0.2, e.z, 0xffffff);
          this.zapOne(p, e, FX.storm.dmg * p.zapMul);
          this.zap(p, e, 1, FX.zap.dmg * p.zapMul, false);
        }
      }
    }
    if (p.auraFire || p.auraPsn || p.auraChill) {
      p.auraT -= dt;
      const tick = p.auraT <= 0;
      if (tick) p.auraT = FX.aura.tick;
      for (const e of this.f) {
        if (e.state === 'dead' || e.team === p.team || hypot(e.x - p.x, e.z - p.z) > FX.aura.R + 0.4 * ((e.size ?? 1) - 1)) continue;
        if (p.auraChill) e.sChill = Math.max(e.sChill, 0.3);
        if (!tick) continue;
        if (p.auraFire) this.ignite(p, e, p.burnDps, 1.5);
        if (p.auraPsn) this.poison(p, e, 1);
      }
    }
  },
  // lames tournoyantes : positions déduites de l'horloge de la salle (l'affichage fait le même calcul)
  orbitTick(p) {
    const O = FX.orbit, t = this.g.clock * O.speed + p.idx * 1.3;
    for (let k = 0; k < p.orbit; k++) {
      const a = t + (k * Math.PI * 2) / p.orbit;
      const bx = p.x + sin(a) * O.R, bz = p.z + cos(a) * O.R;
      for (const e of this.f) {
        if (e.state === 'dead' || e.team === p.team || e.sOrbT > 0) continue;
        if (hypot(e.x - bx, e.z - bz) > O.hit + 0.45 * ((e.size ?? 1) - 1) || Math.abs(e.y - p.y) > 1.4) continue;
        e.sOrbT = O.cd;
        if (p.orbitBurn) this.ignite(p, e, p.burnDps, FX.burn.dur * p.burnDur);
        this.procHit(p, e, O.dmg, 'orb');
        this.emit('emit', bx, p.y + 1, bz, 5, { color: [0xffffff, 0xd0e8ff], speed: 2, up: 1, size: 0.05, life: 0.3, grav: 4 });
      }
    }
  },

  // ----- roulade, parade, saut -----
  rollItems(p) {
    if (p.rollBuff) p.rollBuffOn = 1;
    p.rollHit = 0;
    if (p.rollZap) {
      let best = null, bd = 6;
      for (const e of this.f) { if (e.state === 'dead' || e.team === p.team) continue; const d = hypot(e.x - p.x, e.z - p.z); if (d < bd) { bd = d; best = e; } }
      if (best) this.zap(p, best, p.zapN - 1, 12 * p.zapMul * p.rollZap, true);
    }
    if (p.rollChill) {
      this.emit('ring', p.x, p.y + 0.1, p.z, 0x8fe0ff, 2.2, 0.35, true);
      for (const e of this.f) if (e.state !== 'dead' && e.team !== p.team && hypot(e.x - p.x, e.z - p.z) < 2.2) this.chill(e, FX.chill.dur);
    }
    if (p.rollFan) this.fan(p, 3, 0.35);
  },
  // pendant la roulade : on traverse les ennemis (Caducée, Sandales de braise, Patinage artistique)
  rollTouch(p) {
    for (const e of this.f) {
      if (e.state === 'dead' || e.team === p.team || (p.rollHit & bit(e))) continue;
      if (hypot(e.x - p.x, e.z - p.z) > 0.95 + 0.45 * ((e.size ?? 1) - 1) || Math.abs(e.y - p.y) > 1.2) continue;
      p.rollHit |= bit(e);
      if (p.rollBurn) this.ignite(p, e, p.burnDps, FX.burn.dur * p.burnDur);
      if (p.rollFreeze) this.freeze(p, e, FX.frz.dur);
      if (p.rollDmg) this.procHit(p, e, p.rollDmg, 'dmg');
    }
  },
  parryItems(p, att) {
    if (p.parryStun && att.state === 'stun') att.dur *= 1 + p.parryStun;
    if (p.parryFull) { p.guard = 100; if (p.spellCd > 0) p.spellCd = Math.max(0, p.spellCd - 2); }
    if (p.parryWave) {
      this.emit('ring', p.x, p.y + 0.15, p.z, 0xffe066, 2.8, 0.45, true);
      this.emit('shake', 0.2);
      for (const e of this.f) {
        if (e.state === 'dead' || e.team === p.team || hypot(e.x - p.x, e.z - p.z) > 2.6 + 0.4 * ((e.size ?? 1) - 1)) continue;
        this.procHit(p, e, p.parryWave, 'brk');
        if (e.state !== 'dead' && !e.sp) this.stun(e, e.boss ? 0.5 : 1);
      }
      if (p.parryZap) { const e = this.target(p.idx); if (e) this.zap(p, e, 2, FX.zap.dmg * p.zapMul, true); }
    }
  },
  // retombée d'un saut (Goliath : écrase les ennemis rétrécis)
  landItems(p) {
    if (!p.stomp) return;
    this.emit('ring', p.x, p.y + 0.06, p.z, 0xff8ae0, FX.stomp.R * 1.1, 0.35, true);
    for (const e of this.f) {
      if (e.state === 'dead' || e.team === p.team || !e.shrunk || hypot(e.x - p.x, e.z - p.z) > FX.stomp.R) continue;
      this.procHit(p, e, FX.stomp.dmg, 'brk');
      this.emit('shake', 0.2);
    }
  },

  // ----- projectiles -----
  // lame spectrale lancée par p dans la direction yaw
  blade(p, yaw, dmg) {
    const sx = sin(yaw), sz = cos(yaw);
    this.pr.push({ x: p.x + sx * 0.5, y: p.y + 1.0, z: p.z + sz * 0.5, vx: sx * BLADE.speed, vy: 0, vz: sz * BLADE.speed, o: p.idx, t: 0, k: 2, dmg });
  },
  // éventail de n lames (Messager des dieux, après une roulade)
  fan(p, n, spread) {
    for (let k = 0; k < n; k++) this.blade(p, p.yaw + (k - (n - 1) / 2) * spread, BLADE.dmg);
    this.emit('sfx', 'swing');
  },
  // nouveaux projectiles d'un héros : perçants, à tête chercheuse, en double (une seule fois chacun : it)
  itemizeShots() {
    const n0 = this.pr.length;
    for (let k = 0; k < n0; k++) {
      const a = this.pr[k];
      if (a.it) continue;
      a.it = 1;
      const p = this.f[a.o];
      if (!p || !this.isHero(p)) continue;
      if (p.pierce && a.k !== 1) a.pc = p.pierce;
      if (p.homing) a.hm = 1;
      const extra = p.multi + (a.k === 2 && p.bladeStorm ? 1 : 0);
      for (let c = 0; c < extra; c++) {
        const ang = (c % 2 ? -1 : 1) * 0.17 * (1 + (c >> 1));
        const s = sin(ang), co = cos(ang);
        this.pr.push({ ...a, vx: a.vx * co + a.vz * s, vz: -a.vx * s + a.vz * co, mul: (a.mul ?? 1) * 0.75 });
      }
    }
  },
  // tête chercheuse : le projectile tourne vers l'ennemi le plus proche devant lui
  steer(a, dt) {
    let best = null, bd = 7;
    const sp = hypot(a.vx, a.vz) || 1;
    for (const e of this.f) {
      if (e.state === 'dead' || !this.foeOf(a.o, e)) continue;
      const dx = e.x - a.x, dz = e.z - a.z, d = hypot(dx, dz);
      if (d < bd && (dx * a.vx + dz * a.vz) / sp > -0.2 * d) { bd = d; best = e; }
    }
    if (!best) return;
    const want = atan2(best.x - a.x, best.z - a.z), cur = atan2(a.vx, a.vz);
    let da = want - cur;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const turn = Math.max(-5 * dt, Math.min(5 * dt, da)), na = cur + turn;
    a.vx = sin(na) * sp; a.vz = cos(na) * sp;
    a.vy *= 0.9;
  },
};
