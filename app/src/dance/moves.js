// Level 2: dancer -> the duck's one-shot skills.
//
// Level 1 steers a gait. This layer spots the moments where the dancer
// does something the gait cannot express, and fires the matching policy
// the playground already ships:
//
//   kickL / kickR   a foot swings up and out
//   pick            a deep bow (the ground-pick gesture reads as a bow)
//   sit / stand     a sustained squat, and standing back out of it
//   roll            a roulade, off by default: it is a real fall risk
//
// Two things make this harder than thresholding a signal.
//
// The duck is BUSY while a skill runs. A kick freezes the twist for half
// a second and another 0.4 s after; a sit takes 0.8 s to enter and 2 s to
// leave. Firing on every detection would leave the duck permanently mid
// gesture and never dancing. So every rule carries an occupancy window,
// and the scheduler drops anything that lands inside one.
//
// Thresholds cannot be absolute. A high kicker and someone marking the
// same routine produce very different numbers, so thresholds are derived
// from each dancer's own range, the same way retarget.js normalises.

import { clamp, smoothSeries, derivative, percentileAbs } from "./math.js";

export const DEFAULT_MOVE_TUNING = {
  enableKicks: true,
  enablePick: true,
  enableSit: true,
  enableRoll: false,   // a roulade from a bad pose is how the duck ends up
                       // on its back; opt in deliberately
  sensitivity: 1.0,    // scales every threshold, higher = more moves
  quantise: true,      // snap to the nearest beat
  quantiseWindow: 0.14, // seconds a move may be nudged to hit a beat
  minSpacing: 0.9,     // seconds between any two moves
  mirror: false,
};

// How long the duck is unavailable after each skill starts, in seconds.
// Taken from the playground's own step budgets: a kick is 25 control
// steps plus a 20-step grace, a ground pick runs 0.7 of a 4 s cycle, a
// sit hands over after 0.8 s and needs 2 s to stand back up.
export const OCCUPANCY = {
  kickL: 1.1, kickR: 1.1, pick: 3.2, sit: 1.2, stand: 2.4, roll: 2.5,
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

// Rising-edge detector over a signal with hysteresis: fires once when the
// signal crosses `hi`, and rearms only after it falls back under `lo`.
function* risingEdges(sig, t, hi, lo) {
  let armed = true;
  for (let i = 0; i < sig.length; i++) {
    if (armed && sig[i] >= hi) {
      // Walk forward to the local peak so the event lands on the apex of
      // the move rather than the moment it started.
      let j = i;
      while (j + 1 < sig.length && sig[j + 1] > sig[j]) j++;
      yield { i: j, t: t[j], value: sig[j] };
      armed = false;
    } else if (!armed && sig[i] < lo) {
      armed = true;
    }
  }
}

// Spans where a signal stays above `hi` for at least `minDur` seconds.
function sustainedSpans(sig, t, hi, lo, minDur) {
  const spans = [];
  let start = -1;
  for (let i = 0; i < sig.length; i++) {
    if (start < 0 && sig[i] >= hi) start = i;
    else if (start >= 0 && sig[i] < lo) {
      if (t[i] - t[start] >= minDur) spans.push([t[start], t[i]]);
      start = -1;
    }
  }
  if (start >= 0 && t[t.length - 1] - t[start] >= minDur) {
    spans.push([t[start], t[t.length - 1]]);
  }
  return spans;
}

/**
 * Find candidate moves in the dancer's features.
 *
 * @param {object} f       features from extractFeatures
 * @param {object} calib   calibration from retarget.calibrate
 * @param {object} tuning  overrides on DEFAULT_MOVE_TUNING
 * @param {number[]} beats beat times in seconds, may be empty
 * @returns {{events: Array, rejected: Array, debug: object}}
 */
export function detectMoves(f, calib, tuning = {}, beats = []) {
  const T = { ...DEFAULT_MOVE_TUNING, ...tuning };
  const t = Array.from(f.t);
  const sens = Math.max(0.2, T.sensitivity);
  const candidates = [];
  const debug = {};

  const srcDt = f.n > 1 ? Math.max(1e-3, (t[f.n - 1] - t[0]) / (f.n - 1)) : 0.033;
  const win = Math.max(3, Math.round(0.09 / srcDt) | 1);

  // ── Kicks ──
  // A kick is a foot that goes higher than this dancer's ordinary steps.
  // The threshold is their own 92nd percentile of foot lift, so a marked
  // routine and a high-energy one both produce a handful of kicks rather
  // than none or hundreds.
  if (T.enableKicks) {
    const liftL = smoothSeries(f.footLiftL, win);
    const liftR = smoothSeries(f.footLiftR, win);
    const relL = new Float32Array(f.n), relR = new Float32Array(f.n);
    for (let i = 0; i < f.n; i++) {
      relL[i] = liftL[i] - calib.footLiftL;
      relR[i] = liftR[i] - calib.footLiftR;
    }
    const spread = Math.max(
      0.12,
      (percentile(Array.from(relL), 0.92) + percentile(Array.from(relR), 0.92)) / 2,
    );
    const hi = spread * 1.35 / sens;
    const lo = hi * 0.45;
    debug.kickThreshold = hi;
    for (const e of risingEdges(relL, t, hi, lo)) {
      candidates.push({ t: e.t, type: T.mirror ? "kickR" : "kickL",
        strength: e.value / hi, rule: "foot lift left" });
    }
    for (const e of risingEdges(relR, t, hi, lo)) {
      candidates.push({ t: e.t, type: T.mirror ? "kickL" : "kickR",
        strength: e.value / hi, rule: "foot lift right" });
    }
  }

  // ── Bow, mapped onto the ground-pick gesture ──
  // The pick policy dips the beak to the floor and stands back up, which
  // is the closest thing in the policy set to a bow.
  if (T.enablePick) {
    const lean = smoothSeries(f.leanFwd, win);
    const rel = new Float32Array(f.n);
    for (let i = 0; i < f.n; i++) rel[i] = lean[i] - calib.leanFwd;
    const hi = Math.max(0.28, percentile(Array.from(rel), 0.95) * 0.9) / sens;
    debug.bowThreshold = hi;
    for (const [t0] of sustainedSpans(rel, t, hi, hi * 0.5, 0.35)) {
      candidates.push({ t: t0, type: "pick", strength: 1, rule: "sustained bow" });
    }
  }

  // ── Squat, mapped onto sit and stand ──
  // Sitting is slow on both ends, so only a genuinely held squat earns
  // it; anything shorter would leave the duck standing back up through
  // the next four bars of the song.
  if (T.enableSit) {
    const st = smoothSeries(f.stance, win);
    const drop = new Float32Array(f.n);
    const span = Math.max(0.08, calib.stanceTall - calib.stanceLow);
    for (let i = 0; i < f.n; i++) drop[i] = (calib.stanceTall - st[i]) / span;
    const hi = 0.62 / sens;
    debug.sitThreshold = hi;
    for (const [t0, t1] of sustainedSpans(drop, t, hi, hi * 0.6, 1.1)) {
      candidates.push({ t: t0, type: "sit", strength: 1, rule: "held squat" });
      candidates.push({ t: t1, type: "stand", strength: 1, rule: "rise from squat" });
    }
  }

  // ── Roulade ──
  // Only for something unmistakable: a deep drop with a lot of motion
  // behind it. Off unless the user asks for it.
  if (T.enableRoll) {
    const st = smoothSeries(f.stance, win);
    const en = smoothSeries(f.energy, win);
    const enScale = Math.max(0.4, percentileAbs(en, 0.9));
    const span = Math.max(0.08, calib.stanceTall - calib.stanceLow);
    const sig = new Float32Array(f.n);
    for (let i = 0; i < f.n; i++) {
      sig[i] = ((calib.stanceTall - st[i]) / span) * (en[i] / enScale);
    }
    for (const e of risingEdges(sig, t, 1.5 / sens, 0.6)) {
      candidates.push({ t: e.t, type: "roll", strength: e.value, rule: "drop with energy" });
    }
  }

  // ── Beat quantisation ──
  // A move that lands a tenth of a second off the beat reads as a
  // mistake; the same move on the beat reads as choreography. Only nudge
  // within a small window, so a move far from any beat keeps its timing
  // rather than being dragged somewhere it does not belong.
  if (T.quantise && beats.length) {
    for (const c of candidates) {
      let best = null, bestD = Infinity;
      for (const b of beats) {
        const d = Math.abs(b - c.t);
        if (d < bestD) { bestD = d; best = b; }
        if (b > c.t + T.quantiseWindow) break;
      }
      if (best !== null && bestD <= T.quantiseWindow) {
        c.quantised = true;
        c.tRaw = c.t;
        c.t = best;
      }
    }
  }

  // ── Scheduling ──
  // Sort by time, then walk forward keeping only what the duck is
  // actually free to perform. Everything dropped is reported, because a
  // silent filter here looks like broken detection.
  candidates.sort((a, b) => a.t - b.t);
  const events = [];
  const rejected = [];
  let busyUntil = -Infinity;
  let sitting = false;

  for (const c of candidates) {
    // Standing is only meaningful while sitting, and sitting twice in a
    // row is not a thing.
    if (c.type === "stand" && !sitting) { rejected.push({ ...c, why: "not sitting" }); continue; }
    if (c.type === "sit" && sitting) { rejected.push({ ...c, why: "already sitting" }); continue; }
    // While the duck is sitting the only skill that means anything is
    // standing back up.
    if (sitting && c.type !== "stand") { rejected.push({ ...c, why: "sitting" }); continue; }
    if (c.t < busyUntil) { rejected.push({ ...c, why: "duck busy" }); continue; }
    if (events.length && c.t - events[events.length - 1].t < T.minSpacing) {
      rejected.push({ ...c, why: "too close to previous" });
      continue;
    }
    events.push(c);
    busyUntil = c.t + (OCCUPANCY[c.type] ?? 1);
    if (c.type === "sit") sitting = true;
    if (c.type === "stand") sitting = false;
  }

  // A routine that ends mid-squat would leave the duck sitting for good.
  if (sitting && events.length) {
    const last = events[events.length - 1];
    events.push({ t: last.t + OCCUPANCY.sit + 0.4, type: "stand", strength: 1,
      rule: "auto stand at end" });
  }

  return { events, rejected, debug };
}
