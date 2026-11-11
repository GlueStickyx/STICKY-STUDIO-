// The command bus. Every change to the project goes through dispatch(): the UI, undo/redo,
// autosave and (later) the AI assistant all use this one entry point.
import { BAR_TICKS, PAD_COUNT, STEP_COUNT, emptyPad, emptyProject, sliceBounds } from './types';
import type { LoopEvent, Pad, Project, Sample } from './types';

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
    run: (p, a) => ({ ...p, bars: a.bars, events: p.events.filter((e) => e.tick < a.bars * BAR_TICKS) }),
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
    undoable: true, describe: 'Send the first 16 slices of a sample to pads 1-16',
    run: (p, a) => {
      const s = p.samples.find((x) => x.id === a.sampleId);
      if (!s) return p;
      const b = sliceBounds(s);
      return {
        ...p,
        pads: p.pads.map((pad, i) => (i < b.length - 1
          ? { ...pad, sampleId: s.id, start: b[i], end: b[i + 1], reverse: false, semitones: 0, gain: 1 }
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
  'pad.clear': { undoable: true, describe: 'Empty a pad and its steps and recorded hits', run: (p, a) => ({ ...mapPad(p, a.pad, () => emptyPad()), events: p.events.filter((e) => e.pad !== a.pad) }) },
  'pad.select': { undoable: false, describe: 'Select a pad for editing', run: (p, a) => ({ ...p, selectedPad: clamp(a.pad, 0, PAD_COUNT - 1) }) },

  'seq.setStep': {
    undoable: true, describe: 'Set one step of a pad (velocity 0 = off)',
    run: (p, a) => (a.step < 0 || a.step >= STEP_COUNT ? p
      : mapPad(p, a.pad, (pad) => ({ ...pad, steps: pad.steps.map((v, i) => (i === a.step ? clamp(a.vel, 0, 1) : v)) }))),
  },
  'seq.setRow': { undoable: true, describe: 'Replace all 16 steps of a pad', run: (p, a) => mapPad(p, a.pad, (pad) => ({ ...pad, steps: Array.from({ length: STEP_COUNT }, (_, i) => clamp(a.steps[i] ?? 0, 0, 1)) })) },
  'seq.clearAll': { undoable: true, describe: 'Clear every step on every pad', run: (p) => ({ ...p, pads: p.pads.map((pad) => ({ ...pad, steps: new Array(STEP_COUNT).fill(0) })) }) },

  'loop.addEvent': { undoable: true, describe: 'Record one pad hit into the loop', run: (p, a) => ({ ...p, events: [...p.events, a.event as LoopEvent] }) },
  'loop.clearPad': { undoable: true, describe: 'Erase recorded hits of one pad', run: (p, a) => ({ ...p, events: p.events.filter((e) => e.pad !== a.pad) }) },
  'loop.clear': { undoable: true, describe: 'Erase all recorded hits', run: (p) => ({ ...p, events: [] }) },
};

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
  return { ...target, selectedPad: state.selectedPad, metronome: state.metronome, quantize: state.quantize, activeSampleId: active };
}
export function undo() { const prev = past.pop(); if (!prev) return; future.push(state); state = keepSettings(prev); lastKey = ''; emit(); }
export function redo() { const next = future.pop(); if (!next) return; past.push(state); state = keepSettings(next); lastKey = ''; emit(); }
/** Group key of the newest undo step, or '' if it was not grouped. */
export const lastGroup = () => lastKey;
export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;

/** Replace the whole project (load from storage). Clears history. */
export function loadProject(p: Project) { state = p; past = []; future = []; lastKey = ''; emit(); }
