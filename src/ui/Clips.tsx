// Clips: saved loops on four tracks, launched in time with each other. One clip plays per track.
import { useEffect, useState } from 'react';
import { engine } from '../audio/engine';
import { dispatch } from '../core/bus';
import { TRACK_COUNT, uid } from '../core/types';
import type { Project } from '../core/types';

const TRACK_HUES = [330, 30, 150, 215];

export function Clips({ p, say, toSampler }: { p: Project; say: (m: string | null) => void; toSampler: () => void }) {
  const [state, setState] = useState(() => engine.clipState());
  const [menu, setMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => { // follow what is playing and what is waiting for the bar line
    let raf = 0;
    const loop = () => { const s = engine.clipState(); setState((old) => (JSON.stringify(old) === JSON.stringify(s) ? old : s)); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const hasLoop = p.pads.some((pad) => pad.sampleId && pad.steps.some((v) => v > 0)) || p.events.length > 0 || p.notes.length > 0;
  const save = (track: number) => {
    if (!hasLoop) { say('The Sampler loop is empty. Make a pattern there first, then save it here.'); return; }
    dispatch('clip.saveFromLoop', { id: uid(), track, name: `Clip ${p.clips.length + 1}` });
  };

  return (
    <section className="clips">
      <p className="hint clips-help">Each column is a track. Save the loop you made in the Sampler as a clip, then tap clips to launch them: they start together on the next bar. One clip plays per track.</p>
      <div className="clip-tracks">
        {Array.from({ length: TRACK_COUNT }, (_, t) => {
          const track = p.tracks[t];
          const mine = p.clips.filter((c) => c.track === t);
          return (
            <div key={t} className="clip-track panel" style={{ ['--hue' as any]: TRACK_HUES[t] }}>
              <div className="clip-head">
                <strong>Track {t + 1}</strong>
                <div className="group">
                  <button id={`mute-${t}`} className={track.mute ? 'btn small on' : 'btn small'} aria-pressed={track.mute} aria-label={`Mute track ${t + 1}`} onClick={() => dispatch('track.set', { track: t, mute: !track.mute })}>M</button>
                  <button id={`solo-${t}`} className={track.solo ? 'btn small on' : 'btn small'} aria-pressed={track.solo} aria-label={`Solo track ${t + 1}`} onClick={() => dispatch('track.set', { track: t, solo: !track.solo })}>S</button>
                  <button id={`stop-${t}`} className="btn small" disabled={!state.playing[t] && !state.queued[t]} aria-label={`Stop track ${t + 1}`} onClick={() => engine.launch(t, null)}>■</button>
                </div>
              </div>
              <label className="slider">Volume <span>{Math.round(track.vol * 100)}%</span>
                <input id={`vol-${t}`} type="range" min={0} max={1.5} step={0.01} value={track.vol} onChange={(e) => dispatch('track.set', { track: t, vol: Number(e.target.value) })} /></label>
              <div className="clip-list">
                {mine.map((c) => {
                  const playing = state.playing[t] === c.id, queued = state.queued[t] === c.id, stopping = playing && state.queued[t] === '';
                  return (
                    <div key={c.id} className="clip-cell">
                      {renaming === c.id ? (
                        <form className="clip-rename" onSubmit={(e) => { e.preventDefault(); dispatch('clip.rename', { id: c.id, name: new FormData(e.currentTarget).get('name') }); setRenaming(null); }}>
                          <input className="text" name="name" aria-label="Clip name" defaultValue={c.name} autoFocus />
                          <button className="btn small primary" type="submit">Save</button>
                        </form>
                      ) : (
                        <button className={`clip${playing ? ' playing' : ''}${queued ? ' queued' : ''}${stopping ? ' stopping' : ''}`} data-clip={c.id}
                          aria-label={`${c.name}, ${c.bars} ${c.bars === 1 ? 'bar' : 'bars'}${playing ? ', playing' : queued ? ', starts on the next bar' : ''}`}
                          onClick={() => engine.launch(t, playing && !stopping ? null : c.id)}>
                          <span className="clip-name">{playing ? '▶ ' : queued ? '… ' : ''}{c.name}</span>
                          <span className="meta">{c.bars} {c.bars === 1 ? 'bar' : 'bars'}</span>
                        </button>
                      )}
                      <button className="btn small" aria-label={`Options for ${c.name}`} aria-expanded={menu === c.id} onClick={() => setMenu(menu === c.id ? null : c.id)}>⋯</button>
                      {menu === c.id && (
                        <div className="clip-menu">
                          <button className="btn small" onClick={() => { engine.setMode('loop'); dispatch('clip.loadToLoop', { id: c.id }); setMenu(null); toSampler(); say(`"${c.name}" is in the Sampler for editing. Save it as a new clip when you are done.`); }}>Edit in Sampler</button>
                          <button className="btn small" onClick={() => { setRenaming(c.id); setMenu(null); }}>Rename</button>
                          <button className="btn small danger" onClick={() => { if (confirm === c.id) { if (playing) engine.launch(t, null); dispatch('clip.remove', { id: c.id }); setConfirm(null); setMenu(null); } else setConfirm(c.id); }}>{confirm === c.id ? 'Tap again to delete' : 'Delete'}</button>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button id={`save-clip-${t}`} className="btn clip-add" onClick={() => save(t)}>+ Save Sampler loop here</button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
