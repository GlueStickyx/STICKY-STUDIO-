import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { engine } from '../audio/engine';
import { canRedo, canUndo, dispatch, getProject, redo, subscribe, undo } from '../core/bus';
import { loopTicks } from '../core/sequence';
import { BAR_TICKS, PPQ, STEP_TICKS, sliceBounds } from '../core/types';
import type { Project } from '../core/types';
import { autoSlice, boot, exportLoopWav, gridSlice, importFile, onSaveState, saveState } from './actions';
import { padHue } from './colors';
import { Chat } from './Chat';
import { Waveform } from './Waveform';
import type { Tool } from './Waveform';

const useProject = () => useSyncExternalStore(subscribe, getProject);
function useTick<T>(read: () => T): T {
  // Re-read a fast-changing engine value every animation frame.
  const [v, setV] = useState(read);
  useEffect(() => {
    let raf = 0;
    const loop = () => { setV(read()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line
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
  const [panel, setPanel] = useState<'steps' | 'pad'>('steps');
  const [msg, setMsg] = useState<string | null>(null);
  const [chat, setChat] = useState(false);
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
      <Transport p={p} say={setMsg} chat={chat} toggleChat={() => setChat(!chat)} />
      {msg && <div className="toast" role="status" onClick={() => setMsg(null)}>{msg}</div>}
      <section className="chop">
        <ChopBar p={p} tool={tool} setTool={setTool} say={setMsg} />
        {sample ? <Waveform sample={sample} project={p} tool={tool} />
          : <div className="empty">Import a WAV or MP3 to start chopping.</div>}
      </section>
      <section className="perform">
        <Pads p={p} />
        <div className="side">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={panel === 'steps'} className={panel === 'steps' ? 'tab on' : 'tab'} onClick={() => setPanel('steps')}>Steps</button>
            <button role="tab" aria-selected={panel === 'pad'} className={panel === 'pad' ? 'tab on' : 'tab'} onClick={() => setPanel('pad')}>Pad {p.selectedPad + 1}</button>
          </div>
          {panel === 'steps' ? <Steps p={p} /> : <PadEdit p={p} />}
        </div>
      </section>
    </div>
  );
}

function Transport({ p, say, chat, toggleChat }: { p: Project; say: (m: string | null) => void; chat: boolean; toggleChat: () => void }) {
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
        <button id="rec" className={engine.recording ? 'btn icon rec on' : 'btn icon rec'} aria-label="Record pad hits" aria-pressed={engine.recording}
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
          onClick={async () => { setBusy(true); try { await exportLoopWav(); say('Loop saved as a WAV file.'); } catch { say('Export failed. Try again.'); } setBusy(false); }}>
          {busy ? 'Rendering…' : 'Export WAV'}</button>
        <button id="assistant" className={chat ? 'btn on' : 'btn'} aria-pressed={chat} onClick={toggleChat}>Assistant</button>
        <span className="meta" title="Output delay reported by the browser">
          {lat !== null ? `${lat} ms` : ''}{saveState === 'off' ? ' · not saving' : saveState === 'saving' ? ' · saving' : ' · saved'}
        </span>
      </div>
    </header>
  );
}

function ChopBar({ p, tool, setTool, say }: { p: Project; tool: Tool; setTool: (t: Tool) => void; say: (m: string | null) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [sens, setSens] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const s = p.samples.find((x) => x.id === p.activeSampleId);
  const slices = s ? s.markers.length + 1 : 0;
  return (
    <div className="chopbar">
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
            <span className="meta">{slices} {slices === 1 ? 'slice' : 'slices'}{slices > 16 ? ' · first 16 go to pads' : ''}</span>
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
      if (e.repeat || e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      if (e.key === ' ') { e.preventDefault(); engine.playing ? engine.stop() : engine.play(); return; }
      const i = KEYS.indexOf(e.key.toLowerCase());
      if (i >= 0) { engine.hitPad(i); dispatch('pad.select', { pad: i }); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); engine.onPadFire = () => {}; };
  }, []);
  // MPC order: pad 1 bottom-left, pad 16 top-right.
  const order = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
  return (
    <div className="pads">
      {order.map((i) => {
        const pad = p.pads[i];
        return (
          <button key={i} ref={(el) => { refs.current[i] = el; }} id={`pad-${i}`}
            className={`pad${pad.sampleId ? ' loaded' : ''}${p.selectedPad === i ? ' sel' : ''}`}
            style={{ ['--hue' as any]: padHue(i) }}
            aria-label={`Pad ${i + 1}${pad.sampleId ? '' : ', empty'}`}
            onPointerDown={(e) => { e.preventDefault(); engine.hitPad(i); dispatch('pad.select', { pad: i }); }}>
            <span>{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

function Steps({ p }: { p: Project }) {
  const cur = useTick(() => (engine.playing ? Math.floor(engine.position() / STEP_TICKS) % 16 : -1));
  const i = p.selectedPad, pad = p.pads[i];
  const recorded = p.events.filter((e) => e.pad === i).length;
  return (
    <div className="panel">
      <p className="panel-title">Pad {i + 1} pattern{!pad.sampleId && <em> · empty pad, send a slice to it first</em>}</p>
      <div className="steps" style={{ ['--hue' as any]: padHue(i) }}>
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

function PadEdit({ p }: { p: Project }) {
  const i = p.selectedPad, pad = p.pads[i];
  const s = p.samples.find((x) => x.id === pad.sampleId);
  if (!s) return <div className="panel"><p className="panel-title">Pad {i + 1} is empty</p><p className="hint">Slice a sample and press Send to pads.</p></div>;
  const set = (patch: object, group: string) => dispatch('pad.set', { pad: i, ...patch }, { group: `${group}-${i}` });
  const b = sliceBounds(s);
  const slice = b.findIndex((v, k) => k < b.length - 1 && Math.abs(v - pad.start) < 0.001 && Math.abs(b[k + 1] - pad.end) < 0.001);
  return (
    <div className="panel">
      <p className="panel-title">Pad {i + 1} · {s.name} · {(pad.end - pad.start).toFixed(2)} s</p>
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
        <button className="btn danger" onClick={() => dispatch('pad.clear', { pad: i })}>Clear pad</button>
      </div>
      <p className="hint">Pitch changes speed too, like a classic sampler.</p>
    </div>
  );
}
