// Standard MIDI File writing and reading, by hand (the format is small). Pure data in, pure data out.
import { loopTicks, stepTick } from './sequence';
import { PITCH_MAX, PITCH_MIN, PPQ, STEP_COUNT, STEP_TICKS, padLabel } from './types';
import type { Note, Project } from './types';

const DRUM_BASE = 36; // pad A1 = MIDI note 36 (C1), the usual drum-pad layout
const MIDDLE_C = 60;

function varLen(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0x7f);
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

interface Ev { tick: number; order: number; bytes: number[] }
function track(name: string, events: Ev[]): number[] {
  const body: number[] = [0, 0xff, 0x03, ...varLen(name.length), ...str(name)];
  let last = 0;
  // Note-offs before note-ons at the same tick, so repeated notes are not cut short.
  for (const e of [...events].sort((a, b) => a.tick - b.tick || a.order - b.order)) {
    body.push(...varLen(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  return [...str('MTrk'), ...u32(body.length), ...body];
}
const noteEvents = (ch: number, key: number, tick: number, len: number, vel: number): Ev[] => [
  { tick, order: 1, bytes: [0x90 | ch, key, Math.max(1, Math.min(127, Math.round(vel * 127)))] },
  { tick: tick + len, order: 0, bytes: [0x80 | ch, key, 0] },
];

/**
 * One pass of the loop as a type-1 MIDI file: a tempo track, a drum track (channel 10) holding every
 * step and recorded hit, and one track per pad that has piano-roll notes.
 */
export function projectToMidi(p: Project): Uint8Array {
  const L = loopTicks(p);
  const us = Math.round(60000000 / p.bpm);
  const tracks: number[][] = [track('Sticky Studio', [{ tick: 0, order: 0, bytes: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] }])];

  const drums: Ev[] = [];
  const hitLen = STEP_TICKS / 2;
  for (let k = 0; k < p.bars * STEP_COUNT; k++) {
    const tick = Math.round(stepTick(k, p.swing));
    p.pads.forEach((pad, i) => { const v = pad.steps[k % STEP_COUNT]; if (pad.sampleId && v > 0 && tick < L) drums.push(...noteEvents(9, DRUM_BASE + i, tick, hitLen, v)); });
  }
  for (const e of p.events) if (p.pads[e.pad]?.sampleId) drums.push(...noteEvents(9, DRUM_BASE + e.pad, e.tick, hitLen, e.vel));
  if (drums.length) tracks.push(track('Pads', drums));

  let ch = 0;
  for (const pad of [...new Set(p.notes.map((n) => n.pad))].sort((a, b) => a - b)) {
    const evs = p.notes.filter((n) => n.pad === pad).flatMap((n) => noteEvents(ch, MIDDLE_C + p.root + n.pitch, n.tick, n.len, n.vel));
    tracks.push(track(`Pad ${padLabel(pad)}`, evs));
    ch = ch === 8 ? 10 : (ch + 1) % 16; // skip the drum channel
  }
  return Uint8Array.from([...str('MThd'), ...u32(6), 0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (PPQ >> 8) & 255, PPQ & 255, ...tracks.flat()]);
}

export interface ParsedNote { tick: number; len: number; key: number; vel: number; channel: number }
export interface ParsedMidi { notes: ParsedNote[]; bpm: number | null }

/** Read the notes of a MIDI file, with times converted to this app's ticks. Throws on a file that is not MIDI. */
export function parseMidi(data: Uint8Array): ParsedMidi {
  const tag = (o: number) => String.fromCharCode(...data.subarray(o, o + 4));
  const r32 = (o: number) => ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
  if (data.length < 14 || tag(0) !== 'MThd') throw new Error('Not a MIDI file');
  const division = (data[12] << 8) | data[13];
  if (division & 0x8000) throw new Error('This MIDI file uses film timecode, which is not supported');
  const scale = PPQ / division;
  const notes: ParsedNote[] = [];
  let bpm: number | null = null;
  let o = 8 + r32(4);
  while (o + 8 <= data.length) {
    const size = r32(o + 4), end = Math.min(data.length, o + 8 + size);
    if (tag(o) === 'MTrk') {
      let i = o + 8, tick = 0, status = 0;
      const open = new Map<number, { tick: number; vel: number }>();
      const readVar = () => { let v = 0; for (let k = 0; k < 4 && i < end; k++) { const b = data[i++]; v = (v << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return v; };
      while (i < end) {
        tick += readVar();
        if (i >= end) break;
        if (data[i] & 0x80) status = data[i++];
        if (status === 0xff) { // meta event
          const type = data[i++], len = readVar();
          if (type === 0x51 && len === 3 && bpm === null) bpm = Math.round((60000000 / ((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])) * 10) / 10;
          i += len;
        } else if (status === 0xf0 || status === 0xf7) { i += readVar(); }
        else {
          const kind = status & 0xf0, ch = status & 0x0f;
          const a = data[i++], b = kind === 0xc0 || kind === 0xd0 ? 0 : data[i++];
          const id = ch * 128 + a;
          if (kind === 0x90 && b > 0) open.set(id, { tick, vel: b / 127 });
          else if (kind === 0x80 || kind === 0x90) {
            const on = open.get(id);
            if (on) { open.delete(id); notes.push({ tick: Math.round(on.tick * scale), len: Math.max(1, Math.round((tick - on.tick) * scale)), key: a, vel: on.vel, channel: ch }); }
          }
        }
      }
    }
    o += 8 + size;
  }
  return { notes: notes.sort((a, b) => a.tick - b.tick), bpm };
}

/**
 * Turn parsed MIDI into piano-roll notes for one pad: melodic channels only, pitches measured from
 * middle C plus the project root and moved by octaves into range, anything past the loop dropped.
 */
export function midiToNotes(m: ParsedMidi, pad: number, root: number, loop: number, makeId: () => string): { notes: Note[]; dropped: number } {
  const melodic = m.notes.filter((n) => n.channel !== 9);
  const src = melodic.length ? melodic : m.notes;
  const notes: Note[] = [];
  for (const n of src) {
    if (n.tick >= loop) continue;
    let pitch = n.key - MIDDLE_C - root;
    while (pitch > PITCH_MAX) pitch -= 12;
    while (pitch < PITCH_MIN) pitch += 12;
    notes.push({ id: makeId(), pad, tick: n.tick, len: Math.min(n.len, loop - n.tick), pitch, vel: Math.max(0.05, n.vel) });
  }
  return { notes, dropped: src.length - notes.length };
}
