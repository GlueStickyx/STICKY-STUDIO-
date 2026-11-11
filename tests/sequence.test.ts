import { describe, it, expect } from 'vitest';
import { BAR_TICKS, PPQ, STEP_TICKS, emptyProject } from '../src/core/types';
import type { Project } from '../src/core/types';
import { beatsInWindow, hitsInWindow, loopTicks, quantizeTick, secondsPerTick, stepTick } from '../src/core/sequence';
import type { Hit } from '../src/core/sequence';

/** Project with pad 0 loaded and the given steps switched on. */
function withSteps(steps: number[], pad = 0, vel = 1): Project {
  const p = emptyProject();
  p.pads[pad].sampleId = 's1';
  for (const s of steps) p.pads[pad].steps[s] = vel;
  return p;
}

const key = (h: Hit) => `${h.abs.toFixed(6)}|${h.pad}|${h.vel}|${h.id ?? ''}`;

describe('constants and helpers', () => {
  it('uses 24 ticks per step and 384 per bar', () => {
    expect(STEP_TICKS).toBe(24);
    expect(BAR_TICKS).toBe(384);
    expect(PPQ).toBe(96);
  });

  it('loopTicks is bars * 384', () => {
    const p = emptyProject();
    expect(loopTicks({ ...p, bars: 1 })).toBe(384);
    expect(loopTicks({ ...p, bars: 2 })).toBe(768);
    expect(loopTicks({ ...p, bars: 4 })).toBe(1536);
  });

  it('secondsPerTick: one quarter note at 120 bpm lasts 0.5 s', () => {
    expect(secondsPerTick(120) * PPQ).toBeCloseTo(0.5, 12);
  });

  it('stepTick delays odd steps only', () => {
    expect(stepTick(0, 0.5)).toBe(0);
    expect(stepTick(1, 0.5)).toBe(36);
    expect(stepTick(2, 0.5)).toBe(48);
    expect(stepTick(3, 0)).toBe(72);
  });
});

describe('hitsInWindow: sequencer steps', () => {
  it('returns nothing for an empty project', () => {
    expect(hitsInWindow(emptyProject(), 0, 10000)).toEqual([]);
  });

  it('returns nothing for an empty or inverted window', () => {
    const p = withSteps([0, 1, 2, 3]);
    expect(hitsInWindow(p, 0, 0)).toEqual([]);
    expect(hitsInWindow(p, 48, 48)).toEqual([]);
    expect(hitsInWindow(p, 100, 50)).toEqual([]);
  });

  it('puts every step on a multiple of 24 ticks', () => {
    const p = withSteps(Array.from({ length: 16 }, (_, i) => i));
    const hits = hitsInWindow(p, 0, BAR_TICKS);
    expect(hits.map((h) => h.abs)).toEqual(Array.from({ length: 16 }, (_, i) => i * 24));
    expect(hits.every((h) => h.pad === 0 && h.vel === 1 && h.id === undefined)).toBe(true);
  });

  it('only switched-on steps fire, with their velocity', () => {
    const p = withSteps([0, 4, 10], 3, 0.6);
    expect(hitsInWindow(p, 0, BAR_TICKS)).toEqual([
      { abs: 0, pad: 3, vel: 0.6 },
      { abs: 96, pad: 3, vel: 0.6 },
      { abs: 240, pad: 3, vel: 0.6 },
    ]);
  });

  it('the 16-step row repeats every bar, also across the loop boundary', () => {
    const p = withSteps([0, 5]);
    const hits = hitsInWindow(p, 0, BAR_TICKS * 5);
    const expected: number[] = [];
    for (let bar = 0; bar < 5; bar++) expected.push(bar * 384, bar * 384 + 120);
    expect(hits.map((h) => h.abs)).toEqual(expected);
  });

  it('swing delays odd steps and leaves even steps alone', () => {
    const p = { ...withSteps([0, 1, 2, 3, 15]), swing: 0.5 };
    const hits = hitsInWindow(p, 0, BAR_TICKS);
    expect(hits.map((h) => h.abs)).toEqual([0, 24 + 12, 48, 72 + 12, 360 + 12]);
  });

  it('a swung step belongs to the window that contains its delayed position', () => {
    const p = { ...withSteps([1]), swing: 0.5 }; // lands on tick 36
    expect(hitsInWindow(p, 0, 36)).toEqual([]);
    expect(hitsInWindow(p, 24, 36)).toEqual([]);
    expect(hitsInWindow(p, 36, 37).map((h) => h.abs)).toEqual([36]);
    expect(hitsInWindow(p, 30, 48).map((h) => h.abs)).toEqual([36]);
  });

  it('a swung last step of the bar is found by a window starting after its grid line', () => {
    const p = { ...withSteps([15]), swing: 0.6 }; // 360 + 14.4
    expect(hitsInWindow(p, 370, 380).map((h) => h.abs)).toEqual([374.4]);
    expect(hitsInWindow(p, 754, 768).map((h) => h.abs)).toEqual([758.4]);
  });

  it('pads without a sampleId are silent even with steps on', () => {
    const p = emptyProject();
    p.pads[0].steps[0] = 1;
    p.pads[1].steps[0] = 1;
    p.pads[1].sampleId = 's1';
    const hits = hitsInWindow(p, 0, BAR_TICKS);
    expect(hits).toEqual([{ abs: 0, pad: 1, vel: 1 }]);
  });

  it('several pads on the same step all fire, sorted by time', () => {
    const p = withSteps([4], 2);
    p.pads[7].sampleId = 's1';
    p.pads[7].steps[0] = 0.5;
    p.pads[7].steps[4] = 0.5;
    const hits = hitsInWindow(p, 0, BAR_TICKS);
    expect(hits.map((h) => [h.abs, h.pad])).toEqual([[0, 7], [96, 2], [96, 7]]);
  });
});

describe('hitsInWindow: recorded loop events', () => {
  const withEvents = (bars: 1 | 2 | 4): Project => ({
    ...emptyProject(), bars,
    events: [
      { id: 'a', pad: 2, tick: 10, vel: 0.8 },
      { id: 'b', pad: 5, tick: 400.5, vel: 0.4 },
    ],
  });

  it('plays an event at its tick in the first pass', () => {
    const hits = hitsInWindow(withEvents(2), 0, 768);
    expect(hits).toEqual([
      { abs: 10, pad: 2, vel: 0.8, id: 'a' },
      { abs: 400.5, pad: 5, vel: 0.4, id: 'b' },
    ]);
  });

  it.each([1, 2, 4] as const)('repeats events every %i-bar loop pass (bars * 384 ticks)', (bars) => {
    const p: Project = { ...emptyProject(), bars, events: [{ id: 'a', pad: 2, tick: 10, vel: 0.8 }] };
    const L = bars * 384;
    const hits = hitsInWindow(p, 0, L * 4);
    expect(hits.map((h) => h.abs)).toEqual([10, L + 10, 2 * L + 10, 3 * L + 10]);
    expect(hits.every((h) => h.id === 'a' && h.pad === 2 && h.vel === 0.8)).toBe(true);
  });

  it('finds events in a window deep into a later pass', () => {
    const hits = hitsInWindow(withEvents(2), 768 * 7, 768 * 8);
    expect(hits.map((h) => h.abs)).toEqual([768 * 7 + 10, 768 * 7 + 400.5]);
  });

  it('an event at tick 0 fires at the start of every pass and not at the end of the previous one', () => {
    const p: Project = { ...emptyProject(), bars: 1, events: [{ id: 'z', pad: 0, tick: 0, vel: 1 }] };
    expect(hitsInWindow(p, 0, 384).map((h) => h.abs)).toEqual([0]);
    expect(hitsInWindow(p, 1, 384)).toEqual([]);
    expect(hitsInWindow(p, 384, 385).map((h) => h.abs)).toEqual([384]);
  });

  it('events and steps are merged in time order', () => {
    const p = withSteps([0, 1]);
    p.events = [{ id: 'e', pad: 9, tick: 12, vel: 1 }];
    expect(hitsInWindow(p, 0, 48).map((h) => [h.abs, h.pad])).toEqual([[0, 0], [12, 9], [24, 0]]);
  });
});

describe('hitsInWindow: half-open windows [from, to)', () => {
  it('includes a hit exactly at `from` and excludes one exactly at `to`', () => {
    const p = withSteps([0, 1, 2]);
    expect(hitsInWindow(p, 24, 48).map((h) => h.abs)).toEqual([24]);
    expect(hitsInWindow(p, 0, 24).map((h) => h.abs)).toEqual([0]);
    expect(hitsInWindow(p, 24.0001, 48).map((h) => h.abs)).toEqual([]);
    expect(hitsInWindow(p, 47.9, 48.0001).map((h) => h.abs)).toEqual([48]);
  });

  function busyProject(swing: number, bars: 1 | 2 | 4): Project {
    const p = emptyProject();
    p.swing = swing;
    p.bars = bars;
    for (let i = 0; i < 16; i++) {
      if (i % 3 === 0) continue; // leave some pads empty
      p.pads[i].sampleId = 's1';
      for (let s = 0; s < 16; s++) if ((s * 7 + i * 3) % 4 < 2) p.pads[i].steps[s] = 0.25 + ((s + i) % 4) * 0.25;
    }
    const L = bars * 384;
    p.events = [0, 0.5, 23.999, 24, 100.25, 383.9, L - 0.001, L / 2, L / 3].map((tick, n) => (
      { id: `e${n}`, pad: n % 16, tick, vel: 0.5 }
    ));
    return p;
  }

  function split(p: Project, bounds: number[]): Hit[] {
    const out: Hit[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) out.push(...hitsInWindow(p, bounds[i], bounds[i + 1]));
    return out;
  }

  const cases: [string, number, 1 | 2 | 4][] = [
    ['no swing, 2 bars', 0, 2], ['swing 0.33, 1 bar', 0.33, 1], ['swing 0.6, 4 bars', 0.6, 4], ['swing 0.5, 2 bars', 0.5, 2],
  ];

  it.each(cases)('small windows add up to one big window (%s)', (_name, swing, bars) => {
    const p = busyProject(swing, bars);
    const end = 384 * 9;
    const big = hitsInWindow(p, 0, end);
    expect(big.length).toBeGreaterThan(500);

    const layouts: number[][] = [];
    // Fixed fractional step, similar to an audio scheduler lookahead.
    for (const step of [1, 7.3, 11.0625, 24, 25.6, 96, 100 / 3]) {
      const b: number[] = [];
      for (let t = 0; t < end; t += step) b.push(t);
      b.push(end);
      layouts.push(b);
    }
    // Irregular pseudo-random boundaries, some landing exactly on grid lines.
    let seed = 12345;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const irregular = [0];
    while (irregular[irregular.length - 1] < end) {
      const last = irregular[irregular.length - 1];
      const next = rnd() < 0.2 ? (Math.floor(last / 24) + 1) * 24 : last + rnd() * 40 + 0.001;
      irregular.push(Math.min(end, next));
    }
    layouts.push(irregular);

    for (const bounds of layouts) {
      const parts = split(p, bounds);
      expect(parts.length).toBe(big.length);
      expect(parts.map(key).sort()).toEqual(big.map(key).sort());
    }
  });

  it('windows starting mid-song agree with the same range cut from a big window', () => {
    const p = busyProject(0.4, 2);
    const big = hitsInWindow(p, 0, 5000);
    for (const [from, to] of [[1000.5, 1900.25], [767.999, 768.001], [3072, 3073], [4444.4, 5000]]) {
      const expected = big.filter((h) => h.abs >= from && h.abs < to);
      expect(hitsInWindow(p, from, to).map(key).sort()).toEqual(expected.map(key).sort());
    }
  });
});

describe('beatsInWindow', () => {
  it('returns one beat per quarter note, marking downbeats every 4', () => {
    expect(beatsInWindow(0, 384 + 1)).toEqual([[0, true], [96, false], [192, false], [288, false], [384, true]]);
  });

  it('is half-open', () => {
    expect(beatsInWindow(0, 96)).toEqual([[0, true]]);
    expect(beatsInWindow(96, 192)).toEqual([[96, false]]);
    expect(beatsInWindow(0.001, 96)).toEqual([]);
    expect(beatsInWindow(10, 10)).toEqual([]);
    expect(beatsInWindow(100, 50)).toEqual([]);
  });

  it('adjacent fractional windows never duplicate or drop a beat', () => {
    const got: number[] = [];
    for (let t = 0; t < 2000; t += 13.7) got.push(...beatsInWindow(t, Math.min(2000, t + 13.7)).map((b) => b[0]));
    expect(got).toEqual(beatsInWindow(0, 2000).map((b) => b[0]));
    expect(got).toEqual(Array.from({ length: 21 }, (_, i) => i * 96));
  });

  it('works far from zero', () => {
    expect(beatsInWindow(7680 - 1, 7680 + 97)).toEqual([[7680, true], [7776, false]]);
  });
});

describe('quantizeTick', () => {
  it('snaps to the nearest grid line', () => {
    expect(quantizeTick(0, 24)).toBe(0);
    expect(quantizeTick(11, 24)).toBe(0);
    expect(quantizeTick(13, 24)).toBe(24);
    expect(quantizeTick(35.9, 24)).toBe(24);
    expect(quantizeTick(36.1, 24)).toBe(48);
    expect(quantizeTick(100, 96)).toBe(96);
    expect(quantizeTick(145, 96)).toBe(192);
  });

  it('rounds half-way points up', () => {
    expect(quantizeTick(12, 24)).toBe(24);
    expect(quantizeTick(36, 24)).toBe(48);
  });

  it('grid 0 only rounds to a whole tick', () => {
    expect(quantizeTick(37.4, 0)).toBe(37);
    expect(quantizeTick(37.6, 0)).toBe(38);
    expect(quantizeTick(50, 0)).toBe(50);
  });

  it('leaves ticks already on the grid alone', () => {
    for (let k = 0; k < 64; k++) expect(quantizeTick(k * 24, 24)).toBe(k * 24);
  });
});
