// Playback: the video is the clock, the duck is the instrument.
//
// Every frame we read the video's own currentTime, sample the track at
// that instant and hand the result to the simulator. Nothing here keeps
// its own timeline, which is what makes pausing, scrubbing and looping
// work without a single line of extra code: wherever the playhead goes,
// the duck's command follows.
//
// Two details that are not obvious.
//
// LEAD TIME. A kick is a policy that takes a moment to wind up, so
// firing it exactly on the beat lands the visible motion late. Events
// are dispatched slightly ahead of their timestamp so the duck's motion,
// not the command, is what falls on the beat.
//
// SEEK DETECTION. Events fire once, tracked by a cursor into a sorted
// list. If the playhead jumps backwards -- a loop, or the user dragging
// the scrubber -- the cursor is rebuilt, otherwise a rewatch would be
// silent.
//
// TIMEBASE. The loop is paced by a timer at the control rate, not by
// requestAnimationFrame. The simulator's own control loop is timer-paced
// at 50 Hz, so matching it keeps the command stream in lockstep with the
// physics rather than with the compositor. Tying this to frames would
// mean that on a machine rendering at 20 fps the duck received commands
// at 20 Hz -- the dance would visibly coarsen while the physics ran on at
// full rate -- and that a throttled tab would drift the two apart.

import { sampleTrack, NUM_CH, CH, TRACK_DT } from "./retarget.js";

export const DEFAULT_PLAYBACK = {
  leadTime: 0.12,   // fire a move this far before its timestamp
  headScale: 1.0,   // final trim on the head channels
  twistScale: 1.0,  // final trim on the twist channels
  jaw: true,        // bill along to the beat
  loop: false,
};

export class DancePlayer {
  #video = null;
  #track = null;
  #events = [];
  #cursor = 0;
  #timer = 0;
  #lastTime = -1;
  #running = false;
  #row = new Float32Array(NUM_CH);
  #opts = { ...DEFAULT_PLAYBACK };
  #api = null;
  #beats = [];
  #log = [];

  // Called with { t, type, fired, reason } after every event decision,
  // so the timeline can show which moves the duck actually took.
  onEvent = null;
  // Called each frame with the live command, for the meters.
  onTick = null;

  constructor(gameApi) {
    this.#api = gameApi;
  }

  attach(video) {
    this.#video = video;
  }

  setTrack(track, events = [], beats = []) {
    this.#track = track;
    this.#events = [...events].sort((a, b) => a.t - b.t);
    this.#beats = beats;
    this.#cursor = 0;
    this.#lastTime = -1;
    this.#log = [];
  }

  setOptions(o) {
    this.#opts = { ...this.#opts, ...o };
  }

  get options() {
    return { ...this.#opts };
  }

  get log() {
    return this.#log;
  }

  get running() {
    return this.#running;
  }

  start() {
    if (this.#running || !this.#track) return;
    this.#running = true;
    this.#api?.dance?.setPlaying(true);
    // Self-correcting pacing: schedule against a running deadline rather
    // than a fixed delay, so a slow step does not stretch the routine.
    let next = performance.now();
    const tick = () => {
      if (!this.#running) return;
      this.#step();
      next += TRACK_DT * 1000;
      const wait = next - performance.now();
      if (wait <= 0) next = performance.now(); // fell behind, do not spiral
      this.#timer = setTimeout(tick, Math.max(0, wait));
    };
    tick();
  }

  stop() {
    this.#running = false;
    clearTimeout(this.#timer);
    this.#api?.dance?.setPlaying(false);
    this.#api?.dance?.setTwist(0, 0, 0);
    this.#lastTime = -1;
  }

  // Re-point the event cursor at the first event at or after `t`.
  #reseek(t) {
    let i = 0;
    while (i < this.#events.length && this.#events[i].t < t) i++;
    this.#cursor = i;
  }

  #step() {
    const v = this.#video;
    const track = this.#track;
    const api = this.#api?.dance;
    if (!v || !track || !api) return;

    const t = v.currentTime;
    const status = api.status;

    // The entrance ceremony holds the inputs until it has played out, and
    // the fall-recovery machine owns the duck while it gets back up. In
    // both cases the honest thing is to command nothing.
    if (!status.ready) {
      api.setTwist(0, 0, 0);
      this.onTick?.({ t, row: null, status });
      this.#lastTime = t;
      return;
    }

    // Backwards jump means a loop or a scrub: rebuild the cursor so the
    // moves fire again on the way through.
    if (this.#lastTime >= 0 && t < this.#lastTime - 0.05) this.#reseek(t);
    this.#lastTime = t;

    sampleTrack(track, t, this.#row);
    const ts = this.#opts.twistScale;
    const hs = this.#opts.headScale;

    // While a skill runs the simulator zeroes the twist for us; sending
    // it anyway would only fight the policy on the way out of the move.
    if (status.busy) {
      api.setTwist(0, 0, 0);
    } else {
      api.setTwist(
        this.#row[CH.VX] * ts,
        this.#row[CH.VY] * ts,
        this.#row[CH.WZ] * ts,
      );
    }
    api.setHead(
      this.#row[CH.NECK_PITCH] * hs,
      this.#row[CH.HEAD_PITCH] * hs,
      this.#row[CH.HEAD_YAW] * hs,
      this.#row[CH.HEAD_ROLL] * hs,
    );

    if (this.#opts.jaw) {
      // Open the bill on the twist's energy, so it moves with the dance
      // rather than on a timer of its own.
      const e = Math.min(1, (Math.abs(this.#row[CH.WZ]) / 0.8) * 0.7 +
        (Math.abs(this.#row[CH.VY]) / 0.15) * 0.3);
      api.setJaw(e * 0.8);
    } else {
      api.setJaw(0);
    }

    // Dispatch every event whose lead-adjusted time has passed.
    const horizon = t + this.#opts.leadTime;
    while (this.#cursor < this.#events.length && this.#events[this.#cursor].t <= horizon) {
      const ev = this.#events[this.#cursor++];
      // A move more than a second stale is one we scrubbed past; firing
      // it now would put it wildly out of time.
      if (ev.t < t - 1.0) {
        this.#record({ ...ev, fired: false, reason: "skipped past" });
        continue;
      }
      const fired = api.trigger(ev.type);
      this.#record({ ...ev, fired, reason: fired ? "" : "duck was busy" });
    }

    if (this.#opts.loop && v.duration && t >= v.duration - 0.05) {
      v.currentTime = 0;
      this.#reseek(0);
    }

    this.onTick?.({ t, row: this.#row, status });
  }

  #record(entry) {
    this.#log.push(entry);
    if (this.#log.length > 400) this.#log.shift();
    this.onEvent?.(entry);
  }
}
