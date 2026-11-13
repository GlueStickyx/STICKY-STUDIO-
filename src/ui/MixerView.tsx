// Mixer: one channel strip per pad bank (A-D) and a master. Faders are vertical, like a desk.
import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { dispatch } from '../core/bus';
import { BANK_NAMES, PAD_COUNT } from '../core/types';
import type { Project } from '../core/types';

const db = (v: number) => (v <= 0.0001 ? '−∞' : `${(20 * Math.log10(v)).toFixed(1)}`);
const STRIP_HUES = [330, 30, 150, 215];

export function MixerView({ p }: { p: Project }) {
  const meters = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => { // meters follow the audio, with a short fall-off so peaks are readable
    let raf = 0;
    const held = [0, 0, 0, 0, 0];
    const loop = () => {
      engine.levels().forEach((v, i) => {
        held[i] = Math.max(v, held[i] * 0.92);
        const el = meters.current[i];
        if (el) { el.style.setProperty('--level', String(Math.min(1, held[i]))); el.classList.toggle('clip', held[i] >= 0.99); }
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const set = (channel: number, patch: object, key: string) => dispatch('mix.set', { channel, ...patch }, { group: `mix-${key}-${channel}` });

  return (
    <section className="mixer">
      <div className="chopbar">
        <p className="hint">Each strip is one bank of pads: everything on bank A, wherever it plays (Sampler, Clips or Arrange), goes through strip A. The mixer is included in every export except single pads saved to the Library.</p>
        <button id="mix-reset" className="btn" onClick={() => dispatch('mix.reset')}>Reset mixer</button>
      </div>
      <div className="strips">
        {p.mixer.channels.map((c, i) => {
          const loaded = p.pads.slice(i * PAD_COUNT, (i + 1) * PAD_COUNT).filter((x) => x.sampleId).length;
          return (
            <div key={i} className="strip panel" style={{ ['--hue' as any]: STRIP_HUES[i] }}>
              <div className="strip-name">Bank {BANK_NAMES[i]}<span className="meta">{loaded} {loaded === 1 ? 'pad' : 'pads'}</span></div>
              {([['high', 'High'], ['mid', 'Mid'], ['low', 'Low']] as const).map(([k, label]) => (
                <label key={k} className="slider eq">{label} <span>{c[k] > 0 ? '+' : ''}{c[k].toFixed(1)} dB</span>
                  <input id={`eq-${k}-${i}`} type="range" min={-12} max={12} step={0.5} value={c[k]} onChange={(e) => set(i, { [k]: Number(e.target.value) }, k)} onDoubleClick={() => set(i, { [k]: 0 }, k)} /></label>
              ))}
              <label className="slider">Pan <span>{c.pan === 0 ? 'Centre' : c.pan < 0 ? `${Math.round(-c.pan * 100)}% L` : `${Math.round(c.pan * 100)}% R`}</span>
                <input id={`pan-${i}`} type="range" min={-1} max={1} step={0.02} value={c.pan} onChange={(e) => set(i, { pan: Number(e.target.value) }, 'pan')} onDoubleClick={() => set(i, { pan: 0 }, 'pan')} /></label>
              <div className="strip-fader">
                <input id={`fader-${i}`} className="vfader" type="range" min={0} max={1.5} step={0.01} value={c.vol} aria-label={`Bank ${BANK_NAMES[i]} level`} onChange={(e) => set(i, { vol: Number(e.target.value) }, 'vol')} onDoubleClick={() => set(i, { vol: 1 }, 'vol')} />
                <div className="meter" ref={(el) => { meters.current[i] = el; }} aria-hidden="true" />
              </div>
              <span className="strip-db">{db(c.vol)} dB</span>
              <div className="row strip-ms">
                <button id={`mix-mute-${i}`} className={c.mute ? 'btn on' : 'btn'} aria-pressed={c.mute} onClick={() => set(i, { mute: !c.mute }, 'mute')}>Mute</button>
                <button id={`mix-solo-${i}`} className={c.solo ? 'btn on' : 'btn'} aria-pressed={c.solo} onClick={() => set(i, { solo: !c.solo }, 'solo')}>Solo</button>
              </div>
            </div>
          );
        })}
        <div className="strip panel master">
          <div className="strip-name">Master<span className="meta">everything</span></div>
          <p className="hint">Red at the top of the meter means too loud. Pull faders down until the master only touches the yellow.</p>
          <div className="strip-fader">
            <input id="fader-master" className="vfader" type="range" min={0} max={1.5} step={0.01} value={p.mixer.master} aria-label="Master level" onChange={(e) => dispatch('mix.master', { vol: Number(e.target.value) }, { group: 'mix-master' })} onDoubleClick={() => dispatch('mix.master', { vol: 1 })} />
            <div className="meter" ref={(el) => { meters.current[4] = el; }} aria-hidden="true" />
          </div>
          <span className="strip-db">{db(p.mixer.master)} dB</span>
        </div>
      </div>
    </section>
  );
}
