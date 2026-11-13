import { beforeEach, describe, expect, it } from 'vitest';
import { canUndo, dispatch, getProject, loadProject, undo } from '../src/core/bus';
import { hitsInWindow, nextBar, segmentHits } from '../src/core/sequence';
import { emptyProject } from '../src/core/types';

const row = (...on: number[]) => Array.from({ length: 16 }, (_, i) => (on.includes(i) ? 1 : 0));
beforeEach(() => {
  loadProject(emptyProject());
  dispatch('sample.add', { sample: { id: 's1', name: 'T', duration: 4, sampleRate: 44100, markers: [1, 2, 3], bpm: null } });
  dispatch('pads.assignSlices', { sampleId: 's1' });
  loadProject(getProject());
});

describe('clips', () => {
  it('an empty loop is not saved', () => {
    dispatch('clip.saveFromLoop', { id: 'c', track: 0 });
    expect(getProject().clips).toHaveLength(0);
    expect(canUndo()).toBe(false);
  });
  it('saving captures steps, recorded hits and notes, and is independent of later edits', () => {
    dispatch('seq.setRow', { pad: 0, steps: row(0, 8) });
    dispatch('loop.addEvent', { event: { id: 'e', pad: 1, tick: 100, vel: 1 } });
    dispatch('note.add', { note: { id: 'n', pad: 2, tick: 0, len: 48, pitch: 3, vel: 1 } });
    dispatch('clip.saveFromLoop', { id: 'c1', track: 2, name: 'Drums' });
    dispatch('seq.setRow', { pad: 0, steps: row() });
    dispatch('loop.clear');
    const c = getProject().clips[0];
    expect(c).toMatchObject({ id: 'c1', track: 2, name: 'Drums', bars: 2 });
    expect(c.steps[0]).toEqual(row(0, 8));
    expect(Object.keys(c.steps)).toEqual(['0']);
    expect(c.events).toHaveLength(1);
    expect(c.notes).toHaveLength(1);
  });
  it('loading a clip back replaces the loop and can be undone', () => {
    dispatch('seq.setRow', { pad: 0, steps: row(0) });
    dispatch('clip.saveFromLoop', { id: 'c1', track: 0 });
    dispatch('seq.setRow', { pad: 0, steps: row() });
    dispatch('seq.setRow', { pad: 3, steps: row(5) });
    dispatch('project.setBars', { bars: 4 });
    dispatch('clip.loadToLoop', { id: 'c1' });
    expect(getProject().pads[0].steps).toEqual(row(0));
    expect(getProject().pads[3].steps).toEqual(row());
    expect(getProject().bars).toBe(2);
    undo();
    expect(getProject().pads[3].steps).toEqual(row(5));
  });
  it('rename, remove and track settings', () => {
    dispatch('seq.setRow', { pad: 0, steps: row(0) });
    dispatch('clip.saveFromLoop', { id: 'c1', track: 9 });
    expect(getProject().clips[0].track).toBe(3);
    dispatch('clip.rename', { id: 'c1', name: '  Verse  ' });
    expect(getProject().clips[0].name).toBe('Verse');
    dispatch('track.set', { track: 1, vol: 9, mute: true });
    expect(getProject().tracks[1]).toEqual({ vol: 1.5, mute: true, solo: false });
    dispatch('clip.remove', { id: 'c1' });
    expect(getProject().clips).toHaveLength(0);
  });
});

describe('launched clips', () => {
  beforeEach(() => {
    dispatch('seq.setRow', { pad: 0, steps: row(0) }); // one hit at the start of every bar
    dispatch('clip.saveFromLoop', { id: 'kick', track: 0 });
    dispatch('seq.setRow', { pad: 0, steps: row() });
    dispatch('seq.setRow', { pad: 1, steps: row(4) }); // one hit on beat 2
    dispatch('clip.saveFromLoop', { id: 'snare', track: 1 });
  });
  const seg = (track: number, clipId: string, start: number, end = Infinity) => ({ track, clipId, start, end });
  it('a clip starts counting from its launch bar and stops at its end', () => {
    const hits = segmentHits(getProject(), [seg(0, 'kick', 384, 1152)], 0, 2000);
    expect(hits.map((h) => h.abs)).toEqual([384, 768]);
  });
  it('clips on different tracks play together, each at its track volume', () => {
    dispatch('track.set', { track: 1, vol: 0.5 });
    const hits = segmentHits(getProject(), [seg(0, 'kick', 0), seg(1, 'snare', 0)], 0, 384);
    expect(hits.map((h) => [h.abs, h.pad, h.vel])).toEqual([[0, 0, 1], [96, 1, 0.5]]);
  });
  it('mute silences a track and solo silences the others', () => {
    const both = [seg(0, 'kick', 0), seg(1, 'snare', 0)];
    dispatch('track.set', { track: 0, mute: true });
    expect(segmentHits(getProject(), both, 0, 384).map((h) => h.pad)).toEqual([1]);
    dispatch('track.set', { track: 0, mute: false, solo: true });
    expect(segmentHits(getProject(), both, 0, 384).map((h) => h.pad)).toEqual([0]);
  });
  it('splitting the window never drops or repeats a hit, and a deleted clip plays nothing', () => {
    const segs = [seg(0, 'kick', 384), seg(1, 'snare', 768, 1920)];
    const whole = segmentHits(getProject(), segs, 0, 3000).length;
    let parts = 0;
    for (let t = 0; t < 3000; t += 37.5) parts += segmentHits(getProject(), segs, t, Math.min(3000, t + 37.5)).length;
    expect(parts).toBe(whole);
    dispatch('clip.remove', { id: 'kick' });
    expect(segmentHits(getProject(), [seg(0, 'kick', 0)], 0, 384)).toEqual([]);
  });
  it('the Sampler loop is unchanged by saving clips, and bar lines round up', () => {
    expect(hitsInWindow(getProject(), 0, 384).map((h) => h.pad)).toEqual([1]);
    expect([0, 1, 383.9, 384, 385].map(nextBar)).toEqual([0, 384, 384, 384, 768]);
  });
});
