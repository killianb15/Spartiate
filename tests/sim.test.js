import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sim, PRESS, NEUTRAL, quant, FIGHT_R, ROUND_TIME } from '../sim.js';
import { AI } from '../ai.js';
import { Rng } from '../dmath.js';

// ---- utilitaires ----
function started(seed = 1) {
  const s = new Sim(seed);
  s.startMatch();
  return s;
}
function toFight(s) { let n = 0; while (s.g.phase !== 'fight' && n++ < 400) s.step(); assert.equal(s.g.phase, 'fight'); }
// place les deux combattants face à face, à `gap` l'un de l'autre
function faceOff(s, gap = 1.2) {
  s.f[0].x = -gap / 2; s.f[1].x = gap / 2; s.f[0].z = s.f[1].z = 0;
  s.f[0].yaw = Math.PI / 2; s.f[1].yaw = -Math.PI / 2;
}
const run = (s, n, i0 = NEUTRAL, i1 = NEUTRAL) => { for (let i = 0; i < n; i++) s.step(i0, i1); };
const press = (a) => ({ ...NEUTRAL, press: PRESS[a] });
function aiMatch(seed, frames, lv0 = 2, lv1 = 1) {
  const s = started(seed);
  const a0 = new AI(s, 0, lv0, seed), a1 = new AI(s, 1, lv1, seed + 1);
  const hashes = [];
  for (let i = 0; i < frames; i++) {
    const dt = s.effectiveDt();
    s.step(a0.update(dt), a1.update(dt));
    hashes.push(s.hash());
  }
  return { s, hashes };
}

// ---- déterminisme ----
test('même graine + mêmes entrées => même état à chaque image', () => {
  const a = aiMatch(123, 6000), b = aiMatch(123, 6000);
  assert.deepEqual(a.hashes, b.hashes);
});

test('graines différentes => parties différentes', () => {
  const a = aiMatch(1, 3000), b = aiMatch(2, 3000);
  assert.notEqual(a.hashes.at(-1), b.hashes.at(-1));
});

test('le code de simulation n\'utilise aucune fonction non déterministe', () => {
  for (const file of ['sim.js', 'ai.js']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    for (const bad of [/Math\.(sin|cos|tan|atan2?|exp|log\d*|pow|hypot|random|cbrt|sinh|cosh|tanh)\b/, /Date\.now|performance\.now|new Date/, /\bsetTimeout|requestAnimationFrame/])
      assert.doesNotMatch(src, bad, `${file} contient ${bad}`);
  }
});

test('save/load : on rejoue exactement la même suite', () => {
  const s = started(5);
  const a0 = new AI(s, 0, 2), a1 = new AI(s, 1, 2);
  for (let i = 0; i < 500; i++) { const dt = s.effectiveDt(); s.step(a0.update(dt), a1.update(dt)); }
  const snap = s.save();
  const inputs = [];
  const first = [];
  for (let i = 0; i < 600; i++) { const dt = s.effectiveDt(); const x = [a0.update(dt), a1.update(dt)]; inputs.push(x); s.step(...x); first.push(s.hash()); }
  s.load(snap);
  const second = [];
  for (const x of inputs) { s.step(...x); second.push(s.hash()); }
  assert.deepEqual(second, first);
});

test('save() est une copie indépendante', () => {
  const s = started(); const snap = s.save(); const h = s.hash();
  run(s, 100, press('atk'));
  assert.notEqual(s.hash(), h);
  s.load(snap);
  assert.equal(s.hash(), h);
});

test('record=false : aucun événement émis', () => {
  const s = started(); s.ev.length = 0; s.record = false;
  toFight(s); faceOff(s);
  run(s, 60, press('atk'));
  assert.equal(s.ev.length, 0);
  s.record = true; run(s, 1, press('atk')); // le flux reprend
});

// ---- règles du jeu ----
test('une attaque touche : -9 PV, adversaire en état hit', () => {
  const s = started(); toFight(s); faceOff(s);
  run(s, 1, press('atk'));
  run(s, 30);
  assert.equal(s.f[1].hp, 91);
  assert.ok(s.ev.some((e) => e[0] === 'pop' && e[1] === '-9'));
  assert.ok(s.ev.some((e) => e[0] === 'sfx' && e[1] === 'hit'));
});

test('trop loin : le coup ne touche pas', () => {
  const s = started(); toFight(s); faceOff(s, 3);
  run(s, 1, press('atk')); run(s, 40);
  assert.equal(s.f[1].hp, 100);
});

test('blocage : pas de dégâts, garde entamée', () => {
  const s = started(); toFight(s); faceOff(s);
  const blk = { ...NEUTRAL, blk: true };
  run(s, 3, NEUTRAL, blk);
  assert.equal(s.f[1].state, 'block');
  faceOff(s);
  run(s, 1, press('atk'), blk); run(s, 30, NEUTRAL, blk);
  assert.equal(s.f[1].hp, 100);
  assert.ok(s.f[1].guard < 100);
});

test('parade au bon moment : l\'attaquant est étourdi', () => {
  const s = started(); toFight(s); faceOff(s);
  run(s, 1, press('atk'), press('par'));
  run(s, 30);
  assert.equal(s.f[0].state, 'stun');
  assert.equal(s.f[1].hp, 100);
  assert.ok(s.ev.some((e) => e[0] === 'pop' && e[1] === 'PARADE !'));
});

test('roulade : invincible pendant la roulade', () => {
  const s = started(); toFight(s); faceOff(s);
  run(s, 1, press('atk'), press('roll'));
  run(s, 30);
  assert.equal(s.f[1].hp, 100);
});

test('endurance : sans endurance, impossible d\'attaquer', () => {
  const s = started(); toFight(s); faceOff(s, 3);
  s.f[0].sta = 0;
  run(s, 1, press('atk'));
  assert.equal(s.f[0].state, 'idle');
  assert.ok(s.ev.some((e) => e[0] === 'pop' && e[1] === 'ÉPUISÉ'));
});

test('KO : le round est gagné, puis le match après 2 manches', () => {
  const s = started(); toFight(s);
  for (let round = 0; round < 2; round++) {
    toFight(s); faceOff(s);
    s.f[1].hp = 5;
    run(s, 1, press('atk')); run(s, 20);
    assert.equal(s.g.phase, 'ko');
    let n = 0; while (s.g.phase === 'ko' && n++ < 600) s.step();
  }
  assert.equal(s.g.w0, 2);
  assert.equal(s.g.phase, 'end');
  assert.ok(s.ev.some((e) => e[0] === 'end'));
});

test('temps écoulé : victoire à celui qui a le plus de PV', () => {
  const s = started(); toFight(s);
  s.f[1].hp = 40;
  s.g.timer = 0.05;
  run(s, 10);
  assert.equal(s.g.phase, 'ko');
  assert.equal(s.g.roundWinner, 0);
});

test('égalité à la fin du temps : personne ne marque', () => {
  const s = started(); toFight(s);
  s.g.timer = 0.05; run(s, 10);
  assert.equal(s.g.roundWinner, -1);
  assert.equal(s.g.w0 + s.g.w1, 0);
});

test('les combattants ne se traversent pas', () => {
  const s = started(); toFight(s);
  s.f[0].x = s.f[1].x = 0; s.f[0].z = 0; s.f[1].z = 0.1;
  run(s, 10);
  const d = Math.hypot(s.f[1].x - s.f[0].x, s.f[1].z - s.f[0].z);
  assert.ok(d > 0.85, `distance ${d}`);
});

test('quant : borné à ±127', () => {
  assert.equal(quant(1), 127); assert.equal(quant(-1), -127); assert.equal(quant(5), 127); assert.equal(quant(0), 0);
});

// ---- robustesse ----
test('fuzz : entrées aléatoires pendant 40 000 images, invariants respectés', () => {
  const rng = new Rng(99);
  const s = started(3);
  const rin = () => ({ mx: Math.round(rng.range(-127, 127)), mz: Math.round(rng.range(-127, 127)), blk: rng.next() < 0.3, press: rng.next() < 0.2 ? Math.floor(rng.range(0, 32)) : 0 });
  for (let i = 0; i < 40000; i++) {
    s.step(rin(), rin());
    if (s.g.phase === 'end') s.startMatch();
    for (const f of s.f) {
      assert.ok(Number.isFinite(f.x) && Number.isFinite(f.z) && Number.isFinite(f.y) && Number.isFinite(f.yaw), `non fini image ${i}`);
      assert.ok(f.hp >= 0 && f.hp <= 100 && f.sta >= 0 && f.sta <= 100 && f.guard <= 100, `bornes image ${i}`);
      assert.ok(Math.hypot(f.x, f.z) <= FIGHT_R + 1e-9, `hors arène image ${i}`);
      assert.ok(f.y >= 0);
    }
    assert.ok(s.g.timer >= 0 && s.g.timer <= ROUND_TIME);
  }
});

test('IA contre IA : des matchs complets se terminent', () => {
  const { s } = aiMatch(7, 60 * 400, 2, 2);
  assert.ok(s.g.round >= 1);
  assert.ok(s.g.w0 + s.g.w1 >= 1, 'au moins une manche jouée');
});
