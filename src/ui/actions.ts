// Multi-step user actions that combine the engine, storage and command bus.
import { engine } from '../audio/engine';
import { detectTransients, estimateBpm, mixToMono } from '../audio/analysis';
import { encodeWav, synthDemoLoop } from '../audio/wav';
import { zipSingle } from '../audio/zip';
import { useDownloads } from '../ai/viewer';
import { dispatch, getProject, loadProject, subscribe } from '../core/bus';
import { loadAudio, loadSavedProject, requestPersistence, saveAudio, saveProject } from '../core/storage';
import { emptyProject, uid } from '../core/types';
import type { Sample } from '../core/types';

export function monoOf(id: string): { mono: Float32Array; sampleRate: number } | null {
  const b = engine.buffers.get(id);
  if (!b) return null;
  const ch: Float32Array[] = [];
  for (let c = 0; c < b.numberOfChannels; c++) ch.push(b.getChannelData(c));
  return { mono: mixToMono(ch), sampleRate: b.sampleRate };
}

async function addSample(name: string, bytes: ArrayBuffer): Promise<Sample> {
  const buf = await engine.decode(bytes);
  const id = uid();
  engine.addBuffer(id, buf);
  const m = monoOf(id)!;
  // Tempo detection on at most the first 60 s keeps long songs quick on a tablet.
  const bpm = estimateBpm(m.mono.subarray(0, Math.min(m.mono.length, m.sampleRate * 60)), m.sampleRate);
  const sample: Sample = { id, name, duration: buf.duration, sampleRate: buf.sampleRate, markers: [], bpm };
  await saveAudio(id, bytes);
  dispatch('sample.add', { sample });
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

let saveTimer: number | null = null;
export let saveState: 'saved' | 'saving' | 'off' = 'saved';
const saveListeners = new Set<() => void>();
export const onSaveState = (l: () => void) => { saveListeners.add(l); return () => { saveListeners.delete(l); }; };
function setSaveState(s: typeof saveState) { saveState = s; saveListeners.forEach((l) => l()); }

/** Called once after the first tap: starts audio, restores the last project, turns on autosave. */
export async function boot(): Promise<void> {
  await engine.start();
  requestPersistence();
  const saved = await loadSavedProject();
  if (saved) {
    const kept: Sample[] = [];
    for (const s of saved.samples) {
      const bytes = await loadAudio(s.id);
      if (!bytes) continue;
      try { engine.addBuffer(s.id, await engine.decode(bytes)); kept.push(s); } catch { /* skip unreadable audio */ }
    }
    const ids = new Set(kept.map((s) => s.id));
    loadProject({
      ...emptyProject(), ...saved, samples: kept,
      activeSampleId: saved.activeSampleId && ids.has(saved.activeSampleId) ? saved.activeSampleId : (kept[0]?.id ?? null),
      pads: saved.pads.map((p) => (p.sampleId && !ids.has(p.sampleId) ? { ...p, sampleId: null } : p)),
    });
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

/** Render the loop and hand it to the user. Returns a sentence describing what happened. */
export async function exportLoopWav(): Promise<string> {
  const ch = await engine.renderLoop(44100);
  const wav = encodeWav(ch, 44100);
  const p = getProject();
  const name = `sticky-loop-${p.bars}bar-${Math.round(p.bpm)}bpm`;
  const downloads = await useDownloads();
  if (downloads) {
    // Inside the Claude app a page may only save certain file types, so the WAV travels in a zip.
    try { await downloads.save({ filename: `${name}.zip`, data: new Blob([zipSingle(`${name}.wav`, wav)]) }); return 'Loop saved as a zip with the WAV inside.'; }
    catch (e) { return (e as { code?: string })?.code === 'declined' ? 'Save cancelled.' : 'Saving is not available in this view.'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  a.download = `${name}.wav`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'Loop saved as a WAV file.';
}
