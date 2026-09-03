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
import { retarget, calibrate, sampleTrack, CH, NUM_CH, LIMITS, TRACK_FPS, TRACK_DT } from "../src/dance/retarget.js";
import { detectMoves, OCCUPANCY } from "../src/dance/moves.js";
import { retargetPhrased, phraseGrid } from "../src/dance/phrase.js";
import { onsetEnvelope, estimateTempo, beatGrid, analyseBuffer } from "../src/dance/beat.js";
import { stampClock } from "../src/dance/stamp.js";
import { analyseMusic } from "../src/dance/beat.js";
import { choreograph } from "../src/dance/choreograph.js";

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

// Followability: the report that tells the user to slow the clip down.
{
  ok("the track reports how well the duck can follow", !!track.fit,
    track.fit ? `${track.fit.demand.toFixed(2)}x, limited by ${track.fit.limitedBy}` : "");

  // A dancer moving at half the tempo demands roughly half the slew rate,
  // so the recommendation must move the right way. This is the property
  // the speed control rests on.
  const fast = retarget(extractFeatures(synthRoutine({ duration: 12, fps: 30, bpm: 150 })));
  const slow = retarget(extractFeatures(synthRoutine({ duration: 12, fps: 30, bpm: 60 })));
  ok("a faster dancer demands more of the duck", fast.fit.demand > slow.fit.demand,
    `${fast.fit.demand.toFixed(2)}x at 150 BPM vs ${slow.fit.demand.toFixed(2)}x at 60 BPM`);
  ok("the faster dancer is told to slow down at least as much",
    fast.fit.recommendedRate <= slow.fit.recommendedRate,
    `${fast.fit.recommendedRate}x vs ${slow.fit.recommendedRate}x`);
  ok("recommended rates stay in a usable range",
    [fast, slow].every((t) => t.fit.recommendedRate > 0.3 && t.fit.recommendedRate <= 1));

  // A motionless dancer asks nothing of the duck and must not be slowed.
  const still = [];
  for (let i = 0; i < 200; i++) still.push({ t: i / 30, ...synthPose() });
  const s2 = retarget(extractFeatures(still));
  ok("a motionless dancer needs no slowdown", s2.fit.recommendedRate === 1,
    `${s2.fit.recommendedRate}x`);
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

// ── Phrased retargeting ────────────────────────────────────────────────
// The whole claim of this path is that it produces a command the duck can
// perform without anything being discarded. That is a property, not a
// preference, so it gets tested as one.
{
  const bpm = 125.7;
  const fastFrames = synthRoutine({ duration: 20, fps: 30, bpm });
  const ff = extractFeatures(fastFrames);
  const beatList = [];
  for (let t = 0; t < 20; t += 60 / bpm) beatList.push(t);
  const ph = retargetPhrased(ff, {}, beatList);

  ok("phrased track has the same shape as the direct one",
    ph.n === ph.data.length / NUM_CH && ph.fps === TRACK_FPS && !!ph.calib);

  // The defining property: never asks for more slew than the duck has.
  const caps = { [CH.VX]: 0.02, [CH.VY]: 0.015, [CH.WZ]: 0.10,
    [CH.NECK_PITCH]: 0.09, [CH.HEAD_PITCH]: 0.09,
    [CH.HEAD_YAW]: 0.09, [CH.HEAD_ROLL]: 0.09 };
  let worst = 0, worstCh = -1;
  for (let i = 1; i < ph.n; i++) {
    for (const c of Object.keys(caps).map(Number)) {
      const d = Math.abs(ph.data[i * NUM_CH + c] - ph.data[(i - 1) * NUM_CH + c]) / caps[c];
      if (d > worst) { worst = d; worstCh = c; }
    }
  }
  ok("phrased output never exceeds the duck's slew limits", worst <= 1.001,
    `worst ${worst.toFixed(3)}x on channel ${worstCh}`);

  const direct = retarget(ff);
  ok("the direct path on the same clip does not fit", direct.fit.demand > 1.2,
    `${direct.fit.demand.toFixed(2)}x, ${(direct.fit.clippedFraction * 100).toFixed(0)}% of steps clipped`);

  // Every channel must still carry the dance. A track that fits by being
  // silent would pass the check above.
  const rng = (t, c) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < t.n; i++) {
      const v = t.data[i * NUM_CH + c];
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    return hi - lo;
  };
  ok("phrased body still turns", rng(ph, CH.WZ) > 0.3, `wz range ${rng(ph, CH.WZ).toFixed(2)}`);
  ok("phrased head still moves on all three axes",
    rng(ph, CH.HEAD_YAW) > 0.2 && rng(ph, CH.HEAD_PITCH) > 0.2 && rng(ph, CH.HEAD_ROLL) > 0.2,
    `yaw ${rng(ph, CH.HEAD_YAW).toFixed(2)}, nod ${rng(ph, CH.HEAD_PITCH).toFixed(2)}, roll ${rng(ph, CH.HEAD_ROLL).toFixed(2)}`);

  // The head must keep the dancer's rhythm, not the phrase's. Counting
  // direction changes is a blunt proxy but it is exactly the thing that
  // broke when the head was bound to the phrase grid.
  const turns = (t, c) => {
    let k = 0;
    for (let i = 1; i < t.n; i++) {
      const a = t.data[(i - 1) * NUM_CH + c], b = t.data[i * NUM_CH + c];
      if ((a < 0) !== (b < 0)) k++;
    }
    return k;
  };
  ok("the head keeps the dancer's rhythm rather than the phrase's",
    turns(ph, CH.HEAD_YAW) >= turns(direct, CH.HEAD_YAW) * 0.7,
    `${turns(ph, CH.HEAD_YAW)} direction changes vs ${turns(direct, CH.HEAD_YAW)} direct`);

  // The body should be calmer than the direct path: that is the point.
  ok("the body is calmer than frame-by-frame",
    turns(ph, CH.VX) < turns(direct, CH.VX),
    `${turns(ph, CH.VX)} vs ${turns(direct, CH.VX)} changes of direction`);

  // A dancer stepping on the spot must not march the duck into the wall.
  let sum = 0;
  for (let i = 0; i < ph.n; i++) sum += ph.data[i * NUM_CH + CH.VX] * TRACK_DT;
  ok("stepping on the spot does not walk the duck away",
    Math.abs(sum) < 0.6, `net travel ${sum.toFixed(2)} m over ${ph.duration.toFixed(0)} s`);

  // Grid choice.
  const g = phraseGrid(beatList, 20);
  ok("phrases are whole beats long enough to perform",
    g.perPhrase >= 2 && g.source === "beats", `${g.perPhrase} beats per phrase`);
  const g2 = phraseGrid([], 20);
  ok("a clip with no beat still gets a grid", g2.edges.length > 2 && g2.source === "fixed");

  const stillFrames = [];
  for (let i = 0; i < 200; i++) stillFrames.push({ t: i / 30, ...synthPose() });
  const stillPh = retargetPhrased(extractFeatures(stillFrames), {}, []);
  let maxAbs = 0;
  for (let i = 0; i < stillPh.data.length; i++) maxAbs = Math.max(maxAbs, Math.abs(stillPh.data[i]));
  ok("a motionless dancer leaves the phrased duck still too", maxAbs < 0.05,
    `max |cmd| ${maxAbs.toFixed(3)}`);
}

// ── Move budget ────────────────────────────────────────────────────────
{
  const f2 = extractFeatures(synthRoutine({ duration: 24, fps: 30, bpm: 125.7 }));
  const r = detectMoves(f2, calibrate(f2), {}, []);
  ok("kicks are detected on a busy dancer",
    r.events.some((e) => e.type.startsWith("kick")),
    r.events.map((e) => e.type).join(", ") || "none");
  ok("skills stay inside the time budget",
    r.debug.occupancy <= 0.31,
    `${(r.debug.occupancy * 100).toFixed(0)}% of the routine occupied`);

  // A squat has to be priced together with the stand that ends it, or a
  // pair of them looks cheaper than it is.
  const sits = r.events.filter((e) => e.type === "sit").length;
  const stands = r.events.filter((e) => e.type === "stand").length;
  ok("every sit has its stand", sits === stands, `${sits} sits, ${stands} stands`);
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

// -- Level 5: capture timestamps ---------------------------------------
//
// MediaPipe's VIDEO graph throws on a timestamp that does not advance,
// for that call and every later one below the mark. A landmarker outlives
// the clip it was built for, so the stamps have to outlive it too, or the
// second clip of a session tracks 0% of its frames.
{
  const landmarker = {};
  const first = stampClock(landmarker);
  const a = [0, 0.5, 1.5, 40].map(first);
  ok("stamps follow the clip's own timing", a[1] - a[0] === 500 && a[3] - a[2] === 38500,
    a.join(" "));

  const second = stampClock(landmarker);
  const b = [0, 0.5, 30].map(second);
  ok("a second clip starts above the first",
    b[0] > a[a.length - 1], `${a[a.length - 1]} then ${b[0]}`);
  ok("a second clip keeps its own gaps", b[1] - b[0] === 500 && b[2] - b[1] === 29500);

  // The seek fallback re-runs the same video after playback reached the
  // end: same times again, and they still have to climb.
  const third = stampClock(landmarker);
  const c = [0, 0.5, 30].map(third);
  ok("a re-run of the same clip climbs again", c[0] > b[b.length - 1]);

  // Two decoded frames can round to the same millisecond, and a decoder
  // that hands one back twice must not stall the graph either.
  const fourth = stampClock(landmarker);
  const d = [1, 1, 1.0004, 0.9].map(fourth);
  ok("repeated and backwards times still advance",
    d.every((v, i) => i === 0 || v > d[i - 1]), d.join(" "));

  // Where the floor is read matters: a clock opened early but used late
  // must still land above whatever ran in between.
  {
    const lm = {};
    const early = stampClock(lm);
    const other = stampClock(lm);
    other(0); other(20);
    ok("a clock reads the floor when it stamps, not when it opens",
      early(0) > 20000, `${early(0)}`);
  }

  // Separate landmarkers share nothing: a fresh one starts from zero.
  const fresh = stampClock({});
  ok("a fresh landmarker starts from zero", fresh(0) === 0);
}

// ── Level 6: choreography from music ───────────────────────────────────
//
// The music path has no dancer to fall back on, so everything it produces
// has to be justified by the song alone. These checks pin the three
// claims it makes: that it reads the structure, that it dances to it, and
// that everything it writes is inside what the policy can perform.
{
  // A synthetic song. Kick on every beat, backbeat on one and three so
  // the downbeat is findable, and a loud second half so there is a
  // section boundary to find. Deterministic noise: a test that resamples
  // its own fixture is a test that fails on Tuesdays.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const makeSong = ({ bpm = 124, duration = 48, quietFirstHalf = true } = {}) => {
    const sr = 22050, n = Math.round(sr * duration);
    const sig = new Float32Array(n);
    const beat = 60 / bpm;
    for (let i = 0; i * beat < duration; i++) {
      const t = i * beat, at = Math.round(t * sr);
      const loud = !quietFirstHalf || t > duration / 2 ? 1 : 0.45;
      for (let k = 0; k < sr * 0.09; k++) {
        if (at + k < n) {
          sig[at + k] += Math.sin(2 * Math.PI * 55 * k / sr) *
            Math.exp(-k / (sr * 0.03)) * loud;
        }
      }
      if (i % 4 === 0 || i % 4 === 2) {
        for (let k = 0; k < sr * 0.05; k++) {
          if (at + k < n) {
            sig[at + k] += (rand() * 2 - 1) * Math.exp(-k / (sr * 0.015)) * 0.5 * loud;
          }
        }
      }
    }
    return { sampleRate: sr, length: n, duration, numberOfChannels: 1,
      getChannelData: () => sig };
  };

  const music = analyseMusic(makeSong());
  ok("music analysis finds the tempo", Math.abs(music.bpm - 124) < 2,
    `${music.bpm.toFixed(1)} BPM`);
  ok("the bar grid covers the song",
    music.bars.length >= 20 && music.bars.length <= 24, `${music.bars.length} bars`);

  // Every bar must start on a beat of the grid, or a figure written for
  // the one lands somewhere else entirely.
  {
    const onGrid = music.bars.every((b) =>
      music.beats.some((t) => Math.abs(t - b.t0) < 1e-6));
    ok("every bar starts on a beat", onGrid);
  }

  // The backbeat was written onto every other beat, so the meter search
  // has something real to find and must commit to it.
  ok("the downbeat search commits to a phase", music.meterConfidence > 0.1,
    `phase ${music.phase}, confidence ${music.meterConfidence.toFixed(2)}`);

  // The song gets loud halfway through; that is a boundary, and it is the
  // only one.
  ok("the loud half is found as its own section", music.sections.length === 2,
    music.sections.map((s) => `${s.kind}@${s.t0.toFixed(0)}s`).join(" "));
  if (music.sections.length === 2) {
    ok("the boundary sits near the change",
      Math.abs(music.sections[1].t0 - 24) < 5,
      `${music.sections[1].t0.toFixed(1)}s vs 24s`);
    ok("the loud half is ranked louder",
      music.sections[1].level > music.sections[0].level);
  }

  const { track, plan } = choreograph(music);
  // Skills are off by default because they put the duck down; the
  // checks below are about what they do when someone opts in.
  const { events } = choreograph(music, { enableSkills: true });

  // ── What the duck is asked to do ──
  {
    let worst = null;
    const bounds = [
      ["vx", CH.VX, LIMITS.vxBack, LIMITS.vxFwd],
      ["vy", CH.VY, -LIMITS.vy, LIMITS.vy],
      ["wz", CH.WZ, -LIMITS.wz, LIMITS.wz],
      ["neck", CH.NECK_PITCH, -LIMITS.head, LIMITS.head],
      ["pitch", CH.HEAD_PITCH, -LIMITS.head, LIMITS.head],
      ["yaw", CH.HEAD_YAW, -LIMITS.head, LIMITS.head],
      ["roll", CH.HEAD_ROLL, -LIMITS.head, LIMITS.head],
    ];
    for (let i = 0; i < track.n; i++) {
      for (const [name, ch, lo, hi] of bounds) {
        const v = track.data[i * NUM_CH + ch];
        if (v < lo - 1e-6 || v > hi + 1e-6) worst = `${name}=${v.toFixed(3)}`;
      }
    }
    ok("every command is inside the policy limits", worst === null, worst ?? "");
  }
  ok("the track fits the slew budget by construction", track.fit.demand <= 1.0001,
    `${track.fit.demand.toFixed(3)}x the limit`);

  // Holding a turn near the limit is what puts the duck on the floor.
  {
    let worst = 0;
    for (let i = 0; i < track.n; i++) {
      worst = Math.max(worst, Math.abs(track.data[i * NUM_CH + CH.WZ]));
    }
    ok("sustained turns stay under the ceiling", worst <= LIMITS.wz * 0.8 + 1e-6,
      `${worst.toFixed(2)} rad/s`);
  }

  // A routine of velocity commands can quietly walk the duck into a wall.
  {
    let x = 0, y = 0;
    for (let i = 0; i < track.n; i++) {
      x += track.data[i * NUM_CH + CH.VX] * TRACK_DT;
      y += track.data[i * NUM_CH + CH.VY] * TRACK_DT;
    }
    const travel = Math.hypot(x, y);
    ok("dancing on the spot stays on the spot", travel < 1.2,
      `net travel ${travel.toFixed(2)} m over ${music.duration} s`);
  }

  // A routine that never moves passes every check above and is useless.
  {
    const swings = (ch) => {
      let c = 0;
      for (let i = 1; i < track.n; i++) {
        const a = track.data[(i - 1) * NUM_CH + ch], b = track.data[i * NUM_CH + ch];
        if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) c++;
      }
      return c;
    };
    ok("the body actually moves", swings(CH.VY) + swings(CH.WZ) > 10,
      `${swings(CH.VY)} sway + ${swings(CH.WZ)} turn direction changes`);
    ok("the head keeps its own faster rhythm",
      swings(CH.HEAD_PITCH) + swings(CH.HEAD_YAW) > swings(CH.WZ),
      `${swings(CH.HEAD_PITCH) + swings(CH.HEAD_YAW)} head vs ${swings(CH.WZ)} body`);
  }

  // ── Structure: the one thing separating choreography from noise ──
  {
    const first = music.sections[0];
    const inFirst = plan.filter((p) => p.section.index === first.index);
    const names = inFirst.map((p) => `${p.body.name}/${p.head.name}`);
    // A motif of two or four bars, stated more than once.
    const period = names.length >= 8 ? 4 : 2;
    let repeats = 0;
    for (let i = period; i < names.length; i++) {
      if (names[i] === names[i - period]) repeats++;
    }
    ok("a motif repeats through a section",
      repeats >= (names.length - period) * 0.6,
      `${repeats}/${names.length - period} bars repeat at period ${period}`);

    if (music.sections.length === 2) {
      const secondNames = plan
        .filter((p) => p.section.index === 1)
        .map((p) => `${p.body.name}/${p.head.name}`);
      const shared = new Set(names.slice(0, 4));
      const same = secondNames.slice(0, 4).filter((x) => shared.has(x)).length;
      ok("the figures change at the section boundary", same < 4,
        `${same}/4 opening bars shared with the first section`);
    }
  }

  // ── Skills ──
  ok("skills are off unless asked for", choreograph(music).events.length === 0);
  ok("kicks land in the loud section, not the quiet one",
    events.every((e) => !e.type.startsWith("kick") || e.t > 20),
    events.map((e) => `${e.type}@${e.t.toFixed(0)}`).join(" ") || "(none)");
  {
    const feet = events.filter((e) => e.type.startsWith("kick")).map((e) => e.type);
    const alternates = feet.every((f, i) => i === 0 || f !== feet[i - 1]);
    ok("the duck alternates feet", alternates, feet.join(" ") || "(no kicks)");
  }

  // ── Determinism: a tuning slider is unjudgeable without it ──
  {
    const a = choreograph(music).track.data;
    const b = choreograph(music).track.data;
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    ok("the same song gives the same routine", same);
    const c = choreograph(music, { seed: 7 }).track.data;
    let differs = false;
    for (let i = 0; i < c.length; i++) if (c[i] !== a[i]) { differs = true; break; }
    ok("a different seed gives a different routine", differs);
  }

  // ── A song with no beat at all still has to produce something ──
  {
    const silent = { sampleRate: 22050, length: 22050 * 20, duration: 20,
      numberOfChannels: 1, getChannelData: () => new Float32Array(22050 * 20) };
    const m2 = analyseMusic(silent);
    const t2 = choreograph(m2).track;
    ok("silence still yields a performable routine",
      t2.n > 100 && t2.fit.demand <= 1.0001 && t2.fit.gridSource === "invented",
      `${t2.n} steps, ${t2.fit.demand.toFixed(2)}x, grid ${t2.fit.gridSource}`);
  }
}

const w = Math.max(...results.map((r) => r[1].length));
for (const [st, label, detail] of results) {
  console.log(`${st}  ${label.padEnd(w)}  ${detail}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
