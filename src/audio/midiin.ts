// MIDI keyboard / pad controller input through the browser's Web MIDI support, where it exists.
// In "keys" mode notes play the selected pad as an instrument (middle C + root = the pad's own pitch);
// in "pads" mode notes 36-51 trigger the 16 pads of the bank on screen.
import { getProject } from '../core/bus';
import { PAD_COUNT, PITCH_MAX, PITCH_MIN, bankOf } from '../core/types';

export interface MidiTarget {
  hitPad: (i: number, vel: number) => void;
  noteOn: (key: string, pad: number, pitch: number, vel: number) => void;
  noteOff: (key: string) => void;
}
export type MidiMode = 'pads' | 'keys';
let mode: MidiMode = 'pads';
export const setMidiMode = (m: MidiMode) => { mode = m; };

/** Act on one raw MIDI message. Exported so the mapping can be tested without hardware. */
export function handleMidiMessage(data: ArrayLike<number>, target: MidiTarget, m: MidiMode = mode) {
  if (data.length < 3) return;
  const kind = data[0] & 0xf0, key = data[1], vel = data[2];
  const isOn = kind === 0x90 && vel > 0, isOff = kind === 0x80 || (kind === 0x90 && vel === 0);
  if (!isOn && !isOff) return;
  const p = getProject();
  if (m === 'keys') {
    const pitch = key - 60 - p.root;
    if (pitch < PITCH_MIN || pitch > PITCH_MAX) return; // outside the two octaves a pad can be repitched over
    if (isOn) target.noteOn(`midi-${key}`, p.selectedPad, pitch, vel / 127);
    else target.noteOff(`midi-${key}`);
  } else if (isOn && key >= 36 && key < 36 + PAD_COUNT) {
    target.hitPad(bankOf(p.selectedPad) * PAD_COUNT + (key - 36), Math.max(0.2, vel / 127));
  }
}

export const midiSupported = () => typeof navigator !== 'undefined' && typeof (navigator as any).requestMIDIAccess === 'function';

/**
 * Ask the browser for MIDI devices (this shows a permission prompt) and listen to all inputs.
 * `onDevices` is called with the names of connected inputs now and whenever that changes.
 * Rejects if the browser or the page's host refuses MIDI.
 */
export async function connectMidi(target: MidiTarget, onDevices: (names: string[]) => void): Promise<void> {
  const access = await (navigator as any).requestMIDIAccess({ sysex: false });
  const wire = () => {
    const names: string[] = [];
    access.inputs.forEach((input: any) => {
      names.push(input.name || 'MIDI device');
      input.onmidimessage = (e: { data: Uint8Array }) => handleMidiMessage(e.data, target);
    });
    onDevices(names);
  };
  access.onstatechange = wire;
  wire();
}
