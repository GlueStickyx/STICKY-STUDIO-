// Project data model. Everything here is plain serialisable data: no audio buffers, no class instances.

export const PPQ = 96; // ticks per quarter note
export const STEP_TICKS = PPQ / 4; // one 16th note
export const BAR_TICKS = PPQ * 4; // 4/4 only in v1
export const PAD_COUNT = 16;
export const STEP_COUNT = 16;

export interface Sample {
  id: string;
  name: string;
  duration: number; // seconds
  sampleRate: number;
  /** Slice boundaries in seconds, sorted, excluding 0 and duration. */
  markers: number[];
  /** Estimated tempo of the audio, if detection found one. */
  bpm: number | null;
}

export interface Pad {
  sampleId: string | null;
  start: number; // seconds into the sample
  end: number;
  gain: number; // 0..1.5
  semitones: number; // -12..12, repitch by playback rate
  reverse: boolean;
  /** Step sequencer row: velocity 0..1 per 16th note, 0 = off. */
  steps: number[];
}

/** A pad hit recorded into the loop. */
export interface LoopEvent {
  id: string;
  pad: number;
  tick: number; // position within the loop
  vel: number;
}

export interface Project {
  version: 1;
  bpm: number;
  swing: number; // 0..0.6, fraction of a 16th that odd steps are delayed
  bars: 1 | 2 | 4; // loop length
  quantize: number; // record quantize in ticks, 0 = off
  metronome: boolean;
  samples: Sample[];
  activeSampleId: string | null;
  pads: Pad[];
  selectedPad: number;
  events: LoopEvent[];
}

export function emptyPad(): Pad {
  return { sampleId: null, start: 0, end: 0, gain: 1, semitones: 0, reverse: false, steps: new Array(STEP_COUNT).fill(0) };
}

export function emptyProject(): Project {
  return {
    version: 1, bpm: 120, swing: 0, bars: 2, quantize: STEP_TICKS, metronome: false,
    samples: [], activeSampleId: null,
    pads: Array.from({ length: PAD_COUNT }, emptyPad),
    selectedPad: 0, events: [],
  };
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Slice boundaries including both ends: [0, ...markers, duration]. */
export function sliceBounds(s: Sample): number[] {
  return [0, ...s.markers, s.duration];
}
