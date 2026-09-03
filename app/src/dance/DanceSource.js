// A Controller input source fed by the dance track.
//
// The playground already arbitrates between a gamepad, a touch pad and
// the keyboard through one small interface, so the cleanest way in for a
// video-driven command is to be another one of those. Registered first,
// it outranks the human inputs while a routine plays and steps aside the
// moment playback stops, so the keyboard still works between takes.
//
// See game/controls/controller.js for the interface this implements.

export class DanceSource {
  id = "dance";
  connected = true;
  command = new Float32Array(3); // [vx, vy, wz], written by the player
  axes = { jaw: 0, orbitX: 0, orbitY: 0, ride: 0 };
  pressed = {};
  onAction = () => {};

  #playing = false;

  // The controller reads `command` without copying, so writes have to
  // land in place rather than replacing the array.
  setCommand(vx, vy, wz) {
    this.command[0] = vx;
    this.command[1] = vy;
    this.command[2] = wz;
  }

  // Jaw opening rides along with the routine: the duck bills along to
  // the music instead of dancing with its beak clamped shut.
  setJaw(v) {
    this.axes.jaw = v > 0 ? (v < 1 ? v : 1) : 0;
  }

  setPlaying(v) {
    this.#playing = !!v;
    if (!v) {
      this.command.fill(0);
      this.axes.jaw = 0;
    }
  }

  get playing() {
    return this.#playing;
  }

  // Claiming authority only while playing is what hands the duck back to
  // the keyboard on pause, rather than pinning it to a stale command.
  isActive() {
    return this.#playing;
  }

  init() {}
  dispose() {
    this.setPlaying(false);
  }
  poll() {}
}
