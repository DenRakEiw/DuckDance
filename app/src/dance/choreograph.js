// Choreography from music alone.
//
// The video path asks "what did the dancer do, and what of that can the
// duck manage". This one asks the opposite question: "what can the duck
// do, and which of it fits this music". It never needs a camera, a
// dancer, or a pose model, and it cannot fail the way tracking fails.
//
// The case for it is arithmetic. A command channel needs about 0.4 s for
// a full swing and a beat at 125 BPM lasts 0.48 s, so whatever the input,
// the duck performs roughly one gesture per beat and a handful of
// distinct targets per bar. That is a few hundred numbers for a whole
// song. A human dancer is a very expensive way to produce a few hundred
// numbers, and every one of them arrives blurred by tracking noise.
//
// Three ideas carry the result.
//
// BARS, NOT FRAMES. Everything is authored on the bar grid from beat.js,
// so a figure begins on the one. Landing on the beat is most of what
// makes movement read as dancing rather than as drift.
//
// REPETITION, THEN CHANGE. A motif of two or four bars repeats through a
// section and is replaced at the section boundary. This is the single
// rule that separates choreography from a random walk: an audience reads
// a repeated figure as intent, and reads a figure that never repeats as
// noise. Songs already tell us where to change, so we change there.
//
// FIT BY CONSTRUCTION. Every target is checked against the slew budget
// before it is committed, exactly as phrase.js does it: a smoothstep's
// peak slope is a known 1.5x its average, so a gesture that will not fit
// in the time available is shrunk until it does. The duck performs a
// smaller COMPLETE movement rather than a larger one cut off halfway.

import { CH, NUM_CH, TRACK_FPS, TRACK_DT, LIMITS } from "./retarget.js";
import { OCCUPANCY, scheduleCandidates } from "./moves.js";
import { clamp } from "./math.js";

// Same per-step slew caps the other paths respect.
const RATE = { vx: 0.02, vy: 0.015, wz: 0.10, head: 0.09 };
const RATE_BY_CH = {
  [CH.VX]: RATE.vx, [CH.VY]: RATE.vy, [CH.WZ]: RATE.wz,
  [CH.NECK_PITCH]: RATE.head, [CH.HEAD_PITCH]: RATE.head,
  [CH.HEAD_YAW]: RATE.head, [CH.HEAD_ROLL]: RATE.head,
};

export const DEFAULT_MUSIC_TUNING = {
  gainBody: 1.0,       // scales every twist target
  gainHead: 1.0,       // scales every head target
  intensity: 1.0,      // overall size, before the per-section dynamics
  variation: 1.0,      // how readily the routine swaps figures; 0 = one motif
  // Holding a twist near the policy limit is what puts the duck on the
  // floor, so sustained targets are capped below it. The number is the
  // one phrase.js arrived at the hard way.
  sustainedCeiling: 0.8,
  // Share of a gap spent holding rather than moving. Every point of
  // this is transition time taken away from the fit budget, which on a
  // beat-rate figure is what decides its amplitude.
  holdBody: 0.2,
  holdHead: 0.15,      // the head is nearly always moving
  // Off by default, and the number that decided it: with kicks scheduled
  // on the loud accents, a 40 s test routine put the duck on the floor at
  // 25.5 s, 0.2 s after the first kick, and again at every kick after
  // that. The identical routine with this false ran the full 40 s with
  // the trunk never leaving upright (worst 0.998 of vertical) and no
  // drift. Upstream calls its kicks blind one-shot boots and they take
  // no account of the gait they interrupt. A routine that stays on its
  // feet is worth more than one with accents in it, so this is opt-in.
  enableSkills: false,
  seed: 1,             // same song, same routine
};

// ── The move library ───────────────────────────────────────────────────
//
// A figure is a function of the bar: it returns targets as
// { beat, ch, v }, where `beat` is a position in the bar (0 = the one,
// fractions allowed) and v is -1..1, meaning "this share of the channel's
// usable range". Nothing here knows about seconds, limits or slew: that
// is the renderer's job, which is what lets a figure be written for how
// it looks rather than for whether it fits.
//
// `energy` is what the figure asks of the duck, used to match figures to
// how loud the section is. `travel` marks the ones that move the duck
// across the floor rather than turning or swaying on the spot.
//
// TWO MEASURED FACTS DECIDE EVERYTHING BELOW. Both come from driving the
// sim directly with a held command and watching the ankle bodies:
//
//   vx 0.12, 0.16, 0.19  ->  foot lift 0.0 mm, 1 cm of travel: a lean
//   vx 0.21              ->  foot lift  18 mm, 13 cm: STEPPING
//   vx 0.25              ->  foot lift  19 mm, 29 cm
//   vy 0.15, the limit   ->  foot lift 0.1 mm,  4 mm: a lean
//
// So the gait has a THRESHOLD at about 0.20 m/s forward, and sideways
// the duck NEVER steps, at any value the policy allows. Every bit of
// visible footwork has to come from vx, above 0.20, held long enough to
// take a step. vy is a lean and nothing more; it is still worth having,
// because a lean on the beat reads, but it will never be the weight
// shift from one leg to the other that it looks like on paper.

const BODY = [
  {
    name: "settle", energy: 0.12, travel: false,
    // The quiet one. Still a weight change every half bar, because a
    // body that does NOTHING is not contrast, it is a duck standing
    // there while its head wobbles.
    figure: (b) => [
      { beat: 0, ch: CH.VY, v: b.flip * 0.55 },
      { beat: 2, ch: CH.VY, v: -b.flip * 0.55 },
    ],
  },
  {
    name: "sway", energy: 0.3, travel: false,
    // One full swing per bar, so it gets the whole half bar to build
    // amplitude in and reads as a big lean from foot to foot.
    figure: (b) => [
      { beat: 0, ch: CH.VY, v: b.flip },
      { beat: 2, ch: CH.VY, v: -b.flip },
    ],
  },
  {
    name: "weightShift", energy: 0.4, travel: false,
    // Foot to foot ON THE BEAT. Half a beat of transition is not enough
    // for a full sideways swing, so the renderer shrinks this to about
    // two thirds; that is the trade, and it is worth it because the
    // policy answers an alternating sideways command by stepping.
    figure: (b) => [
      { beat: 0, ch: CH.VY, v: b.flip },
      { beat: 1, ch: CH.VY, v: -b.flip },
      { beat: 2, ch: CH.VY, v: b.flip },
      { beat: 3, ch: CH.VY, v: -b.flip },
    ],
  },
  {
    name: "pivot", energy: 0.45, travel: false,
    figure: (b) => [
      { beat: 0, ch: CH.WZ, v: b.flip * 0.9 },
      { beat: 2, ch: CH.WZ, v: -b.flip * 0.9 },
    ],
  },
  {
    name: "step", energy: 0.5, travel: true,
    // A step out and a step back, one every two beats.
    //
    // Half-bar rather than per-beat, and that is forced rather than
    // chosen: swinging vx from one limit to the other is a change of
    // 0.45, and a single beat only affords 0.25 of it, so a per-beat
    // version got shrunk to a fifth of full and never left the ground.
    // Two beats affords 0.5, so this one arrives at full size.
    figure: () => [
      { beat: 0, ch: CH.VX, v: 1 },
      { beat: 2, ch: CH.VX, v: -1 },
    ],
  },
  {
    name: "walk", energy: 0.36, travel: true,
    // The only figure that actually WALKS, and the shape is dictated by
    // the gait threshold rather than by taste.
    //
    // The policy needs about 0.22 m/s before it unweights a foot, and a
    // channel needs 0.375 s of transition to climb from rest to the 0.25
    // limit. So this brings its own run-up: it forces the channel to zero
    // on the bar line, spends a beat getting to full speed, HOLDS there
    // for two beats, and spends the last beat stopping. Two beats at the
    // limit is about 23 cm of travel, which is several steps.
    //
    // Written as one target per beat because the earlier version, a
    // single target at the bar line, could not clear the threshold: a
    // beat-rate figure in the bar before it left vx at the opposite
    // limit, and the fit pass then shrank the step to a fifth of what
    // was asked for. A figure that starts from rest cannot be poisoned
    // by its neighbour.
    figure: (b) => [
      { beat: 0, ch: CH.VX, v: b.flip2 },
      { beat: 1, ch: CH.VX, v: b.flip2 },
      { beat: 3, ch: CH.VX, v: b.flip2 },
      { beat: 4, ch: CH.VX, v: b.flip2 },
    ],
  },
  {
    name: "stepSway", energy: 0.6, travel: true,
    figure: (b) => [
      { beat: 0, ch: CH.VX, v: 1 },
      { beat: 1, ch: CH.VY, v: b.flip },
      { beat: 2, ch: CH.VX, v: -1 },
      { beat: 3, ch: CH.VY, v: -b.flip },
    ],
  },
  {
    name: "swayTurn", energy: 0.7, travel: false,
    figure: (b) => [
      { beat: 0, ch: CH.VY, v: b.flip },
      { beat: 1, ch: CH.WZ, v: b.flip * 0.8 },
      { beat: 2, ch: CH.VY, v: -b.flip },
      { beat: 3, ch: CH.WZ, v: -b.flip * 0.8 },
    ],
  },
  {
    name: "boxStep", energy: 0.75, travel: true,
    // Forward, across, back, across: the duck traces a box and ends
    // where it began.
    figure: (b) => [
      { beat: 0, ch: CH.VX, v: 1 },
      { beat: 1, ch: CH.VY, v: b.flip },
      { beat: 2, ch: CH.VX, v: -1 },
      { beat: 3, ch: CH.VY, v: -b.flip },
    ],
  },
  {
    name: "shuffle", energy: 0.85, travel: true,
    figure: (b) => [
      { beat: 0, ch: CH.VX, v: 1 },
      { beat: 0, ch: CH.VY, v: b.flip },
      { beat: 1, ch: CH.VY, v: -b.flip },
      { beat: 2, ch: CH.VX, v: -1 },
      { beat: 2, ch: CH.VY, v: b.flip },
      { beat: 3, ch: CH.VY, v: -b.flip },
    ],
  },
  {
    name: "spin", energy: 0.95, travel: false,
    // A held turn: the one figure that keeps a channel near its ceiling,
    // which is why it is priced as the most expensive thing here and
    // only ever appears in a peak section.
    figure: (b) => [
      { beat: 0, ch: CH.WZ, v: b.flip },
      { beat: 3, ch: CH.WZ, v: b.flip },
      { beat: 4, ch: CH.WZ, v: 0 },
    ],
  },
];

const HEAD = [
  {
    name: "still", energy: 0,
    figure: () => [],
  },
  {
    name: "nod", energy: 0.4,
    // The bob every listener does. Chin down on the beat, up between.
    figure: () => [
      { beat: 0, ch: CH.HEAD_PITCH, v: -0.8 },
      { beat: 1, ch: CH.HEAD_PITCH, v: 0.5 },
      { beat: 2, ch: CH.HEAD_PITCH, v: -0.8 },
      { beat: 3, ch: CH.HEAD_PITCH, v: 0.5 },
    ],
  },
  {
    name: "nodDeep", energy: 0.7,
    // Neck and head together reads as a whole-body bob on a robot with no
    // spine to bend.
    figure: () => [
      { beat: 0, ch: CH.HEAD_PITCH, v: -1 },
      { beat: 0, ch: CH.NECK_PITCH, v: -0.7 },
      { beat: 2, ch: CH.HEAD_PITCH, v: 0.6 },
      { beat: 2, ch: CH.NECK_PITCH, v: 0.5 },
    ],
  },
  {
    name: "lookAcross", energy: 0.5,
    figure: (b) => [
      { beat: 0, ch: CH.HEAD_YAW, v: b.flip },
      { beat: 2, ch: CH.HEAD_YAW, v: -b.flip },
    ],
  },
  {
    name: "scan", energy: 0.65,
    figure: (b) => [
      { beat: 0, ch: CH.HEAD_YAW, v: b.flip },
      { beat: 1, ch: CH.HEAD_YAW, v: 0 },
      { beat: 2, ch: CH.HEAD_YAW, v: -b.flip },
      { beat: 3, ch: CH.HEAD_YAW, v: 0 },
    ],
  },
  {
    name: "tilt", energy: 0.45,
    figure: (b) => [
      { beat: 0, ch: CH.HEAD_ROLL, v: b.flip },
      { beat: 2, ch: CH.HEAD_ROLL, v: -b.flip },
    ],
  },
  {
    name: "tiltNod", energy: 0.8,
    figure: (b) => [
      { beat: 0, ch: CH.HEAD_ROLL, v: b.flip },
      { beat: 0, ch: CH.HEAD_PITCH, v: -0.7 },
      { beat: 2, ch: CH.HEAD_ROLL, v: -b.flip },
      { beat: 2, ch: CH.HEAD_PITCH, v: 0.5 },
    ],
  },
];

// Deterministic RNG. The same song must produce the same routine, or a
// tuning slider becomes impossible to judge and a test impossible to
// write.
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick the figure whose appetite best matches how loud it is here, from
// the few nearest candidates rather than the single best one, so two
// sections at the same level do not get identical choreography.
function pick(list, want, rand, spread) {
  const scored = list
    .map((m) => ({ m, d: Math.abs(m.energy - want) }))
    .sort((a, b) => a.d - b.d);
  const width = Math.max(1, Math.round(1 + spread * 2));
  return scored[Math.floor(rand() * Math.min(width, scored.length))].m;
}

/**
 * Choose the figures for one section.
 *
 * A motif is four bars long where the section is long enough to state it
 * twice, two bars otherwise. The last bar of every second repeat is a
 * fill: a busier body figure, which is what stops a long chorus reading
 * as a loop even though it very nearly is one.
 */
function planSection(sec, bars, T, rand) {
  const nBars = sec.i1 - sec.i0;
  // The floor matters more than the ceiling. At 0.2 the nearest figure
  // to a quiet section was whatever did least, and a routine that opens
  // with four bars of nothing is the one people judge the whole thing by.
  const want = 0.35 + sec.level * 0.55;
  const motifLen = nBars >= 8 ? 4 : 2;
  const spread = T.variation;

  const motif = [];
  for (let i = 0; i < motifLen; i++) {
    motif.push({
      body: pick(BODY, want * (i === motifLen - 1 ? 1.1 : 1), rand, spread),
      head: pick(HEAD, want * 0.9 + 0.15, rand, spread),
    });
  }
  // Every motif must contain at least one figure that clears the gait
  // threshold, or the section has no footwork in it at all. Left to
  // chance, three seeds out of five picked nothing that travels and the
  // duck spent the whole song leaning: which is exactly the complaint
  // this library was rewritten to answer.
  if (!motif.some((m) => m.body.travel)) {
    const travellers = BODY.filter((m) => m.travel);
    const at = Math.floor(rand() * motif.length);
    motif[at].body = pick(travellers, want, rand, spread);
  }

  const fill = pick(BODY, Math.min(1, want + 0.3), rand, spread);

  const plan = [];
  for (let k = 0; k < nBars; k++) {
    const bar = bars[sec.i0 + k];
    const slot = motif[k % motifLen];
    const isFill = motifLen === 4 && k % 8 === 7;
    // The duck alternates which way a figure goes, so a sway is a sway
    // rather than a drift and a pivot comes back.
    const flip = (k & 1) ? -1 : 1;
    // A slower alternation for figures that need to hold one direction
    // longer than a bar. Two bars out, two back: still balanced, but the
    // hold is twice as long, which is what gets a walk over the gait
    // threshold for long enough to be several steps rather than one.
    const flip2 = (k & 2) ? -1 : 1;
    plan.push({
      bar, section: sec, flip, flip2,
      body: isFill ? fill : slot.body,
      head: slot.head,
      // Loud bars inside a section get more than quiet ones, so the
      // routine breathes with the music instead of running flat out.
      // The velocity policy absorbs a small command with a lean and only
      // STEPS above a certain size, so a quiet section asking for half
      // amplitude got no footwork at all. Quiet now means 0.75, not 0.55.
      size: clamp(0.75 + 0.25 * sec.level, 0.5, 1) *
            clamp(0.85 + 0.4 * (bar.onset + bar.low) / 2, 0.7, 1.25),
    });
  }
  return plan;
}

// Normalised target -> command units. vx is the one asymmetric channel:
// the policy walks forward faster than it backs up.
function scaleFor(ch, v) {
  switch (ch) {
    // The full asymmetric range, forward faster than back, because the
    // policy has a GAIT THRESHOLD and the top of the range is on the far
    // side of it. Measured against the sandbox's own keyboard: a held
    // 0.25 walks the duck 0.31 m in 3 s and lifts a foot 18 mm; a held
    // 0.20 moves it 11 mm and never unweights a foot. Capping vx
    // symmetrically to kill drift bought balance at the price of every
    // step, which was the wrong half of the trade. The drift is dealt
    // with properly by the zero-mean pass in render().
    case CH.VX: return v >= 0 ? v * LIMITS.vxFwd : v * Math.abs(LIMITS.vxBack);
    case CH.VY: return v * LIMITS.vy;
    case CH.WZ: return v * LIMITS.wz;
    default: return v * LIMITS.head;
  }
}

// Largest change a smoothstep can carry in `dur` seconds without breaking
// the slew cap. Peak slope is 1.5x the average, hence the divisor.
function maxDelta(ch, dur) {
  return (RATE_BY_CH[ch] / TRACK_DT) * Math.max(dur, TRACK_DT) / 1.5;
}

/**
 * Turn a plan into a track.
 *
 * Per channel: a list of timed targets, each shrunk toward its
 * predecessor if the step between them will not fit, then rendered as
 * hold-and-smoothstep. Channels a bar does not use are commanded back to
 * neutral at the bar line, so nothing is left leaning from a figure that
 * has finished.
 */
function render(plan, duration, T) {
  const n = Math.max(1, Math.round(duration * TRACK_FPS) + 1);
  const data = new Float32Array(n * NUM_CH);
  const keys = {};
  for (let c = 0; c < NUM_CH; c++) keys[c] = [{ t: 0, v: 0 }];

  const bodyCh = new Set([CH.VX, CH.VY, CH.WZ]);
  let shrunk = 0;

  for (const step of plan) {
    const { bar, flip } = step;
    void flip;
    const beatDur = (bar.t1 - bar.t0) / Math.max(1, bar.beats.length);
    const ctx = { flip, flip2: step.flip2, bar };
    const targets = [
      ...step.body.figure(ctx).map((x) => ({ ...x, body: true })),
      ...step.head.figure(ctx).map((x) => ({ ...x, body: false })),
    ];
    const used = new Set(targets.map((x) => x.ch));
    // Anything this bar leaves alone returns to neutral on the bar line.
    for (let c = 0; c < NUM_CH; c++) {
      if (!used.has(c)) keys[c].push({ t: bar.t0, v: 0 });
    }
    for (const x of targets) {
      const gain = x.body ? T.gainBody : T.gainHead;
      // The ceiling exists because HOLDING A TURN near the policy limit
      // puts the duck on the floor. Sideways and forward velocity carry
      // no such risk, and capping them was quietly costing the footwork
      // a fifth of its size for nothing.
      const ceil = x.ch === CH.WZ ? T.sustainedCeiling : 1;
      // Forward travel does not scale with the section.
      //
      // The gait has a THRESHOLD: below about 0.22 m/s the policy holds
      // both feet down and leans instead of stepping. So the usual
      // dynamics, which shrink a quiet section to 65% of full size, do
      // not make a smaller walk there - they make no walk at all, which
      // is exactly what the duck was doing. Musical light and shade has
      // to come from WHICH figures are chosen and how often, not from
      // scaling a step down through the floor of what the legs can do.
      const size = x.ch === CH.VX ? Math.max(step.size, 0.95) : step.size;
      const norm = clamp(x.v * size * T.intensity * gain, -ceil, ceil);
      keys[x.ch].push({ t: bar.t0 + x.beat * beatDur, v: scaleFor(x.ch, norm) });
    }
  }

  for (let c = 0; c < NUM_CH; c++) {
    const k = keys[c].sort((a, b) => a.t - b.t);
    const hold = bodyCh.has(c) ? T.holdBody : T.holdHead;
    // Fit pass: a destination that cannot be reached in the time available
    // is pulled back toward where the channel already is.
    for (let i = 1; i < k.length; i++) {
      const gap = Math.max(TRACK_DT, k[i].t - k[i - 1].t) * (1 - hold);
      const cap = maxDelta(c, gap);
      const d = k[i].v - k[i - 1].v;
      if (Math.abs(d) > cap) {
        k[i].v = k[i - 1].v + Math.sign(d) * cap;
        shrunk++;
      }
    }
    // Render: hold, then smoothstep to the next target.
    const smooth = (u) => u * u * (3 - 2 * u);
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const t = i * TRACK_DT;
      while (seg + 1 < k.length && t >= k[seg + 1].t) seg++;
      const a = k[seg];
      const b = k[seg + 1];
      let v;
      if (!b) v = a.v;
      else {
        const span = Math.max(1e-6, b.t - a.t);
        const u = clamp((t - a.t) / span, 0, 1);
        v = u <= hold ? a.v : a.v + (b.v - a.v) * smooth((u - hold) / (1 - hold));
      }
      data[i * NUM_CH + c] = v;
    }
  }

  // Zero the mean of the travel channels.
  //
  // vx and vy are VELOCITIES, so their mean over the routine is exactly
  // the speed at which the duck leaves the stage. Figures are written to
  // balance out within a bar, but the fit pass breaks that: it shrinks a
  // target toward its predecessor, which always biases the channel in
  // the direction it is already going. Measured, that left a metre of
  // creep in 48 s, four metres over a song, and the duck ends up in a
  // wall.
  //
  // Subtracting the mean is free where any other correction is not: a
  // constant has zero slope, so it cannot cost a single step of the slew
  // budget, and it leaves the shape of every gesture untouched.
  for (const c of [CH.VX, CH.VY]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i * NUM_CH + c];
    const mean = sum / n;
    const lo = c === CH.VX ? LIMITS.vxBack : -LIMITS.vy;
    const hi = c === CH.VX ? LIMITS.vxFwd : LIMITS.vy;
    for (let i = 0; i < n; i++) {
      data[i * NUM_CH + c] = clamp(data[i * NUM_CH + c] - mean, lo, hi);
    }
  }
  return { data, n, shrunk };
}

// A song with no detectable beat still deserves a routine, so the bar
// grid is invented at a plausible tempo rather than the whole thing
// failing. It will not be ON anything, but it will not be still either.
function fallbackBars(duration, bpm = 100) {
  const beat = 60 / bpm;
  const bars = [];
  for (let t = 0; t + beat * 4 <= duration; t += beat * 4) {
    bars.push({
      index: bars.length, t0: t, t1: t + beat * 4,
      beats: [t, t + beat, t + 2 * beat, t + 3 * beat],
      low: 0.5, mid: 0.5, high: 0.5, onset: 0.5,
    });
  }
  return bars;
}

/**
 * Propose skills where the music asks for them.
 *
 * A kick belongs on a hit that is already loud, in a part of the song
 * that is already big; a bow belongs at the end of a quiet section, where
 * there is room for it. Candidates only: the shared scheduler decides
 * what the duck actually has time for.
 */
function skillCandidates(music, plan, T) {
  const out = [];
  if (!T.enableSkills) return out;
  const { salience, beats } = music;
  const bySection = new Map();
  for (const step of plan) bySection.set(step.bar.index, step.section);

  for (let i = 0; i < beats.length; i++) {
    const s = salience[i] ?? 0;
    if (s < 0.55) continue;
    const bar = plan.find((p) => beats[i] >= p.bar.t0 && beats[i] < p.bar.t1);
    if (!bar || bar.section.level < 0.5) continue;
    // On the one or the three: a kick on an off-beat reads as a stumble.
    const inBar = bar.bar.beats.findIndex((b) => Math.abs(b - beats[i]) < 1e-6);
    if (inBar !== 0 && inBar !== 2) continue;
    // Alternate feet across the candidates that survive the filters, not
    // across the beat index: only beats one and three ever get here, so
    // indexing by beat gave a routine that kicked with the same leg all
    // the way through.
    out.push({
      t: beats[i], type: out.length % 2 ? "kickR" : "kickL",
      strength: s, rule: "loud accent in a big section", quantised: true,
    });
  }

  for (const step of plan) {
    if (step.section.kind !== "calm") continue;
    if (step.bar.index !== step.section.i1 - 1) continue;
    out.push({
      t: step.bar.t0, type: "pick",
      strength: 0.8, rule: "bow at the end of a quiet section", quantised: true,
    });
  }
  void bySection;
  void OCCUPANCY;
  return out;
}

/**
 * Build a routine from a music analysis.
 *
 * @param {object} music   from beat.js analyseMusic()
 * @param {object} tuning  DEFAULT_MUSIC_TUNING overrides
 * @param {object} moveTuning  passed to the shared skill scheduler
 * @returns {{track:object, events:Array, rejected:Array, plan:Array}}
 */
export function choreograph(music, tuning = {}, moveTuning = {}) {
  const T = { ...DEFAULT_MUSIC_TUNING, ...tuning };
  const duration = music?.duration ?? 0;
  const bars = music?.bars?.length ? music.bars : fallbackBars(duration, music?.bpm || 100);
  const secs = bars === music?.bars && music.sections?.length
    ? music.sections
    : [{ index: 0, i0: 0, i1: bars.length, t0: bars[0]?.t0 ?? 0,
         t1: bars[bars.length - 1]?.t1 ?? duration, energy: 0, level: 0.5, kind: "groove" }];

  const rand = rng(T.seed + Math.round((music?.bpm ?? 0) * 100));
  const plan = [];
  for (const sec of secs) plan.push(...planSection(sec, bars, T, rand));

  const { data, n, shrunk } = render(plan, duration, T);
  const tracked = new Uint8Array(n).fill(1);

  const cands = skillCandidates(music ?? {}, plan, T);
  const { events, rejected } = scheduleCandidates(cands, duration, moveTuning);
  // Feet are assigned after scheduling, not before it. The scheduler
  // drops whatever does not fit the budget, and dropping every other
  // candidate from an alternating list leaves the duck kicking with the
  // same leg all night.
  let foot = 0;
  for (const e of events) {
    if (e.type === "kickL" || e.type === "kickR") {
      e.type = foot++ % 2 ? "kickR" : "kickL";
    }
  }

  const track = {
    fps: TRACK_FPS, dt: TRACK_DT, t0: 0, duration, n, data, tracked,
    calib: null, tuning: T, mode: "music",
    plan, sections: secs, bars,
    fit: {
      demand: measureDemand(data, n),
      limitedBy: "music",
      recommendedRate: 1,
      clippedFraction: 0,
      targetsShrunk: shrunk,
      barsPerMinute: duration > 0 ? (bars.length / duration) * 60 : 0,
      sections: secs.length,
      gridSource: bars === music?.bars ? "beats" : "invented",
    },
  };
  return { track, events, rejected, plan };
}

// Largest fraction of a channel's slew budget the track actually asks
// for. Anything at or below 1 needs no limiting at playback.
export function measureDemand(data, n) {
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
