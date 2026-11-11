// The command bus. Every change to the project goes through dispatch(): the UI, undo/redo,
// autosave and (later) the AI assistant all use this one entry point.
import { PITCH_MAX, PITCH_MIN, SCALES, BANK_COUNT, BAR_TICKS, DELAY_TIMES, PAD_COUNT, STEP_COUNT, STUTTERS, TOTAL_PADS, bankOf, defaultFx, emptyPad, emptyProject, sliceBounds } from './types';
import type { LoopEvent, Note, Pad, PadFx, Project, Sample } from './types';

type Handler = (p: Project, args: any) => Project;
interface CommandDef { run: Handler; undoable: boolean; describe: string }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mapPad = (p: Project, i: number, f: (pad: Pad) => Pad): Project =>
  ({ ...p, pads: p.pads.map((pad, k) => (k === i ? f(pad) : pad)) });
const mapSample = (p: Project, id: string, f: (s: Sample) => Sample): Project =>
  ({ ...p, samples: p.samples.map((s) => (s.id === id ? f(s) : s)) });
const cleanMarkers = (m: number[], duration: number) =>
  [...new Set(m.map((t) => Math.round(t * 10000) / 10000))].filter((t) => t > 0.005 && t < duration - 0.005).sort((a, b) => a - b);

export const commands: Record<string, CommandDef> = {
  'project.setBpm': { undoable: true, describe: 'Set tempo in BPM (40-240)', run: (p, a) => ({ ...p, bpm: clamp(Math.round(a.bpm * 10) / 10, 40, 240) }) },
  'project.setSwing': { undoable: true, describe: 'Set swing 0-0.6', run: (p, a) => ({ ...p, swing: clamp(a.swing, 0, 0.6) }) },
  'project.setBars': {
    undoable: true, describe: 'Set loop length to 1, 2 or 4 bars',
    run: (p, a) => ({ ...p, bars: a.bars, events: p.events.filter((e) => e.tick < a.bars * BAR_TICKS), notes: fitNotes(p.notes, a.bars * BAR_TICKS) }),
  },
  'project.setQuantize': { undoable: false, describe: 'Set record quantize in ticks (0 = off)', run: (p, a) => ({ ...p, quantize: a.ticks }) },
  'project.setMetronome': { undoable: false, describe: 'Turn the metronome on or off', run: (p, a) => ({ ...p, metronome: !!a.on }) },
  'project.reset': { undoable: true, describe: 'Start a new empty project', run: () => emptyProject() },

  'sample.add': { undoable: true, describe: 'Add an imported sample', run: (p, a) => ({ ...p, samples: [...p.samples, a.sample], activeSampleId: a.sample.id }) },
  'sample.select': { undoable: false, describe: 'Show a sample in the chop view', run: (p, a) => ({ ...p, activeSampleId: a.id }) },
  'sample.remove': {
    undoable: true, describe: 'Remove a sample and clear pads using it',
    run: (p, a) => {
      const samples = p.samples.filter((s) => s.id !== a.id);
      return {
        ...p, samples,
        activeSampleId: p.activeSampleId === a.id ? (samples[0]?.id ?? null) : p.activeSampleId,
        pads: p.pads.map((pad) => (pad.sampleId === a.id ? { ...emptyPad(), steps: pad.steps } : pad)),
      };
    },
  },
  'sample.setMarkers': { undoable: true, describe: 'Replace all slice markers of a sample', run: (p, a) => mapSample(p, a.id, (s) => ({ ...s, markers: cleanMarkers(a.markers, s.duration) })) },
  'sample.addMarker': { undoable: true, describe: 'Add one slice marker', run: (p, a) => mapSample(p, a.id, (s) => ({ ...s, markers: cleanMarkers([...s.markers, a.time], s.duration) })) },
  'sample.removeMarker': { undoable: true, describe: 'Remove one slice marker by index', run: (p, a) => mapSample(p, a.id, (s) => ({ ...s, markers: s.markers.filter((_, i) => i !== a.index) })) },
  'sample.moveMarker': {
    undoable: true, describe: 'Move one slice marker',
    run: (p, a) => mapSample(p, a.id, (s) => ({ ...s, markers: cleanMarkers(s.markers.map((t, i) => (i === a.index ? a.time : t)), s.duration) })),
  },

  'pads.assignSlices': {
    undoable: true, describe: 'Send the slices of a sample to pads, starting at the first pad of a bank (default: the bank on screen) and continuing into later banks',
    run: (p, a) => {
      const s = p.samples.find((x) => x.id === a.sampleId);
      if (!s) return p;
      const b = sliceBounds(s);
      const first = clamp(a.bank ?? bankOf(p.selectedPad), 0, BANK_COUNT - 1) * PAD_COUNT;
      return {
        ...p,
        pads: p.pads.map((pad, i) => (i >= first && i - first < b.length - 1
          ? { ...pad, sampleId: s.id, start: b[i - first], end: b[i - first + 1], reverse: false, semitones: 0, gain: 1, fx: defaultFx() }
          : pad)),
      };
    },
  },
  'pad.assign': { undoable: true, describe: 'Assign a region of a sample to one pad', run: (p, a) => mapPad(p, a.pad, (pad) => ({ ...pad, sampleId: a.sampleId, start: a.start, end: a.end })) },
  'pad.set': {
    undoable: true, describe: 'Change pad gain, semitones or reverse',
    run: (p, a) => mapPad(p, a.pad, (pad) => ({
      ...pad,
      gain: a.gain !== undefined ? clamp(a.gain, 0, 1.5) : pad.gain,
      semitones: a.semitones !== undefined ? clamp(Math.round(a.semitones), -12, 12) : pad.semitones,
      reverse: a.reverse !== undefined ? !!a.reverse : pad.reverse,
    })),
  },
  'pad.setFx': {
    undoable: true, describe: 'Change effects on one pad: filter, cutoff, resonance, drive, delayMix, delayTime, delayFeedback, stutter',
    run: (p, a) => mapPad(p, a.pad, (pad) => {
      const f = pad.fx, n = a.fx as Partial<PadFx>;
      const num = (v: unknown, lo: number, hi: number, cur: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : cur);
      return {
        ...pad,
        fx: {
          filter: ['off', 'lowpass', 'highpass', 'bandpass'].includes(n.filter as string) ? n.filter! : f.filter,
          cutoff: num(n.cutoff, 40, 16000, f.cutoff),
          resonance: num(n.resonance, 0, 1, f.resonance),
          drive: num(n.drive, 0, 1, f.drive),
          delayMix: num(n.delayMix, 0, 1, f.delayMix),
          delayTime: n.delayTime !== undefined && n.delayTime in DELAY_TIMES ? n.delayTime : f.delayTime,
          delayFeedback: num(n.delayFeedback, 0, 0.85, f.delayFeedback),
          stutter: (STUTTERS as readonly number[]).includes(n.stutter as number) ? n.stutter! : f.stutter,
        },
      };
    }),
  },
  'pad.resetFx': { undoable: true, describe: 'Remove all effects from one pad', run: (p, a) => mapPad(p, a.pad, (pad) => ({ ...pad, fx: defaultFx() })) },
  'pad.clear': { undoable: true, describe: 'Empty a pad and its steps and recorded hits', run: (p, a) => ({ ...mapPad(p, a.pad, () => emptyPad()), events: p.events.filter((e) => e.pad !== a.pad), notes: p.notes.filter((n) => n.pad !== a.pad) }) },
  'pad.select': { undoable: false, describe: 'Select a pad for editing', run: (p, a) => ({ ...p, selectedPad: clamp(a.pad, 0, TOTAL_PADS - 1) }) },
  'bank.select': { undoable: false, describe: 'Show pad bank 0-3 (A-D)', run: (p, a) => ({ ...p, selectedPad: clamp(a.bank, 0, BANK_COUNT - 1) * PAD_COUNT + (p.selectedPad % PAD_COUNT) }) },

  'seq.setStep': {
    undoable: true, describe: 'Set one step of a pad (velocity 0 = off)',
    run: (p, a) => (a.step < 0 || a.step >= STEP_COUNT ? p
      : mapPad(p, a.pad, (pad) => ({ ...pad, steps: pad.steps.map((v, i) => (i === a.step ? clamp(a.vel, 0, 1) : v)) }))),
  },
  'seq.setRow': { undoable: true, describe: 'Replace all 16 steps of a pad', run: (p, a) => mapPad(p, a.pad, (pad) => ({ ...pad, steps: Array.from({ length: STEP_COUNT }, (_, i) => clamp(a.steps[i] ?? 0, 0, 1)) })) },
  'seq.clearAll': { undoable: true, describe: 'Clear every step on every pad', run: (p) => ({ ...p, pads: p.pads.map((pad) => ({ ...pad, steps: new Array(STEP_COUNT).fill(0) })) }) },

  'note.add': { undoable: true, describe: 'Add one piano-roll note', run: (p, a) => { const n = cleanNote(a.note, p.bars * BAR_TICKS); return n ? { ...p, notes: [...p.notes, n] } : p; } },
  'note.remove': { undoable: true, describe: 'Remove one piano-roll note by id', run: (p, a) => (p.notes.some((n) => n.id === a.id) ? { ...p, notes: p.notes.filter((n) => n.id !== a.id) } : p) },
  'notes.set': {
    undoable: true, describe: 'Replace every piano-roll note of one pad',
    run: (p, a) => ({ ...p, notes: [...p.notes.filter((n) => n.pad !== a.pad), ...(a.notes as Note[]).map((n) => cleanNote({ ...n, pad: a.pad }, p.bars * BAR_TICKS)).filter((n): n is Note => !!n)] }),
  },
  'notes.clearPad': { undoable: true, describe: 'Erase the piano-roll notes of one pad', run: (p, a) => (p.notes.some((n) => n.pad === a.pad) ? { ...p, notes: p.notes.filter((n) => n.pad !== a.pad) } : p) },
  'project.setScale': {
    undoable: false, describe: 'Set the piano-roll scale and the note name of a pad\'s own pitch',
    run: (p, a) => ({ ...p, scale: a.scale in SCALES ? a.scale : p.scale, root: Number.isInteger(a.root) ? clamp(a.root, 0, 11) : p.root }),
  },
  'loop.addEvent': { undoable: true, describe: 'Record one pad hit into the loop', run: (p, a) => ({ ...p, events: [...p.events, a.event as LoopEvent] }) },
  'loop.clearPad': { undoable: true, describe: 'Erase recorded hits of one pad', run: (p, a) => ({ ...p, events: p.events.filter((e) => e.pad !== a.pad) }) },
  'loop.clear': { undoable: true, describe: 'Erase all recorded hits', run: (p) => ({ ...p, events: [] }) },
};

/** Validate a note against the loop: inside the loop, in pitch range, at least one tick long. */
function cleanNote(n: Note, loop: number): Note | null {
  if (!n || ![n.tick, n.len, n.pitch].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const tick = Math.round(n.tick);
  if (tick < 0 || tick >= loop || !Number.isInteger(n.pad) || n.pad < 0 || n.pad >= TOTAL_PADS) return null;
  return {
    id: String(n.id), pad: n.pad, tick, len: clamp(Math.round(n.len), 1, loop - tick),
    pitch: clamp(Math.round(n.pitch), PITCH_MIN, PITCH_MAX), vel: clamp(typeof n.vel === 'number' ? n.vel : 1, 0.05, 1),
  };
}
const fitNotes = (notes: Note[], loop: number) => notes.filter((n) => n.tick < loop).map((n) => ({ ...n, len: Math.min(n.len, loop - n.tick) }));

let state: Project = emptyProject();
let past: Project[] = [];
let future: Project[] = [];
let lastKey = '';
let lastTime = 0;
const listeners = new Set<() => void>();
const HISTORY_LIMIT = 200;

function emit() { listeners.forEach((l) => l()); }

export const getProject = () => state;
export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/**
 * Run a named command. `group` merges rapid repeats (a slider drag, one recording take)
 * into a single undo step. `sticky` groups have no time limit (one assistant turn = one undo step).
 */
export function dispatch(name: string, args: any = {}, opts: { group?: string; sticky?: boolean } = {}) {
  const cmd = commands[name];
  if (!cmd) throw new Error(`Unknown command: ${name}`);
  const next = cmd.run(state, args);
  if (next === state) return;
  if (cmd.undoable) {
    const now = Date.now();
    const merged = !!opts.group && opts.group === lastKey && (!!opts.sticky || now - lastTime < 1500);
    if (!merged) { past.push(state); if (past.length > HISTORY_LIMIT) past.shift(); }
    future = [];
    lastKey = opts.group ?? '';
    lastTime = now;
  }
  state = next;
  emit();
}

/** Settings that are not undoable stay as they are when history moves. */
function keepSettings(target: Project): Project {
  const active = target.samples.some((s) => s.id === state.activeSampleId) ? state.activeSampleId : target.activeSampleId;
  return { ...target, selectedPad: state.selectedPad, metronome: state.metronome, quantize: state.quantize, activeSampleId: active, scale: state.scale, root: state.root };
}
export function undo() { const prev = past.pop(); if (!prev) return; future.push(state); state = keepSettings(prev); lastKey = ''; emit(); }
export function redo() { const next = future.pop(); if (!next) return; past.push(state); state = keepSettings(next); lastKey = ''; emit(); }
/** Group key of the newest undo step, or '' if it was not grouped. */
export const lastGroup = () => lastKey;
export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;

/** Replace the whole project (load from storage). Clears history. */
export function loadProject(p: Project) { state = p; past = []; future = []; lastKey = ''; emit(); }
