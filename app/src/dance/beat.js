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

  const bins = FFT_SIZE / 2;
  let prev = new Float32Array(bins);
  const cur = new Float32Array(bins);
  const env = new Float32Array(nFrames);

  forEachSpectrum(samples, nFrames, (mag, f) => {
    let flux = 0;
    for (let b = 0; b < bins; b++) {
      cur[b] = Math.log1p(1000 * mag[b]);
      const d = cur[b] - prev[b];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    prev.set(cur);
  });

  return { env: rectify(env, rate), rate };
}

/**
 * Walk the short-time spectrum, handing each frame's magnitudes to `cb`.
 *
 * The buffer is reused between frames: a caller that needs to keep a
 * frame must copy it. That is what lets the onset envelope and the band
 * energies come out of a single pass over a three-minute song instead of
 * two.
 */
function forEachSpectrum(samples, nFrames, cb) {
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  const bins = FFT_SIZE / 2;
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mag = new Float32Array(bins);
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b], im[b]);
    cb(mag, f);
  }
}

// Subtract a local mean and half-wave rectify: this is what turns a
// drifting loudness curve into a spiky "something just happened" trace,
// then normalise so thresholds downstream are scale free.
function rectify(raw, rate) {
  const n = raw.length;
  const smoothWin = Math.max(3, Math.round(rate * 0.35) | 1);
  const half = (smoothWin - 1) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      sum += raw[j]; cnt++;
    }
    out[i] = Math.max(0, raw[i] - sum / cnt);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) if (out[i] > peak) peak = out[i];
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
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

// ── Musical structure ──────────────────────────────────────────────────
//
// A beat grid alone is enough to put a move ON the beat, but not enough
// to make a routine read as choreography. For that you need to know
// where the bar starts (so a figure begins on the one and not on the
// three), which parts of the song are the loud ones (so the duck is
// bigger in the chorus than in the verse), and where the song changes
// (so the routine changes with it). Everything below computes exactly
// those three things, and nothing else.

// Band edges in Hz. Low is the kick and bass that a body moves to; high
// is the hats and air that a head moves to. The split is coarse on
// purpose: this drives the SIZE of a gesture, not its pitch.
const BAND_HZ = { low: 250, mid: 2500 };

/**
 * Onset envelope and per-band energy from one pass over the samples.
 * @returns {{env:Float32Array, low:Float32Array, mid:Float32Array,
 *            high:Float32Array, rate:number}}
 */
export function spectralFeatures(samples, sampleRate) {
  const nFrames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const rate = sampleRate / HOP;
  const empty = new Float32Array(0);
  if (nFrames < 2) return { env: empty, low: empty, mid: empty, high: empty, rate };

  const bins = FFT_SIZE / 2;
  const binHz = sampleRate / FFT_SIZE;
  const loEnd = Math.max(1, Math.min(bins, Math.round(BAND_HZ.low / binHz)));
  const midEnd = Math.max(loEnd + 1, Math.min(bins, Math.round(BAND_HZ.mid / binHz)));

  let prev = new Float32Array(bins);
  const cur = new Float32Array(bins);
  const raw = new Float32Array(nFrames);
  const low = new Float32Array(nFrames);
  const mid = new Float32Array(nFrames);
  const high = new Float32Array(nFrames);

  forEachSpectrum(samples, nFrames, (mag, f) => {
    let flux = 0, a = 0, b = 0, c = 0;
    for (let k = 0; k < bins; k++) {
      cur[k] = Math.log1p(1000 * mag[k]);
      const d = cur[k] - prev[k];
      if (d > 0) flux += d;
      const p = mag[k] * mag[k];
      if (k < loEnd) a += p; else if (k < midEnd) b += p; else c += p;
    }
    raw[f] = flux;
    low[f] = Math.sqrt(a); mid[f] = Math.sqrt(b); high[f] = Math.sqrt(c);
    prev.set(cur);
  });

  // Each band is normalised on its own: what matters downstream is how
  // loud the bass is RELATIVE TO ITSELF over the song, not whether this
  // mix has more bass than treble.
  return { env: rectify(raw, rate), low: norm(low), mid: norm(mid), high: norm(high), rate };
}

function norm(a) {
  let peak = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > peak) peak = a[i];
  if (peak > 0) for (let i = 0; i < a.length; i++) a[i] /= peak;
  return a;
}

// Read a frame series at a time in seconds, taking the strongest value in
// a small window: a kick lands a frame or two either side of where the
// grid says it should, and the peak is the honest reading of "how hard
// was this beat hit".
function peakAt(series, rate, t, halfWindow = 0.06) {
  if (!series.length) return 0;
  const i0 = Math.max(0, Math.round((t - halfWindow) * rate));
  const i1 = Math.min(series.length - 1, Math.round((t + halfWindow) * rate));
  let m = 0;
  for (let i = i0; i <= i1; i++) if (series[i] > m) m = series[i];
  return m;
}

/**
 * How hard each beat of the grid is hit.
 * @returns {Float32Array} one value per beat, already scale free
 */
export function beatSalience(env, rate, beats) {
  const out = new Float32Array(beats.length);
  for (let i = 0; i < beats.length; i++) out[i] = peakAt(env, rate, beats[i]);
  return out;
}

/**
 * Which beat of the grid is the downbeat.
 *
 * Music puts its weight on the one. So for each candidate phase we ask
 * how strong the beats falling on that phase are on average, and take
 * the phase that wins. Four beats to the bar is assumed: three-four
 * exists but is vanishingly rare in the music anyone will drop in here,
 * and guessing it wrong costs more than not guessing at all.
 *
 * @returns {{beatsPerBar:number, phase:number, confidence:number}}
 *          confidence 0 means no phase stood out, and the caller should
 *          treat the first beat as the one rather than trusting this.
 */
export function meter(salience, { beatsPerBar = 4 } = {}) {
  if (salience.length < beatsPerBar * 2) {
    return { beatsPerBar, phase: 0, confidence: 0 };
  }
  const scores = [];
  for (let p = 0; p < beatsPerBar; p++) {
    let sum = 0, cnt = 0;
    for (let i = p; i < salience.length; i += beatsPerBar) { sum += salience[i]; cnt++; }
    scores.push(cnt ? sum / cnt : 0);
  }
  let best = 0;
  for (let p = 1; p < beatsPerBar; p++) if (scores[p] > scores[best]) best = p;
  const mean = scores.reduce((a, b) => a + b, 0) / beatsPerBar;
  const confidence = mean > 1e-9 ? Math.min(1, (scores[best] - mean) / mean) : 0;
  return { beatsPerBar, phase: best, confidence };
}

/**
 * Cut the beat grid into bars, each carrying what the music is doing in it.
 * @returns {Array<{index:number,t0:number,t1:number,beats:number[],
 *                  low:number,mid:number,high:number,onset:number}>}
 */
export function buildBars(beats, { phase = 0, beatsPerBar = 4 }, feat) {
  const bars = [];
  if (beats.length < beatsPerBar + 1) return bars;
  const mean = (series, t0, t1) => {
    if (!series?.length) return 0;
    const i0 = Math.max(0, Math.round(t0 * feat.rate));
    const i1 = Math.min(series.length - 1, Math.round(t1 * feat.rate));
    if (i1 <= i0) return series[i0] ?? 0;
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += series[i];
    return sum / (i1 - i0 + 1);
  };
  for (let i = phase; i + beatsPerBar < beats.length; i += beatsPerBar) {
    const t0 = beats[i], t1 = beats[i + beatsPerBar];
    const within = [];
    for (let k = 0; k < beatsPerBar; k++) within.push(beats[i + k]);
    bars.push({
      index: bars.length, t0, t1, beats: within,
      low: mean(feat.low, t0, t1),
      mid: mean(feat.mid, t0, t1),
      high: mean(feat.high, t0, t1),
      onset: mean(feat.env, t0, t1),
    });
  }
  return bars;
}

/**
 * Where the song changes character.
 *
 * Novelty is the distance between what the music was doing over the bars
 * before a point and what it does over the bars after it. A verse going
 * into a chorus moves a long way in that space; a verse continuing does
 * not. Peaks in that curve, kept a musical distance apart, are the
 * section boundaries.
 *
 * Boundaries snap to a multiple of four bars where one is close, because
 * that is where songs actually change, and a section starting on bar
 * three of a phrase reads as a mistake even when the spectrum likes it.
 *
 * @returns {Array<{index:number,i0:number,i1:number,t0:number,t1:number,
 *                  energy:number,level:number,kind:string}>}
 */
export function sections(bars, { window = 4, minBars = 8, snap = 4 } = {}) {
  if (bars.length < minBars * 2) {
    return bars.length ? [wholeSection(bars)] : [];
  }
  const vec = (b) => [b.low, b.mid, b.high, b.onset];
  const novelty = new Float32Array(bars.length);
  for (let i = window; i <= bars.length - window; i++) {
    const before = [0, 0, 0, 0], after = [0, 0, 0, 0];
    for (let k = 1; k <= window; k++) {
      const a = vec(bars[i - k]), b = vec(bars[i + k - 1]);
      for (let c = 0; c < 4; c++) { before[c] += a[c] / window; after[c] += b[c] / window; }
    }
    let d = 0;
    for (let c = 0; c < 4; c++) d += (after[c] - before[c]) ** 2;
    novelty[i] = Math.sqrt(d);
  }

  let peak = 0, sum = 0;
  for (let i = 0; i < novelty.length; i++) { peak = Math.max(peak, novelty[i]); sum += novelty[i]; }
  const mean = sum / novelty.length;
  // A boundary has to stand clearly above the ordinary bar-to-bar drift,
  // otherwise a steady song gets chopped into arbitrary pieces.
  const threshold = Math.max(mean * 1.6, peak * 0.4);

  const cuts = [];
  for (let i = window; i <= bars.length - window; i++) {
    if (novelty[i] < threshold) continue;
    if (novelty[i] < novelty[i - 1] || novelty[i] < novelty[i + 1]) continue;
    const snapped = snap > 1 ? Math.round(i / snap) * snap : i;
    const at = Math.abs(snapped - i) <= 1 ? snapped : i;
    if (at < minBars || at > bars.length - minBars) continue;
    if (cuts.length && at - cuts[cuts.length - 1] < minBars) continue;
    cuts.push(at);
  }

  const edges = [0, ...cuts, bars.length];
  const out = [];
  for (let s = 0; s + 1 < edges.length; s++) {
    out.push(makeSection(bars, edges[s], edges[s + 1], out.length));
  }
  return rankSections(out);
}

function wholeSection(bars) {
  return rankSections([makeSection(bars, 0, bars.length, 0)])[0];
}

function makeSection(bars, i0, i1, index) {
  let energy = 0;
  for (let i = i0; i < i1; i++) energy += bars[i].low + bars[i].mid + bars[i].onset;
  return {
    index, i0, i1, t0: bars[i0].t0, t1: bars[i1 - 1].t1,
    energy: energy / Math.max(1, i1 - i0), level: 0, kind: "groove",
  };
}

// Loudness only means something next to the rest of the same song, so the
// level is where a section sits in ITS song's range, not an absolute.
function rankSections(list) {
  let lo = Infinity, hi = -Infinity;
  for (const s of list) { lo = Math.min(lo, s.energy); hi = Math.max(hi, s.energy); }
  const span = hi - lo;
  for (const s of list) {
    s.level = span > 1e-9 ? (s.energy - lo) / span : 0.5;
    s.kind = s.level >= 0.66 ? "peak" : s.level >= 0.33 ? "groove" : "calm";
  }
  return list;
}

/**
 * Everything the choreographer needs to know about a piece of music.
 *
 * @param {{sampleRate:number, duration:number, getChannelData:Function,
 *          numberOfChannels:number}} buffer
 */
export function analyseMusic(buffer) {
  const sr = buffer.sampleRate;
  const n = buffer.length ?? buffer.getChannelData(0).length;
  const mono = new Float32Array(n);
  const chs = buffer.numberOfChannels ?? 1;
  for (let c = 0; c < chs; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / chs;
  }
  const duration = buffer.duration ?? n / sr;
  const feat = spectralFeatures(mono, sr);
  const { bpm, confidence } = estimateTempo(feat.env, feat.rate);
  const beats = beatGrid(feat.env, feat.rate, bpm, duration);
  const salience = beatSalience(feat.env, feat.rate, beats);
  const m = meter(salience);
  // A meter reading nobody believes is worse than none: starting every
  // figure on the first beat is at least consistently wrong, where a
  // wrong phase is wrong in a way that fights the music.
  const phase = m.confidence >= 0.08 ? m.phase : 0;
  const bars = buildBars(beats, { phase, beatsPerBar: m.beatsPerBar }, feat);
  return {
    bpm, confidence, beats, salience, duration, feat,
    beatPeriod: bpm > 0 ? 60 / bpm : 0,
    beatsPerBar: m.beatsPerBar, phase, meterConfidence: m.confidence,
    bars, sections: sections(bars),
  };
}
