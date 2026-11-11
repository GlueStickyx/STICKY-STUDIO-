import { describe, it, expect } from 'vitest';
import { encodeWav, synthDemoLoop } from '../src/audio/wav';

const tag = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
const samplesOf = (buf: ArrayBuffer) => {
  const v = new DataView(buf);
  const out: number[] = [];
  for (let o = 44; o < buf.byteLength; o += 2) out.push(v.getInt16(o, true));
  return out;
};

describe('encodeWav header', () => {
  it('writes a mono 16-bit PCM header', () => {
    const buf = encodeWav([new Float32Array(100)], 44100);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 200);
    expect(tag(v, 0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 200); // file size - 8
    expect(tag(v, 8)).toBe('WAVE');
    expect(tag(v, 12)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // channels
    expect(v.getUint32(24, true)).toBe(44100); // sample rate
    expect(v.getUint32(28, true)).toBe(44100 * 2); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16); // bits per sample
    expect(tag(v, 36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(200); // data size
  });

  it('writes a stereo header at another sample rate', () => {
    const buf = encodeWav([new Float32Array(1000), new Float32Array(1000)], 48000);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44 + 4000);
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(48000 * 4);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(4000);
  });

  it('handles an empty buffer', () => {
    const buf = encodeWav([new Float32Array(0)], 44100);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(44);
    expect(v.getUint32(4, true)).toBe(36);
    expect(v.getUint32(40, true)).toBe(0);
  });
});

describe('encodeWav samples', () => {
  it('encodes known values', () => {
    const got = samplesOf(encodeWav([new Float32Array([0, 1, -1, 0.5, -0.5])], 44100));
    expect(got).toEqual([0, 32767, -32768, 16384, -16384]);
  });

  it('round-trips within 16-bit precision', () => {
    const n = 5000;
    const src = new Float32Array(n);
    let seed = 99;
    for (let i = 0; i < n; i++) { seed = (seed * 16807) % 2147483647; src[i] = (seed / 2147483647) * 2 - 1; }
    const got = samplesOf(encodeWav([src], 44100));
    expect(got).toHaveLength(n);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const decoded = got[i] / 32768;
      worst = Math.max(worst, Math.abs(decoded - src[i]));
      expect(Math.sign(got[i]) === Math.sign(src[i]) || got[i] === 0).toBe(true);
    }
    expect(worst).toBeLessThanOrEqual(1 / 32768 + 1e-9);
  });

  it('round-trips a sine wave within one LSB', () => {
    const src = new Float32Array(4410);
    for (let i = 0; i < src.length; i++) src[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    const got = samplesOf(encodeWav([src], 44100));
    for (let i = 0; i < src.length; i++) expect(Math.abs(got[i] / 32768 - src[i])).toBeLessThanOrEqual(1 / 32768 + 1e-9);
  });

  it('clips out-of-range values instead of wrapping', () => {
    const got = samplesOf(encodeWav([new Float32Array([1.0001, 2, 100, Infinity, -1.0001, -2, -100, -Infinity])], 44100));
    expect(got).toEqual([32767, 32767, 32767, 32767, -32768, -32768, -32768, -32768]);
  });

  it('interleaves stereo channels as L R L R', () => {
    const L = new Float32Array([1, 1, 1]);
    const R = new Float32Array([-1, 0, -1]);
    const got = samplesOf(encodeWav([L, R], 44100));
    expect(got).toEqual([32767, -32768, 32767, 0, 32767, -32768]);
  });

  it('silence encodes to all zero bytes', () => {
    const got = samplesOf(encodeWav([new Float32Array(64)], 44100));
    expect(got.every((s) => s === 0)).toBe(true);
  });
});

describe('synthDemoLoop', () => {
  it('is 2 bars at 100 bpm, deterministic, and within [-1, 1]', () => {
    const a = synthDemoLoop();
    const b = synthDemoLoop();
    expect(a.bpm).toBe(100);
    expect(a.data.length).toBe(Math.round(4.8 * 44100));
    let peak = 0, same = true;
    for (let i = 0; i < a.data.length; i++) {
      peak = Math.max(peak, Math.abs(a.data[i]));
      if (a.data[i] !== b.data[i]) same = false;
    }
    expect(same).toBe(true);
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.3);
    expect(Number.isFinite(peak)).toBe(true);
  });

  it('honours the sample rate argument', () => {
    expect(synthDemoLoop(22050).data.length).toBe(Math.round(4.8 * 22050));
  });
});
