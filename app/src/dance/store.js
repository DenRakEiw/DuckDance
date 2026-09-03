// State for the dance lab, and the one function that drives a video all
// the way to a track the duck can follow.
//
// Analysis is split into named stages so the progress readout can say
// what is actually happening rather than spinning. Re-tuning does not
// re-run the tracker: the captured pose frames are kept, and moving a
// slider only redoes the cheap arithmetic downstream of them, which is
// what makes the gain controls feel live rather than like a re-render.

import { create } from "zustand";
import { createLandmarker, loadVideo, captureFrames } from "./capture.js";
import { extractFeatures } from "./features.js";
import { retarget, calibrate, DEFAULT_TUNING } from "./retarget.js";
import { detectMoves, DEFAULT_MOVE_TUNING } from "./moves.js";
import { decodeAudio, analyseBuffer } from "./beat.js";
import { DEFAULT_PLAYBACK } from "./player.js";
import { synthRoutine } from "./synth.js";

// Below this share of frames with a detected pose, a clip is rejected
// outright rather than turned into a routine built on noise.
export const MIN_TRACKED_FRACTION = 0.15;

export const useDance = create(() => ({
  // Source
  fileName: "",
  videoUrl: "",
  isDemo: false,

  // Analysis lifecycle
  stage: "idle", // idle | loading | tracking | audio | building | ready | error
  progress: 0,
  progressLabel: "",
  error: "",

  // Results
  frames: null,     // raw pose frames, kept for the overlay and re-tuning
  features: null,
  calib: null,
  track: null,
  events: [],
  rejected: [],
  beats: [],
  bpm: 0,
  bpmConfidence: 0,
  trackedFraction: 0,
  captureInfo: null,

  // Controls
  tuning: { ...DEFAULT_TUNING },
  moveTuning: { ...DEFAULT_MOVE_TUNING },
  playback: { ...DEFAULT_PLAYBACK },
  captureOpts: { model: "full", targetFps: 30, maxDuration: 90, mode: "auto" },

  // Playback mirror
  playing: false,
  waitingForDuck: false,
  currentTime: 0,
  duration: 0,
  liveRow: null,
  liveStatus: null,
  eventLog: [],
}));

const set = useDance.setState;
const get = useDance.getState;

// Debug handle for the console and for automated checks, matching the
// sandbox's own window.__store / window.rl hooks.
if (typeof window !== "undefined") window.__danceStore = useDance;

let landmarker = null;
let abortCtl = null;

// Rebuild everything downstream of the captured frames. Cheap enough to
// run on every slider move.
export function rebuild() {
  const { features, tuning, moveTuning, beats } = get();
  if (!features) return;
  const track = retarget(features, tuning);
  const calib = track.calib;
  const { events, rejected } = detectMoves(features, calib, moveTuning, beats);
  set({ track, calib, events, rejected });
  return { track, events };
}

export function setTuning(patch) {
  set({ tuning: { ...get().tuning, ...patch } });
  rebuild();
}

export function setMoveTuning(patch) {
  set({ moveTuning: { ...get().moveTuning, ...patch } });
  rebuild();
}

export function setPlayback(patch) {
  set({ playback: { ...get().playback, ...patch } });
}

export function setCaptureOpts(patch) {
  set({ captureOpts: { ...get().captureOpts, ...patch } });
}

export function cancelAnalysis() {
  abortCtl?.abort();
}

/**
 * Analyse an uploaded file end to end.
 * @param {File} file
 */
export async function analyseFile(file) {
  abortCtl?.abort();
  abortCtl = new AbortController();
  const signal = abortCtl.signal;

  const prev = get().videoUrl;
  if (prev && !get().isDemo) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(file);

  set({
    fileName: file.name, videoUrl: url, isDemo: false,
    stage: "loading", progress: 0, progressLabel: "Reading the file",
    error: "", frames: null, features: null, track: null,
    events: [], rejected: [], beats: [], bpm: 0, eventLog: [],
  });

  try {
    const video = await loadVideo(url);
    set({ duration: video.duration });

    if (!landmarker) {
      set({ progressLabel: "Loading the pose model" });
      landmarker = await createLandmarker({ model: get().captureOpts.model });
    }
    if (signal.aborted) return;

    // Tracking is the slow stage, so it owns most of the progress bar.
    set({ stage: "tracking", progressLabel: "Watching the dancer" });
    const capture = await captureFrames({
      video, landmarker, signal,
      ...get().captureOpts,
      onProgress: ({ done, total, t }) => {
        set({ progress: total ? Math.min(1, done / total) * 0.8 : 0,
          progressLabel: `Watching the dancer, ${t.toFixed(1)}s` });
      },
    });
    if (signal.aborted) return;
    if (capture.frames.length < 10) {
      throw new Error("no usable frames came out of this video");
    }
    // A clip where the tracker almost never found a person cannot produce
    // a routine worth performing, and the arithmetic downstream would
    // happily build one anyway out of a handful of stray detections.
    // Saying so is far more useful than a duck moving at random.
    const seen = capture.frames.filter((f) => f.landmarks).length / capture.frames.length;
    if (seen < MIN_TRACKED_FRACTION) {
      throw new Error(
        `no dancer found in this clip (${Math.round(seen * 100)}% of frames). ` +
        "One person, whole body in shot, reasonably lit works best.",
      );
    }

    // The audio is optional: plenty of clips are silent or use a codec
    // this browser will not decode, and a routine without a beat grid is
    // still a routine.
    set({ stage: "audio", progress: 0.85, progressLabel: "Listening for the beat" });
    let beats = [], bpm = 0, bpmConfidence = 0;
    try {
      const buf = await decodeAudio(await file.arrayBuffer());
      if (buf) {
        const a = analyseBuffer(buf);
        // A weak estimate would drag moves onto beats that are not
        // really there, so it is dropped rather than half-trusted.
        if (a.confidence > 0.25 && a.bpm > 0) {
          beats = a.beats; bpm = a.bpm; bpmConfidence = a.confidence;
        }
      }
    } catch { /* no beat grid, carry on */ }
    if (signal.aborted) return;

    set({ stage: "building", progress: 0.92, progressLabel: "Choreographing" });
    finish(capture, beats, bpm, bpmConfidence);
  } catch (e) {
    if (signal.aborted) return;
    set({ stage: "error", error: e?.message || String(e), progress: 0 });
  }
}

/** Load the built-in synthetic routine, so the duck can dance with no upload. */
export function loadDemo() {
  abortCtl?.abort();
  const prev = get().videoUrl;
  if (prev && !get().isDemo) URL.revokeObjectURL(prev);
  const frames = synthRoutine({ duration: 24, fps: 30, bpm: 100 });
  const beats = [];
  for (let t = 0; t < 24; t += 60 / 100) beats.push(t);
  set({
    fileName: "Built-in routine", videoUrl: "", isDemo: true,
    duration: frames[frames.length - 1].t, eventLog: [],
    stage: "building", progress: 0.9, progressLabel: "Choreographing", error: "",
  });
  finish({ frames, fps: 30, mode: "synthetic", dropped: 0 }, beats, 100, 1);
}

function finish(capture, beats, bpm, bpmConfidence) {
  const features = extractFeatures(capture.frames);
  const calib = calibrate(features);
  set({
    frames: capture.frames, features, calib, beats, bpm, bpmConfidence,
    captureInfo: capture, trackedFraction: calib.trackedFraction,
  });
  rebuild();
  set({
    stage: "ready", progress: 1,
    progressLabel: `${capture.frames.length} frames, ${Math.round(calib.trackedFraction * 100)}% tracked`,
  });
}

export function reset() {
  abortCtl?.abort();
  const prev = get().videoUrl;
  if (prev && !get().isDemo) URL.revokeObjectURL(prev);
  set({
    fileName: "", videoUrl: "", isDemo: false, stage: "idle", progress: 0,
    progressLabel: "", error: "", frames: null, features: null, track: null,
    events: [], rejected: [], beats: [], bpm: 0, duration: 0, eventLog: [],
    playing: false, waitingForDuck: false, currentTime: 0, liveRow: null,
  });
}
