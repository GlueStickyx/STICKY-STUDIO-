// Pure timing maths: which hits fall inside a window of ticks. Shared by live playback and offline export,
// so what you hear is what you render.
import { BAR_TICKS, PPQ, STEP_COUNT, STEP_TICKS } from './types';
import type { Project } from './types';

export interface Hit { abs: number; pad: number; vel: number; id?: string }

export const loopTicks = (p: Project) => p.bars * BAR_TICKS;
export const secondsPerTick = (bpm: number) => 60 / bpm / PPQ;

/** Absolute tick of step k, with swing delaying every second 16th. */
export const stepTick = (k: number, swing: number) => k * STEP_TICKS + (k % 2 === 1 ? swing * STEP_TICKS : 0);

/** All sequencer steps and recorded hits with from <= abs < to. Ticks are absolute (not wrapped). */
export function hitsInWindow(p: Project, from: number, to: number): Hit[] {
  const out: Hit[] = [];
  if (to <= from) return out;
  for (let k = Math.max(0, Math.floor(from / STEP_TICKS) - 1); k <= Math.ceil(to / STEP_TICKS); k++) {
    const abs = stepTick(k, p.swing);
    if (abs < from || abs >= to) continue;
    const s = k % STEP_COUNT;
    p.pads.forEach((pad, i) => { if (pad.sampleId && pad.steps[s] > 0) out.push({ abs, pad: i, vel: pad.steps[s] }); });
  }
  const L = loopTicks(p);
  for (let n = Math.max(0, Math.floor(from / L)); n * L < to; n++) {
    for (const e of p.events) {
      const abs = n * L + e.tick;
      if (abs >= from && abs < to) out.push({ abs, pad: e.pad, vel: e.vel, id: e.id });
    }
  }
  return out.sort((a, b) => a.abs - b.abs);
}

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
