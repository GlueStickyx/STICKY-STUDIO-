import { beforeEach, describe, expect, it } from 'vitest';
import { TOOLS, runTool } from '../src/ai/tools';
import type { StudioDeps } from '../src/ai/tools';
import { describeAudio } from '../src/audio/analysis';
import { canUndo, dispatch, getProject, loadProject, undo } from '../src/core/bus';
import { emptyProject } from '../src/core/types';

const SR = 44100;
// Two seconds: a 60 Hz thump in the first half, white-ish noise in the second.
const mono = new Float32Array(SR * 2);
for (let i = 0; i < SR; i++) mono[i] = Math.sin((2 * Math.PI * 60 * i) / SR) * Math.exp((-6 * i) / SR);
let seed = 3;
for (let i = SR; i < SR * 2; i++) { seed = (seed * 16807) % 2147483647; mono[i] = ((seed / 2147483647) * 2 - 1) * Math.exp((-20 * (i - SR)) / SR) * 0.5; }
// Give both halves a sharp start so transient detection has something to find.
let playing = false;
const deps: StudioDeps = { audio: (id) => (id === 's1' ? { mono, sampleRate: SR } : null), isPlaying: () => playing, setPlaying: (on) => { playing = on; } };
const call = (name: string, input: unknown) => runTool(name, input, deps, 'ai-test');

beforeEach(() => {
  playing = false;
  loadProject(emptyProject());
  dispatch('sample.add', { sample: { id: 's1', name: 'Test', duration: 2, sampleRate: SR, markers: [1], bpm: null } });
  dispatch('pads.assignSlices', { sampleId: 's1' });
  loadProject(getProject());
});

describe('tool definitions', () => {
  it('every tool has a name, description and closed object schema', () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description!.length).toBeGreaterThan(20);
      expect((t.input_schema as any).additionalProperties).toBe(false);
    }
  });
});

describe('reading', () => {
  it('get_studio_state reports pads with 1-based numbers and step strings', () => {
    dispatch('seq.setRow', { pad: 0, steps: [1, 0, 0.5, 0] });
    const s = JSON.parse(call('get_studio_state', {}).text);
    expect(s.pads[0]).toMatchObject({ pad: 1, sample: 'Test', steps: 'X.o.............' });
    expect(s.pads[2]).toEqual({ pad: 3, empty: true });
  });
  it('describe_pads tells a low thump from bright noise', () => {
    const d = JSON.parse(call('describe_pads', {}).text);
    expect(d).toHaveLength(2);
    expect(d[0].low).toBeGreaterThan(0.6);
    expect(d[0].hint).toMatch(/kick|bass/);
    expect(d[1].high).toBeGreaterThan(0.5);
    expect(d[1].hint).toMatch(/hat|bright/);
  });
  it('describeAudio shares sum to 1 and silence is labelled', () => {
    const d = describeAudio(mono.subarray(0, SR), SR);
    expect(d.low + d.mid + d.high).toBeCloseTo(1, 1);
    expect(describeAudio(new Float32Array(1000), SR).hint).toBe('near silence');
  });
});

describe('writing', () => {
  it('write_patterns sets steps and warns about empty pads', () => {
    const steps = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 1 : 0));
    const r = call('write_patterns', { patterns: [{ pad: 1, steps }, { pad: 5, steps }] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/pad 5 has no audio/);
    expect(r.change).toBe('Wrote patterns for pad 1, 5');
    expect(getProject().pads[0].steps).toEqual(steps);
  });
  it('clear_other_pads wipes unlisted rows', () => {
    dispatch('seq.setRow', { pad: 1, steps: [1] });
    call('write_patterns', { patterns: [{ pad: 1, steps: new Array(16).fill(0) }], clear_other_pads: true });
    expect(getProject().pads[1].steps.every((v) => v === 0)).toBe(true);
  });
  it('rejects bad input without changing anything', () => {
    for (const bad of [
      { patterns: [{ pad: 0, steps: new Array(16).fill(0) }] },
      { patterns: [{ pad: 1, steps: [1, 0] }] },
      { patterns: [{ pad: 1, steps: new Array(16).fill(2) }] },
      { patterns: [] }, {}, null, 'x', [1],
    ]) {
      const r = call('write_patterns', bad);
      expect(r.isError).toBe(true);
    }
    expect(call('edit_pads', { pads: [{ pad: 9, semitones: 3 }] }).isError).toBe(true); // empty pad
    expect(call('edit_pads', { pads: [{ pad: 1, semitones: 40 }] }).isError).toBe(true);
    expect(call('set_transport', { bpm: 999 }).isError).toBe(true);
    expect(call('nope', {}).isError).toBe(true);
    expect(canUndo()).toBe(false);
  });
  it('edit_pads and set_transport apply values', () => {
    call('edit_pads', { pads: [{ pad: 2, volume_percent: 50, semitones: -5, reverse: true }] });
    expect(getProject().pads[1]).toMatchObject({ gain: 0.5, semitones: -5, reverse: true });
    call('set_transport', { bpm: 92, swing_percent: 20, loop_bars: 4, playing: true });
    expect(getProject()).toMatchObject({ bpm: 92, swing: 0.2, bars: 4 });
    expect(playing).toBe(true);
  });
  it('slice_sample grid + send_to_pads fills pads', () => {
    const r = call('slice_sample', { method: 'grid', parts: 8, send_to_pads: true });
    expect(r.text).toMatch(/8 slices/);
    expect(getProject().pads.filter((p) => p.sampleId).length).toBe(8);
    expect(getProject().pads[7].end).toBeCloseTo(2);
  });
  it('slice_sample transients finds the second hit', () => {
    call('slice_sample', { method: 'transients', sensitivity: 0.5 });
    const m = getProject().samples[0].markers;
    expect(m.some((t) => Math.abs(t - 1) < 0.03)).toBe(true);
  });
  it('erase targets', () => {
    dispatch('seq.setRow', { pad: 0, steps: [1] });
    dispatch('loop.addEvent', { event: { id: 'e', pad: 0, tick: 0, vel: 1 } });
    call('erase', { target: 'pad_recorded', pad: 1 });
    expect(getProject().events).toHaveLength(0);
    call('erase', { target: 'all_steps' });
    expect(getProject().pads[0].steps.every((v) => v === 0)).toBe(true);
    expect(call('erase', { target: 'pad' }).isError).toBe(true);
  });
  it('a whole assistant turn is one undo step, however long it takes', async () => {
    call('set_transport', { bpm: 90 });
    await new Promise((r) => setTimeout(r, 1700)); // longer than the normal merge window
    call('write_patterns', { patterns: [{ pad: 1, steps: new Array(16).fill(1) }] });
    call('edit_pads', { pads: [{ pad: 1, semitones: 2 }] });
    undo();
    expect(getProject().bpm).toBe(120);
    expect(getProject().pads[0].steps.every((v) => v === 0)).toBe(true);
    expect(getProject().pads[0].semitones).toBe(0);
    expect(canUndo()).toBe(false);
  });
});
