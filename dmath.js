// Maths déterministes : sin, cos, atan2 et exp n'utilisent que + − × ÷ et Math.sqrt,
// des opérations dont le résultat est exactement défini par la norme IEEE 754.
// Les Math.sin/cos/atan2/exp/hypot natifs peuvent différer d'un dernier bit selon le
// navigateur : inacceptable pour une simulation que deux machines doivent calculer à
// l'identique (rollback). Précision ≈ 1e-14, largement suffisante pour le jeu.

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const INV_TAU = 0.15915494309189535;
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634;

// coefficients 1/n! calculés au chargement (÷ et × exacts => identiques partout)
const SIN_C = [];
{
  let f = 1;
  for (let n = 1; n <= 21; n++) {
    f *= n;
    if (n % 2 === 1) SIN_C.push(((n - 1) / 2) % 2 === 0 ? 1 / f : -1 / f);
  }
}
const EXP_C = [];
{
  let f = 1;
  for (let n = 0; n <= 18; n++) { if (n > 0) f *= n; EXP_C.push(1 / f); }
}

export function sin(x) {
  if (!(x - x === 0)) return NaN;            // ±Infinity, NaN
  let r = x - Math.round(x * INV_TAU) * TAU; // [-π, π]
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  const r2 = r * r;
  let s = SIN_C[SIN_C.length - 1];
  for (let i = SIN_C.length - 2; i >= 0; i--) s = SIN_C[i] + r2 * s;
  return r * s;
}

export function cos(x) { return sin(x + HALF_PI); }

// arctangente pour t dans [0, 1]
function atanUnit(t) {
  let off = 0;
  if (t > 0.4142135623730951) { t = (t - 1) / (t + 1); off = PI / 4; }   // atan(t) = π/4 + atan((t-1)/(t+1))
  const t2 = t * t;
  let s = 0;
  for (let n = 23; n >= 0; n--) s = (n % 2 === 0 ? 1 : -1) / (2 * n + 1) + t2 * s;
  return off + t * s;
}

export function atan2(y, x) {
  if (x !== x || y !== y) return NaN;
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
  let a = ay > ax ? HALF_PI - atanUnit(ax / ay) : atanUnit(ay / ax);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

export function exp(x) {
  if (x !== x) return NaN;
  if (x > 700) return Infinity;
  if (x < -700) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2;
  let s = EXP_C[EXP_C.length - 1];
  for (let i = EXP_C.length - 2; i >= 0; i--) s = EXP_C[i] + r * s;
  for (let i = 0; i < k; i++) s *= 2;
  for (let i = 0; i > k; i--) s *= 0.5;
  return s;
}

export const hypot = (x, y) => Math.sqrt(x * x + y * y);
export const wrap = (a) => atan2(sin(a), cos(a));
export const lerpAng = (a, b, t) => a + wrap(b - a) * t;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Générateur pseudo-aléatoire à graine (mulberry32) : état = un entier 32 bits.
// Retourne { next(), state } où state se lit/écrit pour les sauvegardes du rollback.
export class Rng {
  constructor(seed = 1) { this.s = seed >>> 0; }
  next() {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
}
