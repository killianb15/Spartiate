// =====================================================================
//  Événements mystérieux (« ? ») du mode Donjon.
//  Logique 100 % pure et déterministe : tous les tirages passent par sim.rng.
// =====================================================================
import { ITEMS, ITEM_IDS, QUALITY, itemOf } from './items.js';

const heal = (p, n) => {
  const before = p.hp;
  p.hp = Math.min(p.maxHp, p.hp + Math.round(n));
  return Math.max(0, Math.round(p.hp - before));
};
const hurt = (p, n) => {
  const loss = Math.min(Math.max(0, Math.floor(p.hp) - 1), Math.round(n)); // ne tue jamais directement en salle calme
  p.hp = Math.max(1, p.hp - loss);
  return loss;
};

// Donne au héros un objet (non maudit, pas encore sorti dans la partie) de qualité q
// (0 commun, 1 rare, 2 épique, 3 légendaire) ; si cette qualité est épuisée : un cran au-dessus, puis en dessous.
// Retourne « nom (qualité) ». En dernier recours : l'éclat de puissance.
function grantItem(sim, p, q) {
  const seen = ',' + sim.g.seen + ',';
  for (const k of [q, q + 1, q - 1, q - 2, q + 2]) {
    if (k < 0 || k > 3) continue;
    const pool = ITEM_IDS.filter((id) => ITEMS[id].q === k && !ITEMS[id].curse && !seen.includes(',' + id + ','));
    if (!pool.length) continue;
    const id = pool[(sim.rng.next() * pool.length) | 0];
    sim.g.seen += (sim.g.seen ? ',' : '') + id;
    sim.giveItem(p, id);
    return `${ITEMS[id].name} (${QUALITY[k].name.toLowerCase()})`;
  }
  sim.giveItem(p, 'eclat');
  return itemOf('eclat').name;
}
// les statistiques changées par un événement restent dans les bornes des objets (et la jauge du sort suit)
const done = (sim, p) => sim.itemRefresh(p);

export const EVENTS = {
  autel: {
    id: 'autel',
    title: "L'Autel de sang",
    text: "Un autel d'obsidienne encore chaud pulse au centre de la salle. Une inscription gravée dans le bronze exige un tribut.",
    choices: [
      {
        label: 'Offrir ton sang',
        hint: '−25 % de tes PV → objet Épique (parfois Légendaire)',
        tone: 'risk',
        apply(sim, p) {
          const loss = hurt(p, p.maxHp * 0.25);
          const name = grantItem(sim, p, sim.rng.next() < 0.25 ? 3 : 2);
          return `−${loss} PV · Objet obtenu : ${name}`;
        },
      },
      {
        label: "S'incliner humblement",
        hint: 'Soigne 20 PV',
        tone: 'safe',
        apply(sim, p) {
          const g = heal(p, 20);
          sim.emit('sfx', 'parry');
          sim.emit('pop', `+${g} PV`, p.x, p.y + 2.1, p.z, 'heal');
          return `Soin : +${g} PV`;
        },
      },
      {
        label: "Ignorer l'autel",
        hint: 'Repartir sans risque',
        tone: 'neutral',
        apply() { return 'Tu passes ton chemin.'; },
      },
    ],
  },

  forge: {
    id: 'forge',
    title: 'La Forge oubliée',
    text: "Une enclume brûlante et des braises encore vives reposent dans l'ombre. De quoi tremper ton acier… au prix d'une brûlure.",
    choices: [
      {
        label: 'Tremper ta lame',
        hint: '+15 % dégâts permanents, mais −15 PV',
        tone: 'risk',
        apply(sim, p) {
          const loss = hurt(p, 15);
          p.pow += 0.15; done(sim, p);
          sim.emit('sfx', 'clang');
          sim.emit('pop', '+15 % DÉGÂTS', p.x, p.y + 2.1, p.z, 'spell');
          return `+15 % dégâts (−${loss} PV)`;
        },
      },
      {
        label: 'Renforcer ton bouclier',
        hint: '−12 % dégâts subis permanents',
        tone: 'safe',
        apply(sim, p) {
          p.armor = 1 - (1 - p.armor) * 0.88; done(sim, p);
          sim.emit('sfx', 'aegis');
          sim.emit('pop', 'ARMURE +12 %', p.x, p.y + 2.1, p.z, 'parry');
          return 'Armure renforcée (−12 % dégâts subis)';
        },
      },
    ],
  },

  fontaine: {
    id: 'fontaine',
    title: 'La Fontaine des Thermopyles',
    text: "Une source dorée jaillit entre deux colonnes brisées. Son eau semble autant réparer les corps que charger les lames.",
    choices: [
      {
        label: 'Boire à pleine gorgée',
        hint: 'Restaure 50 % de tes PV max',
        tone: 'safe',
        apply(sim, p) {
          const g = heal(p, p.maxHp * 0.5);
          sim.emit('sfx', 'parry');
          sim.emit('pop', `+${g} PV`, p.x, p.y + 2.1, p.z, 'heal');
          return `Restauré : +${g} PV`;
        },
      },
      {
        label: 'Plonger ton arme',
        hint: '−15 % recharge du sort et +10 % critique',
        tone: 'safe',
        apply(sim, p) {
          p.spellCdMul -= 0.15;
          p.crit += 0.10;
          done(sim, p);
          sim.emit('sfx', 'spell');
          sim.emit('pop', 'ARME BÉNIE', p.x, p.y + 2.1, p.z, 'spell');
          return '−15 % CD sort et +10 % chances de critique';
        },
      },
    ],
  },

  coffre: {
    id: 'coffre',
    title: 'Le Coffre maudit',
    text: "Un lourd coffre cerclé de bronze repose seul au milieu des dalles. Le silence est presque trop calme…",
    choices: [
      {
        label: 'Forcer le cadenas',
        hint: '50 % objets sur piédestaux · 50 % embuscade d’élites',
        tone: 'risk',
        apply(sim, p) {
          if (sim.rng.next() < 0.5) {
            sim.emit('sfx', 'coin');
            return { text: 'Coup de chance ! Le coffre s’ouvre sans piège.', spawnItems: 'vault' };
          }
          sim.emit('sfx', 'roar');
          return { text: 'EMBUSCADE ! Des gardes surgissent de l’ombre !', ambush: 'coffre' };
        },
      },
      {
        label: 'Contourner prudemment',
        hint: 'Avancer sans ouvrir le coffre',
        tone: 'neutral',
        apply() { return 'Mieux vaut rester prudent.'; },
      },
    ],
  },

  titan: {
    id: 'titan',
    title: 'Le Pacte du Titan',
    text: "Une statue colossale tend un anneau de fer massif. Le porter donne une vigueur de géant, au prix de ta légèreté.",
    choices: [
      {
        label: 'Accepter le fardeau',
        hint: '+40 PV max (soigne 40 PV), mais −10 % vitesse',
        tone: 'risk',
        apply(sim, p) {
          p.maxHp += 40;
          heal(p, 40);
          p.runMul -= 0.1;
          done(sim, p);
          sim.emit('sfx', 'heavy');
          sim.emit('pop', '+40 PV MAX', p.x, p.y + 2.1, p.z, 'heal');
          return '+40 PV max, −10 % vitesse de course';
        },
      },
      {
        label: 'Refuser et t’alléger',
        hint: '+10 % vitesse de course et +20 % endurance',
        tone: 'safe',
        apply(sim, p) {
          p.runMul += 0.1;
          p.staMul += 0.2;
          done(sim, p);
          sim.emit('sfx', 'dodge');
          sim.emit('pop', 'AGILITÉ +', p.x, p.y + 2.1, p.z, 'parry');
          return '+10 % vitesse et +20 % endurance';
        },
      },
    ],
  },

  arene: {
    id: 'arene',
    title: "L'Épreuve de l'arène secrète",
    text: "Des braseros s'embrasent autour d'un cercle gravé dans la pierre. Un champion attend qu'on relève son défi.",
    choices: [
      {
        label: 'Relever le défi',
        hint: 'Combat intense → objet Rare ou mieux',
        tone: 'risk',
        apply(sim) {
          sim.emit('sfx', 'gong');
          return { text: 'Le combat secret commence !', ambush: 'elite' };
        },
      },
      {
        label: 'Passer ton chemin',
        hint: 'Aucun combat, aucune récompense',
        tone: 'neutral',
        apply() { return 'Tu quittes le cercle sans combattre.'; },
      },
    ],
  },

  statue: {
    id: 'statue',
    title: 'La Statue du Héros déchu',
    text: "Au pied d'une statue de spartiates anciens repose une fiole intacte, tandis qu'une rune brille sur le bouclier.",
    choices: [
      {
        label: 'Méditer devant la rune',
        hint: '+25 % dégâts de sort permanents',
        tone: 'safe',
        apply(sim, p) {
          p.spellPow += 0.25; done(sim, p);
          sim.emit('sfx', 'spell');
          sim.emit('pop', 'SORT +25 %', p.x, p.y + 2.1, p.z, 'spell');
          return '+25 % dégâts de sort';
        },
      },
      {
        label: 'Boire la fiole',
        hint: 'Soigne 35 PV et restaure garde & endurance',
        tone: 'safe',
        apply(sim, p) {
          const g = heal(p, 35);
          p.guard = 100;
          p.sta = 100;
          sim.emit('sfx', 'parry');
          sim.emit('pop', `+${g} PV`, p.x, p.y + 2.1, p.z, 'heal');
          return `+${g} PV, garde et endurance au maximum`;
        },
      },
    ],
  },

  hermes: {
    id: 'hermes',
    title: "Le Pari d'Hermès",
    text: "Deux coupes sont posées sur un piédestal : l'une renferme une faveur rare, l'autre un dard empoisonné.",
    choices: [
      {
        label: 'Tenter le tout pour le tout',
        hint: '60 % objet Rare gratuit · 40 % piège (−20 PV)',
        tone: 'risk',
        apply(sim, p) {
          if (sim.rng.next() < 0.6) {
            const name = grantItem(sim, p, 1);
            return `Gagné ! Objet obtenu : ${name}`;
          }
          const loss = hurt(p, 20);
          sim.emit('sfx', 'hit');
          sim.emit('pop', `-${loss}`, p.x, p.y + 2.1, p.z, 'dmg');
          return `Piège ! −${loss} PV`;
        },
      },
      {
        label: 'Jouer la prudence',
        hint: '+10 % dégâts permanents',
        tone: 'safe',
        apply(sim, p) {
          p.pow += 0.1; done(sim, p);
          sim.emit('sfx', 'parry');
          sim.emit('pop', '+10 % DÉGÂTS', p.x, p.y + 2.1, p.z, 'parry');
          return '+10 % dégâts permanents';
        },
      },
    ],
  },
};

export const EVENT_IDS = Object.keys(EVENTS);
