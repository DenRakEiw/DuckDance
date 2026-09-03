// A stand-in for a video element, so the built-in routine can drive the
// duck without one.
//
// The player only ever reads currentTime and duration and calls play and
// pause, so that is the whole surface a clock has to provide. Keeping it
// to exactly that subset is deliberate: it means the demo path and the
// upload path go through identical playback code, and a bug in one shows
// up in the other rather than hiding.
//
// Like the player, this is timer-paced rather than frame-paced. A real
// video element's clock keeps running when rendering stalls, so a
// stand-in for one has to as well, or the built-in routine would play in
// slow motion on exactly the machines where rendering is already
// struggling.

export class SyntheticClock {
  #t = 0;
  #playing = false;
  #last = 0;
  #timer = 0;

  constructor(duration = 0) {
    this.duration = duration;
  }

  get currentTime() {
    return this.#t;
  }

  set currentTime(v) {
    this.#t = Math.max(0, Math.min(this.duration, v));
    this.onTime?.(this.#t);
  }

  get paused() {
    return !this.#playing;
  }

  play() {
    if (this.#playing) return Promise.resolve();
    this.#playing = true;
    this.#last = performance.now();
    const TICK_MS = 20; // the simulator's control period
    const tick = () => {
      if (!this.#playing) return;
      const now = performance.now();
      // Clamp the step so a backgrounded tab resumes where it paused
      // instead of jumping the routine forward by however long it slept.
      const dt = Math.min(0.1, (now - this.#last) / 1000);
      this.#last = now;
      this.#t += dt;
      if (this.#t >= this.duration) {
        this.#t = this.duration;
        this.onTime?.(this.#t);
        this.pause();
        this.onEnded?.();
        return;
      }
      this.onTime?.(this.#t);
      this.#timer = setTimeout(tick, TICK_MS);
    };
    this.#timer = setTimeout(tick, TICK_MS);
    return Promise.resolve();
  }

  pause() {
    this.#playing = false;
    clearTimeout(this.#timer);
  }

  dispose() {
    this.pause();
    this.onTime = null;
    this.onEnded = null;
  }
}
