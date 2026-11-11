import { beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '../src/ai/tools';
import { handleMidiMessage } from '../src/audio/midiin';
import { canUndo, dispatch, getProject, loadProject, undo } from '../src/core/bus';
import { midiToNotes, parseMidi, projectToMidi } from '../src/core/midi';
import { hitsInWindow } from '../src/core/sequence';
import { emptyProject } from '../src/core/types';

const note = (o: object) => ({ id: Math.random().toString(36), pad: 0, tick: 0, len: 48, pitch: 0, vel: 1, ...o });
beforeEach(() => {
  loadProject(emptyProject());
  dispatch('sample.add', { sample: { id: 's1', name: 'Test', duration: 2, sampleRate: 44100, markers: [1], bpm: null } });
  dispatch('pads.assignSlices', { sampleId: 's1' });
  loadProject(getProject());
});

describe('note commands', () => {
  it('adds, clamps and removes notes', () => {
    dispatch('note.add', { note: note({ id: 'a', tick: 700, len: 500, pitch: 40 }) }); // 2-bar loop = 768 ticks
    expect(getProject().notes[0]).toMatchObject({ tick: 700, len: 68, pitch: 12 });
    dispatch('note.add', { note: note({ tick: 9999 }) }); // outside the loop: ignored
    dispatch('note.add', { note: note({ tick: NaN }) });
    expect(getProject().notes).toHaveLength(1);
    dispatch('note.remove', { id: 'a' });
    expect(getProject().notes).toHaveLength(0);
  });
  it('notes.set replaces only that pad, and shortening the loop trims notes', () => {
    dispatch('note.add', { note: note({ id: 'keep', pad: 1 }) });
    dispatch('notes.set', { pad: 0, notes: [note({ tick: 0 }), note({ tick: 400, len: 300 })] });
    dispatch('notes.set', { pad: 0, notes: [note({ tick: 96 }), note({ tick: 360, len: 300 })] });
    expect(getProject().notes.map((n) => n.pad).sort()).toEqual([0, 0, 1]);
    dispatch('project.setBars', { bars: 1 });
    const mine = getProject().notes.filter((n) => n.pad === 0);
    expect(mine.find((n) => n.tick === 360)!.len).toBe(24);
    dispatch('pad.clear', { pad: 0 });
    expect(getProject().notes.map((n) => n.id)).toEqual(['keep']);
  });
  it('setting the scale is not an undo step and survives undo', () => {
    dispatch('project.setScale', { scale: 'phrygian', root: 4 });
    expect(canUndo()).toBe(false);
    dispatch('project.setBpm', { bpm: 90 });
    undo();
    expect(getProject()).toMatchObject({ scale: 'phrygian', root: 4, bpm: 120 });
    dispatch('project.setScale', { scale: 'nonsense' });
    expect(getProject().scale).toBe('phrygian');
  });
  it('notes are scheduled every loop pass with pitch and length', () => {
    dispatch('note.add', { note: note({ tick: 96, len: 48, pitch: 7 }) });
    const hits = hitsInWindow(getProject(), 0, 768 * 2).filter((h) => h.pitch !== undefined);
    expect(hits.map((h) => h.abs)).toEqual([96, 864]);
    expect(hits[0]).toMatchObject({ pad: 0, pitch: 7, len: 48 });
  });
});

describe('MIDI files', () => {
  it('round-trips notes, tempo and drum hits', () => {
    dispatch('project.setBpm', { bpm: 97 });
    dispatch('project.setScale', { root: 2 });
    dispatch('seq.setRow', { pad: 0, steps: [1, 0, 0, 0, 0.5] });
    dispatch('loop.addEvent', { event: { id: 'e', pad: 1, tick: 100, vel: 0.8 } });
    dispatch('notes.set', { pad: 1, notes: [note({ tick: 0, len: 96, pitch: 0 }), note({ tick: 96, len: 24, pitch: -5, vel: 0.5 }), note({ tick: 96, len: 24, pitch: 7 })] });
    const bytes = projectToMidi(getProject());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('MThd');
    const m = parseMidi(bytes);
    expect(m.bpm).toBeCloseTo(97, 0);
    const drums = m.notes.filter((n) => n.channel === 9);
    expect(drums.filter((n) => n.key === 36).map((n) => n.tick)).toEqual([0, 96, 384, 480]); // step 1 and 5, both bars
    expect(drums.filter((n) => n.key === 37).map((n) => n.tick)).toEqual([100]);
    const mel = m.notes.filter((n) => n.channel !== 9);
    expect(mel.map((n) => [n.tick, n.len, n.key]).sort()).toEqual([[0, 96, 62], [96, 24, 57], [96, 24, 69]].sort());
    const back = midiToNotes(m, 5, 2, 768, () => 'x');
    expect(back.dropped).toBe(0);
    expect(back.notes.map((n) => [n.tick, n.len, n.pitch, n.pad]).sort()).toEqual([[0, 96, 0, 5], [96, 24, -5, 5], [96, 24, 7, 5]].sort());
  });
  it('swing moves off-beat steps in the file', () => {
    dispatch('project.setSwing', { swing: 0.5 });
    dispatch('seq.setRow', { pad: 0, steps: [0, 1] });
    expect(parseMidi(projectToMidi(getProject())).notes[0].tick).toBe(36);
  });
  it('folds far pitches by octaves and drops notes past the loop', () => {
    const r = midiToNotes({ bpm: null, notes: [{ tick: 0, len: 10, key: 96, vel: 1, channel: 0 }, { tick: 0, len: 10, key: 30, vel: 1, channel: 0 }, { tick: 5000, len: 10, key: 60, vel: 1, channel: 0 }] }, 0, 0, 768, () => 'x');
    expect(r.notes.map((n) => n.pitch)).toEqual([12, -6]);
    expect(r.dropped).toBe(1);
  });
  it('rescales files with a different resolution and rejects non-MIDI data', () => {
    // 480 ticks per quarter: one quarter note at tick 480 -> our tick 96, length 96
    const file = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 14,
      0x83, 0x60, 0x90, 60, 100, 0x83, 0x60, 60, 0, /* running status note-off */ 0, 0xff, 0x2f, 0]);
    expect(parseMidi(file).notes).toEqual([{ tick: 96, len: 96, key: 60, vel: 100 / 127, channel: 0 }]);
    expect(() => parseMidi(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => parseMidi(new TextEncoder().encode('RIFF....WAVEfmt this is not midi'))).toThrow();
  });
});

describe('MIDI keyboard mapping', () => {
  const log: string[] = [];
  const target = { hitPad: (i: number) => log.push(`hit ${i}`), noteOn: (k: string, pad: number, pitch: number) => log.push(`on ${pad} ${pitch}`), noteOff: (k: string) => log.push(`off ${k}`) };
  beforeEach(() => { log.length = 0; });
  it('pads mode: notes 36-51 hit the bank on screen', () => {
    dispatch('bank.select', { bank: 1 });
    handleMidiMessage([0x90, 36, 100], target, 'pads');
    handleMidiMessage([0x99, 51, 1], target, 'pads');
    handleMidiMessage([0x90, 60, 100], target, 'pads');
    handleMidiMessage([0x80, 36, 0], target, 'pads');
    expect(log).toEqual(['hit 16', 'hit 31']);
  });
  it('keys mode: middle C plus root is the pad pitch; out-of-range keys are ignored', () => {
    dispatch('pad.select', { pad: 3 });
    dispatch('project.setScale', { root: 2 });
    handleMidiMessage([0x90, 62, 100], target, 'keys');
    handleMidiMessage([0x90, 69, 100], target, 'keys');
    handleMidiMessage([0x90, 69, 0], target, 'keys'); // note-on with velocity 0 = note-off
    handleMidiMessage([0x80, 62, 0], target, 'keys');
    handleMidiMessage([0x90, 100, 100], target, 'keys');
    handleMidiMessage([0xb0, 1, 64], target, 'keys'); // mod wheel: ignored
    expect(log).toEqual(['on 3 0', 'on 3 7', 'off midi-69', 'off midi-62']);
  });
});

describe('assistant write_notes', () => {
  const deps = { audio: () => null, isPlaying: () => false, setPlaying: () => {} };
  const call = (input: unknown) => runTool('write_notes', input, deps, 'ai-t');
  it('writes, appends, clears and reports state', () => {
    expect(call({ pad: 'A1', notes: [{ step: 1, pitch: 0, length_steps: 4 }, { step: 5, pitch: 3, length_steps: 2, velocity: 0.6 }], scale: 'dorian' }).change).toBe('Wrote 2 notes on pad A1');
    expect(getProject().notes.map((n) => [n.tick, n.len, n.pitch])).toEqual([[0, 96, 0], [96, 48, 3]]);
    expect(getProject().scale).toBe('dorian');
    call({ pad: 'A1', notes: [{ step: 9, pitch: -12, length_steps: 1 }], keep_existing: true });
    expect(getProject().notes).toHaveLength(3);
    const st = JSON.parse(runTool('get_studio_state', {}, deps, 'ai-t').text);
    expect(st.loop_steps).toBe(32);
    expect(st.pads[0].notes).toEqual([[1, 0, 4], [5, 3, 2], [9, -12, 1]]);
    expect(call({ pad: 'A1', notes: [] }).change).toBe('Cleared notes on pad A1');
    expect(getProject().notes).toHaveLength(0);
  });
  it('rejects bad notes without changing anything', () => {
    for (const bad of [
      { pad: 'A1', notes: [{ step: 33, pitch: 0, length_steps: 1 }] }, { pad: 'A1', notes: [{ step: 0, pitch: 0, length_steps: 1 }] },
      { pad: 'A1', notes: [{ step: 1, pitch: 13, length_steps: 1 }] }, { pad: 'A1', notes: [{ step: 1, pitch: 0.5, length_steps: 1 }] },
      { pad: 'A1', notes: [{ step: 1, pitch: 0, length_steps: 0 }] }, { pad: 'A9', notes: [{ step: 1, pitch: 0, length_steps: 1 }] },
      { pad: 'A1', notes: 'x' }, { pad: 'A1', notes: [], scale: 'blues' },
    ]) expect(call(bad).isError).toBe(true);
    expect(getProject().notes).toHaveLength(0);
  });
});
