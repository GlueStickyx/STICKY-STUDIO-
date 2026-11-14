import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { engine } from '../audio/engine';
import { canRedo, canUndo, dispatch, getProject, redo, subscribe, undo } from '../core/bus';
import { loopTicks } from '../core/sequence';
import { BANK_COUNT, BANK_NAMES, BAR_TICKS, PAD_COUNT, PPQ, STEP_TICKS, TOTAL_PADS, bankOf, padLabel, sliceBounds } from '../core/types';
import { DELAY_TIMES, REVERBS, STRETCH_MAX, STRETCH_MIN, STUTTERS, fxActive, isGranular } from '../core/types';
import type { FilterType, PadFx, Project } from '../core/types';
import { connectMidi, midiSupported, setMidiMode } from '../audio/midiin';
import { NOTE_NAMES, SCALES } from '../core/types';
import type { ScaleName } from '../core/types';
import { autoSlice, boot, exportLoopWav, exportMidi, gridSlice, importFile, importMidi, onSaveState, resamplePad, savePadToLibrary, saveSampleToLibrary, saveState } from './actions';
import { Guide } from './Guide';
import { Library } from './Library';
import { MODULES } from './modules';
import { PianoRoll } from './PianoRoll';
import { padHue } from './colors';
import { inArtifact } from '../ai/viewer';
import { Arrange } from './Arrange';
import { Analyze } from './Analyze';
import { Chat } from './Chat';
import { Suno } from './Suno';
import { MixerView } from './MixerView';
import { Clips } from './Clips';
import { Waveform } from './Waveform';
import type { Tool } from './Waveform';

const useProject = () => useSyncExternalStore(subscribe, getProject);
function useTick<T>(read: () => T): T {
  // Re-read a fast-changing engine value every animation frame. The latest `read` is used each frame,
  // so a value that depends on props (which sample, which pad) never goes stale.
  const [v, setV] = useState(read);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    let raf = 0;
    const loop = () => { setV(latest.current()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return v;
}

export function App() {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  if (phase !== 'ready') {
    return (
      <div className="gate">
        <h1>Sticky Studio</h1>
        <p>Chop a track, play it on pads, record a loop.</p>
        <button id="start" className="btn primary big" disabled={phase === 'loading'}
          onClick={async () => { setPhase('loading'); try { await boot(); setPhase('ready'); } catch { setPhase('error'); } }}>
          {phase === 'loading' ? 'Starting…' : 'Start audio'}
        </button>
        {phase === 'error' && <p className="warn">Audio could not start in this browser. Reload the page and try again.</p>}
        <p className="hint">Browsers only allow sound after a tap, so the studio opens with this button.</p>
      </div>
    );
  }
  return <Studio />;
}

function Studio() {
  const p = useProject();
  const [, force] = useState(0);
  const [tool, setTool] = useState<Tool>('play');
  const [panel, setPanel] = useState<'steps' | 'pad' | 'fx'>('steps');
  const [msg, setMsg] = useState<string | null>(null);
  const [chat, setChat] = useState(false);
  const [module, setModule] = useState('studio');
  useEffect(() => { engine.setMode(module === 'clips' ? 'clips' : module === 'arrange' ? 'song' : 'loop'); }, [module]); // the Clips page plays clips; everywhere else plays the Sampler loop
  const [sheet, setSheet] = useState<'library' | 'guide' | null>(null);
  const [view, setView] = useState<'chop' | 'roll'>('chop');
  const [noteLen, setNoteLen] = useState(STEP_TICKS * 2);
  useEffect(() => { setMidiMode(view === 'roll' ? 'keys' : 'pads'); }, [view]);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);
  useEffect(() => { engine.onTransport = () => force((n) => n + 1); return onSaveState(() => force((n) => n + 1)); }, []);
  useEffect(() => { // keep the screen awake while the studio is open, where the browser allows it
    let lock: any;
    const get = () => (navigator as any).wakeLock?.request('screen').then((l: any) => { lock = l; }).catch(() => {});
    get();
    const vis = () => { if (document.visibilityState === 'visible') get(); };
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); lock?.release?.(); };
  }, []);
  const sample = p.samples.find((s) => s.id === p.activeSampleId) ?? null;
  return (
    <div className={chat ? 'studio with-chat' : 'studio'}>
      {chat && <Chat onClose={() => setChat(false)} />}
      {sheet === 'library' && <Library onClose={() => setSheet(null)} say={setMsg} />}
      {sheet === 'guide' && <Guide onClose={() => setSheet(null)} />}
      <Transport p={p} say={setMsg} chat={chat} toggleChat={() => setChat(!chat)} openSheet={setSheet} />
      {msg && <div className="toast" role="status" onClick={() => setMsg(null)}>{msg}</div>}
      <nav className="modules" aria-label="Modules">
        {MODULES.map((m) => (
          <button key={m.id} id={`mod-${m.id}`} className={module === m.id ? 'mod on' : 'mod'} aria-current={module === m.id ? 'page' : undefined} onClick={() => setModule(m.id)}>
            {m.name}{!m.built && <span className="soon">soon</span>}
          </button>
        ))}
      </nav>
      {module === 'suno' ? <Suno p={p} say={setMsg} /> : module === 'analyze' ? <Analyze p={p} say={setMsg} /> : module === 'mixer' ? <MixerView p={p} /> : module === 'arrange' ? <Arrange p={p} say={setMsg} /> : module === 'clips' ? <Clips p={p} say={setMsg} toSampler={() => setModule('studio')} /> : module !== 'studio' ? <Planned id={module} back={() => setModule('studio')} /> : (
        <>
      <section className="chop">
        {view === 'chop' ? (
          <>
            <ChopBar p={p} tool={tool} setTool={setTool} say={setMsg} switcher={<ViewSwitch view={view} setView={setView} />} />
            {sample ? <Waveform sample={sample} project={p} tool={tool} />
              : <div className="empty">Import a WAV or MP3 to start chopping.</div>}
          </>
        ) : (
          <>
            <RollBar p={p} say={setMsg} noteLen={noteLen} setNoteLen={setNoteLen} switcher={<ViewSwitch view={view} setView={setView} />} />
            {p.pads[p.selectedPad].sampleId ? <PianoRoll p={p} noteLen={noteLen} />
              : <div className="empty">Pad {padLabel(p.selectedPad)} is empty. Pick a pad with a sound to play it as an instrument.</div>}
          </>
        )}
      </section>
      <section className="perform">
        <Pads p={p} />
        <div className="side">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={panel === 'steps'} className={panel === 'steps' ? 'tab on' : 'tab'} onClick={() => setPanel('steps')}>Steps</button>
            <button role="tab" aria-selected={panel === 'pad'} className={panel === 'pad' ? 'tab on' : 'tab'} onClick={() => setPanel('pad')}>Pad {padLabel(p.selectedPad)}</button>
            <button id="tab-fx" role="tab" aria-selected={panel === 'fx'} className={panel === 'fx' ? 'tab on' : 'tab'} onClick={() => setPanel('fx')}>FX{fxActive(p.pads[p.selectedPad].fx) ? ' •' : ''}</button>
          </div>
          {panel === 'steps' ? <Steps p={p} /> : panel === 'pad' ? <PadEdit p={p} say={setMsg} /> : <FxEdit p={p} say={setMsg} />}
        </div>
      </section>
        </>
      )}
    </div>
  );
}

function Transport({ p, say, chat, toggleChat, openSheet }: { p: Project; say: (m: string | null) => void; chat: boolean; toggleChat: () => void; openSheet: (s: 'library' | 'guide') => void }) {
  const pos = useTick(() => Math.floor(engine.position() / (PPQ / 4)));
  const taps = useRef<number[]>([]);
  const [busy, setBusy] = useState(false);
  const bar = Math.floor((pos * STEP_TICKS) / BAR_TICKS) + 1, beat = Math.floor(((pos * STEP_TICKS) % BAR_TICKS) / PPQ) + 1;
  const lat = engine.latencyMs();
  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 2500), now].slice(-6);
    const t = taps.current;
    if (t.length >= 3) dispatch('project.setBpm', { bpm: 60000 / ((t[t.length - 1] - t[0]) / (t.length - 1)) }, { group: 'tap' });
  };
  return (
    <header className="transport">
      <div className="group">
        <button id="play" className={engine.playing ? 'btn icon on' : 'btn icon'} aria-label={engine.playing ? 'Stop' : 'Play'}
          onClick={() => (engine.playing ? engine.stop() : engine.play())}>{engine.playing ? '■' : '▶'}</button>
        <button id="rec" disabled={engine.mode !== 'loop'} title={engine.mode !== 'loop' ? 'Recording writes into the Sampler loop. Go to the Sampler to record.' : undefined} className={engine.recording ? 'btn icon rec on' : 'btn icon rec'} aria-label="Record pad hits" aria-pressed={engine.recording}
          onClick={() => engine.toggleRecord()}>●</button>
        <button id="metro" className={p.metronome ? 'btn on' : 'btn'} aria-pressed={p.metronome}
          onClick={() => dispatch('project.setMetronome', { on: !p.metronome })}>Click</button>
        <span className="pos" aria-label="Position">{engine.playing ? `${bar}.${beat}` : '–.–'}</span>
      </div>
      <div className="group">
        <button className="btn icon" aria-label="Slower" onClick={() => dispatch('project.setBpm', { bpm: p.bpm - 1 }, { group: 'bpm' })}>−</button>
        <label className="bpm"><input id="bpm" type="number" inputMode="decimal" min={40} max={240} value={p.bpm}
          onChange={(e) => { const v = Number(e.target.value); if (v >= 40 && v <= 240) dispatch('project.setBpm', { bpm: v }, { group: 'bpm' }); }} /><span>BPM</span></label>
        <button className="btn icon" aria-label="Faster" onClick={() => dispatch('project.setBpm', { bpm: p.bpm + 1 }, { group: 'bpm' })}>+</button>
        <button className="btn" onClick={tap}>Tap</button>
      </div>
      <div className="group">
        <label className="field">Loop
          <select id="bars" value={p.bars} onChange={(e) => dispatch('project.setBars', { bars: Number(e.target.value) })}>
            <option value={1}>1 bar</option><option value={2}>2 bars</option><option value={4}>4 bars</option>
          </select></label>
        <label className="field">Snap
          <select id="quantize" value={p.quantize} onChange={(e) => dispatch('project.setQuantize', { ticks: Number(e.target.value) })}>
            <option value={0}>Off</option><option value={48}>1/8</option><option value={24}>1/16</option><option value={12}>1/32</option>
          </select></label>
      </div>
      <div className="group end">
        <button id="undo" className="btn" disabled={!canUndo()} onClick={undo}>Undo</button>
        <button id="redo" className="btn" disabled={!canRedo()} onClick={redo}>Redo</button>
        <button id="export" className="btn primary" disabled={busy}
          onClick={async () => { setBusy(true); try { say(await exportLoopWav()); } catch { say('Export failed. Try again.'); } setBusy(false); }}>
          {busy ? 'Rendering…' : inArtifact() ? 'Export loop' : 'Export WAV'}</button>
        <TwoTap id="new-project" label="New" confirm="Tap again: clear everything" onConfirm={() => { engine.stop(); engine.stopPreview(); dispatch('project.reset'); say('Everything is cleared. Undo brings it all back. Save to the Library first if you want to keep a copy.'); }} />
        <button id="library" className="btn" onClick={() => openSheet('library')}>Library</button>
        <button id="assistant" className={chat ? 'btn on' : 'btn'} aria-pressed={chat} onClick={toggleChat}>Assistant</button>
        <button id="guide" className="btn" onClick={() => openSheet('guide')}>Guide</button>
        <span className="meta" title="Output delay reported by the browser">
          {lat !== null ? `${lat} ms` : ''}{saveState === 'off' ? ' · not saving' : saveState === 'saving' ? ' · saving' : ' · saved'}
        </span>
      </div>
    </header>
  );
}

function ChopBar({ p, tool, setTool, say, switcher }: { p: Project; tool: Tool; setTool: (t: Tool) => void; say: (m: string | null) => void; switcher: React.ReactNode }) {
  const file = useRef<HTMLInputElement>(null);
  const [sens, setSens] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const s = p.samples.find((x) => x.id === p.activeSampleId);
  const slices = s ? s.markers.length + 1 : 0;
  const room = TOTAL_PADS - bankOf(p.selectedPad) * PAD_COUNT; // pads from the bank on screen to the last bank
  return (
    <div className="chopbar">
      {switcher}
      <div className="group">
        <input ref={file} id="file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            setBusy(true); say(await importFile(f)); setBusy(false);
          }} />
        <button id="import" className="btn primary" disabled={busy} onClick={() => file.current?.click()}>{busy ? 'Reading…' : 'Import audio'}</button>
        {p.samples.length > 0 && (
          <select id="sample" aria-label="Sample" value={p.activeSampleId ?? ''} onChange={(e) => dispatch('sample.select', { id: e.target.value })}>
            {p.samples.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
        {s?.bpm && <button className="btn" title="Set the project tempo to this sample's detected tempo"
          onClick={() => dispatch('project.setBpm', { bpm: s.bpm })}>Use {s.bpm} BPM</button>}
        {s && <PreviewButton id={s.id} />}
        {s && <button id="save-sample" className="btn" onClick={async () => say(await saveSampleToLibrary(s.id))}>Save to library</button>}
        {s && <TwoTap id="remove-sample" label="Remove sample" confirm="Tap again to remove" onConfirm={() => { engine.stopPreview(); dispatch('sample.remove', { id: s.id }); say(`"${s.name}" removed, and any pads using it were emptied. Undo brings it back.`); }} />}
      </div>
      {s && (
        <>
          <div className="group">
            <div className="seg" role="radiogroup" aria-label="Waveform tool">
              {([['play', 'Audition'], ['add', 'Add cut'], ['remove', 'Remove cut']] as [Tool, string][]).map(([t, label]) => (
                <button key={t} role="radio" aria-checked={tool === t} className={tool === t ? 'btn on' : 'btn'} onClick={() => setTool(t)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="group">
            <button id="autoslice" className="btn" onClick={() => autoSlice(s.id, sens)}>Auto-slice</button>
            <input id="sens" type="range" aria-label="Auto-slice sensitivity" min={0} max={1} step={0.05} value={sens}
              onChange={(e) => { const v = Number(e.target.value); setSens(v); autoSlice(s.id, v); }} />
            <button className="btn" onClick={() => gridSlice(s.id, 8)}>÷8</button>
            <button className="btn" onClick={() => gridSlice(s.id, 16)}>÷16</button>
            <button className="btn" disabled={!s.markers.length} onClick={() => dispatch('sample.setMarkers', { id: s.id, markers: [] })}>Clear cuts</button>
          </div>
          <div className="group end">
            <span className="meta">{slices} {slices === 1 ? 'slice' : 'slices'}{slices > room ? ` · first ${room} fit from bank ${BANK_NAMES[bankOf(p.selectedPad)]}` : slices > PAD_COUNT ? ' · spills into the next bank' : ''}</span>
            <button id="topads" className="btn primary" onClick={() => dispatch('pads.assignSlices', { sampleId: s.id })}>Send to pads</button>
          </div>
        </>
      )}
    </div>
  );
}

const KEYS = ['z', 'x', 'c', 'v', 'a', 's', 'd', 'f', 'q', 'w', 'e', 'r', '1', '2', '3', '4'];

function Pads({ p }: { p: Project }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    engine.onPadFire = (i, delay) => {
      setTimeout(() => {
        const el = refs.current[i];
        if (!el) return;
        el.classList.add('lit');
        setTimeout(() => el.classList.remove('lit'), 110);
      }, delay * 1000);
    };
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Never steal keys from anything the user is typing or choosing in (the assistant box, BPM, menus).
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || el?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName ?? '')) return;
      if (e.key === ' ') { e.preventDefault(); engine.playing ? engine.stop() : engine.play(); return; }
      const i = KEYS.indexOf(e.key.toLowerCase());
      if (i >= 0) { const pad = bankOf(getProject().selectedPad) * PAD_COUNT + i; engine.hitPad(pad); dispatch('pad.select', { pad }); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); engine.onPadFire = () => {}; };
  }, []);
  // MPC order: pad 1 bottom-left, pad 16 top-right.
  const order = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
  const bank = bankOf(p.selectedPad);
  return (
    <div className="padwrap">
    <div className="banks" role="radiogroup" aria-label="Pad bank">
      {Array.from({ length: BANK_COUNT }, (_, b) => {
        const used = p.pads.slice(b * PAD_COUNT, (b + 1) * PAD_COUNT).filter((x) => x.sampleId).length;
        return (
          <button key={b} id={`bank-${b}`} role="radio" aria-checked={bank === b} className={`btn bank${bank === b ? ' on' : ''}${used ? ' used' : ''}`}
            aria-label={`Bank ${BANK_NAMES[b]}, ${used} of ${PAD_COUNT} pads loaded`} onClick={() => dispatch('bank.select', { bank: b })}>{BANK_NAMES[b]}</button>
        );
      })}
    </div>
    <div className="pads">
      {order.map((local) => {
        const i = bank * PAD_COUNT + local;
        const pad = p.pads[i];
        return (
          <button key={i} ref={(el) => { refs.current[i] = el; }} id={`pad-${local}`}
            className={`pad${pad.sampleId ? ' loaded' : ''}${p.selectedPad === i ? ' sel' : ''}`}
            style={{ ['--hue' as any]: padHue(local) }}
            aria-label={`Pad ${padLabel(i)}${pad.sampleId ? '' : ', empty'}`}
            onPointerDown={(e) => { e.preventDefault(); engine.hitPad(i); dispatch('pad.select', { pad: i }); }}>
            <span>{padLabel(i)}</span>
          </button>
        );
      })}
    </div>
    </div>
  );
}

function Steps({ p }: { p: Project }) {
  const cur = useTick(() => (engine.playing ? Math.floor(engine.position() / STEP_TICKS) % 16 : -1));
  const i = p.selectedPad, pad = p.pads[i];
  const recorded = p.events.filter((e) => e.pad === i).length;
  return (
    <div className="panel">
      <p className="panel-title">Pad {padLabel(i)} pattern{!pad.sampleId && <em> · empty pad, send a slice to it first</em>}</p>
      <div className="steps" style={{ ['--hue' as any]: padHue(i % PAD_COUNT) }}>
        {pad.steps.map((v, s) => (
          <button key={s} id={`step-${s}`} aria-label={`Step ${s + 1} ${v > 0 ? (v < 1 ? 'soft' : 'on') : 'off'}`}
            className={`step${v >= 1 ? ' on' : v > 0 ? ' soft' : ''}${cur === s ? ' cur' : ''}${s % 4 === 0 ? ' beat' : ''}`}
            onClick={() => dispatch('seq.setStep', { pad: i, step: s, vel: v === 0 ? 1 : v >= 1 ? 0.5 : 0 })}>{s + 1}</button>
        ))}
      </div>
      <p className="hint">Tap a step: on, soft, off.</p>
      <label className="slider">Swing <span>{Math.round(p.swing * 100)}%</span>
        <input id="swing" type="range" min={0} max={0.6} step={0.02} value={p.swing} onChange={(e) => dispatch('project.setSwing', { swing: Number(e.target.value) }, { group: 'swing' })} /></label>
      <div className="row">
        <button className="btn" disabled={!pad.steps.some((v) => v > 0)} onClick={() => dispatch('seq.setRow', { pad: i, steps: [] })}>Clear steps</button>
        <button className="btn" disabled={!recorded} onClick={() => dispatch('loop.clearPad', { pad: i })}>Erase {recorded} recorded {recorded === 1 ? 'hit' : 'hits'}</button>
        <button className="btn" disabled={!p.events.length} onClick={() => dispatch('loop.clear')}>Erase all recorded</button>
      </div>
    </div>
  );
}

function PadEdit({ p, say }: { p: Project; say: (m: string | null) => void }) {
  const i = p.selectedPad, pad = p.pads[i];
  const s = p.samples.find((x) => x.id === pad.sampleId);
  if (!s) return <div className="panel"><p className="panel-title">Pad {padLabel(i)} is empty</p><p className="hint">Slice a sample and press Send to pads.</p></div>;
  const set = (patch: object, group: string) => dispatch('pad.set', { pad: i, ...patch }, { group: `${group}-${i}` });
  const b = sliceBounds(s);
  const slice = b.findIndex((v, k) => k < b.length - 1 && Math.abs(v - pad.start) < 0.001 && Math.abs(b[k + 1] - pad.end) < 0.001);
  return (
    <div className="panel">
      <p className="panel-title">Pad {padLabel(i)} · {s.name} · {(pad.end - pad.start).toFixed(2)} s</p>
      <label className="slider">Volume <span>{Math.round(pad.gain * 100)}%</span>
        <input id="pad-gain" type="range" min={0} max={1.5} step={0.01} value={pad.gain} onChange={(e) => set({ gain: Number(e.target.value) }, 'gain')} /></label>
      <label className="slider">Pitch <span>{pad.semitones > 0 ? '+' : ''}{pad.semitones} st</span>
        <input id="pad-pitch" type="range" min={-12} max={12} step={1} value={pad.semitones} onChange={(e) => set({ semitones: Number(e.target.value) }, 'pitch')} /></label>
      <div className="row">
        <button id="pad-reverse" className={pad.reverse ? 'btn on' : 'btn'} aria-pressed={pad.reverse} onClick={() => set({ reverse: !pad.reverse }, 'rev')}>Reverse</button>
        <button className="btn" disabled={slice <= 0}
          onClick={() => dispatch('pad.assign', { pad: i, sampleId: s.id, start: b[slice - 1], end: b[slice] })}>◀ Slice</button>
        <button className="btn" disabled={slice < 0 || slice >= b.length - 2}
          onClick={() => dispatch('pad.assign', { pad: i, sampleId: s.id, start: b[slice + 1], end: b[slice + 2] })}>Slice ▶</button>
        <button id="save-pad" className="btn" onClick={async () => say(await savePadToLibrary(i))}>Save to library</button>
        <button className="btn danger" onClick={() => dispatch('pad.clear', { pad: i })}>Clear pad</button>
      </div>
      <p className="hint">Pitch changes speed too, like a classic sampler.</p>
    </div>
  );
}

const FILTERS: [FilterType, string][] = [['off', 'Off'], ['lowpass', 'Low-pass'], ['highpass', 'High-pass'], ['bandpass', 'Band-pass']];
// Cutoff slider is logarithmic: 0..1 maps to 40 Hz..16 kHz.
const hzOf = (x: number) => 40 * Math.pow(400, x);
const posOf = (hz: number) => Math.log(hz / 40) / Math.log(400);

function FxEdit({ p, say }: { p: Project; say: (m: string | null) => void }) {
  const i = p.selectedPad, pad = p.pads[i], fx = pad.fx;
  const [busy, setBusy] = useState(false);
  if (!pad.sampleId) return <div className="panel"><p className="panel-title">Pad {padLabel(i)} is empty</p><p className="hint">Effects apply to a pad's sound. Send a slice to this pad first.</p></div>;
  const set = (patch: Partial<PadFx>, key: string) => dispatch('pad.setFx', { pad: i, fx: patch }, { group: `fx-${key}-${i}` });
  const hit = () => engine.hitPad(i);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const natural = (pad.end - pad.start) / Math.pow(2, pad.semitones / 12); // seconds the slice lasts unstretched
  return (
    <div className="panel">
      <p className="panel-title">Pad {padLabel(i)} effects</p>
      <div className="fx-row">
        <span className="fx-name">Filter</span>
        <div className="seg" role="radiogroup" aria-label="Filter type">
          {FILTERS.map(([t, label]) => <button key={t} id={`fx-filter-${t}`} role="radio" aria-checked={fx.filter === t} className={fx.filter === t ? 'btn small on' : 'btn small'} onClick={() => { set({ filter: t }, 'filter'); }}>{label}</button>)}
        </div>
      </div>
      {fx.filter !== 'off' && (
        <div className="fx-pair">
          <label className="slider">Cutoff <span>{fx.cutoff >= 1000 ? `${(fx.cutoff / 1000).toFixed(1)} kHz` : `${Math.round(fx.cutoff)} Hz`}</span>
            <input id="fx-cutoff" type="range" min={0} max={1} step={0.005} value={posOf(fx.cutoff)} onChange={(e) => set({ cutoff: hzOf(Number(e.target.value)) }, 'cutoff')} /></label>
          <label className="slider">Resonance <span>{pct(fx.resonance)}</span>
            <input id="fx-res" type="range" min={0} max={1} step={0.01} value={fx.resonance} onChange={(e) => set({ resonance: Number(e.target.value) }, 'res')} /></label>
        </div>
      )}
      <label className="slider">Drive <span>{pct(fx.drive)}</span>
        <input id="fx-drive" type="range" min={0} max={1} step={0.01} value={fx.drive} onChange={(e) => set({ drive: Number(e.target.value) }, 'drive')} /></label>
      <label className="slider">Echo <span>{fx.delayMix > 0 ? pct(fx.delayMix) : 'Off'}</span>
        <input id="fx-delay" type="range" min={0} max={1} step={0.01} value={fx.delayMix} onChange={(e) => set({ delayMix: Number(e.target.value) }, 'delay')} /></label>
      {fx.delayMix > 0 && (
        <div className="fx-pair">
          <div className="fx-row">
            <span className="fx-name">Time</span>
            <div className="seg" role="radiogroup" aria-label="Echo time">
              {(Object.keys(DELAY_TIMES) as (keyof typeof DELAY_TIMES)[]).map((t) => <button key={t} id={`fx-time-${t.replace('/', '-')}`} role="radio" aria-checked={fx.delayTime === t} className={fx.delayTime === t ? 'btn small on' : 'btn small'} onClick={() => set({ delayTime: t }, 'time')}>{t === '1/8d' ? '1/8 dot' : t}</button>)}
            </div>
          </div>
          <label className="slider">Repeats <span>{pct(fx.delayFeedback / 0.85)}</span>
            <input id="fx-feedback" type="range" min={0} max={0.85} step={0.01} value={fx.delayFeedback} onChange={(e) => set({ delayFeedback: Number(e.target.value) }, 'fb')} /></label>
        </div>
      )}
      <label className="slider">Reverb <span>{fx.reverb > 0 ? pct(fx.reverb) : 'Off'}</span>
        <input id="fx-reverb" type="range" min={0} max={1} step={0.01} value={fx.reverb} onChange={(e) => set({ reverb: Number(e.target.value) }, 'reverb')} /></label>
      {fx.reverb > 0 && (
        <div className="fx-row">
          <span className="fx-name">Space</span>
          <div className="seg" role="radiogroup" aria-label="Reverb size">
            {(Object.keys(REVERBS) as (keyof typeof REVERBS)[]).map((r) => <button key={r} id={`fx-space-${r}`} role="radio" aria-checked={fx.reverbSize === r} className={fx.reverbSize === r ? 'btn small on' : 'btn small'} onClick={() => set({ reverbSize: r }, 'space')}>{r[0].toUpperCase() + r.slice(1)}</button>)}
          </div>
        </div>
      )}
      <div className="fx-row">
        <span className="fx-name">Stretch</span>
        <div className="seg" role="radiogroup" aria-label="Stretch: length without changing pitch">
          {[0.5, 1, 1.5, 2, 4].map((v) => <button key={v} id={`fx-stretch-${String(v).replace('.', '_')}`} role="radio" aria-checked={Math.abs(fx.stretch - v) < 0.001} className={Math.abs(fx.stretch - v) < 0.001 ? 'btn small on' : 'btn small'} onClick={() => set({ stretch: v }, 'stretch')}>{v === 1 ? 'Off' : `×${v}`}</button>)}
        </div>
        <span className="fx-name">Fit to</span>
        <div className="seg" role="group" aria-label="Stretch the slice to a musical length">
          {([[1, '1/4'], [2, '1/2'], [4, 'Bar'], [8, '2 bars']] as [number, string][]).map(([beats, label]) => {
            const s = ((beats * 60) / p.bpm) / natural;
            return <button key={beats} id={`fx-fit-${beats}`} className="btn small" disabled={s < STRETCH_MIN || s > STRETCH_MAX} title={`${s.toFixed(2)}× at ${p.bpm} BPM`} onClick={() => set({ stretch: s }, 'stretch')}>{label}</button>;
          })}
        </div>
        {isGranular(fx) && <span className="meta">{fx.stretch.toFixed(2)}× · {(natural * fx.stretch).toFixed(2)} s</span>}
      </div>
      <div className="fx-pair">
        <label className="slider">Scatter <span>{fx.scatter > 0 ? pct(fx.scatter) : 'Off'}</span>
          <input id="fx-scatter" type="range" min={0} max={1} step={0.01} value={fx.scatter} onChange={(e) => set({ scatter: Number(e.target.value) }, 'scatter')} /></label>
        {isGranular(fx) && (
          <label className="slider">Grain size <span>{Math.round(fx.grain)} ms</span>
            <input id="fx-grain" type="range" min={20} max={200} step={1} value={fx.grain} onChange={(e) => set({ grain: Number(e.target.value) }, 'grain')} /></label>
        )}
      </div>
      <div className="fx-row">
        <span className="fx-name">Stutter</span>
        <div className="seg" role="radiogroup" aria-label="Stutter">
          {STUTTERS.map((n) => <button key={n} id={`fx-stutter-${n}`} role="radio" aria-checked={fx.stutter === n} className={fx.stutter === n ? 'btn small on' : 'btn small'} onClick={() => set({ stutter: n }, 'stutter')}>{n === 1 ? 'Off' : `×${n}`}</button>)}
        </div>
      </div>
      <div className="row">
        <button id="fx-hear" className="btn" onClick={hit}>Hear it</button>
        <button id="fx-reset" className="btn" disabled={!fxActive(fx)} onClick={() => dispatch('pad.resetFx', { pad: i })}>Remove effects</button>
        <button id="fx-resample" className="btn primary" disabled={busy}
          onClick={async () => { setBusy(true); try { say(await resamplePad(i)); } catch { say('Resampling failed. Try again.'); } setBusy(false); }}>{busy ? 'Rendering…' : 'Resample'}</button>
      </div>
      <p className="hint">Resample prints this pad with its pitch and effects into a new sample, so you can chop it again or stack more effects on top.</p>
    </div>
  );
}

function ViewSwitch({ view, setView }: { view: 'chop' | 'roll'; setView: (v: 'chop' | 'roll') => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Top view">
      <button id="view-chop" role="radio" aria-checked={view === 'chop'} className={view === 'chop' ? 'btn on' : 'btn'} onClick={() => setView('chop')}>Chop</button>
      <button id="view-roll" role="radio" aria-checked={view === 'roll'} className={view === 'roll' ? 'btn on' : 'btn'} onClick={() => setView('roll')}>Piano roll</button>
    </div>
  );
}

const LENGTHS: [number, string][] = [[STEP_TICKS, '1/16'], [STEP_TICKS * 2, '1/8'], [PPQ, '1/4'], [PPQ * 2, '1/2'], [BAR_TICKS, 'Bar']];

function RollBar({ p, say, noteLen, setNoteLen, switcher }: { p: Project; say: (m: string | null) => void; noteLen: number; setNoteLen: (n: number) => void; switcher: React.ReactNode }) {
  const file = useRef<HTMLInputElement>(null);
  const [devices, setDevices] = useState<string[] | null>(null);
  const count = p.notes.filter((n) => n.pad === p.selectedPad).length;
  const connect = async () => {
    try {
      await connectMidi({ hitPad: (i, v) => { engine.hitPad(i, v); dispatch('pad.select', { pad: i }); }, noteOn: (k, pad, pitch, v) => engine.noteOn(k, pad, pitch, v), noteOff: (k) => engine.noteOff(k) }, setDevices);
    } catch { say('This browser or page does not allow MIDI devices here.'); }
  };
  return (
    <div className="chopbar">
      {switcher}
      <div className="group">
        <span className="meta">Pad {padLabel(p.selectedPad)} · {count} {count === 1 ? 'note' : 'notes'}</span>
        <label className="field">Scale
          <select id="scale" value={p.scale} onChange={(e) => dispatch('project.setScale', { scale: e.target.value as ScaleName })}>
            {Object.keys(SCALES).map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select></label>
        <label className="field" title="The note name given to the pad's own pitch">Pad is
          <select id="root" value={p.root} onChange={(e) => dispatch('project.setScale', { root: Number(e.target.value) })}>
            {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select></label>
      </div>
      <div className="group">
        <span className="meta">Length</span>
        <div className="seg" role="radiogroup" aria-label="New note length">
          {LENGTHS.map(([t, label]) => <button key={t} id={`len-${t}`} role="radio" aria-checked={noteLen === t} className={noteLen === t ? 'btn on' : 'btn'} onClick={() => setNoteLen(t)}>{label}</button>)}
        </div>
      </div>
      <div className="group end">
        <button id="clear-notes" className="btn" disabled={!count} onClick={() => dispatch('notes.clearPad', { pad: p.selectedPad })}>Clear notes</button>
        <input ref={file} id="midi-file" type="file" accept=".mid,.midi,audio/midi" hidden
          onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) say(await importMidi(f)); }} />
        <button id="import-midi" className="btn" onClick={() => file.current?.click()}>Import MIDI</button>
        <button id="export-midi" className="btn" onClick={async () => say(await exportMidi())}>Export MIDI</button>
        {midiSupported() && (devices === null
          ? <button id="connect-midi" className="btn" onClick={connect}>Connect keyboard</button>
          : <span className="meta">{devices.length ? devices.join(', ') : 'No MIDI device found'}</span>)}
      </div>
    </div>
  );
}

/** The page behind a tab whose tool is not built yet: what it will do, where it is in the queue, and what works today. */
function Planned({ id, back }: { id: string; back: () => void }) {
  const m = MODULES.find((x) => x.id === id)!;
  return (
    <section className="planned">
      <div className="planned-card">
        <p className="planned-tag">Not built yet · number {m.order} in the build order</p>
        <h2>{m.name}</h2>
        <p className="planned-what">{m.what}</p>
        <h3>What it will do</h3>
        <ul>{m.will!.map((w) => <li key={w}>{w}</li>)}</ul>
        {m.needs && (<><h3>What it needs</h3><p>{m.needs}</p></>)}
        <h3>What you can do today</h3>
        <p>{m.today}</p>
        <button className="btn primary" onClick={back}>Back to the Sampler</button>
      </div>
    </section>
  );
}

/** Plays the whole sample shown in the chop view, from the start, with a moving line on the waveform. */
function PreviewButton({ id }: { id: string }) {
  const playing = useTick(() => engine.previewPosition() !== null && engine.preview?.sampleId === id);
  return (
    <button id="preview" className={playing ? 'btn on' : 'btn'} aria-pressed={playing}
      onClick={() => (playing ? engine.stopPreview() : engine.previewSample(id, 0))}>{playing ? '■ Stop' : '▶ Play sample'}</button>
  );
}

/** A button that needs a second tap within a few seconds, for anything that clears work. */
function TwoTap({ id, label, confirm, onConfirm }: { id: string; label: string; confirm: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3500); return () => clearTimeout(t); }, [armed]);
  return <button id={id} className={armed ? 'btn danger armed' : 'btn'} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>{armed ? confirm : label}</button>;
}
