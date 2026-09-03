// Running the pose tracker over an uploaded video.
//
// Everything is local: the wasm runtime and the .task model ship in
// public/mediapipe, so a routine can be analysed with no network at all
// and nothing about the upload leaves the browser.
//
// Two ways through a video, because neither is right for every clip.
//
// PLAYBACK plays the file muted at speed and samples whatever frames the
// decoder hands over, through requestVideoFrameCallback. It is by far
// the faster path and gets the video's true frame timing for free.
//
// SEEKING steps the playhead to fixed timestamps and waits for each
// frame. It is much slower, but it is exact and works where playback
// sampling does not: a browser without the frame callback, a decoder
// that drops frames under load, or a clip whose timing must be sampled
// evenly regardless of how it was encoded.

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { signed } from "../game/signed.js";
import { stampClock } from "./stamp.js";

const base = import.meta.env?.BASE_URL ?? "/";
const asset = (p) => signed(`${base}${p}`.replace(/([^:]\/)\/+/g, "$1"));

export const MODELS = {
  lite: { path: "mediapipe/models/pose_landmarker_lite.task", label: "Lite, fastest" },
  full: { path: "mediapipe/models/pose_landmarker_full.task", label: "Full, more accurate" },
};

let visionPromise = null;

async function getVision() {
  visionPromise ??= FilesetResolver.forVisionTasks(asset("mediapipe/wasm"));
  return visionPromise;
}

/**
 * Build a pose landmarker in VIDEO mode.
 * Falls back from the GPU delegate to CPU, which is the normal outcome
 * on machines without WebGL2 rather than an error worth surfacing.
 */
export async function createLandmarker({ model = "full", delegate = "GPU" } = {}) {
  const vision = await getVision();
  const opts = (d) => ({
    baseOptions: { modelAssetPath: asset(MODELS[model].path), delegate: d },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
  try {
    return await PoseLandmarker.createFromOptions(vision, opts(delegate));
  } catch (e) {
    if (delegate === "CPU") throw e;
    return PoseLandmarker.createFromOptions(vision, opts("CPU"));
  }
}

const waitFor = (el, ev) => new Promise((res) => el.addEventListener(ev, res, { once: true }));
const after = (ms) => new Promise((res) => setTimeout(res, ms));

// Move the playhead and wait for the frame to actually be there.
// A video already sitting on the requested time fires no "seeked" at all,
// so awaiting one would wait for ever; and a decoder that swallows the
// event should cost one stale frame, not the whole analysis.
const seekTo = (v, t) => {
  if (Math.abs(v.currentTime - t) < 1e-3) return Promise.resolve();
  v.currentTime = t;
  return Promise.race([waitFor(v, "seeked"), after(2000)]);
};

// Load a file into a detached video element and wait until it can be
// decoded frame by frame.
export async function loadVideo(src) {
  const v = document.createElement("video");
  v.src = src;
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  await new Promise((res, rej) => {
    v.addEventListener("loadedmetadata", res, { once: true });
    v.addEventListener("error", () => rej(new Error("the browser could not decode this video")), { once: true });
  });
  if (!Number.isFinite(v.duration) || v.duration <= 0) {
    throw new Error("this file has no readable duration");
  }
  return v;
}

/**
 * Track a dancer through a video.
 *
 * @param {object} o
 * @param {HTMLVideoElement} o.video   a loaded, muted video element
 * @param {object} o.landmarker        from createLandmarker
 * @param {number} o.targetFps         samples per second to keep
 * @param {number} o.maxDuration       seconds of video to analyse
 * @param {number} o.rate              playback speed in "playback" mode
 * @param {"auto"|"playback"|"seek"} o.mode
 * @param {(p:{done:number,total:number,t:number})=>void} o.onProgress
 * @param {AbortSignal} o.signal
 * @returns {Promise<{frames:Array, fps:number, mode:string, dropped:number,
 *                    errors:number, firstError:string}>}
 */
export async function captureFrames({
  video, landmarker, targetFps = 30, maxDuration = 90, rate = 2,
  mode = "auto", onProgress, signal,
} = {}) {
  const hasRvfc = typeof video.requestVideoFrameCallback === "function";
  const chosen = mode === "auto" ? (hasRvfc ? "playback" : "seek") : mode;
  const duration = Math.min(video.duration, maxDuration);
  const minGap = 1 / targetFps;

  const frames = [];
  let dropped = 0;
  // A frame the detector refused to look at at all. Kept apart from
  // dropped: a clip the tracker never ran on is a broken tracker, not a
  // clip without a dancer, and only one of those is the user's problem.
  let errors = 0;
  let firstError = "";
  // Timestamps must clear anything already fed to this landmarker, and
  // two decoded frames can share a millisecond after rounding.
  const stampAt = stampClock(landmarker);
  const detect = (t) => {
    let res;
    try {
      res = landmarker.detectForVideo(video, stampAt(t));
    } catch (e) {
      errors++;
      firstError ||= e?.message || String(e);
      dropped++;
      return { t, landmarks: null, worldLandmarks: null };
    }
    const lm = res?.landmarks?.[0] ?? null;
    const wl = res?.worldLandmarks?.[0] ?? null;
    if (!lm || !wl) dropped++;
    return { t, landmarks: lm, worldLandmarks: wl };
  };

  const abort = () => signal?.aborted;

  if (chosen === "playback") {
    await seekTo(video, 0);
    video.playbackRate = rate;
    let lastKept = -Infinity;
    let finished = false;
    const done = new Promise((resolve) => {
      const onFrame = (_now, meta) => {
        if (abort()) return resolve();
        const t = meta?.mediaTime ?? video.currentTime;
        if (t > duration) { finished = true; return resolve(); }
        if (t - lastKept >= minGap - 1e-4) {
          lastKept = t;
          frames.push(detect(t));
          onProgress?.({ done: t, total: duration, t });
        }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
      video.addEventListener("ended", () => { finished = true; resolve(); }, { once: true });
      video.play().catch(() => resolve());
    });
    await done;
    video.pause();
    video.playbackRate = 1;
    // A decoder that starved under the detector's load leaves holes; the
    // seek path fills them in rather than pretending the clip was short.
    if (!abort() && frames.length < duration * targetFps * 0.5) {
      return captureFrames({
        video, landmarker, targetFps, maxDuration, mode: "seek",
        onProgress, signal,
      });
    }
    void finished;
  } else {
    const total = Math.floor(duration * targetFps) + 1;
    for (let i = 0; i < total; i++) {
      if (abort()) break;
      const t = Math.min(duration, i * minGap);
      await seekTo(video, t);
      frames.push(detect(t));
      onProgress?.({ done: i + 1, total, t });
    }
    video.pause();
  }

  return { frames, fps: targetFps, mode: chosen, dropped, errors, firstError };
}
