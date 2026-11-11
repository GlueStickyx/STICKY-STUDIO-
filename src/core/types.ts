// Project data model. Everything here is plain serialisable data: no audio buffers, no class instances.

export const PPQ = 96; // ticks per quarter note
export const STEP_TICKS = PPQ / 4; // one 16th note
export const BAR_TICKS = PPQ * 4; // 4/4 only in v1
export const PAD_COUNT = 16; // pads per bank
export const BANK_COUNT = 4;
export const TOTAL_PADS = PAD_COUNT * BANK_COUNT;
export const BANK_NAMES = 'ABCD';
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
  /** Index into pads (0..63). The bank on screen is the one holding the selected pad. */
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
    pads: Array.from({ length: TOTAL_PADS }, emptyPad),
    selectedPad: 0, events: [],
  };
}

/** Human name of a pad: bank letter + number within the bank, e.g. "A1", "C12". */
export const padLabel = (i: number) => `${BANK_NAMES[Math.floor(i / PAD_COUNT)]}${(i % PAD_COUNT) + 1}`;
export const bankOf = (i: number) => Math.floor(i / PAD_COUNT);
/** Parse "A1".."D16" (case-insensitive) into a pad index, or null. */
export function parsePad(label: unknown): number | null {
  const m = typeof label === 'string' ? /^\s*([A-Da-d])\s*(\d{1,2})\s*$/.exec(label) : null;
  if (!m) return null;
  const n = Number(m[2]);
  return n >= 1 && n <= PAD_COUNT ? BANK_NAMES.indexOf(m[1].toUpperCase()) * PAD_COUNT + n - 1 : null;
}
/** Bring a project saved by an older version up to the current shape. */
export function normalizeProject(p: Project): Project {
  const pads = Array.from({ length: TOTAL_PADS }, (_, i) => p.pads[i] ?? emptyPad());
  return { ...p, pads, selectedPad: Math.min(Math.max(0, p.selectedPad ?? 0), TOTAL_PADS - 1) };
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Slice boundaries including both ends: [0, ...markers, duration]. */
export function sliceBounds(s: Sample): number[] {
  return [0, ...s.markers, s.duration];
}
