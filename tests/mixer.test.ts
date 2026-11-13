import { beforeEach, describe, expect, it } from 'vitest';
import { canUndo, dispatch, getProject, loadProject, undo } from '../src/core/bus';
import { channelGain, emptyProject, normalizeProject } from '../src/core/types';

beforeEach(() => loadProject(emptyProject()));
const mix = () => getProject().mixer;

describe('mixer commands', () => {
  it('starts flat, with four channels at unity', () => {
    expect(mix().channels).toHaveLength(4);
    expect(mix().channels.every((c) => c.vol === 1 && c.pan === 0 && c.low === 0 && !c.mute)).toBe(true);
    expect(mix().master).toBe(1);
  });
  it('sets and clamps values, ignoring junk, and is undoable', () => {
    dispatch('mix.set', { channel: 2, vol: 9, pan: -4, low: 30, mid: -30, high: 'x', mute: 'yes' });
    expect(mix().channels[2]).toEqual({ vol: 1.5, pan: -1, low: 12, mid: -12, high: 0, mute: false, solo: false });
    expect(mix().channels[0].vol).toBe(1);
    expect(canUndo()).toBe(true);
    undo();
    expect(mix().channels[2].vol).toBe(1);
  });
  it('mute and solo decide which channels sound', () => {
    dispatch('mix.set', { channel: 1, vol: 0.5 });
    dispatch('mix.set', { channel: 0, mute: true });
    expect([0, 1, 2, 3].map((i) => channelGain(mix(), i))).toEqual([0, 0.5, 1, 1]);
    dispatch('mix.set', { channel: 3, solo: true });
    expect([0, 1, 2, 3].map((i) => channelGain(mix(), i))).toEqual([0, 0, 0, 1]);
  });
  it('master and reset', () => {
    dispatch('mix.master', { vol: 3 });
    expect(mix().master).toBe(1.5);
    dispatch('mix.set', { channel: 0, pan: 0.5 });
    dispatch('mix.reset');
    expect(mix().master).toBe(1);
    expect(mix().channels[0].pan).toBe(0);
  });
  it('an older project without a mixer gets a flat one', () => {
    const old = { ...emptyProject() } as any;
    delete old.mixer;
    expect(normalizeProject(old).mixer.channels).toHaveLength(4);
  });
});
