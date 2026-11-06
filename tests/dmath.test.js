import test from 'node:test';
import assert from 'node:assert/strict';
import { sin, cos, atan2, exp, hypot, wrap, Rng } from '../dmath.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (écart ${Math.abs(a - b)})`);

test('sin/cos proches de Math sur [-50, 50]', () => {
  for (let x = -50; x <= 50; x += 0.0137) {
    near(sin(x), Math.sin(x), 1e-13, `sin(${x})`);
    near(cos(x), Math.cos(x), 1e-13, `cos(${x})`);
  }
});

test('sin/cos : valeurs remarquables', () => {
  near(sin(0), 0, 1e-16, 'sin 0');
  near(cos(0), 1, 1e-15, 'cos 0');
  near(sin(Math.PI / 2), 1, 1e-15, 'sin π/2');
  near(cos(Math.PI), -1, 1e-15, 'cos π');
  assert.ok(Number.isNaN(sin(Infinity)));
});

test('atan2 proche de Math.atan2 dans tous les quadrants', () => {
  for (let a = -3.14; a < 3.14; a += 0.00731) {
    const y = Math.sin(a) * 3.7, x = Math.cos(a) * 3.7;
    near(atan2(y, x), Math.atan2(y, x), 1e-13, `atan2(${y},${x})`);
  }
  assert.equal(atan2(0, 0), 0);
  near(atan2(1, 0), Math.PI / 2, 1e-15, 'axe +z');
  near(atan2(-1, 0), -Math.PI / 2, 1e-15, 'axe -z');
  near(atan2(0, -1), Math.PI, 1e-15, 'axe -x');
});

test('exp proche de Math.exp (plage utilisée par le jeu et au-delà)', () => {
  for (let x = -40; x <= 10; x += 0.0173) {
    const e = Math.exp(x);
    assert.ok(Math.abs(exp(x) - e) <= e * 1e-13, `exp(${x})`);
  }
  assert.equal(exp(-1000), 0);
  assert.equal(exp(1000), Infinity);
});

test('hypot et wrap', () => {
  assert.equal(hypot(3, 4), 5);
  near(wrap(7), 7 - 2 * Math.PI, 1e-13, 'wrap 7');
  near(wrap(-4), -4 + 2 * Math.PI, 1e-13, 'wrap -4');
});

test('résultats identiques d\'un appel à l\'autre (pas d\'état caché)', () => {
  const a = [], b = [];
  for (let i = 0; i < 1000; i++) { a.push(sin(i * 0.37), atan2(i - 500, 77), exp(-i * 0.01)); }
  for (let i = 0; i < 1000; i++) { b.push(sin(i * 0.37), atan2(i - 500, 77), exp(-i * 0.01)); }
  assert.deepEqual(a, b);
});

test('Rng : reproductible, dans [0,1), état sauvegardable', () => {
  const r1 = new Rng(42), r2 = new Rng(42);
  for (let i = 0; i < 100; i++) assert.equal(r1.next(), r2.next());
  const r = new Rng(7);
  for (let i = 0; i < 5000; i++) { const v = r.next(); assert.ok(v >= 0 && v < 1); }
  const s = r.s, a = r.next();
  r.s = s;
  assert.equal(r.next(), a);
  assert.notEqual(new Rng(1).next(), new Rng(2).next());
});
