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

export type FilterType = 'off' | 'lowpass' | 'highpass' | 'bandpass';
export const DELAY_TIMES = { '1/16': 0.25, '1/8': 0.5, '1/8d': 0.75, '1/4': 1 } as const; // in beats
export type DelayTime = keyof typeof DELAY_TIMES;
export const STUTTERS = [1, 2, 3, 4, 6, 8] as const;
export const REVERBS = { room: 0.6, hall: 2, vast: 5 } as const; // decay time in seconds
export type ReverbSize = keyof typeof REVERBS;
export const STRETCH_MIN = 0.25;
export const STRETCH_MAX = 4;

/** Per-pad effects. Applied identically in live playback and in export. */
export interface PadFx {
  filter: FilterType;
  cutoff: number; // Hz, 40..16000
  resonance: number; // 0..1
  drive: number; // 0..1, saturation amount
  delayMix: number; // 0..1, level of the echoes (the dry sound stays at full level)
  delayTime: DelayTime; // tempo-synced
  delayFeedback: number; // 0..0.85
  stutter: number; // 1 = off; N = the first 1/N of the slice repeated N times
  reverb: number; // 0..1, level sent to the reverb (the dry sound stays at full level)
  reverbSize: ReverbSize;
  /** Length multiplier without changing pitch (granular time-stretch). 1 = off. */
  stretch: number;
  grain: number; // grain length in milliseconds, 20..200
  /** 0..1: how far each grain may jump from its place in the slice. Above 0 turns the sound into a texture. */
  scatter: number;
}
export const defaultFx = (): PadFx => ({ filter: 'off', cutoff: 2000, resonance: 0.2, drive: 0, delayMix: 0, delayTime: '1/8d', delayFeedback: 0.4, stutter: 1, reverb: 0, reverbSize: 'hall', stretch: 1, grain: 70, scatter: 0 });
export const fxActive = (fx: PadFx) => fx.filter !== 'off' || fx.drive > 0 || fx.delayMix > 0 || fx.stutter > 1 || fx.reverb > 0 || isGranular(fx);
export const isGranular = (fx: PadFx) => Math.abs(fx.stretch - 1) > 0.001 || fx.scatter > 0;

export interface Pad {
  sampleId: string | null;
  start: number; // seconds into the sample
  end: number;
  gain: number; // 0..1.5
  semitones: number; // -12..12, repitch by playback rate
  reverse: boolean;
  fx: PadFx;
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

/** A melodic note: the pad's sound replayed at another pitch for a set length. */
export interface Note {
  id: string;
  pad: number; // which pad's sound is the instrument
  tick: number; // start within the loop
  len: number; // length in ticks
  pitch: number; // semitones away from the pad's own pitch, PITCH_MIN..PITCH_MAX
  vel: number;
}
export const PITCH_MIN = -12;
export const PITCH_MAX = 12;
export const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  'minor pentatonic': [0, 3, 5, 7, 10],
  'major pentatonic': [0, 2, 4, 7, 9],
} as const;
export type ScaleName = keyof typeof SCALES;
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const inScale = (pitch: number, scale: ScaleName) => (SCALES[scale] as readonly number[]).includes(((pitch % 12) + 12) % 12);

/** A saved loop: everything the Sampler loop was playing at the moment it was saved. */
export interface Clip {
  id: string;
  name: string;
  track: number; // 0..TRACK_COUNT-1
  bars: number;
  /** Step rows by pad index; pads with no steps are left out. */
  steps: Record<number, number[]>;
  events: LoopEvent[];
  notes: Note[];
}
/** A clip placed on the song timeline. It sits on its clip's track, starts at `bar` and plays `repeats` times. */
export interface Placement { id: string; clipId: string; bar: number; repeats: number }
export const MAX_SONG_BARS = 256;
export interface Track { vol: number; mute: boolean; solo: boolean }
/** One mixer channel per pad bank. EQ values are in decibels (-12..12). */
export interface Channel { vol: number; pan: number; low: number; mid: number; high: number; mute: boolean; solo: boolean }
export interface MixerState { channels: Channel[]; master: number }
export const emptyChannel = (): Channel => ({ vol: 1, pan: 0, low: 0, mid: 0, high: 0, mute: false, solo: false });
export const emptyMixer = (): MixerState => ({ channels: Array.from({ length: 4 }, emptyChannel), master: 1 });
/** How loud a channel plays right now: 0 when muted, or when another channel is soloed. */
export const channelGain = (m: MixerState, i: number) => { const c = m.channels[i]; return !c || c.mute || (m.channels.some((x) => x.solo) && !c.solo) ? 0 : c.vol; };
export const TRACK_COUNT = 4;
export const emptyTracks = (): Track[] => Array.from({ length: TRACK_COUNT }, () => ({ vol: 1, mute: false, solo: false }));
/** How loud a track plays right now: 0 when muted, or when another track is soloed. */
export const trackGain = (tracks: Track[], i: number) => { const t = tracks[i]; return !t || t.mute || (tracks.some((x) => x.solo) && !t.solo) ? 0 : t.vol; };

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
  notes: Note[];
  clips: Clip[];
  tracks: Track[];
  arrangement: Placement[];
  mixer: MixerState;
  /** Scale shown in the piano roll, counted from the pad's own pitch. */
  scale: ScaleName;
  /** Note name (0 = C) given to a pad's own pitch, for labels and MIDI files. */
  root: number;
}

export function emptyPad(): Pad {
  return { sampleId: null, start: 0, end: 0, gain: 1, semitones: 0, reverse: false, fx: defaultFx(), steps: new Array(STEP_COUNT).fill(0) };
}

export function emptyProject(): Project {
  return {
    version: 1, bpm: 120, swing: 0, bars: 2, quantize: STEP_TICKS, metronome: false,
    samples: [], activeSampleId: null,
    pads: Array.from({ length: TOTAL_PADS }, emptyPad),
    selectedPad: 0, events: [], notes: [], clips: [], tracks: emptyTracks(), arrangement: [], mixer: emptyMixer(), scale: 'minor', root: 0,
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
  const pads = Array.from({ length: TOTAL_PADS }, (_, i) => (p.pads[i] ? { ...p.pads[i], fx: { ...defaultFx(), ...p.pads[i].fx } } : emptyPad()));
  return { ...p, pads, selectedPad: Math.min(Math.max(0, p.selectedPad ?? 0), TOTAL_PADS - 1), notes: p.notes ?? [], clips: p.clips ?? [], arrangement: p.arrangement ?? [], mixer: p.mixer?.channels?.length === 4 ? p.mixer : emptyMixer(), tracks: p.tracks?.length === TRACK_COUNT ? p.tracks : emptyTracks(), scale: p.scale in SCALES ? p.scale : 'minor', root: p.root ?? 0 };
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Slice boundaries including both ends: [0, ...markers, duration]. */
export function sliceBounds(s: Sample): number[] {
  return [0, ...s.markers, s.duration];
}
