// Level 1: dancer -> the duck's command vector.
//
// The simulator never poses the duck directly. It runs a velocity-tracking
// policy at 50 Hz whose only steering wheel is a 13-slot command:
//
//   [0..2]  vx, vy, wz     twist the gait policy tracks
//   [3..6]  neck_pitch, head_pitch, head_yaw, head_roll
//   [7..12] body pose      unused by the playground's policies, left zero
//
// So "dancing" here means writing a plausible twist and head pose for every
// 20 ms of the video. The legs are the policy's business: it decides how to
// step, we only say where to go. That is what keeps the duck upright while
// it dances.
//
// Two ideas do most of the work.
//
// CALIBRATION. Every dancer has a different build and stands in front of
// the lens differently, so the raw features have an arbitrary zero. We take
// a robust baseline per clip (a median over tracked frames) and a robust
// range (a high percentile of the deviation), then normalise. A tall dancer
// and a short one that move the same way drive the duck the same way.
//
// SAFETY. The walk policy falls over if its command jumps. Everything
// leaving this module is smoothed, rate-limited and clamped to the limits
// the playground uses for its own keyboard input.

import {
  OneEuro, clamp, derivative, smoothSeries, percentileAbs, unwrapSeries,
} from "./math.js";

// 50 Hz, matching the simulator's control loop exactly: one track sample
// per policy step means no resampling at playback time.
export const TRACK_FPS = 50;
export const TRACK_DT = 1 / TRACK_FPS;

// Channel layout of a track row.
export const CH = {
  VX: 0, VY: 1, WZ: 2,
  NECK_PITCH: 3, HEAD_PITCH: 4, HEAD_YAW: 5, HEAD_ROLL: 6,
};
export const NUM_CH = 7;

// Command limits. The twist ones are the playground's own keyboard limits
// (constants.js VEL_FWD / VEL_BACK / VEL_ANG); going past them asks the
// policy for gaits it was never trained on. The head limit is ours: the
// runtime allows 2.5 rad, which looks like a broken neck on a dancing duck.
export const LIMITS = {
  vxFwd: 0.25, vxBack: -0.2, vy: 0.15, wz: 1.0, head: 0.9,
};

// Largest change allowed per 20 ms control step. A dancer can snap from
// still to full speed in one frame; a 25 cm biped cannot.
const RATE = { vx: 0.02, vy: 0.015, wz: 0.10, head: 0.09 };

export const DEFAULT_TUNING = {
  // How hard each human signal drives its command slot. 1 means "a
  // typical move for this dancer reaches the duck's limit".
  gainTurn: 0.85,    // body rotation -> wz
  gainSway: 1.0,     // sideways travel -> vy
  gainStride: 0.8,   // depth travel + step cadence -> vx
  gainHead: 1.0,     // head orientation -> head slots
  gainLean: 0.8,     // torso bow -> neck pitch
  strideMix: 0.55,   // share of vx coming from step cadence vs real depth
  mirror: false,     // swap the dancer's left and right
  // Per-slot polarity. The playground's own comments give the joint
  // directions (cmd + is UP for neck_pitch but DOWN for head_pitch, LEFT
  // for head_yaw but RIGHT-tilt for head_roll); these carry that over and
  // stay adjustable because they are the one thing a screenshot settles
  // faster than arithmetic.
  signNeckPitch: -1, // dancer bows -> neck goes down
  signHeadPitch: -1, // dancer's chin up -> negative cmd
  signHeadYaw: 1,    // dancer looks left -> duck looks left
  signHeadRoll: -1,  // dancer tips crown left -> negative cmd
  smoothing: 1.0,    // scales the One-Euro cutoffs; higher = calmer duck
};

const median = (arr) => {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[clamp(Math.round(p * (s.length - 1)), 0, s.length - 1)];
};

/**
 * Per-clip baselines and ranges. Only frames the tracker was confident
 * about contribute, so a few garbage frames cannot move the zero point.
 */
export function calibrate(f) {
  const keep = [];
  for (let i = 0; i < f.n; i++) if (f.tracked[i]) keep.push(i);
  const col = (name) => keep.map((i) => f[name][i]);

  const base = {
    headYaw: median(col("headYaw")),
    headPitch: median(col("headPitch")),
    headRoll: median(col("headRoll")),
    leanFwd: median(col("leanFwd")),
    leanSide: median(col("leanSide")),
    footLiftL: median(col("footLiftL")),
    footLiftR: median(col("footLiftR")),
    imgScale: median(col("imgScale")),
    imgX: median(col("imgX")),
    // Standing tall is the high end of the stance signal, not its middle:
    // a routine spent mostly crouched must still read as crouched.
    stanceTall: percentile(col("stance"), 0.9),
    stanceLow: percentile(col("stance"), 0.1),
    trackedFraction: keep.length / Math.max(1, f.n),
  };

  // Robust ranges: how far this dancer actually moves each signal. The
  // floors stop a nearly-motionless clip from being amplified into noise.
  const dev = (name, b) => percentile(keep.map((i) => Math.abs(f[name][i] - b)), 0.9);
  base.rangeHeadYaw = Math.max(0.18, dev("headYaw", base.headYaw));
  base.rangeHeadPitch = Math.max(0.15, dev("headPitch", base.headPitch));
  base.rangeHeadRoll = Math.max(0.12, dev("headRoll", base.headRoll));
  base.rangeLeanFwd = Math.max(0.12, dev("leanFwd", base.leanFwd));
  return base;
}

// Resample an irregular (t, v) series onto a fixed grid by linear
// interpolation. Capture timestamps come from the video's own frame
// callbacks, so they are never exactly uniform.
function resample(t, v, grid) {
  const out = new Float32Array(grid.length);
  if (!t.length) return out;
  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const x = grid[i];
    while (j < t.length - 2 && t[j + 1] < x) j++;
    const t0 = t[j], t1 = t[Math.min(j + 1, t.length - 1)];
    if (t1 <= t0) { out[i] = v[j]; continue; }
    const a = clamp((x - t0) / (t1 - t0), 0, 1);
    out[i] = v[j] * (1 - a) + v[Math.min(j + 1, v.length - 1)] * a;
  }
  return out;
}

// Slew limiter: caps how far a channel may move in one control step.
function rateLimit(src, maxStep) {
  const out = new Float32Array(src.length);
  let prev = 0;
  for (let i = 0; i < src.length; i++) {
    const d = clamp(src[i] - prev, -maxStep, maxStep);
    prev += d;
    out[i] = prev;
  }
  return out;
}

function euroPass(src, opts) {
  const f = new OneEuro(opts);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = f.filter(src[i], TRACK_DT);
  return out;
}

/**
 * Build the 50 Hz command track.
 *
 * @param {object} f    features from extractFeatures
 * @param {object} tuning overrides on DEFAULT_TUNING
 * @returns {{fps, duration, n, data: Float32Array, tracked: Uint8Array,
 *           debug: object, calib: object}}
 *          `data` is row-major, NUM_CH floats per sample.
 */
export function retarget(f, tuning = {}) {
  const T = { ...DEFAULT_TUNING, ...tuning };
  const calib = calibrate(f);
  const mir = T.mirror ? -1 : 1;

  const t0 = f.t[0] ?? 0;
  const t1 = f.t[f.n - 1] ?? 0;
  const duration = Math.max(0, t1 - t0);
  const n = Math.max(1, Math.round(duration * TRACK_FPS) + 1);
  const grid = new Float64Array(n);
  for (let i = 0; i < n; i++) grid[i] = t0 + i * TRACK_DT;

  const times = Array.from(f.t);
  const rs = (arr) => resample(times, arr, grid);

  // Feature sample spacing, needed to differentiate before resampling.
  const srcDt = f.n > 1 ? Math.max(1e-3, (t1 - t0) / (f.n - 1)) : TRACK_DT;
  // Smoothing window in samples, about 130 ms: short enough to keep a
  // beat, long enough to kill landmark jitter.
  const win = Math.max(3, Math.round(0.13 / srcDt) | 1);

  // ── Turn: body heading rate ──
  const yawS = smoothSeries(Float32Array.from(unwrapSeries(Array.from(f.yaw))), win);
  const yawRate = derivative(yawS, srcDt);
  const yawScale = Math.max(0.35, percentileAbs(yawRate, 0.9));
  const wzSrc = new Float32Array(f.n);
  for (let i = 0; i < f.n; i++) {
    // The headroom above 1 lets the dancer's biggest turns read as
    // bigger, but a duck commanded to spin at its full rate for long
    // enough loses its footing, and the fall costs several seconds of
    // the routine. 1.25 keeps the accent without the tumble.
    wzSrc[i] = clamp((yawRate[i] / yawScale) * T.gainTurn, -1.25, 1.25) * LIMITS.wz * mir;
  }

  // ── Sway: sideways travel across the frame, in torso lengths per
  // second so a dancer filmed close up and one filmed wide agree. The
  // dancer's own left is image RIGHT, and the duck's +vy is its left, so
  // this maps straight through.
  const scale = rs(f.imgScale);
  const imgXs = smoothSeries(rs(f.imgX), Math.max(3, Math.round(0.13 / TRACK_DT) | 1));
  const imgXRate = derivative(imgXs, TRACK_DT);
  const swayNorm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    swayNorm[i] = imgXRate[i] / Math.max(1e-3, scale[i]);
  }
  const swayScale = Math.max(0.5, percentileAbs(swayNorm, 0.9));

  // ── Stride: real depth travel, plus the dancer's step cadence. Depth
  // from a single camera is the least trustworthy signal we have, so it
  // is heavily smoothed and shares the slot with a cadence term that is
  // measured in the image plane and much steadier.
  const scaleS = smoothSeries(scale, Math.max(5, Math.round(0.25 / TRACK_DT) | 1));
  const depthRate = derivative(scaleS, TRACK_DT);
  const depthNorm = new Float32Array(n);
  for (let i = 0; i < n; i++) depthNorm[i] = depthRate[i] / Math.max(1e-3, scaleS[i]);
  const depthScale = Math.max(0.35, percentileAbs(depthNorm, 0.9));

  // Step cadence: which foot is up, centred per dancer. Rocking the duck
  // forward and back with the dancer's steps is what turns a stationary
  // sway into something that reads as dancing.
  const footL = rs(f.footLiftL), footR = rs(f.footLiftR);
  const footAlt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    footAlt[i] = (footL[i] - calib.footLiftL) - (footR[i] - calib.footLiftR);
  }
  const footAltS = smoothSeries(footAlt, Math.max(3, Math.round(0.1 / TRACK_DT) | 1));
  const cadence = derivative(footAltS, TRACK_DT);
  const cadScale = Math.max(0.5, percentileAbs(cadence, 0.9));

  // ── Head and torso ──
  const hYaw = rs(f.headYaw), hPitch = rs(f.headPitch), hRoll = rs(f.headRoll);
  const lean = rs(f.leanFwd);
  const trackedRs = rs(Float32Array.from(f.tracked));

  // Assemble, then filter each channel.
  const raw = {
    vx: new Float32Array(n), vy: new Float32Array(n), wz: rs(wzSrc),
    neck: new Float32Array(n), hp: new Float32Array(n),
    hy: new Float32Array(n), hr: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const depthTerm = clamp(depthNorm[i] / depthScale, -1.5, 1.5);
    const cadTerm = clamp(cadence[i] / cadScale, -1.5, 1.5);
    const vx = (depthTerm * (1 - T.strideMix) + cadTerm * T.strideMix) * T.gainStride;
    raw.vx[i] = vx >= 0 ? vx * LIMITS.vxFwd : -vx * LIMITS.vxBack;
    raw.vy[i] = clamp(swayNorm[i] / swayScale, -1.5, 1.5) * T.gainSway * LIMITS.vy * mir;

    const nHeadYaw = (hYaw[i] - calib.headYaw) / calib.rangeHeadYaw;
    const nHeadPitch = (hPitch[i] - calib.headPitch) / calib.rangeHeadPitch;
    const nHeadRoll = (hRoll[i] - calib.headRoll) / calib.rangeHeadRoll;
    const nLean = (lean[i] - calib.leanFwd) / calib.rangeLeanFwd;

    raw.hy[i] = clamp(nHeadYaw, -1.4, 1.4) * T.gainHead * T.signHeadYaw * LIMITS.head * mir;
    raw.hp[i] = clamp(nHeadPitch, -1.4, 1.4) * T.gainHead * T.signHeadPitch * LIMITS.head;
    raw.hr[i] = clamp(nHeadRoll, -1.4, 1.4) * T.gainHead * T.signHeadRoll * LIMITS.head * mir;
    raw.neck[i] = clamp(nLean, -1.4, 1.4) * T.gainLean * T.signNeckPitch * LIMITS.head;

    // Tracking gaps fade EVERY channel toward neutral rather than
    // freezing a stale one. The head matters as much as the twist here:
    // a held head angle does not read as "we lost the dancer", it reads
    // as a deliberate instruction to stand there with a cocked head, and
    // a clip the tracker only caught a couple of frames of would have the
    // duck holding a pose derived from those two frames throughout.
    if (trackedRs[i] < 0.5) {
      const fade = 0.2;
      raw.vx[i] *= fade; raw.vy[i] *= fade; raw.wz[i] *= fade;
      raw.hy[i] *= fade; raw.hp[i] *= fade;
      raw.hr[i] *= fade; raw.neck[i] *= fade;
    }
  }

  const sm = T.smoothing;
  const filt = {
    vx: rateLimit(euroPass(raw.vx, { minCutoff: 1.4 / sm, beta: 0.02 }), RATE.vx),
    vy: rateLimit(euroPass(raw.vy, { minCutoff: 1.6 / sm, beta: 0.02 }), RATE.vy),
    wz: rateLimit(euroPass(raw.wz, { minCutoff: 2.0 / sm, beta: 0.03 }), RATE.wz),
    neck: rateLimit(euroPass(raw.neck, { minCutoff: 1.6 / sm, beta: 0.02 }), RATE.head),
    hp: rateLimit(euroPass(raw.hp, { minCutoff: 2.2 / sm, beta: 0.04 }), RATE.head),
    hy: rateLimit(euroPass(raw.hy, { minCutoff: 2.2 / sm, beta: 0.04 }), RATE.head),
    hr: rateLimit(euroPass(raw.hr, { minCutoff: 2.0 / sm, beta: 0.03 }), RATE.head),
  };

  const data = new Float32Array(n * NUM_CH);
  for (let i = 0; i < n; i++) {
    const o = i * NUM_CH;
    data[o + CH.VX] = clamp(filt.vx[i], LIMITS.vxBack, LIMITS.vxFwd);
    data[o + CH.VY] = clamp(filt.vy[i], -LIMITS.vy, LIMITS.vy);
    data[o + CH.WZ] = clamp(filt.wz[i], -LIMITS.wz, LIMITS.wz);
    data[o + CH.NECK_PITCH] = clamp(filt.neck[i], -LIMITS.head, LIMITS.head);
    data[o + CH.HEAD_PITCH] = clamp(filt.hp[i], -LIMITS.head, LIMITS.head);
    data[o + CH.HEAD_YAW] = clamp(filt.hy[i], -LIMITS.head, LIMITS.head);
    data[o + CH.HEAD_ROLL] = clamp(filt.hr[i], -LIMITS.head, LIMITS.head);
  }

  const tracked = new Uint8Array(n);
  for (let i = 0; i < n; i++) tracked[i] = trackedRs[i] >= 0.5 ? 1 : 0;

  return {
    fps: TRACK_FPS, dt: TRACK_DT, t0, duration, n, data, tracked, calib,
    tuning: T,
    debug: { footAlt: footAltS, cadence, depthNorm, swayNorm, yawRate },
  };
}

// Read one row of a track into `out` (length NUM_CH). Time is relative to
// the clip start. Out-of-range times clamp to the ends, which is what the
// player wants while the video is paused at either edge.
export function sampleTrack(track, tRel, out) {
  const x = clamp(tRel / track.dt, 0, track.n - 1);
  const i = Math.floor(x);
  const j = Math.min(i + 1, track.n - 1);
  const a = x - i;
  const oi = i * NUM_CH, oj = j * NUM_CH;
  for (let c = 0; c < NUM_CH; c++) {
    out[c] = track.data[oi + c] * (1 - a) + track.data[oj + c] * a;
  }
  return out;
}
