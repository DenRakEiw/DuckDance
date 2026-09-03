// Small numeric toolbox shared by the retargeting pipeline: 3D vector
// helpers on plain {x,y,z} landmark objects, angle unwrapping, and the
// two smoothers we lean on (One-Euro for jittery pose signals, EMA for
// anything already tame).

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// Map v from [inLo, inHi] onto [outLo, outHi], clamped at both ends.
export function remap(v, inLo, inHi, outLo, outHi) {
  if (inHi === inLo) return outLo;
  return clamp(outLo + ((v - inLo) / (inHi - inLo)) * (outHi - outLo),
    Math.min(outLo, outHi), Math.max(outLo, outHi));
}

// Symmetric dead zone around 0, rescaled so the output still reaches 1
// at |v| = 1: kills sensor noise without eating the top of the range.
export function deadzone(v, dz) {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

// ── Vectors (landmarks arrive as {x, y, z, visibility}) ────────────────
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vscale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vmid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vlen = (a) => Math.hypot(a.x, a.y, a.z);
export const vcross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export function vnorm(a) {
  const l = vlen(a);
  return l < 1e-9 ? { x: 0, y: 0, z: 0 } : { x: a.x / l, y: a.y / l, z: a.z / l };
}

// ── Angles ─────────────────────────────────────────────────────────────
// Wrap to (-pi, pi].
export function wrapPi(a) {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

// Turn a sequence of wrapped angles into a continuous one, so a dancer
// spinning past the +-pi seam yields a monotone heading we can
// differentiate into a yaw rate.
export function unwrapSeries(angles) {
  const out = new Float32Array(angles.length);
  let offset = 0;
  for (let i = 0; i < angles.length; i++) {
    if (i > 0) {
      const d = angles[i] - angles[i - 1];
      if (d > Math.PI) offset -= 2 * Math.PI;
      else if (d < -Math.PI) offset += 2 * Math.PI;
    }
    out[i] = angles[i] + offset;
  }
  return out;
}

// ── Filters ────────────────────────────────────────────────────────────
// One-Euro: low cutoff when the signal is slow (kills jitter), cutoff
// rising with speed (keeps fast dance moves crisp). Casiez et al. 2012.
export class OneEuro {
  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }
  static #alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reset() { this.x = null; this.dx = 0; }
  filter(v, dt) {
    if (!Number.isFinite(v)) return this.x ?? 0;
    if (dt <= 0) return this.x ?? v;
    if (this.x === null) { this.x = v; return v; }
    const dxRaw = (v - this.x) / dt;
    const ad = OneEuro.#alpha(this.dCutoff, dt);
    this.dx = this.dx + ad * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuro.#alpha(cutoff, dt);
    this.x = this.x + a * (v - this.x);
    return this.x;
  }
}

// Centred moving average over a Float32Array; window is in samples and
// forced odd so the output stays phase-aligned with the input.
export function smoothSeries(src, window) {
  const n = src.length;
  const w = Math.max(1, window | 1);
  if (w <= 1 || n === 0) return Float32Array.from(src);
  const half = (w - 1) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      sum += src[j];
      cnt++;
    }
    out[i] = sum / cnt;
  }
  return out;
}

// Central difference in units per second; edges fall back to one-sided.
export function derivative(src, dt) {
  const n = src.length;
  const out = new Float32Array(n);
  if (n < 2 || dt <= 0) return out;
  for (let i = 0; i < n; i++) {
    if (i === 0) out[i] = (src[1] - src[0]) / dt;
    else if (i === n - 1) out[i] = (src[n - 1] - src[n - 2]) / dt;
    else out[i] = (src[i + 1] - src[i - 1]) / (2 * dt);
  }
  return out;
}

// Robust scale: the given percentile of |v|, used to auto-normalise a
// dancer's range without a single outlier frame setting the gain.
export function percentileAbs(src, p = 0.9) {
  const vals = [];
  for (let i = 0; i < src.length; i++) {
    const a = Math.abs(src[i]);
    if (Number.isFinite(a)) vals.push(a);
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => a - b);
  return vals[clamp(Math.round(p * (vals.length - 1)), 0, vals.length - 1)];
}
