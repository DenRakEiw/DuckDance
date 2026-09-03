// Phrased retargeting: choreography at the tempo the duck can hold.
//
// The direct path in retarget.js maps every video frame to a command and
// then filters what the duck cannot follow. On real dance footage that
// throws away almost everything: at 125 BPM a beat is 0.48 s while a
// command channel needs about 0.4 s just to reach one extreme, so the
// limiter spends the whole clip holding the duck back and the residue
// reads as twitching.
//
// This module inverts the problem. Instead of filtering a signal that is
// too fast, it BUILDS one that is inside the duck's limits by
// construction, and spends the available movement on the musical
// structure of the dance rather than on its every frame.
//
// Three ideas.
//
// PHRASES. The dancer's motion is summarised over a span of whole beats
// long enough for the duck to complete a gesture in, currently about a
// second. Each phrase gets one target per channel: the net rotation the
// dancer actually turned through, where they travelled, how they held
// their head. The duck then performs that, once, properly.
//
// TWO RATES. A body turn and a nod cost the same slew budget, but a nod
// only has to move half its range to read. So the body moves at phrase
// rate and the head accents on every beat, which is roughly how a dancer
// is organised anyway and is what makes the result look musical rather
// than merely slow.
//
// AMPLITUDE, NOT CLIPPING. Interpolating with a smoothstep gives a known
// maximum slope of 1.5 * delta / duration. That is a budget we can check
// before committing to a target, so when a gesture will not fit we shrink
// it and the duck performs a smaller COMPLETE movement, instead of
// starting a large one and being cut off halfway.

import { clamp, smoothSeries, derivative, percentileAbs, unwrapSeries } from "./math.js";
import { CH, NUM_CH, TRACK_FPS, TRACK_DT, LIMITS, calibrate } from "./retarget.js";

// Same slew caps the direct path respects, per 20 ms control step.
const RATE = { vx: 0.02, vy: 0.015, wz: 0.10, head: 0.09 };
const RATE_BY_CH = {
  [CH.VX]: RATE.vx, [CH.VY]: RATE.vy, [CH.WZ]: RATE.wz,
  [CH.NECK_PITCH]: RATE.head, [CH.HEAD_PITCH]: RATE.head,
  [CH.HEAD_YAW]: RATE.head, [CH.HEAD_ROLL]: RATE.head,
};

// A gesture the duck can complete: roughly one full swing out and back.
export const MIN_GESTURE_S = 0.9;
// Used when the clip has no detectable beat.
const FALLBACK_PHRASE_S = 1.0;

export const DEFAULT_PHRASE_TUNING = {
  gainTurn: 1.0,
  gainSway: 1.0,
  gainStride: 0.8,
  gainHead: 1.0,
  gainLean: 0.8,
  accent: 0.8,      // how hard the head marks each beat
  mirror: false,
  signNeckPitch: -1,
  signHeadPitch: -1,
  signHeadYaw: 1,
  signHeadRoll: -1,
  holdFraction: 0.45, // share of a phrase spent holding the target
  // Ceiling on the SUSTAINED body commands, as a share of the policy's
  // limit. The frame-by-frame path only ever touches the limit in
  // spikes; this one deliberately holds a target for most of a phrase,
  // and a turn held near the maximum for half a second is what puts the
  // duck on the floor. Measured on the demo routine: the phrased path
  // spent 14.6% of the clip above 0.8 rad/s in stretches up to 0.64 s,
  // against 10.8% and 0.50 s for the direct path.
  sustainedCeiling: 0.8,
};

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

// The value furthest from zero, sign kept. For an oscillating signal this
// is the phrase's accent; for a steady one it is simply the level.
function signedPeak(arr) {
  let best = 0;
  for (const v of arr) if (Number.isFinite(v) && Math.abs(v) > Math.abs(best)) best = v;
  return best;
}

const medianOf = (arr) => {
  const s = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Largest change a channel may make across `dur` seconds when the
// transition is shaped as a smoothstep, whose peak slope is 1.5x the
// average. This is the whole reason the output never needs clipping.
function maxDelta(ch, dur) {
  return (RATE_BY_CH[ch] / TRACK_DT) * dur / 1.5;
}

/**
 * Work out the phrase grid: spans of whole beats, each long enough for
 * the duck to finish a gesture in.
 */
export function phraseGrid(beats, duration) {
  if (beats && beats.length >= 4) {
    const diffs = [];
    for (let i = 1; i < beats.length; i++) diffs.push(beats[i] - beats[i - 1]);
    diffs.sort((a, b) => a - b);
    const beatPeriod = diffs[diffs.length >> 1];
    if (beatPeriod > 0.05) {
      const perPhrase = Math.max(1, Math.ceil(MIN_GESTURE_S / beatPeriod));
      const edges = [];
      for (let i = 0; i < beats.length; i += perPhrase) edges.push(beats[i]);
      if (edges.length >= 2) {
        const last = edges[edges.length - 1];
        if (duration - last > beatPeriod) edges.push(duration);
        return { edges, beatPeriod, perPhrase, source: "beats" };
      }
    }
  }
  // No beat grid: a fixed span, still long enough to be performable.
  const edges = [];
  for (let t = 0; t < duration; t += FALLBACK_PHRASE_S) edges.push(t);
  edges.push(duration);
  return { edges, beatPeriod: FALLBACK_PHRASE_S, perPhrase: 1, source: "fixed" };
}

// Index of the first sample at or after t.
function indexAt(times, t) {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Summarise the dancer over each phrase.
 *
 * Everything here is a NET or MEAN quantity, never an instantaneous one.
 * Net rotation is the honest thing to reproduce: if the dancer came back
 * to where they started, the duck should too, however busy the path was.
 */
export function describePhrases(f, calib, grid) {
  const times = Array.from(f.t);
  const yaw = unwrapSeries(Array.from(f.yaw));
  const win = Math.max(3, Math.round(0.1 / Math.max(1e-3,
    (times[times.length - 1] - times[0]) / Math.max(1, f.n - 1))) | 1);
  const imgX = smoothSeries(f.imgX, win);
  const scale = smoothSeries(f.imgScale, win);
  const footL = f.footLiftL, footR = f.footLiftR;

  const out = [];
  for (let p = 0; p < grid.edges.length - 1; p++) {
    const t0 = grid.edges[p], t1 = grid.edges[p + 1];
    const i0 = indexAt(times, t0), i1 = Math.max(i0 + 1, indexAt(times, t1));
    const range = [];
    for (let i = i0; i < i1 && i < f.n; i++) range.push(i);
    if (!range.length) continue;
    const tracked = range.filter((i) => f.tracked[i]).length / range.length;

    // Net heading change across the phrase, in radians.
    const turn = yaw[Math.min(i1, f.n - 1)] - yaw[i0];
    // Net sideways travel, in torso lengths: the dancer's own left is
    // image right, and the duck's +y is its left, so this maps through.
    const sway = (imgX[Math.min(i1, f.n - 1)] - imgX[i0]) /
      Math.max(1e-3, mean(range.map((i) => scale[i])));
    // Net depth travel, from apparent size. Growing means approaching.
    const s0 = scale[i0], s1 = scale[Math.min(i1, f.n - 1)];
    const advance = (s1 - s0) / Math.max(1e-3, (s0 + s1) / 2);
    // How much the feet worked, which is what a stationary dancer's
    // energy goes into and what the forward command reads instead of
    // depth when the dancer stays put.
    const stepWork = mean(range.map((i) =>
      Math.abs(footL[i] - calib.footLiftL) + Math.abs(footR[i] - calib.footLiftR)));

    out.push({
      index: p, t0, t1, dur: Math.max(1e-3, t1 - t0), tracked,
      turn, sway, advance, stepWork,
      // Head and lean take the phrase's signed PEAK, not its mean.
      // A dancer swinging their head left then right inside one phrase
      // averages to nothing, and the mean duly collapsed both channels
      // to zero on the first real clip. The peak keeps the phrase's
      // strongest gesture and its direction, which is the thing worth
      // reproducing, while genuinely still frames still read as still.
      headYaw: signedPeak(range.map((i) => f.headYaw[i] - calib.headYaw)),
      headPitch: signedPeak(range.map((i) => f.headPitch[i] - calib.headPitch)),
      headRoll: signedPeak(range.map((i) => f.headRoll[i] - calib.headRoll)),
      lean: signedPeak(range.map((i) => f.leanFwd[i] - calib.leanFwd)),
      energy: mean(range.map((i) => f.energy[i])),
      peakEnergy: Math.max(...range.map((i) => f.energy[i])),
    });
  }
  return out;
}

// Robust scale for a per-phrase quantity, so gains mean the same thing
// for a big mover and a subtle one.
function phraseScale(phrases, pick, floor) {
  const vals = phrases.map(pick).map(Math.abs).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return floor;
  const p = vals[clamp(Math.round(0.85 * (vals.length - 1)), 0, vals.length - 1)];
  return Math.max(floor, p);
}

/**
 * Turn phrase descriptions into a 50 Hz command track.
 *
 * Each channel holds its phrase target through the middle of the phrase
 * and smoothsteps to the next one across the gaps, so the signal is flat
 * where the duck should be committing to a pose and moving where it
 * should be travelling between them.
 */
export function synthesisePhrases(phrases, grid, tuning, duration, beats) {
  const T = { ...DEFAULT_PHRASE_TUNING, ...tuning };
  const mir = T.mirror ? -1 : 1;
  const n = Math.max(1, Math.round(duration * TRACK_FPS) + 1);
  const data = new Float32Array(n * NUM_CH);
  if (!phrases.length) return { data, n, targets: [], shrunk: 0 };

  // Normalisers, computed once over the whole routine.
  const turnScale = phraseScale(phrases, (p) => p.turn / p.dur, 0.5);
  const swayScale = phraseScale(phrases, (p) => p.sway / p.dur, 0.4);
  const advScale = phraseScale(phrases, (p) => p.advance / p.dur, 0.25);
  const stepMid = medianOf(phrases.map((p) => p.stepWork));
  const stepScale = phraseScale(phrases, (p) => p.stepWork - stepMid, 0.08);

  // One target vector per phrase.
  const targets = phrases.map((p) => {
    const t = new Float32Array(NUM_CH);
    // Average angular velocity that reproduces the dancer's NET turn.
    const ceil = clamp(T.sustainedCeiling, 0.3, 1);
    t[CH.WZ] = clamp((p.turn / p.dur / turnScale) * T.gainTurn, -1, 1) * LIMITS.wz * ceil * mir;
    t[CH.VY] = clamp((p.sway / p.dur / swayScale) * T.gainSway, -1, 1) * LIMITS.vy * ceil * mir;
    // Forward is the weakest signal from one camera, so it leans on how
    // hard the feet worked rather than on apparent depth alone. Both
    // terms are CENTRED: an uncentred step-work term is a constant
    // forward bias, and the duck walks steadily into the arena wall
    // while the dancer is merely stepping on the spot.
    const adv = clamp((p.advance / p.dur / advScale), -1, 1);
    const work = clamp((p.stepWork - stepMid) / stepScale, -1, 1);
    const vx = (adv * 0.45 + work * 0.55) * T.gainStride;
    t[CH.VX] = clamp(vx, -1, 1) * (vx >= 0 ? LIMITS.vxFwd : -LIMITS.vxBack);
    // The head is NOT a phrase-rate channel and is rendered separately
    // by renderHead(). A full head swing takes about 0.4 s against a
    // phrase of nearly a second, so binding it to the phrase throws away
    // motion the duck is perfectly capable of. Worse, sampling one head
    // value per phrase aliases: on the first clip the dancer's head
    // happened to swing once per phrase, every sample landed on the same
    // side of the swing, and both head channels froze at their limit.
    // Where the dancer was lost, ask for nothing rather than guess.
    if (p.tracked < 0.5) for (let c = 0; c < NUM_CH; c++) t[c] *= 0.2;
    return t;
  });

  // Fit consecutive targets to the slew budget. A transition gets the
  // gap between two phrase holds; if the step is bigger than a smoothstep
  // can carry in that time, the DESTINATION shrinks toward the origin, so
  // the duck completes a smaller gesture instead of being cut off mid
  // way through a larger one.
  let shrunk = 0;
  const hold = clamp(T.holdFraction, 0.1, 0.8);
  for (let p = 1; p < targets.length; p++) {
    const moveDur = Math.max(0.1, phrases[p].dur * (1 - hold));
    for (let c = 0; c < NUM_CH; c++) {
      const cap = maxDelta(c, moveDur);
      const d = targets[p][c] - targets[p - 1][c];
      if (Math.abs(d) > cap) {
        targets[p][c] = targets[p - 1][c] + Math.sign(d) * cap;
        shrunk++;
      }
    }
  }

  // Render: hold through the middle of each phrase, smoothstep between.
  const smooth = (u) => u * u * (3 - 2 * u);
  for (let i = 0; i < n; i++) {
    const t = i * TRACK_DT;
    let p = 0;
    while (p < phrases.length - 1 && t >= phrases[p].t1) p++;
    const cur = phrases[p];
    const holdEnd = cur.t0 + cur.dur * hold;
    let a = targets[p], b = targets[p], u = 0;
    if (t > holdEnd && p < targets.length - 1) {
      a = targets[p];
      b = targets[p + 1];
      u = clamp((t - holdEnd) / Math.max(1e-3, cur.t1 - holdEnd), 0, 1);
    }
    const w = smooth(u);
    const o = i * NUM_CH;
    for (let c = 0; c < NUM_CH; c++) data[o + c] = a[c] * (1 - w) + b[c] * w;
  }

  // Final clamp. Nothing above should exceed the limits; this is a
  // backstop, not the mechanism.
  for (let i = 0; i < n; i++) {
    const o = i * NUM_CH;
    data[o + CH.VX] = clamp(data[o + CH.VX], LIMITS.vxBack, LIMITS.vxFwd);
    data[o + CH.VY] = clamp(data[o + CH.VY], -LIMITS.vy, LIMITS.vy);
    data[o + CH.WZ] = clamp(data[o + CH.WZ], -LIMITS.wz, LIMITS.wz);
    for (const c of [CH.NECK_PITCH, CH.HEAD_PITCH, CH.HEAD_YAW, CH.HEAD_ROLL]) {
      data[o + c] = clamp(data[o + c], -LIMITS.head, LIMITS.head);
    }
  }
  return { data, n, targets, shrunk };
}


/**
 * The head, rendered at the dancer's own rate.
 *
 * The body has to be phrased because a turn takes most of a phrase to
 * perform. The head does not: a full swing is about 0.4 s, so it can
 * follow the dancer's actual rhythm, and that is what makes the result
 * look like it is listening to the music rather than merely moving
 * slowly.
 *
 * What it cannot do is follow at full AMPLITUDE. So the trade is made
 * explicitly: smooth the signal until the motion is slow enough to be
 * performed at a visible size, then scale whatever is left to sit exactly
 * on the slew cap. A dancer whipping their head around gets a smaller
 * version at the same rhythm, which reads correctly, rather than a
 * clipped version at the wrong one.
 */
export function renderHead(f, calib, tuning, duration, n) {
  const T = { ...DEFAULT_PHRASE_TUNING, ...tuning };
  const mir = T.mirror ? -1 : 1;
  const times = Array.from(f.t);
  const srcDt = f.n > 1
    ? Math.max(1e-3, (times[f.n - 1] - times[0]) / (f.n - 1))
    : TRACK_DT;

  const grid = new Float64Array(n);
  for (let i = 0; i < n; i++) grid[i] = times[0] + i * TRACK_DT;

  const channels = [
    { ch: CH.HEAD_YAW, src: f.headYaw, base: calib.headYaw,
      floor: 0.18, gain: T.gainHead * T.signHeadYaw * mir },
    { ch: CH.HEAD_PITCH, src: f.headPitch, base: calib.headPitch,
      floor: 0.15, gain: T.gainHead * T.signHeadPitch },
    { ch: CH.HEAD_ROLL, src: f.headRoll, base: calib.headRoll,
      floor: 0.12, gain: T.gainHead * T.signHeadRoll * mir },
    { ch: CH.NECK_PITCH, src: f.leanFwd, base: calib.leanFwd,
      floor: 0.12, gain: T.gainLean * T.signNeckPitch },
  ];

  const cap = RATE_BY_CH[CH.HEAD_PITCH];
  const out = {};
  const report = {};
  for (const c of channels) {
    // Centre and normalise against the dancer's own range, then scale to
    // the duck's head limit, exactly as the direct path does.
    const centred = new Float32Array(f.n);
    for (let i = 0; i < f.n; i++) centred[i] = c.src[i] - c.base;
    const range = Math.max(c.floor, percentileAbs(centred, 0.9));
    const wanted = new Float32Array(f.n);
    for (let i = 0; i < f.n; i++) {
      wanted[i] = clamp(centred[i] / range, -1.3, 1.3) * c.gain * LIMITS.head;
      if (!f.tracked[i]) wanted[i] *= 0.2;
    }

    // Smooth until the motion is performable at a decent amplitude, then
    // scale the remainder to fit. Widening the window costs detail but
    // buys amplitude, and past half a second the head stops reading as
    // responsive, so that is where the search stops.
    let win = Math.max(3, Math.round(0.08 / srcDt) | 1);
    const maxWin = Math.max(win, Math.round(0.5 / srcDt) | 1);
    let curve = smoothSeries(wanted, win);
    let scale = fitScale(resampleTo(times, curve, grid), cap);
    while (scale < 0.6 && win < maxWin) {
      win = Math.min(maxWin, win + 2);
      curve = smoothSeries(wanted, win);
      scale = fitScale(resampleTo(times, curve, grid), cap);
    }
    scale = Math.min(1, scale);
    const rendered = resampleTo(times, curve, grid);
    for (let i = 0; i < n; i++) {
      rendered[i] = clamp(rendered[i] * scale, -LIMITS.head, LIMITS.head);
    }
    out[c.ch] = rendered;
    report[c.ch] = { scale, smoothingS: win * srcDt };
  }
  return { channels: out, report };
}

// Largest factor by which a curve can be scaled and still respect the
// per-step slew cap.
function fitScale(curve, cap) {
  let peak = 0;
  for (let i = 1; i < curve.length; i++) {
    const d = Math.abs(curve[i] - curve[i - 1]);
    if (d > peak) peak = d;
  }
  return peak <= 1e-9 ? 1 : cap / peak;
}

// Linear resample of an irregular series onto a uniform grid.
function resampleTo(t, v, grid) {
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

/**
 * The phrased equivalent of retarget(): same track shape, so the player
 * and the timeline cannot tell the two apart.
 */
export function retargetPhrased(f, tuning = {}, beats = []) {
  const T = { ...DEFAULT_PHRASE_TUNING, ...tuning };
  const calib = calibrate(f);
  const t0 = f.t[0] ?? 0;
  const t1 = f.t[f.n - 1] ?? 0;
  const duration = Math.max(0, t1 - t0);

  // Beats arrive in clip time; the grid works in the same frame.
  const grid = phraseGrid(beats, duration);
  const phrases = describePhrases(f, calib, grid);
  const { data, n, targets, shrunk } = synthesisePhrases(phrases, grid, T, duration, beats);

  // Overlay the head, which runs on the dancer's clock rather than the
  // phrase grid.
  const head = renderHead(f, calib, T, duration, n);
  for (const chStr of Object.keys(head.channels)) {
    const ch = Number(chStr);
    const curve = head.channels[ch];
    for (let i = 0; i < n; i++) data[i * NUM_CH + ch] = curve[i];
  }

  const tracked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * TRACK_DT;
    const p = phrases.find((q) => t >= q.t0 && t < q.t1);
    tracked[i] = !p || p.tracked >= 0.5 ? 1 : 0;
  }

  // The whole point of this path is that it fits, so report that rather
  // than a demand the user is expected to act on.
  const worst = measureDemand(data, n);
  return {
    fps: TRACK_FPS, dt: TRACK_DT, t0, duration, n, data, tracked, calib,
    tuning: T, mode: "phrase",
    phrases, grid, targetsShrunk: shrunk, head: head.report,
    fit: {
      demand: worst,
      limitedBy: "phrasing",
      recommendedRate: worst > 1.15 ? 0.75 : 1,
      clippedFraction: 0,
      phrasesPerMinute: duration > 0 ? (phrases.length / duration) * 60 : 0,
      beatsPerPhrase: grid.perPhrase,
      gridSource: grid.source,
    },
  };
}

// How close the finished track comes to the slew caps: 1 means it sits
// exactly on the limit, above 1 would mean the construction failed.
function measureDemand(data, n) {
  let worst = 0;
  for (let c = 0; c < NUM_CH; c++) {
    const cap = RATE_BY_CH[c];
    let peak = 0;
    for (let i = 1; i < n; i++) {
      const d = Math.abs(data[i * NUM_CH + c] - data[(i - 1) * NUM_CH + c]);
      if (d > peak) peak = d;
    }
    worst = Math.max(worst, peak / cap);
  }
  return worst;
}
