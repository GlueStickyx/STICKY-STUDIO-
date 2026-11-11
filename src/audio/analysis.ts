// Offline analysis on raw sample data: transient detection for auto-slicing, tempo estimate, waveform peaks.
// Pure functions on Float32Array so they can be tested without a browser.

const FRAME = 1024;
const HOP = 512;

/**
 * Onset strength per hop: positive change in log energy, measured on the full signal and on a
 * treble-weighted copy, so a snare or hat landing on top of a sustained bass note still registers.
 */
export function onsetEnvelope(mono: Float32Array): Float32Array {
  const n = Math.max(0, Math.floor((mono.length - FRAME) / HOP) + 1);
  const env = new Float32Array(n);
  let prev = 0, prevHi = 0;
  for (let i = 0; i < n; i++) {
    let e = 0, eh = 0;
    const o = i * HOP;
    for (let j = 0; j < FRAME; j++) {
      const v = mono[o + j];
      const d = v - (o + j > 0 ? mono[o + j - 1] : 0);
      e += v * v; eh += d * d;
    }
    const le = Math.log10(1e-6 + e / FRAME), lh = Math.log10(1e-7 + eh / FRAME);
    env[i] = i === 0 ? 0 : Math.max(0, le - prev) + Math.max(0, lh - prevHi);
    prev = le; prevHi = lh;
  }
  return env;
}

/**
 * Find transient positions in seconds. sensitivity 0..1: higher finds more slices.
 * A peak counts when it exceeds the local average by a margin and is the largest within its neighbourhood.
 */
export function detectTransients(mono: Float32Array, sampleRate: number, sensitivity = 0.5, minGap = 0.08): number[] {
  const env = onsetEnvelope(mono);
  const hopSec = HOP / sampleRate;
  const win = Math.max(4, Math.round(0.5 / hopSec));
  let globalMax = 0;
  for (const v of env) if (v > globalMax) globalMax = v;
  if (globalMax <= 0) return [];
  const k = 3.2 - sensitivity * 2.8; // threshold multiplier over the local mean
  const floor = globalMax * (0.25 - sensitivity * 0.22);
  const gapHops = Math.max(1, Math.round(minGap / hopSec));
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i];
    if (v < floor || v < env[i - 1] || v < env[i + 1]) continue;
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - win); j < Math.min(env.length, i + win); j++) { sum += env[j]; cnt++; }
    if (v < (sum / cnt) * k) continue;
    if (i - last < gapHops) continue;
    last = i;
    // Walk back to where the rise starts, so the slice begins just before the hit.
    let s = i * HOP;
    const lim = Math.max(0, s - HOP);
    let peak = 0;
    for (let j = s; j < Math.min(mono.length, s + FRAME); j++) peak = Math.max(peak, Math.abs(mono[j]));
    while (s > lim && Math.abs(mono[s]) > peak * 0.1) s--;
    out.push(s / sampleRate);
  }
  return out;
}

/**
 * Rough tempo estimate from the autocorrelation of the onset envelope. Returns null if nothing periodic.
 * Tempo is ambiguous by octaves (75 vs 150 BPM); candidates are weighted toward the 80-160 range.
 */
export function estimateBpm(mono: Float32Array, sampleRate: number): number | null {
  const raw = onsetEnvelope(mono);
  const hopSec = HOP / sampleRate;
  if (raw.length * hopSec < 2) return null;
  let mean = 0;
  for (const v of raw) mean += v;
  mean /= raw.length;
  // Smooth so a beat period that falls between two hops still lines up with itself.
  let env = Float32Array.from(raw, (v) => v - mean);
  for (let pass = 0; pass < 2; pass++) {
    const sm = new Float32Array(env.length);
    for (let i = 0; i < env.length; i++) sm[i] = 0.25 * (env[i - 1] ?? 0) + 0.5 * env[i] + 0.25 * (env[i + 1] ?? 0);
    env = sm;
  }
  // Normalised autocorrelation, so long lags are not penalised for having fewer overlapping frames.
  const ac = (lag: number) => {
    let c = 0;
    const n = env.length - lag;
    for (let i = 0; i < n; i++) c += env[i] * env[i + lag];
    return c / n;
  };
  const zero = ac(0);
  if (zero <= 0) return null;
  const minLag = Math.max(2, Math.floor(60 / 200 / hopSec)), maxLag = Math.min(Math.ceil(60 / 60 / hopSec), Math.floor(env.length / 2));
  const scores = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) scores[lag] = ac(lag);
  let best = -Infinity, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (scores[lag] < scores[lag - 1] || scores[lag] < scores[lag + 1]) continue; // local peaks only
    const bpm = 60 / (lag * hopSec);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.7, 2));
    const score = (scores[lag] / zero) * prior;
    if (score > best) { best = score; bestLag = lag; }
  }
  if (!bestLag || scores[bestLag] / zero < 0.08) return null;
  // Parabolic interpolation between hops for a finer estimate.
  const y0 = scores[bestLag - 1], y1 = scores[bestLag], y2 = scores[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const lag = bestLag + (denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0);
  return Math.round((60 / (lag * hopSec)) * 10) / 10;
}

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
}

export const PEAK_BUCKET = 256;
/** Min/max pairs per bucket of PEAK_BUCKET samples, for drawing. */
export function computePeaks(mono: Float32Array): Float32Array {
  const n = Math.ceil(mono.length / PEAK_BUCKET);
  const peaks = new Float32Array(n * 2);
  for (let b = 0; b < n; b++) {
    let lo = Infinity, hi = -Infinity;
    const end = Math.min(mono.length, (b + 1) * PEAK_BUCKET);
    for (let i = b * PEAK_BUCKET; i < end; i++) { const v = mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    peaks[b * 2] = lo; peaks[b * 2 + 1] = hi;
  }
  return peaks;
}

export interface AudioDescription {
  seconds: number; peak: number; rms: number;
  /** Share of energy below 200 Hz, 200 Hz-2 kHz, and above 2 kHz. Sums to 1. */
  low: number; mid: number; high: number;
  /** Milliseconds from the start to the loudest point: short = percussive. */
  attackMs: number;
  hint: string;
}

/** Numeric description of a piece of audio, so the assistant can tell a kick from a hat without hearing it. */
export function describeAudio(mono: Float32Array, sampleRate: number): AudioDescription {
  const r = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
  const aLow = 1 - Math.exp((-2 * Math.PI * 200) / sampleRate), aMid = 1 - Math.exp((-2 * Math.PI * 2000) / sampleRate);
  let lp1 = 0, lp2 = 0, eLow = 0, eMid = 0, eHigh = 0, sum = 0, peak = 0, peakAt = 0;
  for (let i = 0; i < mono.length; i++) {
    const x = mono[i];
    lp1 += aLow * (x - lp1); lp2 += aMid * (x - lp2);
    eLow += lp1 * lp1; eMid += (lp2 - lp1) ** 2; eHigh += (x - lp2) ** 2;
    sum += x * x;
    if (Math.abs(x) > peak) { peak = Math.abs(x); peakAt = i; }
  }
  const total = eLow + eMid + eHigh || 1;
  const low = eLow / total, mid = eMid / total, high = eHigh / total;
  const rms = Math.sqrt(sum / Math.max(1, mono.length));
  const hint = rms < 0.003 ? 'near silence'
    : low > 0.6 ? 'low and heavy: kick or bass note'
    : high > 0.5 ? 'bright or noisy: hat, cymbal, shaker or snare top'
    : low > 0.3 && high > 0.2 ? 'full range: kick with something on top, or a full mix'
    : 'mid-focused: snare, vocal, chord or melodic material';
  return { seconds: r(mono.length / sampleRate), peak: r(peak), rms: r(rms), low: r(low, 2), mid: r(mid, 2), high: r(high, 2), attackMs: Math.round((peakAt / sampleRate) * 1000), hint };
}
