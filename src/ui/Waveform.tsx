// Chop view: the waveform of the active sample, with draggable slice markers. Drawn on a canvas for speed.
import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { PEAK_BUCKET } from '../audio/analysis';
import { dispatch } from '../core/bus';
import { PAD_COUNT, TOTAL_PADS, bankOf, padLabel, sliceBounds } from '../core/types';
import type { Project, Sample } from '../core/types';
import { padHue } from './colors';

export type Tool = 'play' | 'add' | 'remove';
const GRAB_PX = 22; // how close a finger must be to grab a marker

export function Waveform({ sample, project, tool }: { sample: Sample; project: Project; tool: Tool }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 150 });
  const [view, setView] = useState({ start: 0, end: sample.duration });
  const [drag, setDrag] = useState<{ index: number; time: number } | null>(null);
  const [flash, setFlash] = useState<number | null>(null);

  useEffect(() => { setView({ start: 0, end: sample.duration }); }, [sample.id, sample.duration]);
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const span = view.end - view.start;
  const xOf = (t: number) => ((t - view.start) / span) * size.w;
  const tOf = (x: number) => view.start + (x / size.w) * span;
  const markers = drag ? sample.markers.map((t, i) => (i === drag.index ? drag.time : t)) : sample.markers;

  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    const peaks = engine.peaks.get(sample.id);
    const bounds = [0, ...[...markers].sort((a, b) => a - b), sample.duration];
    const mid = size.h / 2;
    const firstPad = bankOf(project.selectedPad) * PAD_COUNT; // where Send to pads would start
    const fits = (s: number) => firstPad + s < TOTAL_PADS;
    // Each slice gets the colour of the pad it will land on.
    for (let s = 0; s < bounds.length - 1; s++) {
      const x0 = Math.max(0, xOf(bounds[s])), x1 = Math.min(size.w, xOf(bounds[s + 1]));
      if (x1 <= 0 || x0 >= size.w) continue;
      const hue = padHue(s % 16);
      g.fillStyle = `hsl(${hue} 60% 50% / ${flash === s ? 0.28 : s % 2 ? 0.07 : 0.12})`;
      g.fillRect(x0, 0, x1 - x0, size.h);
      if (!peaks) continue;
      g.fillStyle = fits(s) ? `hsl(${hue} 90% 66%)` : 'hsl(220 8% 55%)';
      const perPx = (span * sample.sampleRate) / PEAK_BUCKET / size.w;
      for (let x = Math.floor(x0); x < x1; x++) {
        const b0 = Math.floor((tOf(x) * sample.sampleRate) / PEAK_BUCKET);
        const b1 = Math.max(b0 + 1, Math.floor(b0 + perPx));
        let lo = 1, hi = -1;
        for (let b = b0; b < b1 && b * 2 + 1 < peaks.length; b++) { if (peaks[b * 2] < lo) lo = peaks[b * 2]; if (peaks[b * 2 + 1] > hi) hi = peaks[b * 2 + 1]; }
        if (hi < lo) continue;
        const y0 = mid - hi * mid * 0.92, y1 = mid - lo * mid * 0.92;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
      if (fits(s) && x1 - x0 > 22) { g.font = '600 11px system-ui, sans-serif'; g.fillStyle = `hsl(${hue} 90% 78%)`; g.fillText(padLabel(firstPad + s), Math.max(x0, 0) + 5, size.h - 7); }
    }
    markers.forEach((t, i) => {
      const x = xOf(t);
      if (x < -10 || x > size.w + 10) return;
      const active = drag?.index === i;
      g.fillStyle = active ? '#fff' : 'hsl(48 100% 62%)';
      g.fillRect(x - (active ? 1 : 0.5), 0, active ? 2 : 1, size.h);
      g.beginPath(); g.moveTo(x - 7, 0); g.lineTo(x + 7, 0); g.lineTo(x + 7, 9); g.lineTo(x, 17); g.lineTo(x - 7, 9); g.closePath(); g.fill();
    });
  }, [sample, size, view, markers, flash, drag, project.selectedPad]); // eslint-disable-line

  const nearest = (x: number) => {
    let best = -1, d = GRAB_PX;
    sample.markers.forEach((t, i) => { const dx = Math.abs(xOf(t) - x); if (dx < d) { d = dx; best = i; } });
    return best;
  };
  const localX = (e: React.PointerEvent) => e.clientX - canvas.current!.getBoundingClientRect().left;

  const down = (e: React.PointerEvent) => {
    const x = localX(e), t = tOf(x), hit = nearest(x);
    if (tool === 'remove') { if (hit >= 0) dispatch('sample.removeMarker', { id: sample.id, index: hit }); return; }
    if (hit >= 0) { canvas.current!.setPointerCapture(e.pointerId); setDrag({ index: hit, time: sample.markers[hit] }); return; }
    if (tool === 'add') { dispatch('sample.addMarker', { id: sample.id, time: t }); return; }
    const b = sliceBounds(sample);
    const s = Math.max(0, b.findIndex((v, i) => i < b.length - 1 && t >= v && t < b[i + 1]));
    engine.audition(sample.id, b[s], b[s + 1]);
    setFlash(s); setTimeout(() => setFlash(null), 160);
  };
  const move = (e: React.PointerEvent) => { if (drag) setDrag({ index: drag.index, time: Math.min(sample.duration, Math.max(0, tOf(localX(e)))) }); };
  const up = () => { if (drag) { dispatch('sample.moveMarker', { id: sample.id, index: drag.index, time: drag.time }); setDrag(null); } };

  const zoom = (f: number) => {
    const c = (view.start + view.end) / 2, half = Math.min(sample.duration, Math.max(0.05, span * f)) / 2;
    let s = c - half, en = c + half;
    if (s < 0) { en -= s; s = 0; }
    if (en > sample.duration) { s = Math.max(0, s - (en - sample.duration)); en = sample.duration; }
    setView({ start: s, end: en });
  };
  const zoomed = span < sample.duration - 0.001;

  return (
    <div className="wave">
      <div className="wave-canvas" ref={wrap}>
        <canvas ref={canvas} style={{ width: size.w, height: size.h }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        <div className="wave-zoom">
          <button className="btn icon" aria-label="Zoom out" disabled={!zoomed} onClick={() => zoom(2)}>−</button>
          <button className="btn icon" aria-label="Zoom in" onClick={() => zoom(0.5)}>+</button>
        </div>
      </div>
      {zoomed && (
        <input id="wave-scroll" className="wave-scroll" type="range" aria-label="Scroll waveform" min={0} max={sample.duration - span} step={span / 200}
          value={view.start} onChange={(e) => { const s = Number(e.target.value); setView({ start: s, end: s + span }); }} />
      )}
    </div>
  );
}
