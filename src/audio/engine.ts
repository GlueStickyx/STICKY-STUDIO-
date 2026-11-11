// The audio engine. It reads the project from the command bus and never mutates it directly:
// recording a hit dispatches 'loop.addEvent' like any other change.
import { dispatch, getProject, subscribe } from '../core/bus';
import { beatsInWindow, hitsInWindow, loopTicks, quantizeTick, secondsPerTick } from '../core/sequence';
import { DELAY_TIMES, TOTAL_PADS, uid } from '../core/types';
import type { Pad, Project } from '../core/types';
import { computePeaks, mixToMono } from './analysis';

const LOOKAHEAD_SEC = 0.12; // how far ahead hits are handed to the audio clock
const TIMER_MS = 25;

type Ctx = BaseAudioContext;
interface Voice { stop: (t: number) => void }

const curves = new Map<number, Float32Array<ArrayBuffer>>();
/** Saturation curve for a drive amount 0..1 (cached). Output is normalised so full scale stays full scale. */
function driveCurve(drive: number): Float32Array<ArrayBuffer> {
  const key = Math.round(drive * 50);
  let c = curves.get(key);
  if (!c) {
    const k = 1 + (key / 50) * 24;
    c = new Float32Array(1025);
    for (let i = 0; i < c.length; i++) c[i] = Math.tanh(k * (i / 512 - 1)) / Math.tanh(k);
    curves.set(key, c);
  }
  return c;
}

/**
 * Where voices go. One per audio context (live, or one offline render). It owns the per-pad echo lines,
 * which must outlive individual voices so their tails keep ringing.
 */
export class Mixer {
  private delays = new Map<number, { input: GainNode; delay: DelayNode; fb: GainNode }>();
  constructor(readonly ctx: Ctx, readonly out: AudioNode) {}

  /** Bring echo settings in line with the project. Cheap; call whenever the project changes. */
  sync(p: Project) {
    p.pads.forEach((pad, i) => {
      if (pad.fx.delayMix <= 0 && !this.delays.has(i)) return;
      let d = this.delays.get(i);
      if (!d) {
        d = { input: this.ctx.createGain(), delay: this.ctx.createDelay(2), fb: this.ctx.createGain() };
        d.input.connect(d.delay); d.delay.connect(d.fb); d.fb.connect(d.delay); d.delay.connect(this.out);
        this.delays.set(i, d);
      }
      d.delay.delayTime.value = Math.min(2, (DELAY_TIMES[pad.fx.delayTime] * 60) / p.bpm);
      d.fb.gain.value = pad.fx.delayFeedback;
    });
  }
  /** The echo input for a pad, or null when the pad has no echo line yet. */
  send(i: number): AudioNode | null { return this.delays.get(i)?.input ?? null; }
}

/** Start one pad voice, with its effects, on any context (live or offline). */
export function playPadVoice(mixer: Mixer, padIndex: number, buffer: AudioBuffer, reversed: AudioBuffer | null, pad: Pad, time: number, vel: number): Voice | null {
  const ctx = mixer.ctx;
  const len = pad.end - pad.start;
  if (len <= 0.001) return null;
  const fx = pad.fx;
  const rate = Math.pow(2, pad.semitones / 12);
  const offset = Math.max(0, pad.reverse ? buffer.duration - pad.end : pad.start);
  const src = pad.reverse && reversed ? reversed : buffer;

  // Chain: sources -> [filter] -> [drive] -> level -> mixer out, with a tap to the pad's echo line.
  const level = ctx.createGain();
  level.gain.value = pad.gain * vel * (1 - fx.drive * 0.45); // saturation makes things louder; pull it back
  let head: AudioNode = level;
  if (fx.drive > 0) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(fx.drive);
    shaper.oversample = '2x';
    shaper.connect(head); head = shaper;
  }
  if (fx.filter !== 'off') {
    const f = ctx.createBiquadFilter();
    f.type = fx.filter;
    f.frequency.value = fx.cutoff;
    f.Q.value = 0.5 + fx.resonance * 14;
    f.connect(head); head = f;
  }
  level.connect(mixer.out);
  const send = fx.delayMix > 0 ? mixer.send(padIndex) : null;
  if (send) { const s = ctx.createGain(); s.gain.value = fx.delayMix; level.connect(s).connect(send); }

  // Stutter: the first 1/N of the slice, N times back to back. N = 1 is the plain slice.
  const n = Math.max(1, fx.stutter);
  const chunk = len / n, played = chunk / rate;
  const fade = Math.min(0.006, played / 4);
  const sources: AudioBufferSourceNode[] = [];
  for (let k = 0; k < n; k++) {
    const t = time + k * played;
    const node = ctx.createBufferSource();
    node.buffer = src;
    node.playbackRate.value = rate;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + Math.min(0.002, played / 4));
    env.gain.setValueAtTime(1, t + played - fade);
    env.gain.linearRampToValueAtTime(0, t + played);
    node.connect(env).connect(head);
    node.start(t, offset, chunk);
    sources.push(node);
  }
  let stopped = false;
  return {
    stop: (t: number) => {
      if (stopped) return;
      stopped = true;
      try {
        level.gain.cancelScheduledValues(t);
        level.gain.setTargetAtTime(0, t, 0.004);
        sources.forEach((s) => s.stop(t + 0.03));
      } catch { /* already ended */ }
    },
  };
}

export function reverseBuffer(ctx: Ctx, b: AudioBuffer): AudioBuffer {
  const r = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const src = b.getChannelData(c), dst = r.getChannelData(c);
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
  }
  return r;
}

function click(ctx: Ctx, dest: AudioNode, time: number, down: boolean) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = down ? 1760 : 1175;
  g.gain.setValueAtTime(0.25, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
  o.connect(g).connect(dest);
  o.start(time); o.stop(time + 0.05);
}

/** Schedule every hit in [fromTick, toTick) onto a mixer. tickTime converts an absolute tick to context time. */
function scheduleHits(mixer: Mixer, p: Project, from: number, to: number, tickTime: (t: number) => number,
  buffers: Map<string, AudioBuffer>, reversed: (id: string) => AudioBuffer | null,
  onHit?: (pad: number, time: number, v: Voice | null, id?: string, abs?: number) => boolean | void) {
  for (const h of hitsInWindow(p, from, to)) {
    const pad = p.pads[h.pad];
    const buf = pad.sampleId ? buffers.get(pad.sampleId) : undefined;
    if (!buf) continue;
    const time = tickTime(h.abs);
    if (onHit && onHit(h.pad, time, null, h.id, h.abs) === false) continue;
    const v = playPadVoice(mixer, h.pad, buf, pad.reverse ? reversed(pad.sampleId!) : null, pad, time, h.vel);
    onHit?.(h.pad, time, v);
  }
}

export class Engine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private mixer!: Mixer;
  buffers = new Map<string, AudioBuffer>();
  peaks = new Map<string, Float32Array>();
  private rev = new Map<string, AudioBuffer>();
  private voices: (Voice | null)[] = new Array(TOTAL_PADS).fill(null);
  private auditionVoice: Voice | null = null;
  playing = false;
  recording = false;
  private anchorTime = 0;
  private anchorTick = 0;
  private anchorBpm = 120;
  private scheduledUntil = 0;
  private timer: number | null = null;
  private suppress = new Map<string, number>(); // event id -> absolute tick already heard live
  private takeId = '';
  /** UI hook: a pad will sound `delaySec` from now. */
  onPadFire: (pad: number, delaySec: number) => void = () => {};
  onTransport: () => void = () => {};

  /** Must be called from a user gesture. */
  async start() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -3; limiter.ratio.value = 12; limiter.attack.value = 0.002; limiter.release.value = 0.1;
      this.master.connect(limiter).connect(this.ctx.destination);
      this.mixer = new Mixer(this.ctx, this.master);
      this.mixer.sync(getProject());
      subscribe(() => this.mixer.sync(getProject()));
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Output delay the browser reports, in milliseconds (null if unknown). */
  latencyMs(): number | null {
    if (!this.ctx) return null;
    const out = (this.ctx as any).outputLatency || 0;
    return Math.round((this.ctx.baseLatency + out) * 1000);
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx!.decodeAudioData(data.slice(0));
  }

  addBuffer(id: string, buf: AudioBuffer) {
    this.buffers.set(id, buf);
    this.rev.delete(id);
    const ch: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
    this.peaks.set(id, computePeaks(mixToMono(ch)));
  }

  private reversed = (id: string): AudioBuffer | null => {
    const b = this.buffers.get(id);
    if (!b || !this.ctx) return null;
    let r = this.rev.get(id);
    if (!r) { r = reverseBuffer(this.ctx, b); this.rev.set(id, r); }
    return r;
  };

  private spt() { return secondsPerTick(this.anchorBpm); }
  private tickAt(time: number) { return this.anchorTick + (time - this.anchorTime) / this.spt(); }
  private timeAt = (tick: number) => this.anchorTime + (tick - this.anchorTick) * this.spt();

  /** Current position inside the loop in ticks, or 0 when stopped. */
  position(): number {
    if (!this.playing || !this.ctx) return 0;
    const t = this.tickAt(this.ctx.currentTime);
    return t < 0 ? 0 : t % loopTicks(getProject());
  }

  play() {
    if (!this.ctx || this.playing) return;
    this.playing = true;
    this.anchorBpm = getProject().bpm;
    this.anchorTime = this.ctx.currentTime + 0.06;
    this.anchorTick = 0;
    this.scheduledUntil = 0;
    this.suppress.clear();
    this.pump();
    this.timer = window.setInterval(() => this.pump(), TIMER_MS);
    this.onTransport();
  }

  stop() {
    if (!this.ctx) return;
    this.playing = false;
    this.recording = false;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    const now = this.ctx.currentTime;
    this.voices.forEach((v) => v?.stop(now));
    this.voices.fill(null);
    this.onTransport();
  }

  toggleRecord() {
    if (!this.ctx) return;
    this.recording = !this.recording;
    if (this.recording) { this.takeId = uid(); if (!this.playing) this.play(); }
    this.onTransport();
  }

  private pump() {
    if (!this.ctx || !this.playing) return;
    const p = getProject();
    const now = this.ctx.currentTime;
    if (p.bpm !== this.anchorBpm) { // tempo changed: keep the musical position, change the speed
      const t = Math.max(now, this.anchorTime);
      this.anchorTick = this.tickAt(t); this.anchorTime = t; this.anchorBpm = p.bpm;
    }
    const horizon = this.tickAt(now + LOOKAHEAD_SEC);
    if (horizon <= this.scheduledUntil) return;
    const from = this.scheduledUntil, to = horizon;
    scheduleHits(this.mixer, p, from, to, this.timeAt, this.buffers, this.reversed, (pad, time, v, id, abs) => {
      if (v === null && id !== undefined) { // pre-check: skip a hit the player just performed live
        if (this.suppress.get(id) === abs) { this.suppress.delete(id); return false; }
        return true;
      }
      if (v) { this.voices[pad]?.stop(time); this.voices[pad] = v; this.onPadFire(pad, Math.max(0, time - now)); }
      return true;
    });
    if (p.metronome) for (const [tick, down] of beatsInWindow(from, to)) click(this.ctx, this.master, this.timeAt(tick), down);
    this.scheduledUntil = to;
  }

  /** A finger (or key) hit a pad: sound it now and, if recording, write it into the loop. */
  hitPad(i: number, vel = 1) {
    if (!this.ctx) return;
    const p = getProject();
    const pad = p.pads[i];
    const buf = pad.sampleId ? this.buffers.get(pad.sampleId) : undefined;
    if (!buf) return;
    const now = this.ctx.currentTime;
    this.voices[i]?.stop(now);
    this.voices[i] = playPadVoice(this.mixer, i, buf, pad.reverse ? this.reversed(pad.sampleId!) : null, pad, now, vel);
    this.onPadFire(i, 0);
    if (this.playing && this.recording) {
      const cur = this.tickAt(now);
      if (cur < 0) return;
      const q = quantizeTick(cur, p.quantize);
      const L = loopTicks(p);
      const id = uid();
      if (q >= this.scheduledUntil) this.suppress.set(id, q); // it will come round in the scheduler: don't double it
      dispatch('loop.addEvent', { event: { id, pad: i, tick: ((q % L) + L) % L, vel } }, { group: 'take-' + this.takeId });
    }
  }

  /** Play a region of a sample directly, without effects (chop view preview). */
  audition(sampleId: string, start: number, end: number) {
    if (!this.ctx) return;
    const buf = this.buffers.get(sampleId);
    if (!buf) return;
    const now = this.ctx.currentTime;
    this.auditionVoice?.stop(now);
    const plain: Pad = { ...getProject().pads[0], sampleId, start, end, gain: 1, semitones: 0, reverse: false, steps: [] };
    plain.fx = { ...plain.fx, filter: 'off', drive: 0, delayMix: 0, stutter: 1 };
    this.auditionVoice = playPadVoice(this.mixer, -1, buf, null, plain, now, 1);
  }

  private offline(seconds: number, sampleRate: number) {
    const off = new OfflineAudioContext(2, Math.max(1, Math.round(seconds * sampleRate)), sampleRate);
    const master = off.createGain();
    master.gain.value = 0.9;
    master.connect(off.destination);
    const mixer = new Mixer(off, master);
    mixer.sync(getProject());
    const cache = new Map<string, AudioBuffer>();
    const rev = (id: string) => {
      const b = this.buffers.get(id);
      if (!b) return null;
      if (!cache.has(id)) cache.set(id, reverseBuffer(off, b));
      return cache.get(id)!;
    };
    return { off, mixer, rev };
  }

  /**
   * Render exactly one pass of the loop to stereo sample data, faster than real time.
   * Two passes are rendered and the second is kept, so echoes and long slices that cross the loop
   * end wrap round to the start and the exported file loops seamlessly.
   */
  async renderLoop(sampleRate = 44100): Promise<Float32Array[]> {
    const p = getProject();
    const spt = secondsPerTick(p.bpm);
    const L = loopTicks(p);
    const frames = Math.round(L * spt * sampleRate);
    const { off, mixer, rev } = this.offline((frames * 2) / sampleRate, sampleRate);
    const voices: (Voice | null)[] = new Array(TOTAL_PADS).fill(null);
    scheduleHits(mixer, p, 0, L * 2, (t) => t * spt, this.buffers, rev, (pad, time, v) => {
      if (v) { voices[pad]?.stop(time); voices[pad] = v; }
      return true;
    });
    const out = await off.startRendering();
    return [out.getChannelData(0).slice(frames, frames * 2), out.getChannelData(1).slice(frames, frames * 2)];
  }

  /** Render one pad hit with its pitch, reverse and effects (and the echo tail) to stereo sample data. */
  async renderPad(i: number, sampleRate = 44100): Promise<Float32Array[] | null> {
    const p = getProject();
    const pad = p.pads[i];
    const buf = pad.sampleId ? this.buffers.get(pad.sampleId) : undefined;
    if (!buf) return null;
    const played = (pad.end - pad.start) / Math.pow(2, pad.semitones / 12);
    const fx = pad.fx;
    const echo = (DELAY_TIMES[fx.delayTime] * 60) / p.bpm;
    // Echo tail: until the repeats have decayed by 60 dB, at most 8 seconds.
    const tail = fx.delayMix > 0 ? Math.min(8, echo * (1 + (fx.delayFeedback > 0 ? Math.log(0.001) / Math.log(fx.delayFeedback) : 0))) : 0.02;
    const { off, mixer, rev } = this.offline(played + tail, sampleRate);
    playPadVoice(mixer, i, buf, pad.reverse ? rev(pad.sampleId!) : null, { ...pad, gain: 1 }, 0, 1);
    const out = await off.startRendering();
    return [out.getChannelData(0), out.getChannelData(1)];
  }
}

export const engine = new Engine();
