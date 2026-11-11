// 16-bit PCM WAV encoding, and a built-in synthesised demo loop so a new project is playable at once.

export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const nc = channels.length, len = channels[0].length;
  const buf = new ArrayBuffer(44 + len * nc * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len * nc * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nc * 2, true);
  v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, len * nc * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nc; c++) {
      v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32768))), true);
      o += 2;
    }
  }
  return buf;
}

/** A 2-bar, 100 BPM drum-and-bass-note loop made from sine sweeps and noise. No third-party sounds. */
export function synthDemoLoop(sampleRate = 44100): { data: Float32Array; bpm: number } {
  const bpm = 100;
  const beat = 60 / bpm;
  const out = new Float32Array(Math.round(beat * 8 * sampleRate));
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };
  const add = (t: number, dur: number, f: (x: number) => number) => {
    const s = Math.round(t * sampleRate), n = Math.round(dur * sampleRate);
    for (let i = 0; i < n && s + i < out.length; i++) out[s + i] += f(i / sampleRate);
  };
  const kick = (t: number) => add(t, 0.28, (x) => Math.sin(2 * Math.PI * (45 * x + (110 / 28) * (1 - Math.exp(-28 * x)))) * Math.exp(-9 * x) * 0.9);
  const snare = (t: number) => add(t, 0.2, (x) => (rnd() * 0.6 + Math.sin(2 * Math.PI * 190 * x) * 0.35) * Math.exp(-18 * x) * 0.7);
  const hat = (t: number, a = 0.3) => add(t, 0.05, (x) => rnd() * Math.exp(-70 * x) * a);
  const bass = (t: number, hz: number) => add(t, beat * 0.45, (x) => Math.tanh(Math.sin(2 * Math.PI * hz * x) * 2.5) * Math.exp(-5 * x) * 0.4 * Math.min(1, x * 400));
  const s16 = beat / 4;
  for (let bar = 0; bar < 2; bar++) {
    const o = bar * beat * 4;
    [0, 6, 10].forEach((k) => kick(o + k * s16));
    if (bar === 1) kick(o + 7 * s16);
    [4, 12].forEach((k) => snare(o + k * s16));
    for (let k = 2; k < 16; k += 4) hat(o + k * s16, 0.32);
    hat(o + 15 * s16, 0.2);
    [[1, 55], [3, 55], [8, 65.4], [9, 73.4], [14, 49]].forEach(([k, hz]) => bass(o + k * s16, hz));
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]);
  return { data: out, bpm };
}
