import { beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '../src/ai/tools';
import { canUndo, dispatch, getProject, loadProject } from '../src/core/bus';
import { emptyProject, normalizeProject, sunoStyle } from '../src/core/types';

beforeEach(() => loadProject(emptyProject()));
const d = () => getProject().suno;

describe('Suno draft', () => {
  it('joins filled pillars in order and is not an undo step', () => {
    dispatch('suno.set', { patch: { pillars: { tempo: '124 BPM', era: '90s garage', mix: '' } } });
    expect(sunoStyle(d())).toBe('90s garage, 124 BPM');
    expect(canUndo()).toBe(false);
  });
  it('a hand-written style replaces the joined one until it is cleared', () => {
    dispatch('suno.set', { patch: { pillars: { era: 'x' }, styleOverride: 'my own words' } });
    expect(sunoStyle(d())).toBe('my own words');
    dispatch('suno.set', { patch: { title: 'T' } });
    expect(d().styleOverride).toBe('my own words');
    dispatch('suno.set', { patch: { styleOverride: null } });
    expect(sunoStyle(d())).toBe('x');
  });
  it('clamps and ignores junk', () => {
    dispatch('suno.set', { patch: { lyrics: 'a'.repeat(6000), weirdness: 3, variety: 9, vocalGender: 'robot', model: 7, pillars: { era: 5, nope: 'x' } } });
    expect(d().lyrics).toHaveLength(5000);
    expect(d()).toMatchObject({ weirdness: 1, variety: 4, vocalGender: '', model: '' });
    expect(d().pillars.era).toBe('');
    expect(Object.keys(d().pillars)).toHaveLength(7);
    dispatch('suno.set', { patch: { weirdness: null, variety: null } });
    expect(d()).toMatchObject({ weirdness: null, variety: null });
  });
  it('the queue adds, updates, removes and keeps 20', () => {
    dispatch('suno.jobs', { jobs: [{ id: 'a', title: 'A', status: 'queued', created: 1 }] });
    dispatch('suno.jobs', { jobs: [{ id: 'a', status: 'complete' }] });
    expect(d().jobs).toEqual([{ id: 'a', title: 'A', status: 'complete', created: 1 }]);
    for (let i = 0; i < 25; i++) dispatch('suno.jobs', { jobs: [{ id: `j${i}`, title: '', status: 'queued', created: i }] });
    expect(d().jobs).toHaveLength(20);
    expect(d().jobs[0].id).toBe('j24');
    dispatch('suno.jobs', { jobs: [], remove: 'j24' });
    expect(d().jobs[0].id).toBe('j23');
  });
  it('older projects get an empty draft', () => {
    const old = { ...emptyProject() } as any;
    delete old.suno;
    expect(normalizeProject(old).suno.pillars.era).toBe('');
  });
});

describe('assistant write_suno_prompt', () => {
  const deps = { audio: () => null, isPlaying: () => false, setPlaying: () => {} };
  it('fills the draft and switches back to the seven parts', () => {
    dispatch('suno.set', { patch: { styleOverride: 'old' } });
    const r = runTool('write_suno_prompt', { era: 'late-90s UK garage', tempo: '132 BPM 2-step', keep_out: 'EDM drop', lyrics: '[Verse]\nhi', title: 'Night bus' }, deps, 'g');
    expect(r.isError).toBe(false);
    expect(sunoStyle(d())).toBe('late-90s UK garage, 132 BPM 2-step');
    expect(d()).toMatchObject({ negative: 'EDM drop', lyrics: '[Verse]\nhi', title: 'Night bus' });
    expect(runTool('write_suno_prompt', { era: 5 }, deps, 'g').isError).toBe(true);
    expect(runTool('write_suno_prompt', { instrumental: 'yes' }, deps, 'g').isError).toBe(true);
  });
});
