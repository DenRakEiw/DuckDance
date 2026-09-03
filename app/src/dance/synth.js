// A synthetic dancer.
//
// Two jobs. It pins down the sign conventions of the whole retargeting
// chain in a test that needs no video and no MediaPipe, and it gives the
// app a demo track so the duck can be driven before anyone uploads
// anything.
//
// The rig is authored in a comfortable human frame -- X to the dancer's
// own right, Y up, Z the way they face -- and then mapped into the frame
// MediaPipe reports (x image-right, y image-DOWN, z away from the lens).
// For a dancer standing square to the lens those two frames are exact
// negations of each other, which makes the mapping a single sign flip.

import { LM } from "./landmarks.js";

// Rest skeleton in human coords, metres, hip midpoint at the origin.
const REST = {
  [LM.HIP_L]: [-0.09, 0, 0], [LM.HIP_R]: [0.09, 0, 0],
  [LM.SHOULDER_L]: [-0.18, 0.50, 0], [LM.SHOULDER_R]: [0.18, 0.50, 0],
  [LM.ELBOW_L]: [-0.21, 0.25, 0.02], [LM.ELBOW_R]: [0.21, 0.25, 0.02],
  [LM.WRIST_L]: [-0.23, 0.03, 0.04], [LM.WRIST_R]: [0.23, 0.03, 0.04],
  [LM.PINKY_L]: [-0.25, -0.03, 0.04], [LM.PINKY_R]: [0.25, -0.03, 0.04],
  [LM.INDEX_L]: [-0.24, -0.04, 0.05], [LM.INDEX_R]: [0.24, -0.04, 0.05],
  [LM.THUMB_L]: [-0.22, -0.02, 0.05], [LM.THUMB_R]: [0.22, -0.02, 0.05],
  [LM.KNEE_L]: [-0.10, -0.45, 0.01], [LM.KNEE_R]: [0.10, -0.45, 0.01],
  [LM.ANKLE_L]: [-0.10, -0.88, 0], [LM.ANKLE_R]: [0.10, -0.88, 0],
  [LM.HEEL_L]: [-0.10, -0.92, -0.04], [LM.HEEL_R]: [0.10, -0.92, -0.04],
  [LM.FOOT_L]: [-0.10, -0.91, 0.11], [LM.FOOT_R]: [0.10, -0.91, 0.11],
};

// Head points live in their own segment, rotated about the neck base.
const NECK = [0, 0.55, 0];
const HEAD = {
  [LM.NOSE]: [0, 0.70, 0.11],
  [LM.EYE_INNER_L]: [-0.02, 0.72, 0.08], [LM.EYE_L]: [-0.035, 0.72, 0.08],
  [LM.EYE_OUTER_L]: [-0.05, 0.72, 0.075],
  [LM.EYE_INNER_R]: [0.02, 0.72, 0.08], [LM.EYE_R]: [0.035, 0.72, 0.08],
  [LM.EYE_OUTER_R]: [0.05, 0.72, 0.075],
  [LM.EAR_L]: [-0.075, 0.70, -0.01], [LM.EAR_R]: [0.075, 0.70, -0.01],
  [LM.MOUTH_L]: [-0.025, 0.645, 0.09], [LM.MOUTH_R]: [0.025, 0.645, 0.09],
};

// NOTE ON HANDEDNESS. This human frame (X right, Y up, Z forward) is
// LEFT-handed: point your right hand along "right" and curl to "up" and
// the thumb lands BEHIND you, not in front. The MediaPipe world frame
// (x image-right, y image-down, z away) is right-handed. The map between
// them is therefore a point reflection, and right-hand-rule intuition
// silently inverts on the way across. Every helper below is documented
// by the motion it produces, verified in tools/check-features.mjs, not
// by the rule it looks like it should follow.
//
// Rotation about the up axis. Positive turns the dancer toward their
// own RIGHT: forward (0,0,1) swings to right (1,0,0) at +90 deg.
function rotY(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}
// Pitch about the dancer's right axis. Positive BOWS them forward: the
// top of the body swings toward +Z. Chin-up is therefore a negative
// angle applied to the head segment.
function rotX(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}
// Roll about the forward axis. Positive tips the crown toward the
// dancer's own RIGHT.
function rotZ(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c, p[2]];
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// Human frame -> MediaPipe world frame, for a dancer at yaw 0 facing the
// lens: right becomes image-left, up becomes image-down, forward becomes
// toward-the-lens. All three flip sign.
const toWorld = (p) => ({ x: -p[0], y: -p[1], z: -p[2] });

const CAM_F = 1.1;   // focal length in frame heights
const CAM_D = 3.2;   // camera standoff along the view axis, metres

// Perspective projection into normalised image coords. World y is
// already down-positive, which is also the image convention.
function project(w, originDepth) {
  const depth = Math.max(0.4, w.z + originDepth);
  return {
    x: 0.5 + (CAM_F * w.x) / depth,
    y: 0.5 + (CAM_F * w.y) / depth,
    z: w.z / depth,
    visibility: 1,
  };
}

/**
 * Build one synthetic pose frame.
 *
 * @param {object} p pose parameters, all optional
 *   bodyYaw    dancer turns toward their own right, radians
 *   leanFwd    torso bows toward the lens, radians
 *   leanSide   torso tips toward the dancer's own right, radians
 *   headYaw    head turns toward the dancer's own LEFT, radians
 *   headPitch  chin up, radians
 *   headRoll   crown tips toward the dancer's own LEFT, radians
 *   liftL/liftR  foot raised, metres
 *   armL/armR    wrist raised, metres
 *   worldX     step to the dancer's own right, metres
 *   worldZ     step TOWARD the lens, metres
 *   crouch     hips sink, metres
 */
export function synthPose(p = {}) {
  const {
    bodyYaw = 0, leanFwd = 0, leanSide = 0,
    headYaw = 0, headPitch = 0, headRoll = 0,
    liftL = 0, liftR = 0, armL = 0, armR = 0,
    worldX = 0, worldZ = 0, crouch = 0,
  } = p;

  const local = {};
  for (const k of Object.keys(REST)) local[k] = REST[k].slice();

  // Limb offsets, applied before any whole-body rotation.
  local[LM.ANKLE_L][1] += liftL; local[LM.HEEL_L][1] += liftL;
  local[LM.FOOT_L][1] += liftL;  local[LM.KNEE_L][1] += liftL * 0.5;
  local[LM.ANKLE_R][1] += liftR; local[LM.HEEL_R][1] += liftR;
  local[LM.FOOT_R][1] += liftR;  local[LM.KNEE_R][1] += liftR * 0.5;
  local[LM.WRIST_L][1] += armL;  local[LM.ELBOW_L][1] += armL * 0.5;
  local[LM.WRIST_R][1] += armR;  local[LM.ELBOW_R][1] += armR * 0.5;

  // Crouch sinks the hips toward the (fixed) feet: everything above the
  // knees drops, the ground contacts stay put.
  if (crouch) {
    for (const k of Object.keys(local)) {
      const i = Number(k);
      if (i === LM.ANKLE_L || i === LM.ANKLE_R || i === LM.HEEL_L ||
          i === LM.HEEL_R || i === LM.FOOT_L || i === LM.FOOT_R) continue;
      local[i][1] -= i === LM.KNEE_L || i === LM.KNEE_R ? crouch * 0.4 : crouch;
    }
  }

  // Head segment: yaw is negated so the parameter reads "toward the
  // dancer's own left", matching the sign the feature extractor reports.
  const head = {};
  for (const k of Object.keys(HEAD)) {
    let q = sub(HEAD[k], NECK);
    q = rotZ(q, -headRoll);  // crown toward the dancer's own left
    q = rotX(q, -headPitch); // chin up
    q = rotY(q, -headYaw);   // face toward the dancer's own left
    head[k] = add(q, NECK);
    if (crouch) head[k][1] -= crouch;
  }
  Object.assign(local, head);

  // Whole-body tilt, then heading, then the world step.
  const world = {};
  for (const k of Object.keys(local)) {
    let q = local[k];
    if (leanFwd) q = rotX(q, leanFwd);   // bow toward the lens
    if (leanSide) q = rotZ(q, leanSide); // tip to the dancer's own right
    q = rotY(q, bodyYaw);
    world[k] = add(q, [worldX, 0, worldZ]);
  }

  // Hip-centred world landmarks, exactly what MediaPipe reports.
  const hipMid = [
    (world[LM.HIP_L][0] + world[LM.HIP_R][0]) / 2,
    (world[LM.HIP_L][1] + world[LM.HIP_R][1]) / 2,
    (world[LM.HIP_L][2] + world[LM.HIP_R][2]) / 2,
  ];
  const worldLandmarks = new Array(33);
  const landmarks = new Array(33);
  // The step away from the lens moves the whole rig in depth; the sign
  // flip into the world frame turns "away" into a smaller z, so the
  // standoff absorbs it here.
  const originDepth = CAM_D - worldZ;
  for (let i = 0; i < 33; i++) {
    const src = world[i] ?? world[LM.HIP_L];
    worldLandmarks[i] = toWorld(sub(src, hipMid));
    landmarks[i] = project(toWorld(sub(src, [0, hipMid[1], 0])), originDepth);
  }
  return { landmarks, worldLandmarks };
}

/**
 * A short scripted routine: two bars of swaying and nodding, a turn, a
 * couple of kicks and a squat. Used as the app's demo track.
 *
 * @param {object} o
 * @param {number} o.duration seconds
 * @param {number} o.fps      sample rate
 * @param {number} o.bpm      tempo the routine is phrased against
 */
export function synthRoutine({ duration = 16, fps = 30, bpm = 100 } = {}) {
  const frames = [];
  const beat = 60 / bpm;
  const n = Math.round(duration * fps);
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const phase = (t / beat) * 2 * Math.PI;
    const bar = Math.floor(t / (beat * 4)) % 4;
    const p = {
      leanSide: 0.18 * Math.sin(phase / 2),
      headYaw: 0.35 * Math.sin(phase / 2),
      headPitch: 0.25 * Math.sin(phase),
      headRoll: 0.2 * Math.sin(phase / 2 + 0.6),
      // Kept deliberately moderate. This routine is the first thing a
      // visitor sees, and an earlier, wilder version drove the turn
      // command to its limit often enough to put the duck on the floor
      // twice a minute -- technically a good test of fall recovery, and
      // a terrible demonstration of dancing.
      bodyYaw: bar === 2 ? 0.45 * Math.sin(phase / 8) : 0.12 * Math.sin(phase / 4),
      worldX: 0.25 * Math.sin(phase / 4),
      liftL: Math.max(0, 0.22 * Math.sin(phase)),
      liftR: Math.max(0, 0.22 * Math.sin(phase + Math.PI)),
      armL: 0.15 * Math.sin(phase / 2),
      armR: 0.15 * Math.sin(phase / 2 + Math.PI),
    };
    // One clear kick per bar rather than every beat: a kick occupies the
    // duck for about a second, so a denser pattern only produces moves
    // the scheduler then has to throw away.
    if (bar === 1 && Math.floor(t / beat) % 4 === 0) {
      p.liftR = Math.max(p.liftR, 0.42 * Math.max(0, Math.sin(phase)));
    }
    if (bar === 3) { p.crouch = 0.22 * Math.max(0, Math.sin(phase / 8)); }
    frames.push({ t, ...synthPose(p) });
  }
  return frames;
}
