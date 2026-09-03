// Skeleton overlay drawing, shared by the video stage and the demo view.
//
// The overlay is not decoration. It is the only way to see whether the
// tracker actually found the dancer, which is the first thing to check
// when the duck does something strange.

import { BONES, LM } from "./landmarks.js";
import { CREAM, COMIC_ORANGE, ACID_CYAN, ACID_MAGENTA } from "../ui/comic.jsx";

const MIN_VIS = 0.4;

/**
 * Draw one pose over a canvas.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} lms normalised image landmarks, or null for "not tracked"
 * @param {number} w  canvas width in device pixels
 * @param {number} h  canvas height
 * @param {object} o  { mirror, scale }
 */
export function drawPose(ctx, lms, w, h, o = {}) {
  ctx.clearRect(0, 0, w, h);
  if (!lms) return;
  const mirror = !!o.mirror;
  const px = (p) => [(mirror ? 1 - p.x : p.x) * w, p.y * h];
  const seen = (i) => (lms[i]?.visibility ?? 1) >= MIN_VIS;
  const s = o.scale ?? 1;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Bones twice: a thick ink pass underneath so the cream line stays
  // legible over a bright or busy frame.
  for (const pass of [
    { color: "rgba(16,16,24,0.85)", width: 7 * s },
    { color: CREAM, width: 3 * s },
  ]) {
    ctx.strokeStyle = pass.color;
    ctx.lineWidth = pass.width;
    ctx.beginPath();
    for (const [a, b] of BONES) {
      if (!seen(a) || !seen(b)) continue;
      const [ax, ay] = px(lms[a]);
      const [bx, by] = px(lms[b]);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
  }

  // The joints the retargeting actually reads, in the colours the
  // timeline uses for the channels they drive.
  const marks = [
    [LM.NOSE, COMIC_ORANGE, 5],
    [LM.SHOULDER_L, ACID_CYAN, 4], [LM.SHOULDER_R, ACID_CYAN, 4],
    [LM.HIP_L, ACID_MAGENTA, 5], [LM.HIP_R, ACID_MAGENTA, 5],
    [LM.ANKLE_L, COMIC_ORANGE, 4], [LM.ANKLE_R, COMIC_ORANGE, 4],
  ];
  for (const [i, color, r] of marks) {
    if (!seen(i)) continue;
    const [x, y] = px(lms[i]);
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(16,16,24,0.9)";
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.arc(x, y, r * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Hip-to-shoulder axis: the body basis every angle is measured against.
  if (seen(LM.HIP_L) && seen(LM.HIP_R) && seen(LM.SHOULDER_L) && seen(LM.SHOULDER_R)) {
    const hip = [(lms[LM.HIP_L].x + lms[LM.HIP_R].x) / 2, (lms[LM.HIP_L].y + lms[LM.HIP_R].y) / 2];
    const sh = [(lms[LM.SHOULDER_L].x + lms[LM.SHOULDER_R].x) / 2, (lms[LM.SHOULDER_L].y + lms[LM.SHOULDER_R].y) / 2];
    ctx.strokeStyle = COMIC_ORANGE;
    ctx.lineWidth = 2 * s;
    ctx.setLineDash([6 * s, 5 * s]);
    ctx.beginPath();
    ctx.moveTo((mirror ? 1 - hip[0] : hip[0]) * w, hip[1] * h);
    ctx.lineTo((mirror ? 1 - sh[0] : sh[0]) * w, sh[1] * h);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Index of the captured frame nearest a given time. */
export function frameAt(frames, t) {
  if (!frames || !frames.length) return -1;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(frames[lo - 1].t - t) <= Math.abs(frames[lo].t - t)) return lo - 1;
  return lo;
}
