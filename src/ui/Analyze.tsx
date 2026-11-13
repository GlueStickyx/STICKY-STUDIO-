// Analyze: suggested loops, hits and voice-like lines from a whole song, to audition and send to pads.
import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { PEAK_BUCKET } from '../audio/analysis';
import { analyseTrack } from '../audio/trackanalysis';
import type { TrackAnalysis } from '../audio/trackanalysis';
import { dispatch, getProject } from '../core/bus';
import { BANK_NAMES, PAD_COUNT, padLabel, uid } from '../core/types';
import type { Project } from '../core/types';
import { importFile, monoOf } from './actions';

type Kind = 'loop' | 'hit' | 'voice';
interface Item { key: string; kind: Kind; start: number; end: number; title: string; detail: string }
const KIND_HUE: Record<Kind, number> = { loop: 200, hit: 30, voice: 320 };
const results = new Map<string, TrackAnalysis>(); // kept while the page is open in this session
const t = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

export function Analyze({ p, say }: { p: Project; say: (m: string | null) => void }) {
  const [sampleId, setSampleId] = useState<string | null>(p.activeSampleId);
  const [res, setRes] = useState<TrackAnalysis | null>(() => (p.activeSampleId ? results.get(p.activeSampleId) ?? null : null));
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bank, setBank] = useState(1);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sample = p.samples.find((s) => s.id === sampleId) ?? null;

  useEffect(() => { if (!sample && p.samples.length) setSampleId(p.samples[p.samples.length - 1].id); }, [p.samples, sample]);
  useEffect(() => { setRes(sampleId ? results.get(sampleId) ?? null : null); setPicked(new Set()); }, [sampleId]);

  const items = useMemo<Item[]>(() => !res ? [] : [
    ...res.loops.map((l, i) => ({ key: `l${i}`, kind: 'loop' as Kind, start: l.start, end: l.end, title: `${l.bars}-bar loop`, detail: `${t(l.start)} · repeats ${Math.round(l.score * 100)}% cleanly` })),
    ...res.hits.map((h, i) => ({ key: `h${i}`, kind: 'hit' as Kind, start: h.start, end: h.end, title: h.label[0].toUpperCase() + h.label.slice(1), detail: `${t(h.start)} · ${Math.round((h.end - h.start) * 1000)} ms` })),
    ...res.voice.map((v, i) => ({ key: `v${i}`, kind: 'voice' as Kind, start: v.start, end: v.end, title: `Vocal or lead line`, detail: `${t(v.start)} · ${(v.end - v.start).toFixed(1)} s · around ${v.pitchHz} Hz` })),
  ], [res]);

  useEffect(() => { // overview: the waveform with every suggestion marked on it
    const c = canvas.current;
    if (!c || !sample) return;
    const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const x = (sec: number) => (sec / sample.duration) * w;
    for (const it of items) {
      const lane = it.kind === 'loop' ? 0 : it.kind === 'voice' ? 1 : 2;
      g.fillStyle = `hsl(${KIND_HUE[it.kind]} 90% 60% / ${picked.has(it.key) ? 0.9 : 0.45})`;
      g.fillRect(x(it.start), lane * (h / 3), Math.max(2, x(it.end) - x(it.start)), h / 3 - 2);
    }
    const peaks = engine.peaks.get(sample.id);
    if (peaks) {
      g.fillStyle = 'hsl(220 10% 85% / 0.8)';
      const per = (sample.duration * sample.sampleRate) / PEAK_BUCKET / w;
      for (let px = 0; px < w; px++) {
        let lo = 0, hi = 0;
        for (let b = Math.floor(px * per); b < (px + 1) * per && b * 2 + 1 < peaks.length; b++) { lo = Math.min(lo, peaks[b * 2]); hi = Math.max(hi, peaks[b * 2 + 1]); }
        g.fillRect(px, h / 2 - hi * h * 0.45, 1, Math.max(1, (hi - lo) * h * 0.45));
      }
    }
  }, [items, picked, sample]);

  const run = async () => {
    const m = sampleId ? monoOf(sampleId) : null;
    if (!m || !sampleId) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, 30)); // let the button show "Analysing…" before the work starts
    const a = analyseTrack(m.mono, m.sampleRate);
    results.set(sampleId, a);
    setRes(a);
    setPicked(new Set([...a.hits.slice(0, 8).map((_, i) => `h${i}`), ...a.loops.slice(0, 4).map((_, i) => `l${i}`), ...a.voice.slice(0, 4).map((_, i) => `v${i}`)]));
    setBusy(false);
    say(`Found ${a.loops.length} loops, ${a.hits.length} hits and ${a.voice.length} vocal or lead lines${a.analysedSeconds < (sample?.duration ?? 0) - 1 ? ' in the first six minutes' : ''}.`);
  };
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const hear = (it: Item) => { if (!sampleId) return; engine.audition(sampleId, it.start, it.end); setPlayingKey(it.key); setTimeout(() => setPlayingKey((k) => (k === it.key ? null : k)), (it.end - it.start) * 1000); };
  const send = () => {
    const chosen = items.filter((it) => picked.has(it.key));
    const first = bank * PAD_COUNT;
    const n = Math.min(chosen.length, PAD_COUNT);
    if (!sampleId || !n) return;
    const group = 'analyze-' + uid();
    chosen.slice(0, n).forEach((it, i) => {
      dispatch('pad.assign', { pad: first + i, sampleId, start: it.start, end: it.end }, { group, sticky: true });
      dispatch('pad.set', { pad: first + i, semitones: 0, reverse: false, gain: 1 }, { group, sticky: true });
      dispatch('pad.resetFx', { pad: first + i }, { group, sticky: true });
    });
    dispatch('pad.select', { pad: first });
    say(`${n} ${n === 1 ? 'suggestion is' : 'suggestions are'} on pads ${padLabel(first)} to ${padLabel(first + n - 1)}${chosen.length > n ? `; ${chosen.length - n} more did not fit in one bank` : ''}. Open the Sampler to play them. One Undo takes them off again.`);
  };
  const bankUsed = getProject().pads.slice(bank * PAD_COUNT, (bank + 1) * PAD_COUNT).filter((x) => x.sampleId).length;

  return (
    <section className="analyze">
      <div className="chopbar">
        <input ref={file} id="an-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" hidden
          onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setBusy(true); const err = await importFile(f); setBusy(false); if (err) say(err); else setSampleId(getProject().activeSampleId); }} />
        <button id="an-import" className="btn" disabled={busy} onClick={() => file.current?.click()}>Import a song</button>
        {p.samples.length > 0 && (
          <select id="an-sample" aria-label="Song to analyse" value={sampleId ?? ''} onChange={(e) => setSampleId(e.target.value)}>
            {p.samples.map((s) => <option key={s.id} value={s.id}>{s.name} ({Math.round(s.duration)} s)</option>)}
          </select>
        )}
        <button id="an-run" className="btn primary" disabled={!sample || busy} onClick={run}>{busy ? 'Analysing…' : res ? 'Analyse again' : 'Analyse'}</button>
        {res?.bpm && <button className="btn" onClick={() => dispatch('project.setBpm', { bpm: res.bpm })}>Use {res.bpm} BPM</button>}
      </div>
      {!res ? (
        <div className="planned"><div className="planned-card">
          <h2>Analyze</h2>
          <p className="planned-what">Pick a whole song and tap Analyse. You get suggestions in three groups, each with a play button:</p>
          <ul><li><b>Loops</b>: 1, 2 or 4 bars that repeat cleanly, counted from the beat.</li><li><b>Hits</b>: the strongest single drum hits, labelled kick, snare or hat by their tone.</li><li><b>Vocal or lead lines</b>: stretches where a steady pitch holds, which is usually singing or a lead melody.</li></ul>
          <p>Tick the ones you like and send them to a bank of pads. The vocal finder measures pitch, not words, so it can also catch a lead synth. Audition before you keep.</p>
        </div></div>
      ) : (
        <>
          <div className="an-overview">
            <canvas ref={canvas} aria-label="The song, with suggestions marked: loops on the top row, vocal or lead lines in the middle, hits at the bottom" />
          </div>
          <div className="an-cols">
            {(['loop', 'hit', 'voice'] as Kind[]).map((kind) => {
              const list = items.filter((it) => it.kind === kind);
              return (
                <div key={kind} className="panel an-col" style={{ ['--hue' as any]: KIND_HUE[kind] }}>
                  <p className="panel-title">{kind === 'loop' ? 'Loops' : kind === 'hit' ? 'Hits' : 'Vocal or lead lines'} <span className="meta">({list.length})</span></p>
                  {list.length === 0 && <p className="hint">{kind === 'loop' ? 'No clean repeating bars found. Very free or changing music has few.' : kind === 'voice' ? 'No steady pitched lines found.' : 'No clear hits found.'}</p>}
                  {list.map((it) => (
                    <div key={it.key} className={picked.has(it.key) ? 'an-item on' : 'an-item'}>
                      <button className={playingKey === it.key ? 'btn icon on' : 'btn icon'} aria-label={`Play ${it.title} at ${t(it.start)}`} onClick={() => hear(it)}>▶</button>
                      <label className="an-check"><input type="checkbox" checked={picked.has(it.key)} onChange={() => toggle(it.key)} /><span><b>{it.title}</b><span className="meta">{it.detail}</span></span></label>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="chopbar an-send">
            <span className="meta">{picked.size} ticked</span>
            <button className="btn small" onClick={() => setPicked(new Set(items.map((i) => i.key)))}>Tick all</button>
            <button className="btn small" disabled={!picked.size} onClick={() => setPicked(new Set())}>Untick all</button>
            <div className="group end">
              <label className="field">Send to bank
                <select id="an-bank" value={bank} onChange={(e) => setBank(Number(e.target.value))}>
                  {BANK_NAMES.split('').map((b, i) => <option key={b} value={i}>{b}</option>)}
                </select></label>
              {bankUsed > 0 && <span className="meta">replaces {bankUsed} loaded {bankUsed === 1 ? 'pad' : 'pads'}</span>}
              <button id="an-send" className="btn primary" disabled={!picked.size} onClick={send}>Send to pads</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
