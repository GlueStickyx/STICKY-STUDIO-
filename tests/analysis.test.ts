import { describe, it, expect } from 'vitest';
import { PEAK_BUCKET, computePeaks, detectTransients, estimateBpm, mixToMono, onsetEnvelope } from '../src/audio/analysis';
import { synthDemoLoop } from '../src/audio/wav';

const SR = 44100;

function rng(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s / 2147483647) * 2 - 1; };
}

type Kind = 'noise' | 'sine';
/** Silence with short decaying bursts starting at the given times (seconds). */
function bursts(duration: number, times: number[], kind: Kind = 'noise', amp = 0.8): Float32Array {
  const out = new Float32Array(Math.round(duration * SR));
  const rnd = rng(42);
  for (const t of times) {
    const s = Math.round(t * SR);
    const n = Math.round(0.06 * SR);
    for (let i = 0; i < n && s + i < out.length; i++) {
      const x = i / SR;
      const v = kind === 'noise' ? rnd() : Math.cos(2 * Math.PI * 220 * x);
      out[s + i] += v * Math.exp(-60 * x) * amp;
    }
  }
  return out;
}

/** Every expected time has a detection within tol, and there are no extra detections. */
function expectMatches(found: number[], expected: number[], tol = 0.03) {
  for (const t of expected) {
    const nearest = found.reduce((best, f) => (Math.abs(f - t) < Math.abs(best - t) ? f : best), Infinity);
    expect(Math.abs(nearest - t), `burst at ${t}s, nearest detection ${nearest}s, all: ${found.join(', ')}`).toBeLessThanOrEqual(tol);
  }
  expect(found.length, `detections: ${found.join(', ')}`).toBe(expected.length);
}

describe('onsetEnvelope', () => {
  it('has one value per hop and is zero for silence', () => {
    const env = onsetEnvelope(new Float32Array(SR));
    expect(env.length).toBe(Math.floor((SR - 1024) / 512) + 1);
    expect(env.every((v) => v === 0)).toBe(true);
  });

  it('is empty for input shorter than one frame', () => {
    expect(onsetEnvelope(new Float32Array(1000)).length).toBe(0);
    expect(onsetEnvelope(new Float32Array(0)).length).toBe(0);
  });

  it('is never negative and peaks where a burst starts', () => {
    const env = onsetEnvelope(bursts(2, [1.0]));
    let maxI = 0;
    for (let i = 0; i < env.length; i++) {
      expect(env[i]).toBeGreaterThanOrEqual(0);
      if (env[i] > env[maxI]) maxI = i;
    }
    expect(Math.abs((maxI * 512) / SR - 1.0)).toBeLessThan(0.03);
  });
});

describe('detectTransients', () => {
  it('finds nothing in silence', () => {
    expect(detectTransients(new Float32Array(SR * 3), SR)).toEqual([]);
    expect(detectTransients(new Float32Array(SR * 3), SR, 1)).toEqual([]);
  });

  it('finds nothing in empty or very short input', () => {
    expect(detectTransients(new Float32Array(0), SR)).toEqual([]);
    expect(detectTransients(new Float32Array(500), SR)).toEqual([]);
  });

  it('finds nothing in a constant (DC) signal', () => {
    expect(detectTransients(new Float32Array(SR * 2).fill(0.5), SR)).toEqual([]);
  });

  const irregular = [0.3, 0.71, 1.05, 1.9, 2.33, 3.2];

  it('finds each noise burst within 30 ms', () => {
    expectMatches(detectTransients(bursts(4, irregular, 'noise'), SR), irregular);
  });

  it('finds each sine burst within 30 ms', () => {
    expectMatches(detectTransients(bursts(4, irregular, 'sine'), SR), irregular);
  });

  it('finds bursts whatever their alignment to the analysis hop', () => {
    // Slide a pair of bursts through one hop (512 samples) in small steps.
    for (let shift = 0; shift < 512; shift += 37) {
      const times = [0.5 + shift / SR, 1.5 + shift / SR];
      expectMatches(detectTransients(bursts(2.5, times, 'noise'), SR), times);
    }
  });

  it('finds quiet bursts next to loud ones at default sensitivity', () => {
    const sig = bursts(3, [0.5, 1.5, 2.5], 'noise', 0.8);
    const quiet = bursts(3, [1.0, 2.0], 'noise', 0.1);
    for (let i = 0; i < sig.length; i++) sig[i] += quiet[i];
    expectMatches(detectTransients(sig, SR), [0.5, 1.0, 1.5, 2.0, 2.5]);
  });

  it('returns sorted times inside the signal', () => {
    const found = detectTransients(bursts(4, irregular), SR);
    expect([...found].sort((a, b) => a - b)).toEqual(found);
    for (const t of found) { expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThan(4); }
  });

  it('respects minGap: two bursts 40 ms apart count once by default', () => {
    const sig = bursts(2, [1.0, 1.04]);
    const found = detectTransients(sig, SR);
    expect(found).toHaveLength(1);
    expect(Math.abs(found[0] - 1.0)).toBeLessThanOrEqual(0.03);
  });

  it('higher sensitivity never finds fewer transients on the demo loop', () => {
    const { data } = synthDemoLoop(SR);
    const lo = detectTransients(data, SR, 0.1).length;
    const mid = detectTransients(data, SR, 0.5).length;
    const hi = detectTransients(data, SR, 0.9).length;
    expect(mid).toBeGreaterThanOrEqual(lo);
    expect(hi).toBeGreaterThanOrEqual(mid);
  });

  it('works at another sample rate', () => {
    const sr = 22050;
    const out = new Float32Array(sr * 2);
    const rnd = rng(5);
    for (const t of [0.5, 1.25]) {
      const s = Math.round(t * sr);
      for (let i = 0; i < sr * 0.05; i++) out[s + i] = rnd() * Math.exp((-60 * i) / sr) * 0.8;
    }
    const found = detectTransients(out, sr);
    expect(found).toHaveLength(2);
    expect(Math.abs(found[0] - 0.5)).toBeLessThanOrEqual(0.05); // hop is twice as long in seconds
    expect(Math.abs(found[1] - 1.25)).toBeLessThanOrEqual(0.05);
  });
});

describe('estimateBpm', () => {
  const every = (period: number, duration: number) => {
    const t: number[] = [];
    for (let x = 0.1; x < duration - 0.1; x += period) t.push(x);
    return t;
  };

  it('returns null for silence', () => {
    expect(estimateBpm(new Float32Array(SR * 4), SR)).toBeNull();
  });

  it('returns null for audio shorter than 2 seconds', () => {
    expect(estimateBpm(bursts(1.5, [0.1, 0.6, 1.1]), SR)).toBeNull();
  });

  it('bursts every 0.5 s give about 120 bpm', () => {
    const bpm = estimateBpm(bursts(8, every(0.5, 8)), SR);
    expect(bpm).not.toBeNull();
    expect(Math.abs(bpm! - 120)).toBeLessThanOrEqual(3);
  });

  it('sine bursts every 0.5 s give about 120 bpm', () => {
    const bpm = estimateBpm(bursts(8, every(0.5, 8), 'sine'), SR);
    expect(bpm).not.toBeNull();
    expect(Math.abs(bpm! - 120)).toBeLessThanOrEqual(3);
  });

  // An even pulse at 174 BPM is indistinguishable from 87 BPM; the estimator deliberately prefers the 80-160 range.
  it.each([[0.6, 100], [0.4, 150], [0.75, 80], [60 / 174, 87]])('bursts every %f s give about %i bpm', (period, want) => {
    const bpm = estimateBpm(bursts(10, every(period, 10)), SR);
    expect(bpm).not.toBeNull();
    expect(Math.abs(bpm! - want)).toBeLessThanOrEqual(want * 0.025);
  });

  it('result is rounded to one decimal', () => {
    const bpm = estimateBpm(bursts(8, every(0.5, 8)), SR)!;
    expect(Math.round(bpm * 10) / 10).toBe(bpm);
  });
});

describe('synthDemoLoop analysis (2 bars at 100 bpm)', () => {
  const { data, bpm } = synthDemoLoop(SR);
  const s16 = 60 / bpm / 4;

  it('estimateBpm returns about 100', () => {
    const got = estimateBpm(data, SR);
    console.log('[demo loop] estimateBpm =', got);
    expect(got).not.toBeNull();
    expect(Math.abs(got! - 100)).toBeLessThanOrEqual(3);
  });

  it('detectTransients finds the kicks and snares, all on the 16th grid', () => {
    const found = detectTransients(data, SR);
    console.log('[demo loop] detectTransients (s) =', found.map((t) => t.toFixed(3)).join(' '));
    console.log('[demo loop] as 16th-note positions =', found.map((t) => (t / s16).toFixed(2)).join(' '));
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found.length).toBeLessThanOrEqual(32);
    // Every detection sits within 30 ms of a 16th-note position.
    for (const t of found) {
      const nearest = Math.round(t / s16) * s16;
      expect(Math.abs(t - nearest), `detection at ${t}s`).toBeLessThanOrEqual(0.03);
    }
    // Snares on steps 4 and 12 of each bar, kicks on 6 and 10 (the kick at 0 is at the very start of the file).
    for (const k of [4, 6, 10, 12, 16 + 4, 16 + 6, 16 + 10, 16 + 12]) {
      const t = k * s16;
      expect(found.some((f) => Math.abs(f - t) <= 0.03), `drum hit at step ${k} (${t.toFixed(3)}s)`).toBe(true);
    }
  });
});

describe('computePeaks', () => {
  it('returns one min/max pair per bucket', () => {
    expect(PEAK_BUCKET).toBe(256);
    expect(computePeaks(new Float32Array(256 * 10)).length).toBe(20);
    expect(computePeaks(new Float32Array(256 * 10 + 1)).length).toBe(22);
    expect(computePeaks(new Float32Array(1)).length).toBe(2);
    expect(computePeaks(new Float32Array(0)).length).toBe(0);
  });

  it('min and max are the true extremes of each bucket', () => {
    const rnd = rng(3);
    const mono = new Float32Array(256 * 7 + 100);
    for (let i = 0; i < mono.length; i++) mono[i] = rnd();
    const peaks = computePeaks(mono);
    expect(peaks.length).toBe(16);
    for (let b = 0; b < 8; b++) {
      const chunk = mono.subarray(b * 256, Math.min(mono.length, (b + 1) * 256));
      let lo = Infinity, hi = -Infinity;
      for (const v of chunk) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      expect(peaks[b * 2]).toBe(lo);
      expect(peaks[b * 2 + 1]).toBe(hi);
      expect(peaks[b * 2]).toBeLessThanOrEqual(peaks[b * 2 + 1]);
    }
  });

  it('places a single spike in the right bucket', () => {
    const mono = new Float32Array(1024);
    mono[600] = 0.9;
    mono[700] = -0.4;
    expect(Array.from(computePeaks(mono))).toEqual([0, 0, 0, 0, -0.4, 0.9, 0, 0].map((v) => Math.fround(v)));
  });

  it('silence gives zero pairs', () => {
    expect(Array.from(computePeaks(new Float32Array(512)))).toEqual([0, 0, 0, 0]);
  });

  it('reports the true extremes of audio hotter than full scale', () => {
    const peaks = computePeaks(new Float32Array(256).fill(1.5));
    expect(peaks[0]).toBe(1.5);
    expect(peaks[1]).toBe(1.5);
    const neg = computePeaks(new Float32Array(256).fill(-1.5));
    expect(neg[0]).toBe(-1.5);
    expect(neg[1]).toBe(-1.5);
  });
});

describe('mixToMono', () => {
  it('returns the single channel untouched', () => {
    const c = new Float32Array([0.1, 0.2]);
    expect(mixToMono([c])).toBe(c);
  });

  it('averages channels', () => {
    const got = mixToMono([new Float32Array([1, 0, -1]), new Float32Array([0, 0, -1])]);
    expect(Array.from(got)).toEqual([0.5, 0, -1]);
  });
});
