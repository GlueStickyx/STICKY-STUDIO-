import { beforeEach, describe, expect, it } from 'vitest';
import { dispatch, getProject, loadProject, undo } from '../src/core/bus';
import { arrangementSegments, segmentHits, songBars } from '../src/core/sequence';
import { emptyProject } from '../src/core/types';

const row = (...on: number[]) => Array.from({ length: 16 }, (_, i) => (on.includes(i) ? 1 : 0));
beforeEach(() => {
  loadProject(emptyProject());
  dispatch('sample.add', { sample: { id: 's1', name: 'T', duration: 4, sampleRate: 44100, markers: [1, 2, 3], bpm: null } });
  dispatch('pads.assignSlices', { sampleId: 's1' });
  dispatch('seq.setRow', { pad: 0, steps: row(0) });
  dispatch('clip.saveFromLoop', { id: 'kick', track: 0 }); // 2 bars, one hit per bar
  dispatch('seq.setRow', { pad: 0, steps: row() });
  dispatch('seq.setRow', { pad: 1, steps: row(4) });
  dispatch('project.setBars', { bars: 1 });
  dispatch('clip.saveFromLoop', { id: 'snare', track: 1 }); // 1 bar
  loadProject(getProject());
});
const arr = () => getProject().arrangement;

describe('arrangement', () => {
  it('places clips, measures the song, and refuses overlaps on the same track', () => {
    dispatch('arr.place', { id: 'a', clipId: 'kick', bar: 0, repeats: 2 }); // bars 0-4
    dispatch('arr.place', { id: 'b', clipId: 'snare', bar: 2, repeats: 4 }); // other track: bars 2-6
    expect(songBars(getProject())).toBe(6);
    dispatch('arr.place', { id: 'c', clipId: 'kick', bar: 3 }); // overlaps a
    dispatch('arr.place', { id: 'd', clipId: 'kick', bar: -1 });
    dispatch('arr.place', { id: 'e', clipId: 'nope', bar: 9 });
    dispatch('arr.place', { id: 'f', clipId: 'kick', bar: 300 });
    expect(arr().map((x) => x.id).sort()).toEqual(['a', 'b']);
    dispatch('arr.place', { id: 'g', clipId: 'kick', bar: 4 }); // touching is fine
    expect(arr()).toHaveLength(3);
  });
  it('move and repeat are refused when something is in the way', () => {
    dispatch('arr.place', { id: 'a', clipId: 'kick', bar: 0 });
    dispatch('arr.place', { id: 'b', clipId: 'kick', bar: 2 });
    dispatch('arr.setRepeats', { id: 'a', repeats: 2 });
    dispatch('arr.move', { id: 'b', bar: 1 });
    expect(arr().find((x) => x.id === 'a')!.repeats).toBe(1);
    expect(arr().find((x) => x.id === 'b')!.bar).toBe(2);
    dispatch('arr.move', { id: 'b', bar: 6 });
    dispatch('arr.setRepeats', { id: 'a', repeats: 3 });
    expect(songBars(getProject())).toBe(8);
    undo();
    expect(arr().find((x) => x.id === 'a')!.repeats).toBe(1);
  });
  it('deleting a clip removes its placements; clear empties the timeline', () => {
    dispatch('arr.place', { id: 'a', clipId: 'kick', bar: 0 });
    dispatch('arr.place', { id: 'b', clipId: 'snare', bar: 0 });
    dispatch('clip.remove', { id: 'kick' });
    expect(arr().map((x) => x.id)).toEqual(['b']);
    dispatch('arr.clear');
    expect(songBars(getProject())).toBe(0);
  });
  it('the song plays each clip only inside its block, and can start from a later bar', () => {
    dispatch('arr.place', { id: 'a', clipId: 'kick', bar: 1 }); // bars 1-3: hits at ticks 384, 768
    dispatch('arr.place', { id: 'b', clipId: 'snare', bar: 2, repeats: 2 }); // bars 2-4: hits at 864, 1248
    const p = getProject();
    expect(segmentHits(p, arrangementSegments(p), 0, 5000).map((h) => [h.abs, h.pad])).toEqual([[384, 0], [768, 0], [864, 1], [1248, 1]]);
    // From bar 2: the kick is in the second bar of its 2-bar pattern, so its hit lands on tick 0.
    expect(segmentHits(p, arrangementSegments(p, 2), 0, 5000).map((h) => [h.abs, h.pad])).toEqual([[0, 0], [96, 1], [480, 1]]);
  });
});
