// End-to-end checks that need no browser, no video and no MediaPipe.
//
// Runs the synthetic dancer through features -> retarget -> moves, and a
// synthetic click track through the beat analyser, then asserts the parts
// the duck's safety depends on: commands inside the policy's limits, no
// step larger than the slew limiter allows, moves that never overlap, and
// a tempo estimate that finds a known BPM.
//
//   node tools/check-pipeline.mjs

import { synthRoutine, synthPose } from "../src/dance/synth.js";
import { extractFeatures } from "../src/dance/features.js";
import { retarget, calibrate, sampleTrack, CH, NUM_CH, LIMITS, TRACK_FPS } from "../src/dance/retarget.js";
import { detectMoves, OCCUPANCY } from "../src/dance/moves.js";
import { onsetEnvelope, estimateTempo, beatGrid, analyseBuffer } from "../src/dance/beat.js";

let failures = 0;
const results = [];
function ok(label, pass, detail = "") {
  if (!pass) failures++;
  results.push([pass ? "PASS" : "FAIL", label, detail]);
}

// ── Level 1: the command track ─────────────────────────────────────────
const frames = synthRoutine({ duration: 16, fps: 30, bpm: 100 });
const feats = extractFeatures(frames);
ok("synthetic clip tracks throughout",
  Array.from(feats.tracked).every((v) => v === 1),
  `${Array.from(feats.tracked).filter(Boolean).length}/${feats.n} frames`);

const track = retarget(feats);
ok("track runs at the control rate", track.fps === TRACK_FPS, `${track.fps} Hz`);
ok("track covers the clip", Math.abs(track.duration - frames[frames.length - 1].t) < 0.05,
  `${track.duration.toFixed(2)} s`);
ok("track has one row per control step", track.data.length === track.n * NUM_CH);

// Every sample must sit inside the limits the policy was trained for.
{
  let worst = null;
  for (let i = 0; i < track.n; i++) {
    const o = i * NUM_CH;
    const checks = [
      ["vx", track.data[o + CH.VX], LIMITS.vxBack, LIMITS.vxFwd],
      ["vy", track.data[o + CH.VY], -LIMITS.vy, LIMITS.vy],
      ["wz", track.data[o + CH.WZ], -LIMITS.wz, LIMITS.wz],
      ["neck", track.data[o + CH.NECK_PITCH], -LIMITS.head, LIMITS.head],
      ["hpitch", track.data[o + CH.HEAD_PITCH], -LIMITS.head, LIMITS.head],
      ["hyaw", track.data[o + CH.HEAD_YAW], -LIMITS.head, LIMITS.head],
      ["hroll", track.data[o + CH.HEAD_ROLL], -LIMITS.head, LIMITS.head],
    ];
    for (const [name, v, lo, hi] of checks) {
      if (!Number.isFinite(v) || v < lo - 1e-6 || v > hi + 1e-6) worst = `${name}=${v}`;
    }
  }
  ok("every command sample is inside the policy limits", worst === null, worst ?? "");
}

// The slew limiter is what stops a command jump from flooring the duck.
{
  const caps = { [CH.VX]: 0.021, [CH.VY]: 0.016, [CH.WZ]: 0.101,
    [CH.NECK_PITCH]: 0.091, [CH.HEAD_PITCH]: 0.091, [CH.HEAD_YAW]: 0.091,
    [CH.HEAD_ROLL]: 0.091 };
  let worst = 0, worstCh = -1;
  for (let i = 1; i < track.n; i++) {
    for (const c of Object.keys(caps).map(Number)) {
      const d = Math.abs(track.data[i * NUM_CH + c] - track.data[(i - 1) * NUM_CH + c]);
      if (d - caps[c] > worst) { worst = d - caps[c]; worstCh = c; }
    }
  }
  ok("no command step exceeds the slew limit", worst <= 1e-6,
    worst > 1e-6 ? `channel ${worstCh} over by ${worst.toFixed(4)}` : "");
}

// The routine sways and turns, so the duck must actually be commanded to
// move. A track of all zeros would pass every safety check above.
{
  const rng = (c) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < track.n; i++) {
      const v = track.data[i * NUM_CH + c];
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    return hi - lo;
  };
  ok("the duck is asked to turn", rng(CH.WZ) > 0.15, `wz range ${rng(CH.WZ).toFixed(3)}`);
  ok("the duck is asked to sway", rng(CH.VY) > 0.02, `vy range ${rng(CH.VY).toFixed(3)}`);
  ok("the duck is asked to move its head",
    rng(CH.HEAD_YAW) > 0.2 && rng(CH.HEAD_PITCH) > 0.1,
    `yaw ${rng(CH.HEAD_YAW).toFixed(2)}, pitch ${rng(CH.HEAD_PITCH).toFixed(2)}`);
}

// Sampling: the player reads the track by time, so out-of-range times
// must clamp rather than produce garbage.
{
  const out = new Float32Array(NUM_CH);
  sampleTrack(track, -5, out);
  const headOk = Array.from(out).every(Number.isFinite);
  sampleTrack(track, 1e6, out);
  const tailOk = Array.from(out).every(Number.isFinite);
  ok("sampling clamps outside the clip", headOk && tailOk);

  sampleTrack(track, 4.0, out);
  const mid = Array.from(out);
  sampleTrack(track, 4.0 + 1e-9, out);
  ok("sampling is continuous in time",
    mid.every((v, i) => Math.abs(v - out[i]) < 1e-5));
}

// A dancer that never moves must produce a duck that never moves. The
// per-clip normalisation divides by the dancer's own range, so this is
// exactly where a missing floor would amplify noise into a seizure.
{
  const still = [];
  for (let i = 0; i < 200; i++) still.push({ t: i / 30, ...synthPose() });
  const t2 = retarget(extractFeatures(still));
  let maxAbs = 0;
  for (let i = 0; i < t2.data.length; i++) maxAbs = Math.max(maxAbs, Math.abs(t2.data[i]));
  ok("a motionless dancer leaves the duck still", maxAbs < 0.02, `max |cmd| ${maxAbs.toFixed(4)}`);
}

// Mirroring must flip the sideways channels and leave the forward one be.
{
  const m = retarget(feats, { mirror: true });
  let flipped = 0, same = 0;
  for (let i = 0; i < Math.min(track.n, m.n); i++) {
    const a = track.data[i * NUM_CH + CH.WZ], b = m.data[i * NUM_CH + CH.WZ];
    if (Math.abs(a) > 0.05) (Math.sign(a) !== Math.sign(b) ? flipped++ : same++);
  }
  ok("mirror flips the turn direction", flipped > same * 4, `${flipped} flipped, ${same} same`);
}

// ── Level 2: moves ─────────────────────────────────────────────────────
const calib = calibrate(feats);
const { events, rejected } = detectMoves(feats, calib, { sensitivity: 1.0 }, []);
ok("the routine yields moves", events.length > 0, `${events.length} events, ${rejected.length} rejected`);

{
  let overlap = null;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    if (events[i].t < prev.t + (OCCUPANCY[prev.type] ?? 1) - 1e-6) {
      overlap = `${prev.type}@${prev.t.toFixed(2)} -> ${events[i].type}@${events[i].t.toFixed(2)}`;
    }
  }
  ok("no move starts while the duck is still busy", overlap === null, overlap ?? "");
}

{
  // Sit and stand must pair up, or the duck is left sitting.
  let sitting = false, bad = null;
  for (const e of events) {
    if (e.type === "sit") { if (sitting) bad = "double sit"; sitting = true; }
    if (e.type === "stand") { if (!sitting) bad = "stand without sit"; sitting = false; }
  }
  if (sitting) bad = "clip ends sitting";
  ok("sit and stand are balanced", bad === null, bad ?? "");
}

{
  const still = [];
  for (let i = 0; i < 200; i++) still.push({ t: i / 30, ...synthPose() });
  const sf = extractFeatures(still);
  const r = detectMoves(sf, calibrate(sf), {}, []);
  ok("a motionless dancer triggers no moves", r.events.length === 0,
    `${r.events.length} events`);
}

{
  // Beat quantisation must snap nearby moves and leave distant ones alone.
  const beats = [];
  for (let t = 0; t < 16; t += 0.6) beats.push(t);
  const q = detectMoves(feats, calib, { quantise: true, quantiseWindow: 0.14 }, beats);
  const snapped = q.events.filter((e) => e.quantised);
  const offGrid = snapped.filter((e) => Math.min(...beats.map((b) => Math.abs(b - e.t))) > 1e-6);
  ok("quantised moves land exactly on a beat", offGrid.length === 0,
    `${snapped.length}/${q.events.length} snapped`);
  const moved = snapped.filter((e) => Math.abs(e.t - e.tRaw) > 0.14 + 1e-6);
  ok("quantisation never moves a beat further than its window", moved.length === 0);
}

// ── Beat analysis ──────────────────────────────────────────────────────
{
  // A synthetic click track at a known tempo: short noise bursts with an
  // exponential decay, which is what a percussive onset looks like.
  const sr = 22050, bpm = 128, dur = 12;
  const n = sr * dur;
  const sig = new Float32Array(n);
  const period = (60 / bpm) * sr;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let b = 0; b * period < n; b++) {
    const start = Math.round(b * period);
    for (let i = 0; i < 900 && start + i < n; i++) {
      sig[start + i] += rnd() * Math.exp(-i / 180);
    }
  }
  for (let i = 0; i < n; i++) sig[i] += 0.02 * Math.sin((2 * Math.PI * 110 * i) / sr);

  const { env, rate } = onsetEnvelope(sig, sr);
  ok("onset envelope is produced", env.length > 100, `${env.length} frames at ${rate.toFixed(1)} Hz`);
  const { bpm: got, confidence } = estimateTempo(env, rate);
  ok("tempo lands on the click track", Math.abs(got - bpm) < 3,
    `got ${got.toFixed(1)} BPM (confidence ${confidence.toFixed(2)})`);

  const beats = beatGrid(env, rate, got, dur);
  ok("beat grid spans the clip", beats.length > dur * (bpm / 60) - 3, `${beats.length} beats`);
  // Every true click should have a grid beat close to it.
  let worst = 0;
  for (let b = 1; b * (60 / bpm) < dur - 1; b++) {
    const truth = b * (60 / bpm);
    const d = Math.min(...beats.map((x) => Math.abs(x - truth)));
    worst = Math.max(worst, d);
  }
  ok("grid beats align with the clicks", worst < 0.06, `worst offset ${(worst * 1000).toFixed(0)} ms`);

  // The AudioBuffer-shaped wrapper must agree with the raw path.
  const fake = { sampleRate: sr, length: n, duration: dur, numberOfChannels: 1,
    getChannelData: () => sig };
  const a = analyseBuffer(fake);
  ok("buffer wrapper agrees with the raw analysis", Math.abs(a.bpm - got) < 0.01);
}

// Silence must not invent a tempo grid we would then quantise to.
{
  const sr = 22050, n = sr * 5;
  const sig = new Float32Array(n);
  const { env, rate } = onsetEnvelope(sig, sr);
  const { bpm } = estimateTempo(env, rate);
  const beats = beatGrid(env, rate, bpm, 5);
  ok("silence produces no onsets", Array.from(env).every((v) => v === 0));
  ok("silence produces no beat grid", beats.length === 0 && bpm === 0,
    `${beats.length} beats, ${bpm} BPM`);
}

const w = Math.max(...results.map((r) => r[1].length));
for (const [st, label, detail] of results) {
  console.log(`${st}  ${label.padEnd(w)}  ${detail}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
