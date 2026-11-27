// Statistiques des tirages d'objets sur un grand nombre de parties (sans combat : seulement le butin).
//
//   node tools/objets.mjs [parties=20000] [salles=20] [joueur=malin|hasard]
//
// Rythme de la simulation (dungeon.js) : salle au trésor après la salle n si n % 5 = 2 (toujours) ou 4
// (une fois sur deux), objets de boss toutes les 5 salles ; un piédestal par héros + les choix en plus.
// Le joueur « malin » prend l'objet qui complète une famille, sinon le meilleur ; « hasard » prend au hasard.
// Mesure : objets par partie, légendaires, transformations, combos, et parties « cassées » (au moins une
// transformation et un combo, ou deux transformations, ou trois légendaires). Objectif : environ 1 sur 8 à 10
// à la salle 20 pour un joueur malin, nettement moins au début.
import { Rng } from '../dmath.js';
import { ITEMS, COMBOS, FAMILIES, ITEM_BASE, TF_N, rollItem, itemOf } from '../items.js';
import { VAULT } from '../dungeon.js';

const [N = 20000, ROOMS = 20, POLICY = 'malin'] = process.argv.slice(2).map((v, i) => (i < 2 ? Number(v) : v));

function hero() { return { ...ITEM_BASE }; }
function give(p, id, st) {
  const it = itemOf(id);
  p.items += (p.items ? ',' : '') + id;
  it.apply(p);
  if (it.q === 3) st.leg++;
  const list = p.items.split(',');
  if (it.fam && !p.tf.split(',').includes(it.fam) && list.filter((k) => ITEMS[k]?.fam === it.fam).length >= TF_N) {
    p.tf += (p.tf ? ',' : '') + it.fam;
    FAMILIES[it.fam].apply(p);
    st.tf++;
    st.tfAt ??= st.room;
  }
  for (const [cid, c] of Object.entries(COMBOS)) {
    if (p.combos.split(',').includes(cid) || !list.includes(c.a) || !list.includes(c.b)) continue;
    p.combos += (p.combos ? ',' : '') + cid;
    c.apply(p);
    st.combo++;
  }
}
// valeur d'un objet pour le joueur malin
function score(p, id) {
  const it = itemOf(id);
  let v = it.q * 10;
  if (it.fam) {
    const n = p.items.split(',').filter((k) => ITEMS[k]?.fam === it.fam).length;
    if (!p.tf.split(',').includes(it.fam)) v += n === 2 ? 40 : n * 6;
  }
  for (const c of Object.values(COMBOS)) if ((c.a === id && p.items.includes(c.b)) || (c.b === id && p.items.includes(c.a))) v += 25;
  if (it.curse) v -= 4;
  return v;
}

const r = new Rng(12345);
const tot = { items: 0, leg: 0, tf: 0, combo: 0, broken: 0, tfRuns: 0, comboRuns: 0, broken10: 0, tfAt: 0, tfN: 0 };
const qn = [0, 0, 0, 0];
for (let run = 0; run < N; run++) {
  const p = hero(), st = { leg: 0, tf: 0, combo: 0, room: 0 };
  let seen = '';
  const pick = (src, room) => {
    const n = Math.min(VAULT.maxItems, 1 + p.choice), offer = [];
    for (let k = 0; k < n; k++) {
      const id = rollItem(r, src, room, p.luck, seen) || 'eclat';
      if (id !== 'eclat') seen += (seen ? ',' : '') + id;
      offer.push(id);
    }
    const id = POLICY === 'hasard' ? offer[(r.next() * offer.length) | 0] : offer.reduce((a, b) => (score(p, b) > score(p, a) ? b : a));
    qn[itemOf(id).q]++;
    give(p, id, st);
  };
  let broken10 = false;
  for (let room = 1; room <= ROOMS; room++) {
    st.room = room;
    const m = room % 5;
    if (m === 0) pick('boss', room);
    else if (m === VAULT.always || (m === VAULT.maybe && r.next() < VAULT.chance)) pick('vault', room);
    const brk = (st.tf >= 1 && st.combo >= 1) || st.tf >= 2 || st.leg >= 3;
    if (room === 10 && brk) broken10 = true;
  }
  const broken = (st.tf >= 1 && st.combo >= 1) || st.tf >= 2 || st.leg >= 3;
  tot.items += p.items.split(',').length;
  tot.leg += st.leg; tot.tf += st.tf; tot.combo += st.combo;
  if (st.tf) tot.tfRuns++;
  if (st.combo) tot.comboRuns++;
  if (broken) tot.broken++;
  if (broken10) tot.broken10++;
  if (st.tfAt) { tot.tfAt += st.tfAt; tot.tfN++; }
}
const pc = (n) => (100 * n / N).toFixed(1) + ' %';
console.log(`${N} parties de ${ROOMS} salles, joueur ${POLICY}`);
console.log(`objets par partie        ${(tot.items / N).toFixed(2)}   (qualités prises : ${qn.map((n) => (100 * n / tot.items).toFixed(0) + ' %').join(' / ')})`);
console.log(`légendaires par partie   ${(tot.leg / N).toFixed(2)}`);
console.log(`au moins 1 transformation ${pc(tot.tfRuns)}   (en moyenne à la salle ${(tot.tfAt / Math.max(1, tot.tfN)).toFixed(1)})`);
console.log(`au moins 1 combo          ${pc(tot.comboRuns)}`);
console.log(`partie « cassée » salle 10 ${pc(tot.broken10)}`);
console.log(`partie « cassée » à la fin ${pc(tot.broken)}   (≈ 1 sur ${(N / Math.max(1, tot.broken)).toFixed(1)})`);
