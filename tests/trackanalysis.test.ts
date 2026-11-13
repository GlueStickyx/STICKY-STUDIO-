import { describe, expect, it } from 'vitest';
import { analyseTrack, findHits, findLoops, findVoice } from '../src/audio/trackanalysis';

const SR = 44100;
let seed = 5;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };

/** A 120 BPM groove (kick on beats, hats on off-beats), optionally with a sung-like line over part of it. */
function song(seconds: number, voice?: [number, number]) {
  const x = new Float32Array(SR * seconds);
  const beat = 0.5;
  for (let b = 0; b * beat < seconds; b++) {
    const k = Math.floor(b * beat * SR);
    for (let i = 0; i < 0.2 * SR && k + i < x.length; i++) x[k + i] += Math.sin(2 * Math.PI * 55 * (i / SR)) * Math.exp(-14 * (i / SR)) * 0.8;
    const h = Math.floor((b * beat + 0.25) * SR);
    for (let i = 0; i < 0.04 * SR && h + i < x.length; i++) x[h + i] += rnd() * Math.exp(-90 * (i / SR)) * 0.3;
  }
  if (voice) {
    let ph = 0;
    for (let i = Math.floor(voice[0] * SR); i < voice[1] * SR; i++) {
      const t = i / SR, f = 220 * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * t)); // vibrato
      ph += (2 * Math.PI * f) / SR;
      x[i] += (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) * 0.35;
    }
  }
  return x;
}

describe('track analysis', () => {
  const x = song(24, [8, 12.5]);
  const a = analyseTrack(x, SR);
  it('finds the tempo and a beat to count bars from', () => {
    expect(a.bpm).not.toBeNull();
    expect(Math.abs(a.bpm! - 120)).toBeLessThan(3);
    expect(a.firstBeat).toBeLessThan(0.05);
  });
  it('suggests bar-length loops that do not overlap', () => {
    expect(a.loops.length).toBeGreaterThan(0);
    for (const l of a.loops) {
      expect(l.end - l.start).toBeCloseTo((240 / a.bpm!) * l.bars, 5);
      expect([1, 2, 4]).toContain(l.bars);
    }
    for (let i = 1; i < a.loops.length; i++) expect(a.loops[i].start).toBeGreaterThanOrEqual(a.loops[i - 1].end - 1e-9);
  });
  it('labels kicks low and hats high', () => {
    const hits = findHits(song(8), SR);
    expect(hits.some((h) => h.kind === 'low')).toBe(true);
    expect(hits.some((h) => h.kind === 'high')).toBe(true);
    for (const h of hits.filter((h) => h.kind === 'low')) expect(Math.abs(h.start / 0.5 - Math.round(h.start / 0.5))).toBeLessThan(0.06);
  });
  it('finds the sung line and its pitch, and nothing in drums alone', () => {
    expect(a.voice.length).toBeGreaterThan(0);
    const best = a.voice.reduce((m, v) => (v.end - v.start > m.end - m.start ? v : m));
    expect(best.start).toBeGreaterThan(7.5);
    expect(best.end).toBeLessThan(13);
    expect(best.end - best.start).toBeGreaterThan(3);
    expect(Math.abs(best.pitchHz - 220)).toBeLessThan(15);
    expect(findVoice(song(10), SR)).toEqual([]);
  });
  it('a track with no rhythm gives no loops', () => {
    expect(findLoops(new Float32Array(SR * 10), SR, 120, 0)).toEqual([]);
    expect(analyseTrack(new Float32Array(SR * 3), SR).loops).toEqual([]);
  });
});
