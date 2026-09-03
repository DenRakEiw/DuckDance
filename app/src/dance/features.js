// Pose frames -> per-frame scalar signals.
//
// This is the interpretation layer: it takes what MediaPipe saw and turns
// it into quantities a robot command can actually be built from. Nothing
// here knows about the duck; the mapping onto the 13D command vector
// lives in retarget.js.
//
// Coordinate conventions
// ----------------------
// worldLandmarks are metres with the origin at the hip midpoint, axes
// aligned with the image: +x is image right, +y is image DOWN, +z is
// away from the camera (a landmark nearer the lens has smaller z).
//
// From that we build a body basis:
//   bUp    shoulder midpoint - hip midpoint      (torso up)
//   bRight right hip - left hip                  (dancer's own right)
//   bFwd   cross(bUp, bRight)                    (the way they face)
// A dancer standing square to the lens gives bUp = (0,-1,0),
// bRight = (-1,0,0) and therefore bFwd = (0,0,-1): straight at the
// camera, which is exactly what "facing" should mean. Body yaw is then
// atan2(bFwd.x, -bFwd.z), zero when square to the lens.
//
// landmarks (normalised image coords, 0..1) carry what the world frame
// throws away: where the dancer is in the picture, and how big they
// appear. Those give us translation and a crouch measure.

import { LM, CORE_POINTS, ENERGY_POINTS } from "./landmarks.js";
import {
  vsub, vmid, vdot, vlen, vcross, vnorm, clamp, wrapPi, unwrapSeries,
} from "./math.js";

const MIN_VIS = 0.4; // landmark presence below this counts as unseen

// Orthonormalise b against a (Gram-Schmidt), returning a unit vector.
function orthonormal(b, a) {
  const d = vdot(b, a);
  return vnorm({ x: b.x - d * a.x, y: b.y - d * a.y, z: b.z - d * a.z });
}

// Signed angle from u to v measured about the axis n (all unit vectors).
function signedAngle(u, v, n) {
  return Math.atan2(vdot(vcross(u, v), n), vdot(u, v));
}

const vis = (lm, i) => lm?.[i]?.visibility ?? 1;

// Per-frame body basis plus the raw geometry every signal derives from.
// Returns null when the torso itself is not reliably tracked.
export function bodyBasis(world) {
  if (!world || world.length < 33) return null;
  const hipL = world[LM.HIP_L], hipR = world[LM.HIP_R];
  const shL = world[LM.SHOULDER_L], shR = world[LM.SHOULDER_R];
  if (!hipL || !hipR || !shL || !shR) return null;
  const hipC = vmid(hipL, hipR);
  const shC = vmid(shL, shR);
  const torso = vsub(shC, hipC);
  const torsoLen = vlen(torso);
  if (torsoLen < 1e-4) return null;
  const bUp = vnorm(torso);
  const latRaw = vsub(hipR, hipL); // points to the dancer's own right
  if (vlen(latRaw) < 1e-5) return null;
  const bRight = orthonormal(latRaw, bUp);
  if (vlen(bRight) < 0.5) return null; // torso seen edge-on, basis unstable
  const bFwd = vnorm(vcross(bUp, bRight));
  return { hipC, shC, bUp, bRight, bFwd, torsoLen };
}

// Head orientation relative to the torso, in radians.
// yaw   > 0 : turned toward the dancer's own left
// pitch > 0 : chin up
// roll  > 0 : crown tipped toward the dancer's own left
function headAngles(world, basis) {
  const nose = world[LM.NOSE];
  const earL = world[LM.EAR_L], earR = world[LM.EAR_R];
  if (!nose || !earL || !earR) return null;
  const earC = vmid(earL, earR);
  const hFwd = vnorm(vsub(nose, earC));
  if (vlen(hFwd) < 0.5) return null;
  const hRight = vnorm(vsub(earR, earL)); // ear to ear, dancer's right
  const { bUp, bRight, bFwd } = basis;
  // Yaw: swing of the face direction about the torso up axis, flattened
  // into the horizontal plane so a nod cannot leak into a turn.
  const d = vdot(hFwd, bUp);
  const fFlat = vnorm({
    x: hFwd.x - d * bUp.x,
    y: hFwd.y - d * bUp.y,
    z: hFwd.z - d * bUp.z,
  });
  const yaw = vlen(fFlat) > 0.3 ? signedAngle(bFwd, fFlat, bUp) : 0;
  const pitch = Math.asin(clamp(vdot(hFwd, bUp), -1, 1));
  const roll = -signedAngle(bRight, hRight, hFwd);
  return { yaw: wrapPi(yaw), pitch, roll: wrapPi(roll) };
}

const HELD_KEYS = [
  "yawRaw", "leanFwd", "leanSide", "headYaw", "headPitch", "headRoll",
  "imgX", "imgY", "imgScale", "stance",
  "footLiftL", "footLiftR", "footFwdL", "footFwdR",
  "kneeLiftL", "kneeLiftR", "armLiftL", "armLiftR",
];

function snapshot(out, i) {
  const s = {};
  for (const k of HELD_KEYS) s[k] = out[k][i];
  return s;
}

function applyHold(out, i, hold) {
  for (const k of HELD_KEYS) out[k][i] = hold[k];
}

/**
 * Turn captured pose frames into aligned signal arrays.
 *
 * @param {Array<{t:number, landmarks:Array, worldLandmarks:Array}>} frames
 *        Capture output, ascending in time. Entries with a null landmark
 *        set are treated as tracking gaps and hold the last good value.
 * @returns {object} signals, every array the same length as `frames`
 */
export function extractFeatures(frames) {
  const n = frames.length;
  const mk = () => new Float32Array(n);
  const out = {
    n,
    t: new Float64Array(n),
    tracked: new Uint8Array(n),
    // orientation
    yawRaw: mk(), yaw: null,
    leanFwd: mk(), leanSide: mk(),
    // head, relative to the torso
    headYaw: mk(), headPitch: mk(), headRoll: mk(),
    // image-space placement and apparent size
    imgX: mk(), imgY: mk(), imgScale: mk(),
    // posture: ankle-to-hip span over torso span, small means crouched
    stance: mk(),
    // limbs, normalised by their own segment length
    footLiftL: mk(), footLiftR: mk(),
    footFwdL: mk(), footFwdR: mk(),
    kneeLiftL: mk(), kneeLiftR: mk(),
    armLiftL: mk(), armLiftR: mk(),
    // aggregate
    energy: mk(),
  };

  const yawSeries = new Float64Array(n);
  let prevImg = null;
  let prevT = null;
  // Held values so a dropped frame repeats the last good pose instead of
  // snapping the duck's command back to zero.
  let hold = null;

  for (let i = 0; i < n; i++) {
    const f = frames[i];
    out.t[i] = f.t;
    const world = f.worldLandmarks;
    const img = f.landmarks;
    const basis = world ? bodyBasis(world) : null;
    const coreSeen = img
      ? CORE_POINTS.every((p) => vis(img, p) >= MIN_VIS)
      : false;

    if (!basis || !coreSeen) {
      out.tracked[i] = 0;
      if (hold) applyHold(out, i, hold);
      yawSeries[i] = i > 0 ? yawSeries[i - 1] : 0;
      continue;
    }
    out.tracked[i] = 1;

    const { bUp, bFwd } = basis;

    // Body heading, zero when square to the lens.
    const yaw = Math.atan2(bFwd.x, -bFwd.z);
    yawSeries[i] = yaw;
    out.yawRaw[i] = yaw;

    // Torso tilt, split into the plane the dancer faces and the one
    // perpendicular to it. Standing upright gives both zero.
    out.leanFwd[i] = Math.asin(clamp(vdot(bUp, { x: 0, y: 0, z: -1 }), -1, 1));
    out.leanSide[i] = Math.asin(clamp(-vdot(bUp, { x: 1, y: 0, z: 0 }), -1, 1));

    const head = headAngles(world, basis);
    if (head) {
      out.headYaw[i] = head.yaw;
      out.headPitch[i] = head.pitch;
      out.headRoll[i] = head.roll;
    } else if (hold) {
      out.headYaw[i] = hold.headYaw;
      out.headPitch[i] = hold.headPitch;
      out.headRoll[i] = hold.headRoll;
    }

    // Image space: placement, apparent size, crouch.
    const iHipC = vmid(img[LM.HIP_L], img[LM.HIP_R]);
    const iShC = vmid(img[LM.SHOULDER_L], img[LM.SHOULDER_R]);
    // Apparent torso length in frame heights: the depth proxy. Growing
    // means the dancer is walking toward the lens.
    const iTorso = Math.hypot(iShC.x - iHipC.x, iShC.y - iHipC.y) || 1e-3;
    out.imgX[i] = iHipC.x;
    out.imgY[i] = iHipC.y;
    out.imgScale[i] = iTorso;

    // Crouch: how far the ankles hang below the hips, in torso lengths.
    // Uses image y (down-positive) so it survives a bad world depth.
    const ankSeen = vis(img, LM.ANKLE_L) >= MIN_VIS && vis(img, LM.ANKLE_R) >= MIN_VIS;
    if (ankSeen) {
      const iAnk = vmid(img[LM.ANKLE_L], img[LM.ANKLE_R]);
      out.stance[i] = (iAnk.y - iHipC.y) / iTorso;
    } else {
      out.stance[i] = hold ? hold.stance : 1.4;
    }

    // Limbs, in world metres normalised by the TORSO. Using each leg's
    // own length would couple the two sides together: lifting one foot
    // shortens that leg, and any shared scale then drags the other
    // foot's reading with it. The torso holds still while the limbs
    // move, so it is the one stable ruler on the body.
    //
    // These are RAW measurements, not centred: a planted foot sits near
    // -1.8 torso lengths below the hip, and how far below depends on the
    // dancer's build. calibrate() in retarget.js subtracts a per-clip
    // baseline; nothing here should hard-code a human's proportions.
    const T = basis.torsoLen;
    out.footLiftL[i] = vdot(vsub(world[LM.ANKLE_L], world[LM.HIP_L]), bUp) / T;
    out.footLiftR[i] = vdot(vsub(world[LM.ANKLE_R], world[LM.HIP_R]), bUp) / T;
    out.footFwdL[i] = vdot(vsub(world[LM.ANKLE_L], world[LM.HIP_L]), bFwd) / T;
    out.footFwdR[i] = vdot(vsub(world[LM.ANKLE_R], world[LM.HIP_R]), bFwd) / T;
    out.kneeLiftL[i] = vdot(vsub(world[LM.KNEE_L], world[LM.HIP_L]), bUp) / T;
    out.kneeLiftR[i] = vdot(vsub(world[LM.KNEE_R], world[LM.HIP_R]), bUp) / T;
    out.armLiftL[i] = vdot(vsub(world[LM.WRIST_L], world[LM.SHOULDER_L]), bUp) / T;
    out.armLiftR[i] = vdot(vsub(world[LM.WRIST_R], world[LM.SHOULDER_R]), bUp) / T;

    // Motion energy: mean joint travel per second, in torso lengths.
    if (prevImg && prevT !== null && f.t > prevT) {
      let sum = 0, cnt = 0;
      for (const p of ENERGY_POINTS) {
        const a = img[p], b = prevImg[p];
        if (!a || !b) continue;
        sum += Math.hypot(a.x - b.x, a.y - b.y);
        cnt++;
      }
      out.energy[i] = cnt ? sum / cnt / iTorso / (f.t - prevT) : 0;
    }
    prevImg = img;
    prevT = f.t;

    hold = snapshot(out, i);
  }

  // Continuous heading, so a spin past the seam differentiates cleanly.
  out.yaw = unwrapSeries(Array.from(yawSeries));
  return out;
}
