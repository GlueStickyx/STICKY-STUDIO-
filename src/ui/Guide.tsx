// The Guide: annotated pictures of every part of the studio, plus step-by-step workflows.
// Text lives in src/guide/guide.json; pictures and marker positions are generated from the running app by
// `npm run guide`, so they always match the real screen.
import { useState } from 'react';
import guide from '../guide/guide.json';
import marksJson from '../guide/marks.json';

interface Shot { w: number; h: number; pts: ({ x: number; y: number } | null)[] }
const marks = marksJson as Record<string, Shot>;
const images = import.meta.glob('../guide/shots/*.jpg', { eager: true, import: 'default' }) as Record<string, string>;
const imageOf = (id: string) => images[`../guide/shots/${id}.jpg`];

const PAGES = [{ id: 'start', title: 'Start here' }, ...guide.sections.map((s) => ({ id: s.id, title: s.title })), { id: 'shortcuts', title: 'Keyboard' }];

export function Guide({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState('start');
  const [hot, setHot] = useState<number | null>(null);
  const section = guide.sections.find((s) => s.id === page);
  const go = (id: string) => { setPage(id); setHot(null); };
  return (
    <div className="sheet" role="dialog" aria-label="Guide">
      <div className="sheet-head">
        <h2>Guide</h2>
        <span className="meta" style={{ flex: 1 }}>Pictures of every control, and how to use them</span>
        <button id="guide-close" className="btn" onClick={onClose}>Close</button>
      </div>
      <div className="guide">
        <nav className="guide-nav" aria-label="Guide pages">
          {PAGES.map((p) => <button key={p.id} id={`guide-${p.id}`} className={page === p.id ? 'btn on' : 'btn'} aria-current={page === p.id ? 'page' : undefined} onClick={() => go(p.id)}>{p.title}</button>)}
        </nav>
        <div className="guide-page" key={page}>
          {page === 'start' && (
            <>
              <h3>How the studio is laid out</h3>
              <p>Three areas, top to bottom: the <b>top bar</b> (play, tempo, export), the <b>work area</b> (chop audio, or write notes in the piano roll), and the <b>pads</b> with their Steps, Pad and FX tabs. Everything you do is saved as you go and can be undone.</p>
              <p>Pick a page on the left for a labelled picture of each area. Or follow one of these from start to finish:</p>
              <div className="flows">
                {guide.workflows.map((w) => (
                  <section key={w.title} className="flow">
                    <h4>{w.title}</h4>
                    <ol>{w.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                  </section>
                ))}
              </div>
            </>
          )}
          {section && (
            <>
              <h3>{section.title}</h3>
              <p>{section.intro}</p>
              {imageOf(section.id) && marks[section.id] && (
                <div className="shot-wrap">
                  <div className="shot" style={{ aspectRatio: `${marks[section.id].w} / ${marks[section.id].h}`, maxWidth: marks[section.id].w, minWidth: Math.min(520, marks[section.id].w) }}>
                    <img src={imageOf(section.id)} alt={`The ${section.title} area of the studio, with numbered markers`} />
                    {marks[section.id].pts.map((pt, i) => pt && (
                      <button key={i} className={hot === i ? 'mark hot' : 'mark'} style={{ left: `${pt.x}%`, top: `${pt.y}%` }}
                        aria-label={`${i + 1}: ${section.marks[i].name}`} onClick={() => { setHot(i); document.getElementById(`mark-${i}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }}>{i + 1}</button>
                    ))}
                  </div>
                </div>
              )}
              <ol className="mark-list">
                {section.marks.map((m, i) => (
                  <li key={i} id={`mark-${i}`} className={hot === i ? 'hot' : ''} onClick={() => setHot(i)}>
                    <span className="mark static">{i + 1}</span>
                    <div><b>{m.name}</b><p>{m.text}</p></div>
                  </li>
                ))}
              </ol>
              {'notes' in section && (section.notes as string[]).map((n, i) => <p key={i} className="guide-note">{n}</p>)}
            </>
          )}
          {page === 'shortcuts' && (
            <>
              <h3>Keyboard</h3>
              <p>For a PC or a tablet with a keyboard attached. The keys are switched off while you type in a text box.</p>
              <table className="keys"><tbody>
                {guide.shortcuts.map(([k, what]) => <tr key={k}><td>{k.split(' ').map((x, i) => (x === '+' ? ' + ' : <kbd key={i}>{x}</kbd>))}</td><td>{what}</td></tr>)}
              </tbody></table>
              <p className="guide-note">The pad keys follow the pad layout: the bottom row of keys is the bottom row of pads.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
