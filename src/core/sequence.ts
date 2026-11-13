// Pure timing maths: which hits fall inside a window of ticks. Shared by live playback and offline export,
// so what you hear is what you render.
import { BAR_TICKS, PPQ, STEP_COUNT, STEP_TICKS } from './types';
import { trackGain } from './types';
import type { Clip, LoopEvent, Note, Project } from './types';

export interface Hit { abs: number; pad: number; vel: number; id?: string; /** Set for piano-roll notes: semitone offset and length in ticks. */ pitch?: number; len?: number }

export const loopTicks = (p: Project) => p.bars * BAR_TICKS;
export const secondsPerTick = (bpm: number) => 60 / bpm / PPQ;

/** Absolute tick of step k, with swing delaying every second 16th. */
export const stepTick = (k: number, swing: number) => k * STEP_TICKS + (k % 2 === 1 ? swing * STEP_TICKS : 0);

/** Anything that can be played as a repeating pattern: the Sampler loop, or a saved clip. */
export interface Pattern { bars: number; stepsOf: (pad: number) => number[] | undefined; events: LoopEvent[]; notes: Note[] }
export const loopPattern = (p: Project): Pattern => ({ bars: p.bars, stepsOf: (i) => p.pads[i].steps, events: p.events, notes: p.notes });
export const clipPattern = (c: Clip): Pattern => ({ bars: c.bars, stepsOf: (i) => c.steps[i], events: c.events, notes: c.notes });

/**
 * Hits of one pattern with from <= abs < to. The pattern starts at absolute tick `start` and repeats
 * until `end`. `gain` scales every velocity (track volume); 0 produces nothing.
 */
export function patternHits(p: Project, pat: Pattern, from: number, to: number, start = 0, end = Infinity, gain = 1): Hit[] {
  const out: Hit[] = [];
  from = Math.max(from, start); to = Math.min(to, end);
  if (to <= from || gain <= 0) return out;
  const f = from - start, t = to - start; // window in the pattern's own time
  for (let k = Math.max(0, Math.floor(f / STEP_TICKS) - 1); k <= Math.ceil(t / STEP_TICKS); k++) {
    const local = stepTick(k, p.swing);
    if (local < f || local >= t) continue;
    const s = k % STEP_COUNT;
    p.pads.forEach((pad, i) => { const v = pad.sampleId ? pat.stepsOf(i)?.[s] ?? 0 : 0; if (v > 0) out.push({ abs: local + start, pad: i, vel: v * gain }); });
  }
  const L = pat.bars * BAR_TICKS;
  for (let n = Math.max(0, Math.floor(f / L)); n * L < t; n++) {
    for (const e of pat.events) {
      const local = n * L + e.tick;
      if (local >= f && local < t) out.push({ abs: local + start, pad: e.pad, vel: e.vel * gain, id: e.id });
    }
    for (const nt of pat.notes) {
      const local = n * L + nt.tick;
      if (local >= f && local < t) out.push({ abs: local + start, pad: nt.pad, vel: nt.vel * gain, id: nt.id, pitch: nt.pitch, len: nt.len });
    }
  }
  return out;
}

/** All sequencer steps, recorded hits and notes of the Sampler loop with from <= abs < to. Ticks are absolute (not wrapped). */
export function hitsInWindow(p: Project, from: number, to: number): Hit[] {
  return patternHits(p, loopPattern(p), from, to).sort((a, b) => a.abs - b.abs);
}

/** One stretch of a clip playing on a track, in absolute ticks. `end` is set when something replaces or stops it. */
export interface Segment { track: number; clipId: string; start: number; end: number }
/** Hits of every launched clip in the window, at each track's current volume. */
export function segmentHits(p: Project, segments: Segment[], from: number, to: number): Hit[] {
  const out: Hit[] = [];
  for (const seg of segments) {
    const clip = p.clips.find((c) => c.id === seg.clipId);
    if (clip) out.push(...patternHits(p, clipPattern(clip), from, to, seg.start, seg.end, trackGain(p.tracks, seg.track)));
  }
  return out.sort((a, b) => a.abs - b.abs);
}
/** The next bar line at or after a tick. */
export const nextBar = (tick: number) => Math.max(0, Math.ceil(Math.max(0, tick) / BAR_TICKS - 1e-9)) * BAR_TICKS + 0;

/** Metronome beats in the window: [absTick, isDownbeat]. */
export function beatsInWindow(from: number, to: number): [number, boolean][] {
  const out: [number, boolean][] = [];
  for (let b = Math.max(0, Math.ceil(from / PPQ)); b * PPQ < to; b++) out.push([b * PPQ, b % 4 === 0]);
  return out;
}

/** Snap a tick to the nearest grid line. grid 0 = no snapping. */
export function quantizeTick(tick: number, grid: number): number {
  return grid > 0 ? Math.round(tick / grid) * grid : Math.round(tick);
}
