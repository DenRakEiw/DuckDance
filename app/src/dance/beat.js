// Tempo and beat grid from the video's own soundtrack.
//
// Moves that land on the beat read as choreography; the same moves a
// tenth of a second early read as a glitch. So before we schedule
// anything we work out where the beats are.
//
// The chain is the standard one: spectral flux onset envelope, tempo by
// autocorrelation, then the phase that best explains the onsets. Kept
// pure and sample-rate agnostic so it runs under node in the tests; only
// decodeAudio() touches the browser.

// ── FFT ────────────────────────────────────────────────────────────────
// In-place iterative radix-2 Cooley-Tukey. n must be a power of two.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export const FFT_SIZE = 1024;
export const HOP = 512;

/**
 * Spectral flux onset envelope.
 *
 * Sums only the RISES in magnitude between neighbouring frames: a note
 * starting is a rise across many bins at once, while a note ending is a
 * fall and carries no rhythmic information. Log magnitudes keep a quiet
 * hi-hat from being buried under a loud bass line.
 *
 * @returns {{env: Float32Array, rate: number}} envelope and its rate in Hz
 */
export function onsetEnvelope(samples, sampleRate) {
  const nFrames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const rate = sampleRate / HOP;
  if (nFrames < 2) return { env: new Float32Array(0), rate };

  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  const bins = FFT_SIZE / 2;
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  let prev = new Float32Array(bins);
  const env = new Float32Array(nFrames);

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    const mag = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      mag[b] = Math.log1p(1000 * Math.hypot(re[b], im[b]));
      const d = mag[b] - prev[b];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    prev = mag;
  }

  // Subtract a local mean and half-wave rectify: this is what turns a
  // drifting loudness curve into a spiky "something just happened" trace.
  const smoothWin = Math.max(3, Math.round(rate * 0.35) | 1);
  const half = (smoothWin - 1) / 2;
  const out = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let sum = 0, cnt = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= nFrames) continue;
      sum += env[j]; cnt++;
    }
    out[i] = Math.max(0, env[i] - sum / cnt);
  }
  // Normalise so thresholds downstream are scale free.
  let peak = 0;
  for (let i = 0; i < nFrames; i++) if (out[i] > peak) peak = out[i];
  if (peak > 0) for (let i = 0; i < nFrames; i++) out[i] /= peak;
  return { env: out, rate };
}

/**
 * Tempo by autocorrelation of the onset envelope.
 *
 * Autocorrelation cannot tell a tempo from half or double of it, so the
 * candidates are weighted by how close they sit to 120 BPM, where most
 * dance music lives. That is a bias, not a truth, which is why the UI
 * lets the number be overridden.
 *
 * @returns {{bpm: number, confidence: number, curve: Float32Array}}
 *          bpm is 0 when the signal carries no rhythm to find.
 */
export function estimateTempo(env, rate, { minBpm = 60, maxBpm = 190 } = {}) {
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * rate));
  const maxLag = Math.min(env.length - 1, Math.ceil((60 / minBpm) * rate));
  if (maxLag <= minLag) return { bpm: 0, confidence: 0, curve: new Float32Array(0) };

  // No onsets, no tempo. Silence and steady tones would otherwise still
  // produce a peak somewhere, and a grid built on that would drag every
  // move onto beats that do not exist.
  let energy = 0;
  for (let i = 0; i < env.length; i++) energy += env[i];
  if (energy <= 1e-6) return { bpm: 0, confidence: 0, curve: new Float32Array(0) };

  const curve = new Float32Array(maxLag - minLag + 1);
  let best = -1, bestScore = -Infinity, total = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < env.length; i++) sum += env[i] * env[i + lag];
    const n = Math.max(1, env.length - lag);
    const bpm = (60 * rate) / lag;
    // Log-normal prior around 120 BPM, gentle enough that a clear 90 or
    // 150 still wins on its own evidence.
    const prior = Math.exp(-0.5 * ((Math.log(bpm / 120) / 0.55) ** 2));
    const score = (sum / n) * prior;
    curve[lag - minLag] = score;
    total += score;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  // Sub-lag refinement. At dance tempos the peak sits around lag 20, so
  // a whole-sample peak is only good to about 2.5 percent -- enough to
  // drift a grid by a tenth of a second across ten seconds of music.
  // Fitting a parabola through the peak and its two neighbours recovers
  // the fractional lag and with it a tempo good to a fraction of a BPM.
  let refined = best;
  const k = best - minLag;
  if (k > 0 && k < curve.length - 1) {
    const y0 = curve[k - 1], y1 = curve[k], y2 = curve[k + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      const off = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(off) <= 1) refined = best + off;
    }
  }
  const bpm = (60 * rate) / refined;
  const mean = total / curve.length;
  const confidence = mean > 0 ? Math.min(1, bestScore / (mean * 4)) : 0;
  return { bpm, confidence, curve };
}

/**
 * Lay a constant-tempo grid over the clip and pick the phase that puts
 * the most onset energy on the beat.
 *
 * A fixed grid is a deliberate simplification: it cannot follow a
 * ritardando, but it never drifts inside a clip that does hold tempo,
 * which is the common case and the one where a wobbly grid would be
 * obvious.
 */
export function beatGrid(env, rate, bpm, duration) {
  if (!bpm || !env.length) return [];
  let energy = 0;
  for (let i = 0; i < env.length; i++) energy += env[i];
  if (energy <= 1e-6) return []; // nothing to phase-align against

  // Read the envelope at a fractional frame, so neither the period nor
  // the phase search is quantised to whole analysis frames.
  const at = (x) => {
    if (x < 0 || x > env.length - 1) return 0;
    const i = Math.floor(x), a = x - i;
    return env[i] * (1 - a) + env[Math.min(i + 1, env.length - 1)] * a;
  };

  // Score a grid by how much onset energy lands on its beats.
  const score = (periodFrames, phase) => {
    let sum = 0;
    for (let x = phase; x <= env.length - 1; x += periodFrames) sum += at(x);
    return sum;
  };

  // Joint search over period and phase.
  //
  // Refining the tempo alone is not enough: the autocorrelation peak is
  // only good to a fraction of a percent, and across ten seconds even
  // that drifts the last beat away from the music by more than the
  // quantisation window. Optimising the grid directly against the onsets
  // is both cheaper to reason about and exactly the thing we care about.
  const base = period0(bpm, rate);
  let bestP = base, bestPhase = 0, bestScore = -Infinity;
  const SPAN = 0.05, STEPS = 80, PHASES = 96;
  for (let k = 0; k <= STEPS; k++) {
    const p = base * (1 - SPAN + (2 * SPAN * k) / STEPS);
    for (let s = 0; s < PHASES; s++) {
      const phase = (s / PHASES) * p;
      const sc = score(p, phase);
      if (sc > bestScore) { bestScore = sc; bestP = p; bestPhase = phase; }
    }
  }

  const beats = [];
  for (let x = bestPhase; x / rate <= duration + 1e-9; x += bestP) {
    beats.push(x / rate);
  }
  return beats;
}

const period0 = (bpm, rate) => (60 / bpm) * rate;

/**
 * Full analysis over a decoded AudioBuffer-like object.
 * @param {{sampleRate:number, duration:number, getChannelData:Function,
 *          numberOfChannels:number}} buffer
 */
export function analyseBuffer(buffer) {
  const sr = buffer.sampleRate;
  const n = buffer.length ?? buffer.getChannelData(0).length;
  // Downmix to mono. Stereo width carries no rhythm we need.
  const mono = new Float32Array(n);
  const chs = buffer.numberOfChannels ?? 1;
  for (let c = 0; c < chs; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / chs;
  }
  const { env, rate } = onsetEnvelope(mono, sr);
  const duration = buffer.duration ?? n / sr;
  const { bpm, confidence } = estimateTempo(env, rate);
  const beats = beatGrid(env, rate, bpm, duration);
  return { bpm, confidence, beats, env, envRate: rate, duration };
}

/**
 * Decode a media file's audio in the browser. Returns null when the
 * browser cannot decode that codec, which is a normal outcome for some
 * phone recordings; the caller falls back to an unquantised timeline.
 */
export async function decodeAudio(arrayBuffer) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    return null;
  } finally {
    ctx.close?.();
  }
}
