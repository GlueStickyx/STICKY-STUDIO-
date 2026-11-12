// Multi-step user actions that combine the engine, storage and command bus.
import { engine } from '../audio/engine';
import { detectTransients, estimateBpm, mixToMono } from '../audio/analysis';
import { encodeWav, synthDemoLoop } from '../audio/wav';
import { zipSingle } from '../audio/zip';
import { useDownloads } from '../ai/viewer';
import { dispatch, getProject, loadProject, subscribe } from '../core/bus';
import { deleteProject, deleteSound, listProjects, listSounds, loadAudio, loadSavedProject, putProject, putSound, requestPersistence, saveAudio, saveProject, soundAudio } from '../core/storage';
import type { LibrarySound, SavedProject } from '../core/storage';
import { midiToNotes, parseMidi, projectToMidi } from '../core/midi';
import { BAR_TICKS, emptyProject, normalizeProject, padLabel, uid } from '../core/types';
import type { Project, Sample } from '../core/types';

export function monoOf(id: string): { mono: Float32Array; sampleRate: number } | null {
  const b = engine.buffers.get(id);
  if (!b) return null;
  const ch: Float32Array[] = [];
  for (let c = 0; c < b.numberOfChannels; c++) ch.push(b.getChannelData(c));
  return { mono: mixToMono(ch), sampleRate: b.sampleRate };
}

async function addSample(name: string, bytes: ArrayBuffer, group?: string): Promise<Sample> {
  const buf = await engine.decode(bytes);
  const id = uid();
  engine.addBuffer(id, buf);
  const m = monoOf(id)!;
  // Tempo detection on at most the first 60 s keeps long songs quick on a tablet.
  const bpm = estimateBpm(m.mono.subarray(0, Math.min(m.mono.length, m.sampleRate * 60)), m.sampleRate);
  const sample: Sample = { id, name, duration: buf.duration, sampleRate: buf.sampleRate, markers: [], bpm };
  await saveAudio(id, bytes);
  dispatch('sample.add', { sample }, group ? { group, sticky: true } : {});
  return sample;
}

/** Import a user's audio file. Returns an error message for the UI, or null on success. */
export async function importFile(file: File): Promise<string | null> {
  try {
    await addSample(file.name.replace(/\.[^.]+$/, ''), await file.arrayBuffer());
    return null;
  } catch {
    return `Could not read "${file.name}". Try a WAV or MP3 file.`;
  }
}

export function autoSlice(sampleId: string, sensitivity: number) {
  const m = monoOf(sampleId);
  if (!m) return;
  dispatch('sample.setMarkers', { id: sampleId, markers: detectTransients(m.mono, m.sampleRate, sensitivity) }, { group: 'autoslice' });
}

export function gridSlice(sampleId: string, parts: number) {
  const s = getProject().samples.find((x) => x.id === sampleId);
  if (!s) return;
  dispatch('sample.setMarkers', { id: sampleId, markers: Array.from({ length: parts - 1 }, (_, i) => ((i + 1) * s.duration) / parts) });
}

/** First run: a synthesised loop, sliced and on the pads, with a starter pattern, so the studio makes sound at once. */
async function seedDemo() {
  const { data, bpm } = synthDemoLoop();
  const s = await addSample('Demo loop', encodeWav([data], 44100));
  dispatch('project.setBpm', { bpm });
  gridSlice(s.id, 16); // the demo is exactly 2 bars: 16 equal slices are 8th notes
  dispatch('pads.assignSlices', { sampleId: s.id });
  const row = (on: number[]) => Array.from({ length: 16 }, (_, i) => (on.includes(i) ? 1 : 0));
  dispatch('seq.setRow', { pad: 0, steps: row([0, 10]) });
  dispatch('seq.setRow', { pad: 2, steps: row([4, 12]) });
  dispatch('seq.setRow', { pad: 1, steps: row([2, 6, 14]).map((v) => v * 0.6) });
}

/**
 * Resample: print a pad with its pitch, reverse and effects into a new sample, and point the pad at it
 * with the effects cleared. One undo step. Returns a sentence for the UI.
 */
export async function resamplePad(i: number): Promise<string> {
  const pad = getProject().pads[i];
  const src = getProject().samples.find((s) => s.id === pad.sampleId);
  const ch = src ? await engine.renderPad(i) : null;
  if (!src || !ch) return 'This pad is empty.';
  const group = 'resample-' + uid();
  const s = await addSample(`${src.name} ${padLabel(i)} resampled`, encodeWav(ch, 44100), group);
  const opt = { group, sticky: true };
  dispatch('pad.assign', { pad: i, sampleId: s.id, start: 0, end: s.duration }, opt);
  dispatch('pad.set', { pad: i, semitones: 0, reverse: false }, opt);
  dispatch('pad.resetFx', { pad: i }, opt);
  return `Pad ${padLabel(i)} now plays the resampled sound. It is in the sample list for further chopping.`;
}

let saveTimer: number | null = null;
export let saveState: 'saved' | 'saving' | 'off' = 'saved';
const saveListeners = new Set<() => void>();
export const onSaveState = (l: () => void) => { saveListeners.add(l); return () => { saveListeners.delete(l); }; };
function setSaveState(s: typeof saveState) { saveState = s; saveListeners.forEach((l) => l()); }

/** Put a stored project on screen: decode its audio, drop anything whose audio is gone. Clears undo history. */
async function restoreProject(saved: Project): Promise<number> {
  const kept: Sample[] = [];
  for (const s of saved.samples) {
    if (!engine.buffers.has(s.id)) {
      const bytes = await loadAudio(s.id);
      if (!bytes) continue;
      try { engine.addBuffer(s.id, await engine.decode(bytes)); } catch { continue; } // skip unreadable audio
    }
    kept.push(s);
  }
  const ids = new Set(kept.map((s) => s.id));
  loadProject(normalizeProject({
    ...emptyProject(), ...saved, samples: kept,
    activeSampleId: saved.activeSampleId && ids.has(saved.activeSampleId) ? saved.activeSampleId : (kept[0]?.id ?? null),
    pads: saved.pads.map((p) => (p.sampleId && !ids.has(p.sampleId) ? { ...p, sampleId: null } : p)),
  }));
  return saved.samples.length - kept.length;
}

/** Called once after the first tap: starts audio, restores the last project, turns on autosave. */
export async function boot(): Promise<void> {
  await engine.start();
  requestPersistence();
  const saved = await loadSavedProject();
  if (saved) {
    await restoreProject(saved);
  } else {
    await seedDemo();
    loadProject(getProject()); // the demo is the starting point, not something to undo
  }
  subscribe(() => {
    setSaveState('saving');
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => { setSaveState((await saveProject(getProject())) ? 'saved' : 'off'); }, 400);
  });
  setSaveState((await saveProject(getProject())) ? 'saved' : 'off');
}

/**
 * Hand a generated file to the user. Inside the Claude app a page may only save certain file types,
 * so there the file travels inside a zip. Returns a sentence describing what happened.
 */
async function saveFile(name: string, ext: string, bytes: ArrayBuffer, mime: string, what: string): Promise<string> {
  const downloads = await useDownloads();
  if (downloads) {
    try { await downloads.save({ filename: `${name}.zip`, data: new Blob([zipSingle(`${name}.${ext}`, bytes)]) }); return `${what} saved as a zip with the ${ext.toUpperCase()} file inside.`; }
    catch (e) { return (e as { code?: string })?.code === 'declined' ? 'Save cancelled.' : 'Saving is not available in this view.'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
  a.download = `${name}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return `${what} saved as a ${ext.toUpperCase()} file.`;
}
const fileStem = (kind: string) => { const p = getProject(); return `sticky-${kind}-${p.bars}bar-${Math.round(p.bpm)}bpm`; };

/** Render the loop and hand it to the user. Returns a sentence describing what happened. */
export async function exportLoopWav(): Promise<string> {
  return saveFile(fileStem('loop'), 'wav', encodeWav(await engine.renderLoop(44100), 44100), 'audio/wav', 'Loop');
}

/** Save the loop's patterns, recorded hits and piano-roll notes as a MIDI file. */
export async function exportMidi(): Promise<string> {
  const bytes = projectToMidi(getProject());
  return saveFile(fileStem('midi'), 'mid', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'audio/midi', 'MIDI');
}

/** Read a MIDI file into the piano roll of the selected pad, replacing that pad's notes. */
export async function importMidi(file: File): Promise<string> {
  const p = getProject();
  let parsed;
  try { parsed = parseMidi(new Uint8Array(await file.arrayBuffer())); } catch (e) { return `Could not read "${file.name}": ${(e as Error).message}.`; }
  const { notes, dropped } = midiToNotes(parsed, p.selectedPad, p.root, p.bars * BAR_TICKS, uid);
  if (!notes.length) return parsed.notes.length ? 'Every note in that file starts after the end of the loop. Make the loop longer and import again.' : 'That MIDI file has no notes.';
  dispatch('notes.set', { pad: p.selectedPad, notes });
  const tempo = parsed.bpm && Math.abs(parsed.bpm - p.bpm) > 0.5 ? ` The file's tempo is ${parsed.bpm} BPM; the project stays at ${p.bpm}.` : '';
  return `Imported ${notes.length} notes onto pad ${padLabel(p.selectedPad)}.${dropped ? ` ${dropped} past the end of the loop were left out.` : ''}${tempo}`;
}

// ---- Library ----

const libListeners = new Set<() => void>();
/** Called whenever the library's contents change, so an open library view can refresh. */
export const onLibraryChange = (l: () => void) => { libListeners.add(l); return () => { libListeners.delete(l); }; };
const libChanged = () => libListeners.forEach((l) => l());
export { listProjects, listSounds };
export type { LibrarySound, SavedProject };

async function storeSound(name: string, bytes: ArrayBuffer, bpm: number | null, tags: string[] = []): Promise<boolean> {
  let duration = 0;
  try { duration = (await engine.decode(bytes)).duration; } catch { return false; }
  const ok = await putSound({ id: uid(), name, tags, duration, bpm, added: Date.now() }, bytes);
  if (ok) libChanged();
  return ok;
}
const FULL = 'The library could not save that. The browser may be out of storage space.';

/** Save a project sample (the whole imported file) to the library. */
export async function saveSampleToLibrary(sampleId: string): Promise<string> {
  const s = getProject().samples.find((x) => x.id === sampleId);
  const bytes = s ? await loadAudio(s.id) : null;
  if (!s || !bytes) return 'That sample\'s audio is not available to save.';
  return (await storeSound(s.name, bytes, s.bpm)) ? `"${s.name}" saved to the library.` : FULL;
}
/** Save one pad as it sounds (slice, pitch, reverse, effects) to the library. */
export async function savePadToLibrary(i: number): Promise<string> {
  const pad = getProject().pads[i];
  const src = getProject().samples.find((s) => s.id === pad.sampleId);
  const ch = src ? await engine.renderPad(i) : null;
  if (!src || !ch) return 'This pad is empty.';
  const name = `${src.name} ${padLabel(i)}`;
  return (await storeSound(name, encodeWav(ch, 44100), null, ['one-shot'])) ? `Pad ${padLabel(i)} saved to the library as "${name}".` : FULL;
}
/** Save the current loop, rendered to audio, to the library. */
export async function saveLoopToLibrary(): Promise<string> {
  const p = getProject();
  const name = `Loop ${p.bars} bar ${Math.round(p.bpm)} BPM`;
  return (await storeSound(name, encodeWav(await engine.renderLoop(44100), 44100), p.bpm, ['loop'])) ? `Loop saved to the library as "${name}".` : FULL;
}
/** Add audio files straight to the library, without putting them in the project. */
export async function uploadToLibrary(files: File[]): Promise<string> {
  let ok = 0;
  const bad: string[] = [];
  for (const f of files) {
    const bytes = await f.arrayBuffer();
    if (await storeSound(f.name.replace(/\.[^.]+$/, ''), bytes, null)) ok++; else bad.push(f.name);
  }
  return `${ok} ${ok === 1 ? 'sound' : 'sounds'} added to the library.${bad.length ? ` Could not read: ${bad.join(', ')}.` : ''}`;
}
export async function updateSound(meta: LibrarySound): Promise<void> { await putSound(meta); libChanged(); }
export async function removeSound(id: string): Promise<void> { await deleteSound(id); libChanged(); }

/** Bring a library sound into the project. With `pad`, also put the whole sound on that pad. One undo step. */
export async function loadSound(sound: LibrarySound, pad?: number): Promise<string> {
  const bytes = await soundAudio(sound.id);
  if (!bytes) return 'That sound\'s audio is missing from the library.';
  const group = 'lib-' + uid();
  let s: Sample;
  try { s = await addSample(sound.name, bytes, group); } catch { return `Could not read "${sound.name}".`; }
  if (pad === undefined) return `"${sound.name}" is in the chop view.`;
  const opt = { group, sticky: true };
  dispatch('pad.assign', { pad, sampleId: s.id, start: 0, end: s.duration }, opt);
  dispatch('pad.set', { pad, semitones: 0, reverse: false, gain: 1 }, opt);
  dispatch('pad.resetFx', { pad }, opt);
  return `"${sound.name}" is on pad ${padLabel(pad)}.`;
}
export async function downloadSound(sound: LibrarySound): Promise<string> {
  const bytes = await soundAudio(sound.id);
  if (!bytes) return 'That sound\'s audio is missing from the library.';
  const isWav = new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF';
  return saveFile(sound.name.replace(/[^\w -]+/g, '').trim() || 'sound', isWav ? 'wav' : 'mp3', bytes, isWav ? 'audio/wav' : 'audio/mpeg', 'Sound');
}

let previewStop: (() => void) | null = null;
/** Play a library sound through the studio output. Calling it again, or stopPreview, stops it. */
export async function previewSound(sound: LibrarySound, onEnd: () => void): Promise<void> {
  stopPreview();
  const bytes = await soundAudio(sound.id);
  if (!bytes) { onEnd(); return; }
  try { previewStop = engine.playBuffer(await engine.decode(bytes), onEnd); } catch { onEnd(); }
}
export function stopPreview() { previewStop?.(); previewStop = null; }

/** Save what is on screen as a named project in the library. Saving under an existing name replaces it. */
export async function saveProjectAs(name: string): Promise<string> {
  name = name.trim();
  if (!name) return 'Give the project a name first.';
  const existing = (await listProjects()).find((p) => p.name.toLowerCase() === name.toLowerCase());
  const ok = await putProject({ id: existing?.id ?? uid(), name, saved: Date.now(), project: getProject() });
  if (ok) libChanged();
  return ok ? (existing ? `Project "${name}" updated.` : `Project "${name}" saved.`) : FULL;
}
/** Replace what is on screen with a saved project. */
export async function openProject(saved: SavedProject): Promise<string> {
  engine.stop();
  const missing = await restoreProject(saved.project as Project);
  return `Opened "${saved.name}".${missing ? ` ${missing} of its samples could not be found in this browser and were left out.` : ''}`;
}
export async function removeProject(id: string): Promise<void> { await deleteProject(id); libChanged(); }
