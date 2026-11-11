// The assistant's hands: each tool is a thin wrapper over the same command bus the buttons use.
// Inputs come from a model and are validated here before anything is dispatched.
import type Anthropic from '@anthropic-ai/sdk';
import { describeAudio, detectTransients } from '../audio/analysis';
import { dispatch, getProject } from '../core/bus';
import { PAD_COUNT, STEP_COUNT, sliceBounds } from '../core/types';

/** What the tools need from the running studio. Injected so the tools can be tested without audio hardware. */
export interface StudioDeps {
  audio: (sampleId: string) => { mono: Float32Array; sampleRate: number } | null;
  isPlaying: () => boolean;
  setPlaying: (on: boolean) => void;
}

export interface ToolOutcome { text: string; isError: boolean; change: string | null }

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false });
const padProp = { type: 'integer', minimum: 1, maximum: PAD_COUNT, description: 'Pad number 1-16' };

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_studio_state',
    description: 'Read the current project: tempo, swing, loop length, samples, what is on each pad, every step pattern and the number of recorded hits. Call this before changing anything.',
    input_schema: obj({}),
  },
  {
    name: 'describe_pads',
    description: 'Measure the audio on every loaded pad: length, loudness, share of energy in low/mid/high bands, attack time, and a plain-language hint (kick-like, hat-like...). This is how you find out what each pad sounds like. Call it before writing a drum pattern.',
    input_schema: obj({}),
  },
  {
    name: 'set_transport',
    description: 'Change tempo, swing, loop length or metronome, and start or stop playback. Only include the fields you want to change.',
    input_schema: obj({
      bpm: { type: 'number', minimum: 40, maximum: 240 },
      swing_percent: { type: 'number', minimum: 0, maximum: 60, description: 'How late every second 16th note plays. 0 = straight, 16-25 = classic swing.' },
      loop_bars: { type: 'integer', enum: [1, 2, 4] },
      metronome: { type: 'boolean' },
      playing: { type: 'boolean' },
    }),
  },
  {
    name: 'write_patterns',
    description: 'Write step-sequencer patterns. Each pattern replaces all 16 steps (16th notes of one bar) of one pad. Step values are velocity: 0 = off, 1 = full, values in between are softer (ghost notes).',
    input_schema: obj({
      patterns: {
        type: 'array', minItems: 1,
        items: obj({ pad: padProp, steps: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: STEP_COUNT, maxItems: STEP_COUNT } }, ['pad', 'steps']),
      },
      clear_other_pads: { type: 'boolean', description: 'Also clear the steps of every pad not listed. Use when replacing the whole beat.' },
    }, ['patterns']),
  },
  {
    name: 'edit_pads',
    description: 'Change volume, pitch or reverse on one or more pads. Pitch is in semitones (-12 to 12) and also changes playback speed.',
    input_schema: obj({
      pads: {
        type: 'array', minItems: 1,
        items: obj({ pad: padProp, volume_percent: { type: 'number', minimum: 0, maximum: 150 }, semitones: { type: 'integer', minimum: -12, maximum: 12 }, reverse: { type: 'boolean' } }, ['pad']),
      },
    }, ['pads']),
  },
  {
    name: 'slice_sample',
    description: 'Re-slice the sample currently shown in the chop view. "transients" cuts at detected hits (sensitivity 0-1, higher = more slices); "grid" cuts into equal parts. Optionally send the first 16 slices to pads 1-16, which replaces what those pads play.',
    input_schema: obj({
      method: { type: 'string', enum: ['transients', 'grid'] },
      sensitivity: { type: 'number', minimum: 0, maximum: 1 },
      parts: { type: 'integer', minimum: 2, maximum: 64 },
      send_to_pads: { type: 'boolean' },
    }, ['method']),
  },
  {
    name: 'erase',
    description: 'Erase step patterns or recorded hits. "pad" empties one pad completely.',
    input_schema: obj({ target: { type: 'string', enum: ['all_steps', 'all_recorded', 'pad_steps', 'pad_recorded', 'pad'] }, pad: padProp }, ['target']),
  },
];
// Large tool inputs stream as they are generated; validation is done below, not by the server.
for (const t of TOOLS) (t as { eager_input_streaming?: boolean }).eager_input_streaming = true;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPad = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= PAD_COUNT;
const fail = (text: string): ToolOutcome => ({ text, isError: true, change: null });
const ok = (text: string, change: string | null = null): ToolOutcome => ({ text, isError: false, change });
const stepString = (steps: number[]) => steps.map((v) => (v >= 0.95 ? 'X' : v > 0 ? 'o' : '.')).join('');

function stateJson(deps: StudioDeps): string {
  const p = getProject();
  return JSON.stringify({
    bpm: p.bpm, swing_percent: Math.round(p.swing * 100), loop_bars: p.bars, metronome: p.metronome, playing: deps.isPlaying(),
    step_legend: '16 characters = 16th notes of one bar. X = full hit, o = soft hit, . = off',
    chop_view_sample: p.samples.find((s) => s.id === p.activeSampleId)?.name ?? null,
    samples: p.samples.map((s) => ({ name: s.name, seconds: +s.duration.toFixed(2), detected_bpm: s.bpm, slices: s.markers.length + 1 })),
    pads: p.pads.map((pad, i) => {
      const s = p.samples.find((x) => x.id === pad.sampleId);
      if (!s) return { pad: i + 1, empty: true };
      return {
        pad: i + 1, sample: s.name, from_seconds: +pad.start.toFixed(3), to_seconds: +pad.end.toFixed(3),
        volume_percent: Math.round(pad.gain * 100), semitones: pad.semitones, reverse: pad.reverse,
        steps: stepString(pad.steps), recorded_hits: p.events.filter((e) => e.pad === i).length,
      };
    }),
  });
}

/** Run one tool call. `group` ties every change of one assistant turn into a single undo step. */
export function runTool(name: string, input: unknown, deps: StudioDeps, group: string): ToolOutcome {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('Tool input must be a JSON object.');
  const a = input as Record<string, any>;
  const run = (cmd: string, args: object) => dispatch(cmd, args, { group, sticky: true });
  const p = getProject();

  switch (name) {
    case 'get_studio_state': return ok(stateJson(deps));

    case 'describe_pads': {
      const out = p.pads.map((pad, i) => {
        const au = pad.sampleId ? deps.audio(pad.sampleId) : null;
        if (!au) return null;
        const seg = au.mono.subarray(Math.floor(pad.start * au.sampleRate), Math.floor(pad.end * au.sampleRate));
        return { pad: i + 1, ...describeAudio(seg, au.sampleRate) };
      }).filter(Boolean);
      return ok(out.length ? JSON.stringify(out) : 'No pads have audio yet. Slice a sample and send it to the pads first.');
    }

    case 'set_transport': {
      const done: string[] = [];
      if (a.bpm !== undefined) { if (!isNum(a.bpm) || a.bpm < 40 || a.bpm > 240) return fail('bpm must be a number from 40 to 240.'); run('project.setBpm', { bpm: a.bpm }); done.push(`tempo ${a.bpm} BPM`); }
      if (a.swing_percent !== undefined) { if (!isNum(a.swing_percent) || a.swing_percent < 0 || a.swing_percent > 60) return fail('swing_percent must be 0 to 60.'); run('project.setSwing', { swing: a.swing_percent / 100 }); done.push(`swing ${a.swing_percent}%`); }
      if (a.loop_bars !== undefined) { if (![1, 2, 4].includes(a.loop_bars)) return fail('loop_bars must be 1, 2 or 4.'); run('project.setBars', { bars: a.loop_bars }); done.push(`loop ${a.loop_bars} bars`); }
      if (a.metronome !== undefined) { run('project.setMetronome', { on: !!a.metronome }); }
      if (a.playing !== undefined) deps.setPlaying(!!a.playing);
      return ok('Done.', done.length ? `Set ${done.join(', ')}` : null);
    }

    case 'write_patterns': {
      if (!Array.isArray(a.patterns) || !a.patterns.length) return fail('patterns must be a non-empty array.');
      for (const row of a.patterns) {
        if (!isPad(row?.pad)) return fail('Each pattern needs pad: an integer 1-16.');
        if (!Array.isArray(row.steps) || row.steps.length !== STEP_COUNT || !row.steps.every((v: unknown) => isNum(v) && v >= 0 && v <= 1)) {
          return fail(`Pad ${row.pad}: steps must be exactly 16 numbers between 0 and 1.`);
        }
      }
      const listed = new Set<number>(a.patterns.map((r: any) => r.pad - 1));
      const empty = [...listed].filter((i) => !p.pads[i].sampleId).map((i) => i + 1);
      if (a.clear_other_pads) p.pads.forEach((pad, i) => { if (!listed.has(i) && pad.steps.some((v) => v > 0)) run('seq.setRow', { pad: i, steps: [] }); });
      for (const row of a.patterns) run('seq.setRow', { pad: row.pad - 1, steps: row.steps });
      const pads = [...listed].map((i) => i + 1).sort((x, y) => x - y).join(', ');
      return ok(empty.length ? `Written. Warning: pad ${empty.join(', ')} has no audio, so its steps will be silent.` : 'Written.', `Wrote patterns for pad ${pads}`);
    }

    case 'edit_pads': {
      if (!Array.isArray(a.pads) || !a.pads.length) return fail('pads must be a non-empty array.');
      for (const e of a.pads) {
        if (!isPad(e?.pad)) return fail('Each entry needs pad: an integer 1-16.');
        if (e.volume_percent !== undefined && (!isNum(e.volume_percent) || e.volume_percent < 0 || e.volume_percent > 150)) return fail('volume_percent must be 0 to 150.');
        if (e.semitones !== undefined && (!Number.isInteger(e.semitones) || e.semitones < -12 || e.semitones > 12)) return fail('semitones must be an integer from -12 to 12.');
        if (!p.pads[e.pad - 1].sampleId) return fail(`Pad ${e.pad} is empty; nothing to edit.`);
      }
      for (const e of a.pads) {
        run('pad.set', { pad: e.pad - 1, gain: e.volume_percent !== undefined ? e.volume_percent / 100 : undefined, semitones: e.semitones, reverse: e.reverse });
      }
      return ok('Done.', `Edited pad ${a.pads.map((e: any) => e.pad).join(', ')}`);
    }

    case 'slice_sample': {
      const s = p.samples.find((x) => x.id === p.activeSampleId);
      if (!s) return fail('There is no sample in the chop view. Ask the user to import audio.');
      let markers: number[];
      if (a.method === 'grid') {
        const parts = a.parts ?? 16;
        if (!Number.isInteger(parts) || parts < 2 || parts > 64) return fail('parts must be an integer from 2 to 64.');
        markers = Array.from({ length: parts - 1 }, (_, i) => ((i + 1) * s.duration) / parts);
      } else if (a.method === 'transients') {
        const sens = a.sensitivity ?? 0.5;
        if (!isNum(sens) || sens < 0 || sens > 1) return fail('sensitivity must be 0 to 1.');
        const au = deps.audio(s.id);
        if (!au) return fail('The sample audio is not loaded.');
        markers = detectTransients(au.mono, au.sampleRate, sens);
      } else return fail('method must be "transients" or "grid".');
      run('sample.setMarkers', { id: s.id, markers });
      if (a.send_to_pads) run('pads.assignSlices', { sampleId: s.id });
      const n = sliceBounds(getProject().samples.find((x) => x.id === s.id)!).length - 1;
      return ok(`"${s.name}" now has ${n} slices${a.send_to_pads ? `; the first ${Math.min(16, n)} are on pads 1-${Math.min(16, n)}` : ''}.`,
        `Sliced "${s.name}" into ${n}${a.send_to_pads ? ' and sent to pads' : ''}`);
    }

    case 'erase': {
      const needsPad = ['pad_steps', 'pad_recorded', 'pad'].includes(a.target);
      if (needsPad && !isPad(a.pad)) return fail('This target needs pad: an integer 1-16.');
      switch (a.target) {
        case 'all_steps': run('seq.clearAll', {}); return ok('Done.', 'Cleared all step patterns');
        case 'all_recorded': run('loop.clear', {}); return ok('Done.', 'Erased all recorded hits');
        case 'pad_steps': run('seq.setRow', { pad: a.pad - 1, steps: [] }); return ok('Done.', `Cleared steps on pad ${a.pad}`);
        case 'pad_recorded': run('loop.clearPad', { pad: a.pad - 1 }); return ok('Done.', `Erased recorded hits on pad ${a.pad}`);
        case 'pad': run('pad.clear', { pad: a.pad - 1 }); return ok('Done.', `Emptied pad ${a.pad}`);
        default: return fail('Unknown erase target.');
      }
    }

    default: return fail(`Unknown tool: ${name}`);
  }
}
