// Piano roll for the selected pad: the pad's sound played at other pitches. Rows are pitches (folded to
// the chosen scale so every row is a right note), columns are 16th notes across the loop.
import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { dispatch } from '../core/bus';
import { loopTicks } from '../core/sequence';
import { BAR_TICKS, NOTE_NAMES, PAD_COUNT, PITCH_MAX, PITCH_MIN, PPQ, STEP_TICKS, inScale, uid } from '../core/types';
import type { Project } from '../core/types';
import { padHue } from './colors';

const LABEL_W = 46;

export function PianoRoll({ p, noteLen }: { p: Project; noteLen: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 200 });
  const [draft, setDraft] = useState<{ tick: number; len: number; pitch: number } | null>(null);
  const pad = p.selectedPad;
  const notes = useMemo(() => p.notes.filter((n) => n.pad === pad), [p.notes, pad]);
  const L = loopTicks(p);

  // Rows, highest first: every pitch in the scale, plus any pitch that already has a note (so nothing is hidden).
  const rows = useMemo(() => {
    const used = new Set(notes.map((n) => n.pitch));
    const out: number[] = [];
    for (let pitch = PITCH_MAX; pitch >= PITCH_MIN; pitch--) if (inScale(pitch, p.scale) || used.has(pitch)) out.push(pitch);
    return out;
  }, [notes, p.scale]);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { // playhead, moved without redrawing the canvas
    let raf = 0;
    const loop = () => {
      const el = head.current;
      if (el) {
        el.hidden = !engine.playing;
        if (engine.playing) el.style.transform = `translateX(${LABEL_W + (engine.position() / L) * (size.w - LABEL_W)}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [L, size.w]);

  const rowH = size.h / rows.length;
  const gridW = size.w - LABEL_W;
  const xOf = (tick: number) => LABEL_W + (tick / L) * gridW;
  const hue = padHue(pad % PAD_COUNT);
  const name = (pitch: number) => `${NOTE_NAMES[(((p.root + pitch) % 12) + 12) % 12]}${pitch === 0 ? ' ●' : ''}`;

  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    rows.forEach((pitch, r) => {
      const y = r * rowH, rootRow = ((pitch % 12) + 12) % 12 === 0;
      g.fillStyle = rootRow ? 'hsl(225 12% 19%)' : inScale(pitch, p.scale) ? (r % 2 ? 'hsl(225 10% 13%)' : 'hsl(225 10% 15%)') : 'hsl(225 8% 10%)';
      g.fillRect(0, y, size.w, rowH);
      g.fillStyle = rootRow ? '#e9eaee' : '#9498a3';
      if (rowH >= 9) { g.font = `600 ${Math.min(12, Math.max(9, rowH - 3))}px system-ui, sans-serif`; g.textBaseline = 'middle'; g.fillText(name(pitch), 6, y + rowH / 2); }
    });
    for (let t = 0; t <= L; t += STEP_TICKS) {
      g.fillStyle = t % BAR_TICKS === 0 ? 'hsl(225 10% 46%)' : t % PPQ === 0 ? 'hsl(225 10% 30%)' : 'hsl(225 10% 21%)';
      g.fillRect(Math.round(xOf(t)), 0, 1, size.h);
    }
    const drawNote = (tick: number, len: number, pitch: number, vel: number, ghost: boolean) => {
      const r = rows.indexOf(pitch);
      if (r < 0) return;
      const x = xOf(tick), w = Math.max(4, (len / L) * gridW - 1);
      g.fillStyle = `hsl(${hue} 90% ${ghost ? 80 : 44 + vel * 22}% / ${ghost ? 0.6 : 1})`;
      g.fillRect(x + 1, r * rowH + 1, w - 1, Math.max(2, rowH - 2));
      g.fillStyle = `hsl(${hue} 95% 86%)`;
      g.fillRect(x + 1, r * rowH + 1, 3, Math.max(2, rowH - 2));
    };
    notes.forEach((n) => drawNote(n.tick, n.len, n.pitch, n.vel, false));
    if (draft) drawNote(draft.tick, draft.len, draft.pitch, 1, true);
  }, [size, rows, notes, draft, p.scale, p.root, L, hue]); // eslint-disable-line

  const at = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, pitch: rows[Math.min(rows.length - 1, Math.max(0, Math.floor(y / rowH)))], tick: ((x - LABEL_W) / gridW) * L };
  };
  const down = (e: React.PointerEvent) => {
    const { x, pitch, tick } = at(e);
    if (x < LABEL_W) { engine.noteOn('audition', pad, pitch); setTimeout(() => engine.noteOff('audition'), 350); return; }
    const hit = notes.find((n) => n.pitch === pitch && tick >= n.tick && tick < n.tick + n.len);
    if (hit) { dispatch('note.remove', { id: hit.id }); return; }
    canvas.current!.setPointerCapture(e.pointerId);
    const start = Math.max(0, Math.min(L - STEP_TICKS, Math.floor(tick / STEP_TICKS) * STEP_TICKS));
    setDraft({ tick: start, len: Math.min(noteLen, L - start), pitch });
    engine.noteOn('audition', pad, pitch);
  };
  const move = (e: React.PointerEvent) => {
    if (!draft) return;
    const end = Math.ceil(at(e).tick / STEP_TICKS) * STEP_TICKS;
    const len = Math.max(Math.min(noteLen, L - draft.tick), Math.min(L, end) - draft.tick); // dragging right stretches it
    if (len !== draft.len) setDraft({ ...draft, len });
  };
  const up = () => {
    engine.noteOff('audition');
    if (!draft) return;
    dispatch('note.add', { note: { id: uid(), pad, tick: draft.tick, len: draft.len, pitch: draft.pitch, vel: 1 } });
    setDraft(null);
  };

  return (
    <div className="roll" ref={wrap}>
      <canvas id="roll" ref={canvas} style={{ width: size.w, height: size.h }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="roll-head" ref={head} hidden />
    </div>
  );
}
