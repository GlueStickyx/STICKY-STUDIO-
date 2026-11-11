import { describe, it, expect, beforeEach } from 'vitest';
import { canRedo, canUndo, commands, dispatch, getProject, loadProject, redo, subscribe, undo } from '../src/core/bus';
import { emptyProject } from '../src/core/types';
import type { LoopEvent, Sample } from '../src/core/types';

const sample = (id: string, duration = 4, markers: number[] = []): Sample =>
  ({ id, name: id, duration, sampleRate: 44100, markers, bpm: null });
const ev = (id: string, pad: number, tick: number): LoopEvent => ({ id, pad, tick, vel: 1 });

/** Number of undo steps currently available (restores state afterwards). */
function undoDepth(): number {
  let n = 0;
  while (canUndo()) { undo(); n++; }
  for (let i = 0; i < n; i++) redo();
  return n;
}

beforeEach(() => {
  loadProject(emptyProject());
});

describe('dispatch', () => {
  it('starts from an empty project with no history', () => {
    expect(getProject()).toEqual(emptyProject());
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
  });

  it('changes state', () => {
    dispatch('project.setBpm', { bpm: 97 });
    expect(getProject().bpm).toBe(97);
    dispatch('project.setSwing', { swing: 0.3 });
    expect(getProject().swing).toBe(0.3);
  });

  it('does not mutate the previous state object', () => {
    const before = getProject();
    const snapshot = JSON.parse(JSON.stringify(before));
    dispatch('seq.setStep', { pad: 0, step: 3, vel: 1 });
    dispatch('loop.addEvent', { event: ev('a', 0, 10) });
    expect(getProject()).not.toBe(before);
    expect(before).toEqual(snapshot);
  });

  it('throws on an unknown command and leaves state alone', () => {
    const before = getProject();
    expect(() => dispatch('nope.nothing', {})).toThrow(/Unknown command: nope\.nothing/);
    expect(getProject()).toBe(before);
    expect(canUndo()).toBe(false);
  });

  it('notifies subscribers, and stops after unsubscribe', () => {
    let calls = 0;
    const off = subscribe(() => { calls++; });
    dispatch('project.setBpm', { bpm: 100 });
    expect(calls).toBe(1);
    off();
    dispatch('project.setBpm', { bpm: 101 });
    expect(calls).toBe(1);
  });

  it('every command has a description and an undoable flag', () => {
    for (const [name, def] of Object.entries(commands)) {
      expect(def.describe.length, name).toBeGreaterThan(0);
      expect(typeof def.undoable, name).toBe('boolean');
    }
  });
});

describe('undo / redo', () => {
  it('undo restores the previous state and redo re-applies it', () => {
    dispatch('project.setBpm', { bpm: 90 });
    dispatch('project.setBpm', { bpm: 150 });
    expect(canUndo()).toBe(true);
    undo();
    expect(getProject().bpm).toBe(90);
    undo();
    expect(getProject().bpm).toBe(120);
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);
    redo();
    expect(getProject().bpm).toBe(90);
    redo();
    expect(getProject().bpm).toBe(150);
    expect(canRedo()).toBe(false);
  });

  it('undo and redo with nothing to do are no-ops', () => {
    const before = getProject();
    undo();
    redo();
    expect(getProject()).toBe(before);
  });

  it('a new change after undo clears the redo stack', () => {
    dispatch('project.setBpm', { bpm: 90 });
    undo();
    expect(canRedo()).toBe(true);
    dispatch('project.setBpm', { bpm: 100 });
    expect(canRedo()).toBe(false);
    redo();
    expect(getProject().bpm).toBe(100);
  });

  it('restores structural changes (steps, events, pads) exactly', () => {
    dispatch('sample.add', { sample: sample('s1', 4, [1, 2, 3]) });
    dispatch('pads.assignSlices', { sampleId: 's1' });
    dispatch('seq.setStep', { pad: 1, step: 4, vel: 0.7 });
    dispatch('loop.addEvent', { event: ev('a', 1, 48) });
    const full = JSON.parse(JSON.stringify(getProject()));
    undo(); undo(); undo(); undo();
    expect(getProject()).toEqual(emptyProject());
    redo(); redo(); redo(); redo();
    expect(getProject()).toEqual(full);
  });

  it('non-undoable commands do not add undo steps', () => {
    dispatch('pad.select', { pad: 5 });
    dispatch('project.setMetronome', { on: true });
    expect(getProject().selectedPad).toBe(5);
    expect(getProject().metronome).toBe(true);
    expect(canUndo()).toBe(false);

    dispatch('project.setBpm', { bpm: 99 });
    dispatch('pad.select', { pad: 7 });
    dispatch('project.setMetronome', { on: false });
    expect(undoDepth()).toBe(1);
  });

  it('non-undoable commands do not clear the redo stack', () => {
    dispatch('project.setBpm', { bpm: 99 });
    undo();
    dispatch('pad.select', { pad: 3 });
    expect(canRedo()).toBe(true);
    redo();
    expect(getProject().bpm).toBe(99);
  });

  it('undo keeps the current pad selection', () => {
    dispatch('project.setBpm', { bpm: 99 });
    dispatch('pad.select', { pad: 9 });
    undo();
    expect(getProject().bpm).toBe(120);
    expect(getProject().selectedPad).toBe(9);
    redo();
    expect(getProject().selectedPad).toBe(9);
  });

  it('undoing past a metronome change must not flip the metronome back', () => {
    // setMetronome is not undoable, so like pad selection it should survive an undo of something else.
    dispatch('project.setBpm', { bpm: 99 });
    dispatch('project.setMetronome', { on: true });
    undo();
    expect(getProject().bpm).toBe(120);
    expect(getProject().metronome).toBe(true);
  });

  it('loadProject clears history', () => {
    dispatch('project.setBpm', { bpm: 99 });
    dispatch('project.setBpm', { bpm: 98 });
    undo();
    loadProject({ ...emptyProject(), bpm: 77 });
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(false);
    expect(getProject().bpm).toBe(77);
  });
});

describe('group', () => {
  it('merges repeated dispatches into one undo step', () => {
    for (let b = 121; b <= 140; b++) dispatch('project.setBpm', { bpm: b }, { group: 'bpm-drag' });
    expect(getProject().bpm).toBe(140);
    expect(undoDepth()).toBe(1);
    undo();
    expect(getProject().bpm).toBe(120);
    expect(canUndo()).toBe(false);
    redo();
    expect(getProject().bpm).toBe(140);
  });

  it('different groups make separate undo steps', () => {
    dispatch('project.setBpm', { bpm: 130 }, { group: 'a' });
    dispatch('project.setBpm', { bpm: 131 }, { group: 'a' });
    dispatch('project.setSwing', { swing: 0.2 }, { group: 'b' });
    dispatch('project.setSwing', { swing: 0.3 }, { group: 'b' });
    expect(undoDepth()).toBe(2);
    undo();
    expect(getProject().swing).toBe(0);
    expect(getProject().bpm).toBe(131);
  });

  it('ungrouped dispatches are never merged', () => {
    dispatch('project.setBpm', { bpm: 130 });
    dispatch('project.setBpm', { bpm: 131 });
    dispatch('project.setBpm', { bpm: 132 });
    expect(undoDepth()).toBe(3);
  });

  it('an ungrouped command in between breaks the group', () => {
    dispatch('project.setBpm', { bpm: 130 }, { group: 'g' });
    dispatch('project.setSwing', { swing: 0.2 });
    dispatch('project.setBpm', { bpm: 131 }, { group: 'g' });
    expect(undoDepth()).toBe(3);
  });

  it('undo breaks the group, so the next grouped dispatch is its own step', () => {
    dispatch('project.setSwing', { swing: 0.1 });
    dispatch('project.setBpm', { bpm: 130 }, { group: 'g' });
    undo();
    dispatch('project.setBpm', { bpm: 131 }, { group: 'g' });
    expect(undoDepth()).toBe(2);
    undo();
    expect(getProject().bpm).toBe(120);
    expect(getProject().swing).toBe(0.1);
  });

  it('groups a recording take of loop events', () => {
    for (let i = 0; i < 5; i++) dispatch('loop.addEvent', { event: ev(`e${i}`, 0, i * 24) }, { group: 'take-1' });
    expect(getProject().events).toHaveLength(5);
    undo();
    expect(getProject().events).toHaveLength(0);
  });
});

describe('project commands', () => {
  it('bpm clamps to 40-240', () => {
    dispatch('project.setBpm', { bpm: 10 });
    expect(getProject().bpm).toBe(40);
    dispatch('project.setBpm', { bpm: 39.99 });
    expect(getProject().bpm).toBe(40);
    dispatch('project.setBpm', { bpm: 1000 });
    expect(getProject().bpm).toBe(240);
    dispatch('project.setBpm', { bpm: -5 });
    expect(getProject().bpm).toBe(40);
    dispatch('project.setBpm', { bpm: 240 });
    expect(getProject().bpm).toBe(240);
  });

  it('bpm rounds to one decimal', () => {
    dispatch('project.setBpm', { bpm: 123.456 });
    expect(getProject().bpm).toBe(123.5);
  });

  it('swing clamps to 0-0.6', () => {
    dispatch('project.setSwing', { swing: 2 });
    expect(getProject().swing).toBe(0.6);
    dispatch('project.setSwing', { swing: -1 });
    expect(getProject().swing).toBe(0);
  });

  it('project.setBars drops events beyond the new loop length', () => {
    dispatch('project.setBars', { bars: 4 });
    for (const [id, tick] of [['a', 0], ['b', 383], ['c', 384], ['d', 767.5], ['e', 768], ['f', 1535]] as [string, number][]) {
      dispatch('loop.addEvent', { event: ev(id, 0, tick) });
    }
    dispatch('project.setBars', { bars: 2 });
    expect(getProject().bars).toBe(2);
    expect(getProject().events.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
    dispatch('project.setBars', { bars: 1 });
    expect(getProject().events.map((e) => e.id)).toEqual(['a', 'b']);
    // Growing the loop keeps what is left and does not resurrect dropped events.
    dispatch('project.setBars', { bars: 4 });
    expect(getProject().events.map((e) => e.id)).toEqual(['a', 'b']);
    // ...but undo does bring them back.
    undo(); undo(); undo();
    expect(getProject().bars).toBe(4);
    expect(getProject().events).toHaveLength(6);
  });

  it('project.reset returns to an empty project and is undoable', () => {
    dispatch('project.setBpm', { bpm: 88 });
    dispatch('sample.add', { sample: sample('s1') });
    dispatch('project.reset');
    expect(getProject()).toEqual(emptyProject());
    undo();
    expect(getProject().bpm).toBe(88);
    expect(getProject().samples).toHaveLength(1);
  });
});

describe('sample commands', () => {
  beforeEach(() => {
    dispatch('sample.add', { sample: sample('s1', 4) });
  });
  const markers = () => getProject().samples.find((s) => s.id === 's1')!.markers;

  it('sample.add appends and makes the sample active', () => {
    expect(getProject().samples.map((s) => s.id)).toEqual(['s1']);
    expect(getProject().activeSampleId).toBe('s1');
    dispatch('sample.add', { sample: sample('s2') });
    expect(getProject().activeSampleId).toBe('s2');
  });

  it('sample.addMarker keeps markers sorted', () => {
    for (const time of [2, 1, 3, 0.5, 2.5]) dispatch('sample.addMarker', { id: 's1', time });
    expect(markers()).toEqual([0.5, 1, 2, 2.5, 3]);
  });

  it('sample.addMarker de-duplicates', () => {
    dispatch('sample.addMarker', { id: 's1', time: 1 });
    dispatch('sample.addMarker', { id: 's1', time: 1 });
    dispatch('sample.addMarker', { id: 's1', time: 1.00001 }); // same after rounding to 0.1 ms
    dispatch('sample.addMarker', { id: 's1', time: 2 });
    expect(markers()).toEqual([1, 2]);
  });

  it('sample.addMarker keeps markers inside the sample', () => {
    for (const time of [0, -1, 4, 4.5, 100, 0.001, 3.999]) dispatch('sample.addMarker', { id: 's1', time });
    expect(markers()).toEqual([]);
    dispatch('sample.addMarker', { id: 's1', time: 0.01 });
    dispatch('sample.addMarker', { id: 's1', time: 3.99 });
    expect(markers()).toEqual([0.01, 3.99]);
  });

  it('sample.addMarker only touches the named sample', () => {
    dispatch('sample.add', { sample: sample('s2', 4) });
    dispatch('sample.addMarker', { id: 's2', time: 1 });
    expect(markers()).toEqual([]);
    expect(getProject().samples[1].markers).toEqual([1]);
  });

  it('sample.setMarkers cleans its input', () => {
    dispatch('sample.setMarkers', { id: 's1', markers: [3, 1, 1, -2, 9, 2, 0] });
    expect(markers()).toEqual([1, 2, 3]);
  });

  it('sample.removeMarker removes by index', () => {
    dispatch('sample.setMarkers', { id: 's1', markers: [1, 2, 3] });
    dispatch('sample.removeMarker', { id: 's1', index: 1 });
    expect(markers()).toEqual([1, 3]);
  });

  it('sample.moveMarker re-sorts and drops a marker dragged outside', () => {
    dispatch('sample.setMarkers', { id: 's1', markers: [1, 2, 3] });
    dispatch('sample.moveMarker', { id: 's1', index: 0, time: 2.5 });
    expect(markers()).toEqual([2, 2.5, 3]);
    dispatch('sample.moveMarker', { id: 's1', index: 2, time: 99 });
    expect(markers()).toEqual([2, 2.5]);
  });

  it('sample.remove clears pads using it but keeps their steps', () => {
    dispatch('sample.setMarkers', { id: 's1', markers: [1, 2] });
    dispatch('pads.assignSlices', { sampleId: 's1' });
    dispatch('seq.setStep', { pad: 0, step: 2, vel: 1 });
    dispatch('sample.remove', { id: 's1' });
    const p = getProject();
    expect(p.samples).toEqual([]);
    expect(p.activeSampleId).toBeNull();
    expect(p.pads.every((pad) => pad.sampleId === null)).toBe(true);
    expect(p.pads[0].steps[2]).toBe(1);
  });
});

describe('pad commands', () => {
  it('pads.assignSlices maps slices to consecutive pads with correct start/end', () => {
    dispatch('sample.add', { sample: sample('s1', 4, [1, 2.5, 3]) });
    dispatch('pads.assignSlices', { sampleId: 's1' });
    const pads = getProject().pads;
    expect(pads.slice(0, 4).map((p) => [p.sampleId, p.start, p.end])).toEqual([
      ['s1', 0, 1], ['s1', 1, 2.5], ['s1', 2.5, 3], ['s1', 3, 4],
    ]);
    expect(pads.slice(4).every((p) => p.sampleId === null)).toBe(true);
  });

  it('pads.assignSlices with no markers puts the whole sample on pad 1', () => {
    dispatch('sample.add', { sample: sample('s1', 2.5) });
    dispatch('pads.assignSlices', { sampleId: 's1' });
    const pads = getProject().pads;
    expect([pads[0].sampleId, pads[0].start, pads[0].end]).toEqual(['s1', 0, 2.5]);
    expect(pads[1].sampleId).toBeNull();
  });

  it('pads.assignSlices uses only the first 16 of many slices', () => {
    const m = Array.from({ length: 24 }, (_, i) => (i + 1) * 0.1); // 25 slices
    dispatch('sample.add', { sample: sample('s1', 2.5, m) });
    dispatch('pads.assignSlices', { sampleId: 's1' });
    const pads = getProject().pads;
    expect(pads).toHaveLength(16);
    pads.forEach((pad, i) => {
      expect(pad.sampleId).toBe('s1');
      expect(pad.start).toBeCloseTo(i * 0.1, 9);
      expect(pad.end).toBeCloseTo((i + 1) * 0.1, 9);
    });
    for (let i = 0; i < 15; i++) expect(pads[i].end).toBe(pads[i + 1].start);
  });

  it('pads.assignSlices resets gain/pitch/reverse but keeps steps', () => {
    dispatch('sample.add', { sample: sample('s1', 4, [2]) });
    dispatch('pad.set', { pad: 0, gain: 0.3, semitones: 5, reverse: true });
    dispatch('seq.setStep', { pad: 0, step: 1, vel: 0.9 });
    dispatch('pads.assignSlices', { sampleId: 's1' });
    const pad = getProject().pads[0];
    expect([pad.gain, pad.semitones, pad.reverse]).toEqual([1, 0, false]);
    expect(pad.steps[1]).toBe(0.9);
  });

  it('pads.assignSlices with an unknown sample changes nothing and adds no undo step', () => {
    const before = getProject();
    dispatch('pads.assignSlices', { sampleId: 'missing' });
    expect(getProject()).toBe(before);
    expect(canUndo()).toBe(false);
  });

  it('pad.set clamps gain and semitones', () => {
    dispatch('pad.set', { pad: 2, gain: 9, semitones: 40 });
    expect(getProject().pads[2].gain).toBe(1.5);
    expect(getProject().pads[2].semitones).toBe(12);
    dispatch('pad.set', { pad: 2, gain: -1, semitones: -40.4 });
    expect(getProject().pads[2].gain).toBe(0);
    expect(getProject().pads[2].semitones).toBe(-12);
    dispatch('pad.set', { pad: 2, reverse: true });
    expect(getProject().pads[2]).toMatchObject({ gain: 0, semitones: -12, reverse: true });
  });

  it('pad.clear empties the pad and removes only that pad\'s events', () => {
    dispatch('sample.add', { sample: sample('s1', 4, [1, 2]) });
    dispatch('pads.assignSlices', { sampleId: 's1' });
    dispatch('seq.setStep', { pad: 1, step: 0, vel: 1 });
    dispatch('seq.setStep', { pad: 2, step: 0, vel: 1 });
    dispatch('loop.addEvent', { event: ev('a', 1, 0) });
    dispatch('loop.addEvent', { event: ev('b', 2, 24) });
    dispatch('loop.addEvent', { event: ev('c', 1, 48) });
    dispatch('loop.addEvent', { event: ev('d', 0, 72) });
    dispatch('pad.clear', { pad: 1 });
    const p = getProject();
    expect(p.events.map((e) => e.id)).toEqual(['b', 'd']);
    expect(p.pads[1]).toEqual(emptyProject().pads[1]);
    expect(p.pads[2].sampleId).toBe('s1');
    expect(p.pads[2].steps[0]).toBe(1);
    undo();
    expect(getProject().events.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(getProject().pads[1].sampleId).toBe('s1');
  });

  it('pad.select clamps to the 16 pads', () => {
    dispatch('pad.select', { pad: 99 });
    expect(getProject().selectedPad).toBe(15);
    dispatch('pad.select', { pad: -3 });
    expect(getProject().selectedPad).toBe(0);
  });
});

describe('sequencer and loop commands', () => {
  it('seq.setStep sets one step with clamped velocity and ignores out-of-range steps', () => {
    dispatch('seq.setStep', { pad: 3, step: 5, vel: 2 });
    expect(getProject().pads[3].steps[5]).toBe(1);
    expect(getProject().pads[3].steps.filter((v) => v > 0)).toHaveLength(1);
    const before = getProject();
    dispatch('seq.setStep', { pad: 3, step: 16, vel: 1 });
    dispatch('seq.setStep', { pad: 3, step: -1, vel: 1 });
    expect(getProject()).toBe(before);
    expect(getProject().pads[3].steps).toHaveLength(16);
  });

  it('seq.setRow always yields 16 clamped steps', () => {
    dispatch('seq.setRow', { pad: 0, steps: [1, 0, 5, -1] });
    expect(getProject().pads[0].steps).toEqual([1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('seq.clearAll clears every pad', () => {
    dispatch('seq.setStep', { pad: 3, step: 5, vel: 1 });
    dispatch('seq.setStep', { pad: 9, step: 0, vel: 1 });
    dispatch('seq.clearAll');
    expect(getProject().pads.every((pad) => pad.steps.every((v) => v === 0))).toBe(true);
  });

  it('loop.clearPad and loop.clear', () => {
    dispatch('loop.addEvent', { event: ev('a', 1, 0) });
    dispatch('loop.addEvent', { event: ev('b', 2, 24) });
    dispatch('loop.clearPad', { pad: 1 });
    expect(getProject().events.map((e) => e.id)).toEqual(['b']);
    dispatch('loop.clear');
    expect(getProject().events).toEqual([]);
  });
});
