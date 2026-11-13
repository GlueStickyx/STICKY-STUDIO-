// Whole-track analysis for the Analyze page: suggested loops, single hits, and pitched voice-like lines.
// Pure functions on mono sample data, so they can be tested without a browser. Signal measurements only:
// no AI model, so "vocal" is an estimate (a sung line and a lead synth both look like steady pitch).
import { describeAudio, detectTransients, estimateBpm, onsetEnvelope } from './analysis';

export interface Region { start: number; end: number }
export interface LoopSuggestion extends Region { bars: number; score: number }
export interface HitSuggestion extends Region { kind: 'low' | 'mid' | 'high'; label: string; strength: number }
export interface VoiceSuggestion extends Region { score: number; pitchHz: number }
export interface TrackAnalysis { bpm: number | null; firstBeat: number; loops: LoopSuggestion[]; hits: HitSuggestion[]; voice: VoiceSuggestion[]; analysedSeconds: number }

const HOP = 512; // onsetEnvelope's hop size
export const MAX_ANALYSE_SECONDS = 360;

function rmsOf(x: Float32Array, a: number, b: number) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

/** Cosine similarity of two equal-length slices of an envelope. 1 = the same rhythm. */
function similarity(env: Float32Array, a: number, b: number, n: number) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const x = env[a + i] ?? 0, y = env[b + i] ?? 0; ab += x * y; aa += x * x; bb += y * y; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * Loops: bar-aligned windows of 1, 2 or 4 bars that repeat (the next window has the same rhythm) and are not
 * quiet. Bars are counted from the first strong hit, so the grid follows the music, not the file start.
 */
export function findLoops(mono: Float32Array, sr: number, bpm: number, firstBeat: number, env = onsetEnvelope(mono)): LoopSuggestion[] {
  const bar = 240 / bpm, dur = mono.length / sr, hopSec = HOP / sr;
  const loud = rmsOf(mono, 0, mono.length);
  const cands: LoopSuggestion[] = [];
  for (const bars of [4, 2, 1]) {
    const len = bar * bars, n = Math.round(len / hopSec);
    for (let s = firstBeat; s + len * 2 <= dur + 0.01; s += bar) {
      const a = Math.round(s / hopSec), b = Math.round((s + len) / hopSec);
      const rep = similarity(env, a, b, n);
      const level = rmsOf(mono, Math.floor(s * sr), Math.floor((s + len) * sr)) / (loud || 1);
      if (level < 0.4) continue; // breakdowns and silence make poor loops
      cands.push({ start: s, end: s + len, bars, score: rep * Math.min(1, level) + bars * 0.02 }); // slight preference for longer loops
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const out: LoopSuggestion[] = [];
  for (const c of cands) {
    if (c.score < 0.5) break;
    if (out.some((o) => c.start < o.end && o.start < c.end)) continue; // spread suggestions across the song
    out.push(c);
    if (out.length === 8) break;
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Hits: the strongest separate transients, each cut until the next hit (at most 0.6 s), labelled by tone. */
export function findHits(mono: Float32Array, sr: number, max = 16): HitSuggestion[] {
  const at = detectTransients(mono, sr, 0.35, 0.09);
  const all = at.map((t, i) => {
    const end = Math.min(at[i + 1] ?? Infinity, t + 0.6, mono.length / sr);
    const seg = mono.subarray(Math.floor(t * sr), Math.floor(end * sr));
    const d = describeAudio(seg, sr);
    const kind: HitSuggestion['kind'] = d.low > 0.55 ? 'low' : d.high > 0.45 ? 'high' : 'mid';
    return { start: t, end, kind, label: kind === 'low' ? 'kick or bass hit' : kind === 'high' ? 'hat, shaker or noise' : 'snare, clap or tone', strength: d.peak };
  }).filter((h) => h.end - h.start > 0.04);
  // Keep a mix of tones: the strongest few of each kind, then fill with the strongest of the rest.
  const pick: HitSuggestion[] = [];
  for (const kind of ['low', 'mid', 'high'] as const) pick.push(...all.filter((h) => h.kind === kind).sort((a, b) => b.strength - a.strength).slice(0, Math.ceil(max / 3)));
  return pick.sort((a, b) => b.strength - a.strength).slice(0, max).sort((a, b) => a.start - b.start);
}

/**
 * Voice-like lines: stretches where a steady pitch between 90 and 900 Hz holds for a while, in the vocal
 * frequency band. Works on a copy resampled to about 11 kHz to keep it fast.
 */
export function findVoice(mono: Float32Array, sr: number): VoiceSuggestion[] {
  const step = Math.max(1, Math.round(sr / 11025)), rate = sr / step;
  const n = Math.floor(mono.length / step);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < step; k++) s += mono[i * step + k]; x[i] = s / step; }
  const frame = 512, hop = 256, minLag = Math.floor(rate / 900), maxLag = Math.ceil(rate / 90);
  const loud = rmsOf(x, 0, n) || 1;
  const frames: { t: number; voiced: boolean; strength: number; hz: number }[] = [];
  for (let o = 0; o + frame + maxLag < n; o += hop) {
    const r = rmsOf(x, o, o + frame);
    let best = 0, bestLag = 0;
    if (r > loud * 0.25) {
      let e0 = 0;
      for (let i = 0; i < frame; i++) e0 += x[o + i] * x[o + i];
      for (let lag = minLag; lag <= maxLag; lag++) {
        let c = 0, e1 = 0;
        for (let i = 0; i < frame; i++) { c += x[o + i] * x[o + i + lag]; e1 += x[o + i + lag] * x[o + i + lag]; }
        const v = c / Math.sqrt(e0 * e1 || 1);
        if (v > best) { best = v; bestLag = lag; }
      }
    }
    frames.push({ t: o / rate, voiced: best > 0.82, strength: best, hz: bestLag ? rate / bestLag : 0 });
  }
  // Join voiced frames into lines, bridging gaps shorter than a quarter second; keep lines of 0.6 s or more.
  const out: VoiceSuggestion[] = [];
  const frameSec = hop / rate, bridge = Math.round(0.25 / frameSec);
  let i = 0;
  while (i < frames.length) {
    if (!frames[i].voiced) { i++; continue; }
    let j = i, gap = 0, last = i;
    while (j < frames.length && gap <= bridge) { if (frames[j].voiced) { last = j; gap = 0; } else gap++; j++; }
    const seg = frames.slice(i, last + 1).filter((f) => f.voiced);
    const start = frames[i].t, end = frames[last].t + frame / rate;
    if (end - start >= 0.6) {
      const hz = seg.map((f) => f.hz).sort((a, b) => a - b)[Math.floor(seg.length / 2)];
      out.push({ start, end, score: seg.reduce((s, f) => s + f.strength, 0) / seg.length, pitchHz: Math.round(hz) });
    }
    i = last + 1;
  }
  return out.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 12).sort((a, b) => a.start - b.start);
}

/** Everything the Analyze page shows. Long tracks are analysed over their first six minutes. */
export function analyseTrack(full: Float32Array, sr: number): TrackAnalysis {
  const mono = full.subarray(0, Math.min(full.length, Math.floor(MAX_ANALYSE_SECONDS * sr)));
  const env = onsetEnvelope(mono);
  const bpm = estimateBpm(mono.subarray(0, Math.min(mono.length, sr * 60)), sr);
  // Beat phase: the offset within one beat where the onsets line up best across the whole track. Measured on
  // the low end, because in most grooves the kick sits on the beat and hats sit between beats.
  let firstBeat = 0;
  if (bpm) {
    const a = 1 - Math.exp((-2 * Math.PI * 150) / sr);
    const low = new Float32Array(mono.length);
    let y = 0;
    for (let i = 0; i < mono.length; i++) { y += a * (mono[i] - y); low[i] = y; }
    const lowEnv = rmsOf(low, 0, low.length) > rmsOf(mono, 0, mono.length) * 0.15 ? onsetEnvelope(low) : env;
    const hopSec = HOP / sr, beat = 60 / bpm;
    let best = -1;
    for (let off = 0; off < beat; off += hopSec) {
      let sum = 0;
      for (let t = off; t < lowEnv.length * hopSec; t += beat) sum += lowEnv[Math.round(t / hopSec)] ?? 0;
      if (sum > best) { best = sum; firstBeat = off; }
    }
    // An onset frame starts up to one hop before the hit it contains; shift by a hop and wrap into the beat.
    firstBeat = (firstBeat + hopSec) % beat;
    if (firstBeat > beat - hopSec) firstBeat = 0;
  }
  return {
    bpm, firstBeat,
    loops: bpm ? findLoops(mono, sr, bpm, firstBeat, env) : [],
    hits: findHits(mono, sr),
    voice: findVoice(mono, sr),
    analysedSeconds: mono.length / sr,
  };
}
