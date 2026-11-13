// Arrange: clips laid out along a bar timeline to make a song. Pick a clip, tap a bar to place it,
// tap a placed block to move, repeat or remove it.
import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { dispatch, getProject } from '../core/bus';
import { placementSpan, songBars } from '../core/sequence';
import { BAR_TICKS, TRACK_COUNT, uid } from '../core/types';
import type { Project } from '../core/types';
import { exportSong } from './actions';

const TRACK_HUES = [330, 30, 150, 215];
const BAR_W = 48; // pixels per bar

export function Arrange({ p, say }: { p: Project; say: (m: string | null) => void }) {
  const [brush, setBrush] = useState<string | null>(p.clips[0]?.id ?? null);
  const [sel, setSel] = useState<string | null>(null);
  const [start, setStart] = useState(0);
  const [busy, setBusy] = useState(false);
  const head = useRef<HTMLDivElement>(null);
  const length = songBars(p);
  const bars = Math.max(16, length + 8);
  const selected = p.arrangement.find((x) => x.id === sel) ?? null;
  const selSpan = selected ? placementSpan(p, selected) : null;
  const selClip = selected ? p.clips.find((c) => c.id === selected.clipId) : null;

  useEffect(() => { engine.songStart = Math.min(start, Math.max(0, length - 1)); }, [start, length]);
  useEffect(() => { if (brush && !p.clips.some((c) => c.id === brush)) setBrush(p.clips[0]?.id ?? null); }, [p.clips, brush]);
  useEffect(() => { // playhead
    let raf = 0;
    const loop = () => {
      const el = head.current;
      if (el) { el.hidden = !engine.playing; if (engine.playing) el.style.transform = `translateX(${(engine.position() / BAR_TICKS) * BAR_W}px)`; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /** Try a change. The command refuses anything that would overlap, so an unchanged project means the spot was taken. */
  const attempt = (cmd: string, args: object, fail: string): boolean => {
    const before = getProject().arrangement;
    dispatch(cmd, args);
    if (getProject().arrangement !== before) return true;
    say(fail);
    return false;
  };
  const place = (bar: number) => {
    const clip = p.clips.find((c) => c.id === brush);
    if (!clip) { say('Pick a clip above first.'); return; }
    const id = uid();
    if (attempt('arr.place', { id, clipId: clip.id, bar }, `Track ${clip.track + 1} already has a clip there. Tap an empty bar, or move the other one.`)) setSel(id);
  };

  if (!p.clips.length) {
    return <section className="planned"><div className="planned-card"><h2>Arrange</h2><p className="planned-what">The timeline is built from clips, and there are none yet.</p><p>Make a pattern in the Sampler, open Clips, and tap “Save Sampler loop here”. Then come back and lay your clips out into a song.</p></div></section>;
  }
  return (
    <section className="arrange">
      <div className="chopbar">
        <span className="meta">Place</span>
        <div className="brushes" role="radiogroup" aria-label="Clip to place">
          {p.clips.map((c) => (
            <button key={c.id} role="radio" aria-checked={brush === c.id} className={brush === c.id ? 'brush on' : 'brush'} style={{ ['--hue' as any]: TRACK_HUES[c.track] }} onClick={() => setBrush(c.id)}>
              {c.name}<span className="meta"> · T{c.track + 1} · {c.bars} {c.bars === 1 ? 'bar' : 'bars'}</span>
            </button>
          ))}
        </div>
        <div className="group end">
          <span className="meta">{length ? `${length} bars · ${Math.round((length * 240) / p.bpm)} s` : 'Empty timeline'}</span>
          <button id="arr-clear" className="btn" disabled={!length} onClick={() => { dispatch('arr.clear'); setSel(null); }}>Clear timeline</button>
          <button id="export-song" className="btn primary" disabled={!length || busy} onClick={async () => { setBusy(true); try { say(await exportSong()); } catch { say('Export failed. Try again.'); } setBusy(false); }}>{busy ? 'Rendering…' : 'Export song'}</button>
        </div>
      </div>
      <div className="chopbar arr-sel">
        {selected && selSpan && selClip ? (
          <>
            <span className="meta"><b>{selClip.name}</b> · bars {selSpan.bar + 1}–{selSpan.end}</span>
            <button id="arr-left" className="btn small" disabled={selSpan.bar === 0} aria-label="Move one bar earlier" onClick={() => attempt('arr.move', { id: selected.id, bar: selSpan.bar - 1 }, 'Another clip is in the way.')}>◀ Move</button>
            <button id="arr-right" className="btn small" aria-label="Move one bar later" onClick={() => attempt('arr.move', { id: selected.id, bar: selSpan.bar + 1 }, 'Another clip is in the way.')}>Move ▶</button>
            <button id="arr-less" className="btn small" disabled={selected.repeats <= 1} onClick={() => dispatch('arr.setRepeats', { id: selected.id, repeats: selected.repeats - 1 })}>− Repeat</button>
            <span className="meta">×{selected.repeats}</span>
            <button id="arr-more" className="btn small" onClick={() => attempt('arr.setRepeats', { id: selected.id, repeats: selected.repeats + 1 }, 'No room to repeat: another clip follows it.')}>+ Repeat</button>
            <button id="arr-remove" className="btn small danger" onClick={() => { dispatch('arr.remove', { id: selected.id }); setSel(null); }}>Remove</button>
          </>
        ) : <span className="hint">Pick a clip above, then tap a bar on the timeline to place it on its track. Tap a placed block to move, repeat or remove it. Tap a bar number to choose where Play starts.</span>}
      </div>
      <div className="timeline-wrap">
        <div className="timeline" style={{ width: 64 + bars * BAR_W }}>
          <div className="tl-row tl-ruler">
            <div className="tl-label">Bar</div>
            <div className="tl-lane">
              {Array.from({ length: bars }, (_, b) => (
                <button key={b} className={`tl-bar${b === start ? ' start' : ''}${b % 4 === 0 ? ' four' : ''}`} style={{ left: b * BAR_W, width: BAR_W }} aria-label={`Start playback from bar ${b + 1}`} aria-pressed={b === start} onClick={() => setStart(b)}>{b + 1}</button>
              ))}
              <div className="tl-head" ref={head} hidden />
            </div>
          </div>
          {Array.from({ length: TRACK_COUNT }, (_, t) => (
            <div key={t} className="tl-row" style={{ ['--hue' as any]: TRACK_HUES[t] }}>
              <div className="tl-label">T{t + 1}</div>
              <div className="tl-lane tl-track" data-track={t} style={{ backgroundSize: `${BAR_W * 4}px 100%, ${BAR_W}px 100%` }}
                onClick={(e) => { if (e.target !== e.currentTarget) return; const r = e.currentTarget.getBoundingClientRect(); place(Math.max(0, Math.floor((e.clientX - r.left) / BAR_W))); }}>
                {p.arrangement.map((pl) => {
                  const s = placementSpan(p, pl), c = p.clips.find((x) => x.id === pl.clipId);
                  if (!s || !c || s.track !== t) return null;
                  return (
                    <button key={pl.id} className={sel === pl.id ? 'tl-block sel' : 'tl-block'} data-placement={pl.id} style={{ left: s.bar * BAR_W, width: (s.end - s.bar) * BAR_W - 2, backgroundSize: `${c.bars * BAR_W}px 100%` }}
                      aria-label={`${c.name}, bars ${s.bar + 1} to ${s.end}`} onClick={() => setSel(pl.id)}>{c.name}{pl.repeats > 1 ? ` ×${pl.repeats}` : ''}</button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
