// The audio engine. It reads the project from the command bus and never mutates it directly:
// recording a hit dispatches 'loop.addEvent' like any other change.
import { dispatch, getProject, subscribe } from '../core/bus';
import { beatsInWindow, hitsInWindow, loopTicks, nextBar, quantizeTick, secondsPerTick, segmentHits, arrangementSegments, songBars } from '../core/sequence';
import type { Hit, Segment } from '../core/sequence';
import { BAR_TICKS, DELAY_TIMES, REVERBS, TOTAL_PADS, defaultFx, isGranular, uid } from '../core/types';
import type { Pad, Project, ReverbSize } from '../core/types';
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

/** Small deterministic random generator, so a rendered export matches what was heard. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const impulses = new Map<string, Float32Array<ArrayBuffer>[]>();
/** A synthetic room: decaying noise that darkens as it fades. Built once per size and sample rate. */
function impulse(size: ReverbSize, sampleRate: number): Float32Array<ArrayBuffer>[] {
  const key = `${size}@${sampleRate}`;
  let ir = impulses.get(key);
  if (!ir) {
    const seconds = REVERBS[size], n = Math.round(seconds * sampleRate);
    ir = [0, 1].map((ch) => {
      const rnd = prng(1234 + ch * 77 + n), out = new Float32Array(n);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        lp += (0.9 - 0.75 * t) * ((rnd() * 2 - 1) - lp); // less treble in the tail
        out[i] = lp * Math.exp(-6.9 * t) * Math.min(1, i / (0.004 * sampleRate));
      }
      return out;
    });
    impulses.set(key, ir);
  }
  return ir;
}

/**
 * Where voices go. One per audio context (live, or one offline render). It owns the per-pad echo lines
 * and the shared reverbs, which must outlive individual voices so their tails keep ringing.
 */
export class Mixer {
  private delays = new Map<number, { input: GainNode; delay: DelayNode; fb: GainNode }>();
  private reverbs = new Map<ReverbSize, ConvolverNode>();
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
  /** The shared reverb of one size, created on first use. */
  reverb(size: ReverbSize): AudioNode {
    let c = this.reverbs.get(size);
    if (!c) {
      c = this.ctx.createConvolver();
      const ir = impulse(size, this.ctx.sampleRate);
      const buf = this.ctx.createBuffer(2, ir[0].length, this.ctx.sampleRate);
      buf.copyToChannel(ir[0], 0); buf.copyToChannel(ir[1], 1);
      c.buffer = buf;
      const wet = this.ctx.createGain();
      wet.gain.value = 1.6; // the normalised impulse is quiet next to the dry sound
      c.connect(wet).connect(this.out);
      this.reverbs.set(size, c);
    }
    return c;
  }
}

/**
 * Start one pad voice, with its effects, on any context (live or offline).
 * `note` plays the pad as an instrument: shifted by `pitch` semitones and held for at most `dur` seconds.
 */
export function playPadVoice(mixer: Mixer, padIndex: number, buffer: AudioBuffer, reversed: AudioBuffer | null, pad: Pad, time: number, vel: number, note?: { pitch: number; dur: number }): Voice | null {
  const ctx = mixer.ctx;
  const fx = pad.fx;
  const rate = Math.pow(2, (pad.semitones + (note?.pitch ?? 0)) / 12);
  const granular = isGranular(fx);
  const stretch = granular ? fx.stretch : 1;
  // How long the voice sounds, and how much of the slice that covers.
  const outDur = Math.min(((pad.end - pad.start) / rate) * stretch, note ? note.dur : Infinity);
  const len = (outDur * rate) / stretch;
  if (len <= 0.001) return null;
  const offset = Math.max(0, pad.reverse ? buffer.duration - pad.end : pad.start);
  const src = pad.reverse && reversed ? reversed : buffer;

  // Chain: sources -> [filter] -> [drive] -> level -> mixer out, with taps to the pad's echo line and the reverb.
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
  if (fx.reverb > 0) { const s = ctx.createGain(); s.gain.value = fx.reverb; level.connect(s).connect(mixer.reverb(fx.reverbSize)); }

  const sources: AudioBufferSourceNode[] = [];
  /** One enveloped piece of the buffer: `from` seconds into it, sounding for `dur` seconds from time `t`. */
  const piece = (t: number, from: number, dur: number, fadeIn: number, fadeOut: number) => {
    const node = ctx.createBufferSource();
    node.buffer = src;
    node.playbackRate.value = rate;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + fadeIn);
    env.gain.setValueAtTime(1, Math.max(t + fadeIn, t + dur - fadeOut));
    env.gain.linearRampToValueAtTime(0, t + dur);
    node.connect(env).connect(head);
    node.start(t, Math.max(0, from), dur * rate);
    sources.push(node);
  };

  // Stutter: the first 1/N of the slice, N times back to back. N = 1 is the plain slice.
  const n = Math.max(1, fx.stutter);
  const chunk = len / n, played = outDur / n;
  const rnd = prng(977 + padIndex * 31);
  for (let k = 0; k < n; k++) {
    const t = time + k * played;
    if (!granular) { piece(t, offset, played, Math.min(0.002, played / 4), Math.min(0.006, played / 4)); continue; }
    // Granular: short overlapping grains read through the slice at their own speed, so length and pitch
    // are independent. Scatter lets each grain jump away from its place, smearing the sound into a texture.
    let g = Math.min(fx.grain / 1000, played, chunk / rate);
    let hop = g / 2;
    if (played / hop > 500) { hop = played / 500; g = hop * 2; } // keep very long stretches affordable
    const lastStart = offset + Math.max(0, chunk - g * rate);
    for (let j = 0; j * hop < played; j++) {
      const tj = j * hop;
      const jump = fx.scatter > 0 ? (rnd() - 0.5) * fx.scatter * chunk : 0;
      const from = Math.min(lastStart, Math.max(offset, offset + (tj / played) * chunk + jump));
      const dur = Math.min(g, played - tj + hop);
      piece(t + tj, from, dur, j === 0 ? Math.min(0.002, dur / 4) : dur / 2, dur / 2); // the first grain keeps its attack
    }
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
function scheduleHits(mixer: Mixer, p: Project, hits: Hit[], tickTime: (t: number) => number,
  buffers: Map<string, AudioBuffer>, reversed: (id: string) => AudioBuffer | null,
  onHit?: (pad: number, time: number, v: Voice | null, id?: string, abs?: number, isNote?: boolean) => boolean | void) {
  for (const h of hits) {
    const pad = p.pads[h.pad];
    const buf = pad.sampleId ? buffers.get(pad.sampleId) : undefined;
    if (!buf) continue;
    const time = tickTime(h.abs);
    const isNote = h.pitch !== undefined;
    if (!isNote && onHit && onHit(h.pad, time, null, h.id, h.abs) === false) continue;
    const note = isNote ? { pitch: h.pitch!, dur: tickTime(h.abs + h.len!) - time } : undefined;
    const v = playPadVoice(mixer, h.pad, buf, pad.reverse ? reversed(pad.sampleId!) : null, pad, time, h.vel, note);
    onHit?.(h.pad, time, v, undefined, undefined, isNote);
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
  private noteVoices = new Set<Voice>(); // sequenced piano-roll notes: polyphonic, so not tied to a pad slot
  private held = new Map<string, { voice: Voice | null; pad: number; pitch: number; tick: number; vel: number }>(); // keys being held on a MIDI keyboard
  playing = false;
  recording = false;
  private anchorTime = 0;
  private anchorTick = 0;
  private anchorBpm = 120;
  private scheduledUntil = 0;
  private timer: number | null = null;
  private suppress = new Map<string, number>(); // event id -> absolute tick already heard live
  private takeId = '';
  /** What the transport plays: the Sampler loop, or the clips launched on the Clips page. */
  mode: 'loop' | 'clips' | 'song' = 'loop';
  /** In song mode: the bar playback starts from. */
  songStart = 0;
  private segments: Segment[] = [];

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
    if (this.mode === 'song') return Math.max(0, this.tickAt(this.ctx.currentTime)) + this.songStart * BAR_TICKS; // position in the whole song
    const t = this.tickAt(this.ctx.currentTime);
    return t < 0 ? 0 : t % loopTicks(getProject());
  }

  play(keepSegments = false) {
    if (!this.ctx || this.playing) return;
    if (this.mode === 'clips' && !keepSegments) this.segments = this.segments.filter((s) => s.end === Infinity).map((s) => ({ ...s, start: 0 })); // restart what was playing
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
    this.noteVoices.forEach((v) => v.stop(now));
    this.noteVoices.clear();
    this.onTransport();
  }

  /** Switch between playing the Sampler loop and playing launched clips. Stops playback, so nothing doubles up. */
  setMode(mode: 'loop' | 'clips' | 'song') {
    if (mode === this.mode) return;
    this.stop();
    this.mode = mode;
    this.segments = [];
  }

  /**
   * Launch a clip on its track at the next bar line (at once if the transport is stopped), replacing
   * whatever that track was playing. Pass null to stop the track at the next bar line.
   */
  launch(track: number, clipId: string | null) {
    if (!this.ctx || this.mode !== 'clips') return;
    if (!this.playing) { this.segments = this.segments.filter((s) => s.track !== track); if (!clipId) return; this.segments.push({ track, clipId, start: 0, end: Infinity }); this.play(true); return; }
    const at = Math.max(nextBar(this.tickAt(this.ctx.currentTime)), nextBar(this.scheduledUntil));
    // Drop anything queued later on this track, and end what is playing at the bar line.
    this.segments = this.segments.filter((s) => s.track !== track || s.start < at).map((s) => (s.track === track && s.end > at ? { ...s, end: at } : s));
    if (clipId) this.segments.push({ track, clipId, start: at, end: Infinity });
    this.onTransport();
  }

  /** For the Clips page: which clip each track is playing now and which is waiting for the bar line ('' = a stop is waiting). */
  clipState(): { playing: (string | null)[]; queued: (string | null)[] } {
    const now = this.playing && this.ctx ? this.tickAt(this.ctx.currentTime) : -1;
    const playing: (string | null)[] = [null, null, null, null], queued: (string | null)[] = [null, null, null, null];
    for (const s of this.segments) {
      if (now >= s.start && now < s.end) { playing[s.track] = s.clipId; if (s.end !== Infinity && !this.segments.some((n) => n.track === s.track && n.start === s.end)) queued[s.track] = ''; }
      else if (s.start > now) queued[s.track] = s.clipId;
    }
    return { playing, queued };
  }

  toggleRecord() {
    if (!this.ctx || this.mode !== 'loop') return; // recording writes into the Sampler loop
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
    if (this.mode === 'clips') this.segments = this.segments.filter((s) => s.end > from); // forget clips that have finished
    const songEnd = (songBars(p) - this.songStart) * BAR_TICKS;
    if (this.mode === 'song' && this.tickAt(now) >= songEnd) { this.stop(); return; } // the song has finished
    const hits = this.mode === 'clips' ? segmentHits(p, this.segments, from, to)
      : this.mode === 'song' ? segmentHits(p, arrangementSegments(p, this.songStart), from, Math.min(to, songEnd))
      : hitsInWindow(p, from, to);
    scheduleHits(this.mixer, p, hits, this.timeAt, this.buffers, this.reversed, (pad, time, v, id, abs, isNote) => {
      if (v === null && id !== undefined) { // pre-check: skip a hit the player just performed live
        if (this.suppress.get(id) === abs) { this.suppress.delete(id); return false; }
        return true;
      }
      if (v && isNote) { this.noteVoices.add(v); if (this.noteVoices.size > 64) this.noteVoices.delete(this.noteVoices.values().next().value!); this.onPadFire(pad, Math.max(0, time - now)); }
      else if (v) { this.voices[pad]?.stop(time); this.voices[pad] = v; this.onPadFire(pad, Math.max(0, time - now)); }
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

  /**
   * A key went down (MIDI keyboard or piano-roll audition): play the pad at a pitch until noteOff.
   * `key` identifies the key so the matching noteOff can find it.
   */
  noteOn(key: string, i: number, pitch: number, vel = 1) {
    if (!this.ctx) return;
    const pad = getProject().pads[i];
    const buf = pad.sampleId ? this.buffers.get(pad.sampleId) : undefined;
    if (!buf) return;
    const now = this.ctx.currentTime;
    this.held.get(key)?.voice?.stop(now);
    const voice = playPadVoice(this.mixer, i, buf, pad.reverse ? this.reversed(pad.sampleId!) : null, pad, now, vel, { pitch, dur: 30 });
    this.held.set(key, { voice, pad: i, pitch, tick: this.playing ? this.tickAt(now) : -1, vel });
    this.onPadFire(i, 0);
  }

  /** The key came up: stop the sound and, if recording, write the note into the piano roll. */
  noteOff(key: string) {
    if (!this.ctx) return;
    const h = this.held.get(key);
    if (!h) return;
    this.held.delete(key);
    const now = this.ctx.currentTime;
    h.voice?.stop(now);
    if (this.playing && this.recording && h.tick >= 0) {
      const p = getProject();
      const L = loopTicks(p), grid = p.quantize || 1;
      const start = quantizeTick(h.tick, p.quantize);
      const len = Math.max(grid, quantizeTick(this.tickAt(now) - h.tick, p.quantize));
      dispatch('note.add', { note: { id: uid(), pad: h.pad, tick: ((start % L) + L) % L, len, pitch: h.pitch, vel: h.vel } }, { group: 'take-' + this.takeId });
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
    plain.fx = defaultFx();
    this.auditionVoice = playPadVoice(this.mixer, -1, buf, null, plain, now, 1);
  }

  /** Play a whole buffer once through the studio output (library preview). Returns a function that stops it. */
  playBuffer(buf: AudioBuffer, onEnd: () => void): () => void {
    if (!this.ctx) { onEnd(); return () => {}; }
    const node = this.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.master);
    node.onended = onEnd;
    node.start();
    return () => { try { node.stop(); } catch { /* already ended */ } };
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
    scheduleHits(mixer, p, hitsInWindow(p, 0, L * 2), (t) => t * spt, this.buffers, rev, (pad, time, v, _id, _abs, isNote) => {
      if (v && !isNote) { voices[pad]?.stop(time); voices[pad] = v; }
      return true;
    });
    const out = await off.startRendering();
    return [out.getChannelData(0).slice(frames, frames * 2), out.getChannelData(1).slice(frames, frames * 2)];
  }

  /** Render the whole arrangement to stereo sample data, with a short tail for echoes and reverb to ring out. */
  async renderSong(sampleRate = 44100): Promise<Float32Array[] | null> {
    const p = getProject();
    const bars = songBars(p);
    if (!bars) return null;
    const spt = secondsPerTick(p.bpm);
    const end = bars * BAR_TICKS;
    const { off, mixer, rev } = this.offline(end * spt + 3, sampleRate);
    const voices: (Voice | null)[] = new Array(TOTAL_PADS).fill(null);
    scheduleHits(mixer, p, segmentHits(p, arrangementSegments(p), 0, end), (t) => t * spt, this.buffers, rev, (pad, time, v, _id, _abs, isNote) => {
      if (v && !isNote) { voices[pad]?.stop(time); voices[pad] = v; }
      return true;
    });
    const out = await off.startRendering();
    return [out.getChannelData(0), out.getChannelData(1)];
  }

  /** Render one pad hit with its pitch, reverse and effects (and the echo tail) to stereo sample data. */
  async renderPad(i: number, sampleRate = 44100): Promise<Float32Array[] | null> {
    const p = getProject();
    const pad = p.pads[i];
    const buf = pad.sampleId ? this.buffers.get(pad.sampleId) : undefined;
    if (!buf) return null;
    const fx = pad.fx;
    const played = ((pad.end - pad.start) / Math.pow(2, pad.semitones / 12)) * (isGranular(fx) ? fx.stretch : 1);
    const echo = (DELAY_TIMES[fx.delayTime] * 60) / p.bpm;
    // Echo tail: until the repeats have decayed by 60 dB, at most 8 seconds.
    const tail = fx.delayMix > 0 ? Math.min(8, echo * (1 + (fx.delayFeedback > 0 ? Math.log(0.001) / Math.log(fx.delayFeedback) : 0))) : 0.02;
    const room = fx.reverb > 0 ? REVERBS[fx.reverbSize] : 0;
    const { off, mixer, rev } = this.offline(played + Math.max(tail, room), sampleRate);
    playPadVoice(mixer, i, buf, pad.reverse ? rev(pad.sampleId!) : null, { ...pad, gain: 1 }, 0, 1);
    const out = await off.startRendering();
    return [out.getChannelData(0), out.getChannelData(1)];
  }
}

export const engine = new Engine();
