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
import { retargetPhrased, DEFAULT_PHRASE_TUNING } from "./phrase.js";
import { detectMoves, DEFAULT_MOVE_TUNING } from "./moves.js";
import { decodeAudio, analyseMusic } from "./beat.js";
import { choreograph, DEFAULT_MUSIC_TUNING } from "./choreograph.js";
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
  isAudio: false,   // a song rather than a clip: no camera, no dancer

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
  music: null,      // tempo, bars and sections, from beat.js
  sourceNote: "",   // why the routine came from where it did

  // Controls
  // One tuning object serves both retargeting paths: the gains, the
  // mirror and the head polarities mean the same thing in each, so
  // switching mode keeps whatever the user has dialled in.
  tuning: {
    ...DEFAULT_TUNING, ...DEFAULT_PHRASE_TUNING, ...DEFAULT_MUSIC_TUNING,
    mode: "phrase",
  },
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
  const { features, music, tuning, moveTuning, beats } = get();
  // The music path needs no dancer at all, so it is checked first: a song
  // uploaded on its own has no features and never will.
  if (tuning.mode === "music") {
    if (!music) return;
    const r = choreograph(music, tuning, moveTuning);
    set({ track: r.track, events: r.events, rejected: r.rejected });
    return { track: r.track, events: r.events };
  }
  if (!features) return;
  // "phrase" builds a command the duck can perform; "direct" maps every
  // frame and lets the slew limiter sort it out. Direct is kept because
  // it is the honest baseline and, on a slow clip, the more faithful of
  // the two.
  const track = tuning.mode === "direct"
    ? retarget(features, tuning)
    : retargetPhrased(features, tuning, beats);
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
  const isAudio = /^audio\//.test(file.type) ||
    /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i.test(file.name);

  set({
    fileName: file.name, videoUrl: url, isDemo: false, isAudio,
    stage: "loading", progress: 0, progressLabel: "Reading the file",
    error: "", frames: null, features: null, track: null, music: null,
    events: [], rejected: [], beats: [], bpm: 0, eventLog: [], sourceNote: "",
  });

  try {
    // The music is analysed first now, whatever the file is. It is quick
    // next to tracking, both paths need the beat grid, and having it in
    // hand is what lets a clip the tracker cannot use still become a
    // routine instead of an apology.
    set({ stage: "audio", progress: 0.05, progressLabel: "Listening for the beat" });
    const music = await analyseAudio(file);
    if (signal.aborted) return;
    if (music) {
      set({
        music, beats: music.beats, bpm: music.bpm,
        bpmConfidence: music.confidence, duration: music.duration,
      });
    }

    if (isAudio) {
      if (!music) throw new Error("the browser could not decode this audio");
      finishMusic(music, "");
      return;
    }

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
    // Frames the detector threw on are not frames without a dancer, and
    // telling the user to light the room better when the tracker never
    // ran wastes their time on a clip that was fine. This one is ours.
    if (capture.errors > capture.frames.length * 0.5) {
      throw new Error(
        `the pose tracker failed on ${capture.errors} of ${capture.frames.length} frames ` +
        `(${capture.firstError || "no message"}). Reloading the page should clear it.`,
      );
    }
    // A clip where the tracker almost never found a person cannot produce
    // a routine worth performing, and the arithmetic downstream would
    // happily build one anyway out of a handful of stray detections.
    const seen = capture.frames.filter((f) => f.landmarks).length / capture.frames.length;
    if (seen < MIN_TRACKED_FRACTION) {
      // But there is usually still a song in there, and a routine built
      // from the music is a far better answer than refusing the file.
      if (get().music?.beats?.length) {
        finishMusic(get().music,
          `No dancer found in this clip (${Math.round(seen * 100)}% of frames), ` +
          "so the routine was choreographed from the music instead.");
        return;
      }
      throw new Error(
        `no dancer found in this clip (${Math.round(seen * 100)}% of frames), ` +
        "and no beat to choreograph to either. One person, whole body in " +
        "shot, reasonably lit works best.",
      );
    }

    set({ stage: "building", progress: 0.92, progressLabel: "Choreographing" });
    const { beats, bpm, bpmConfidence } = get();
    finish(capture, beats, bpm, bpmConfidence);
  } catch (e) {
    if (signal.aborted) return;
    set({ stage: "error", error: e?.message || String(e), progress: 0 });
  }
}

/**
 * Decode and analyse a file's soundtrack.
 *
 * Returns null when there is nothing usable: plenty of clips are silent
 * or use a codec this browser will not decode, and a weak tempo estimate
 * would drag every move onto beats that are not really there, so it is
 * dropped rather than half-trusted.
 */
async function analyseAudio(file) {
  try {
    const buf = await decodeAudio(await file.arrayBuffer());
    if (!buf) return null;
    const m = analyseMusic(buf);
    return m.confidence > 0.25 && m.bpm > 0 ? m : null;
  } catch {
    return null;
  }
}

/** Build a routine out of the music alone and hand it to the player. */
function finishMusic(music, note) {
  set({ stage: "building", progress: 0.92, progressLabel: "Choreographing" });
  set({ tuning: { ...get().tuning, mode: "music" } });
  const r = choreograph(music, get().tuning, get().moveTuning);
  set({
    track: r.track, events: r.events, rejected: r.rejected,
    music, beats: music.beats, bpm: music.bpm, duration: music.duration,
    frames: null, features: null, calib: null, trackedFraction: 0,
    sourceNote: note, stage: "ready", progress: 1,
    progressLabel: `${music.bars.length} bars, ${r.track.fit.sections} sections, ` +
      `${Math.round(music.bpm)} BPM`,
  });
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
    fileName: "", videoUrl: "", isDemo: false, isAudio: false,
    music: null, sourceNote: "", stage: "idle", progress: 0,
    progressLabel: "", error: "", frames: null, features: null, track: null,
    events: [], rejected: [], beats: [], bpm: 0, duration: 0, eventLog: [],
    playing: false, waitingForDuck: false, currentTime: 0, liveRow: null,
  });
}
