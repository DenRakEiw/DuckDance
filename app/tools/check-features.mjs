// Sign-convention harness for the retargeting front end.
//
// Feeds the synthetic dancer through extractFeatures and asserts that
// every signal points the way the rest of the pipeline assumes. Run with
//   node tools/check-features.mjs
// A failure here means the duck would mirror or invert a real dancer.

import { synthPose } from "../src/dance/synth.js";
import { extractFeatures } from "../src/dance/features.js";

let failures = 0;
const results = [];

function one(pose) {
  return extractFeatures([{ t: 0, ...pose }]);
}

function check(label, got, expect, tol = 0.12) {
  const ok = Number.isFinite(got) && Math.abs(got - expect) <= tol;
  if (!ok) failures++;
  results.push([ok ? "PASS" : "FAIL", label, got.toFixed(3), expect.toFixed(3)]);
}

// Assert got > bound, for signals whose zero point is the dancer's build.
function gt(label, got, bound) {
  const ok = Number.isFinite(got) && got > bound;
  if (!ok) failures++;
  results.push([ok ? "PASS" : "FAIL", label, got.toFixed(3), `> ${bound.toFixed(3)}`]);
}

function checkSign(label, got, sign, min = 0.05) {
  const ok = Number.isFinite(got) && Math.sign(got) === sign && Math.abs(got) >= min;
  if (!ok) failures++;
  results.push([ok ? "PASS" : "FAIL", label, got.toFixed(3), `sign ${sign}, |v|>=${min}`]);
}

// Rest pose: everything neutral, tracking valid.
{
  const f = one(synthPose());
  check("rest tracked", f.tracked[0], 1, 0);
  check("rest body yaw", f.yaw[0], 0);
  check("rest lean fwd", f.leanFwd[0], 0);
  check("rest lean side", f.leanSide[0], 0);
  check("rest head yaw", f.headYaw[0], 0);
  check("rest head pitch", f.headPitch[0], 0);
  check("rest head roll", f.headRoll[0], 0);
  // Limb readings are RAW, in torso lengths: a planted foot sits well
  // below the hip. What must hold at rest is that the two sides agree.
  check("rest legs symmetric", f.footLiftL[0] - f.footLiftR[0], 0, 1e-3);
  check("rest arms symmetric", f.armLiftL[0] - f.armLiftR[0], 0, 1e-3);
  check("rest image x", f.imgX[0], 0.5, 0.02);
}

// Body heading. The synth parameter turns the dancer toward their own
// RIGHT; the extractor reports yaw positive toward their own LEFT, so a
// right turn must come back negative.
{
  const f = one(synthPose({ bodyYaw: 0.6 }));
  checkSign("turn to dancer right -> yaw negative", f.yaw[0], -1, 0.3);
  const g = one(synthPose({ bodyYaw: -0.6 }));
  checkSign("turn to dancer left -> yaw positive", g.yaw[0], 1, 0.3);
}

// Torso tilt.
{
  const f = one(synthPose({ leanFwd: 0.4 }));
  checkSign("bow toward lens -> leanFwd positive", f.leanFwd[0], 1, 0.25);
  const g = one(synthPose({ leanSide: 0.4 }));
  checkSign("tip to dancer right -> leanSide positive", g.leanSide[0], 1, 0.25);
}

// Head, relative to the torso. All three are positive toward the
// dancer's own left / chin up.
{
  const f = one(synthPose({ headYaw: 0.5 }));
  checkSign("head to dancer left -> headYaw positive", f.headYaw[0], 1, 0.25);
  const g = one(synthPose({ headPitch: 0.4 }));
  checkSign("chin up -> headPitch positive", g.headPitch[0], 1, 0.2);
  const h = one(synthPose({ headRoll: 0.4 }));
  checkSign("crown to dancer left -> headRoll positive", h.headRoll[0], 1, 0.2);
}

// Head yaw must not leak into body yaw, and a body turn must not be
// read as a head turn: the two are measured in different frames and the
// retarget maps them to different command slots.
{
  const f = one(synthPose({ headYaw: 0.7 }));
  check("head turn leaves body yaw alone", f.yaw[0], 0, 0.08);
  const g = one(synthPose({ bodyYaw: 0.7 }));
  check("body turn leaves head yaw alone", g.headYaw[0], 0, 0.08);
}

// Limbs. Everything is judged against the rest pose, because the raw
// values encode the dancer's build, not their motion.
{
  const rest = one(synthPose());
  const rFootL = rest.footLiftL[0], rFootR = rest.footLiftR[0];
  const rArmL = rest.armLiftL[0];

  const f = one(synthPose({ liftL: 0.3 }));
  gt("raise left foot lifts footLiftL", f.footLiftL[0], rFootL + 0.3);
  // The two legs must stay independent: normalising by a shared leg
  // length used to drag the planted foot along with the raised one.
  check("raising left leaves right planted", f.footLiftR[0], rFootR, 1e-3);

  const g = one(synthPose({ liftR: 0.3 }));
  gt("raise right foot lifts footLiftR", g.footLiftR[0], rFootR + 0.3);
  check("raising right leaves left planted", g.footLiftL[0], rFootL, 1e-3);

  const h = one(synthPose({ armL: 0.35 }));
  gt("raise left arm lifts armLiftL", h.armLiftL[0], rArmL + 0.3);
  check("raising left arm leaves right arm", h.armLiftR[0], rest.armLiftR[0], 1e-3);
}

// Crouching shortens the ankle-to-hip span.
{
  const rest = one(synthPose()).stance[0];
  const low = one(synthPose({ crouch: 0.25 })).stance[0];
  const ok = low < rest - 0.15;
  if (!ok) failures++;
  results.push([ok ? "PASS" : "FAIL", "crouch shortens stance",
    low.toFixed(3), `< ${(rest - 0.15).toFixed(3)}`]);
}

// Image-space translation and depth.
{
  const f = one(synthPose({ worldX: 0.4 }));
  const ok = f.imgX[0] < 0.5 - 0.05;
  if (!ok) failures++;
  results.push([ok ? "PASS" : "FAIL", "step to dancer right -> image left",
    f.imgX[0].toFixed(3), "< 0.45"]);

  // worldZ is a step TOWARD the lens, so the positive one is the near
  // pose and must appear larger.
  const near = one(synthPose({ worldZ: 0.6 })).imgScale[0];
  const far = one(synthPose({ worldZ: -0.6 })).imgScale[0];
  const ok2 = near > far;
  if (!ok2) failures++;
  results.push([ok2 ? "PASS" : "FAIL", "toward lens -> larger apparent torso",
    near.toFixed(4), `> ${far.toFixed(4)}`]);
}

// A dropped frame holds the previous pose instead of snapping to zero.
{
  const good = synthPose({ headYaw: 0.5, liftL: 0.3 });
  const f = extractFeatures([
    { t: 0, ...good },
    { t: 0.033, landmarks: null, worldLandmarks: null },
  ]);
  check("gap marked untracked", f.tracked[1], 0, 0);
  check("gap holds head yaw", f.headYaw[1], f.headYaw[0], 1e-4);
  check("gap holds foot lift", f.footLiftL[1], f.footLiftL[0], 1e-4);
}

const w = Math.max(...results.map((r) => r[1].length));
for (const [st, label, got, exp] of results) {
  console.log(`${st}  ${label.padEnd(w)}  got ${got.padStart(8)}  want ${exp}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
