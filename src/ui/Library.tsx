// The library: sounds and projects kept in this browser across sessions, outside any one project.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getProject, subscribe } from '../core/bus';
import { padLabel } from '../core/types';
import {
  downloadSound, listProjects, listSounds, loadSound, onLibraryChange, openProject, previewSound, removeProject, removeSound,
  saveLoopToLibrary, saveProjectAs, stopPreview, updateSound, uploadToLibrary,
} from './actions';
import type { LibrarySound, SavedProject } from './actions';

const fmt = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : `${sec.toFixed(1)} s`);

export function Library({ onClose, say }: { onClose: () => void; say: (m: string | null) => void }) {
  const p = useSyncExternalStore(subscribe, getProject);
  const [tab, setTab] = useState<'sounds' | 'projects'>('sounds');
  const [sounds, setSounds] = useState<LibrarySound[] | null>(null);
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [query, setQuery] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null); // id awaiting a second tap
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const refresh = async () => { setSounds(await listSounds()); setProjects(await listProjects()); };
    refresh();
    const off = onLibraryChange(refresh);
    return () => { off(); stopPreview(); };
  }, []);
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(null), 3500); return () => clearTimeout(t); }, [confirm]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sounds ?? []).filter((s) => !q || s.name.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)));
  }, [sounds, query]);
  const tags = useMemo(() => [...new Set((sounds ?? []).flatMap((s) => s.tags))].sort(), [sounds]);
  const run = async (f: () => Promise<string>) => { setBusy(true); try { say(await f()); } catch { say('That did not work. Try again.'); } setBusy(false); };
  const toggle = (s: LibrarySound) => {
    if (playing === s.id) { stopPreview(); setPlaying(null); return; }
    setPlaying(s.id);
    previewSound(s, () => setPlaying((cur) => (cur === s.id ? null : cur)));
  };

  return (
    <div className="sheet" role="dialog" aria-label="Library">
      <div className="sheet-head">
        <h2>Library</h2>
        <div className="tabs" role="tablist">
          <button id="lib-tab-sounds" role="tab" aria-selected={tab === 'sounds'} className={tab === 'sounds' ? 'tab on' : 'tab'} onClick={() => setTab('sounds')}>Sounds{sounds ? ` (${sounds.length})` : ''}</button>
          <button id="lib-tab-projects" role="tab" aria-selected={tab === 'projects'} className={tab === 'projects' ? 'tab on' : 'tab'} onClick={() => setTab('projects')}>Projects ({projects.length})</button>
        </div>
        <button id="lib-close" className="btn" onClick={onClose}>Close</button>
      </div>

      {tab === 'sounds' ? (
        <div className="sheet-body">
          <div className="chopbar">
            <input ref={file} id="lib-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" multiple hidden
              onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) run(() => uploadToLibrary(fs)); }} />
            <button id="lib-upload" className="btn primary" disabled={busy} onClick={() => file.current?.click()}>{busy ? 'Working…' : 'Add audio files'}</button>
            <button id="lib-save-loop" className="btn" disabled={busy} onClick={() => run(saveLoopToLibrary)}>Save current loop</button>
            <input id="lib-search" className="text" type="search" placeholder="Search names and tags" value={query} onChange={(e) => setQuery(e.target.value)} />
            {tags.map((t) => <button key={t} className={query === t ? 'btn small on' : 'btn small'} onClick={() => setQuery(query === t ? '' : t)}>{t}</button>)}
          </div>
          {sounds === null ? <p className="hint">Loading…</p> : shown.length === 0 ? (
            <div className="empty lib-empty">
              {sounds.length === 0
                ? <p>Nothing saved yet. Add audio files here, or use “Save to library” in the chop view and on a pad. Sounds stay in this browser between sessions and can go into any project.</p>
                : <p>No sounds match “{query}”.</p>}
            </div>
          ) : (
            <ul className="lib-list">
              {shown.map((s) => (
                <li key={s.id} className="lib-row">
                  <button className={playing === s.id ? 'btn icon on' : 'btn icon'} aria-label={playing === s.id ? `Stop ${s.name}` : `Play ${s.name}`} onClick={() => toggle(s)}>{playing === s.id ? '■' : '▶'}</button>
                  <div className="lib-info">
                    {editing === s.id ? (
                      <form className="lib-edit" onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        const nm = String(f.get('name') ?? '').trim() || s.name;
                        const tg = String(f.get('tags') ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
                        updateSound({ ...s, name: nm, tags: [...new Set(tg)] });
                        setEditing(null);
                      }}>
                        <input className="text" name="name" aria-label="Name" defaultValue={s.name} autoFocus />
                        <input className="text" name="tags" aria-label="Tags, separated by commas" placeholder="tags, separated by commas" defaultValue={s.tags.join(', ')} />
                        <button className="btn small primary" type="submit">Save</button>
                        <button className="btn small" type="button" onClick={() => setEditing(null)}>Cancel</button>
                      </form>
                    ) : (
                      <>
                        <span className="lib-name">{s.name}</span>
                        <span className="meta">{fmt(s.duration)}{s.bpm ? ` · ${s.bpm} BPM` : ''}{s.tags.length ? ` · ${s.tags.join(', ')}` : ''}</span>
                      </>
                    )}
                  </div>
                  {editing !== s.id && (
                    <div className="lib-actions">
                      <button className="btn small" disabled={busy} onClick={() => run(() => loadSound(s))}>To chop view</button>
                      <button className="btn small" disabled={busy} onClick={() => run(() => loadSound(s, p.selectedPad))}>To pad {padLabel(p.selectedPad)}</button>
                      <button className="btn small" onClick={() => setEditing(s.id)}>Rename / tag</button>
                      <button className="btn small" disabled={busy} onClick={() => run(() => downloadSound(s))}>Download</button>
                      <button className="btn small danger" onClick={() => (confirm === s.id ? (removeSound(s.id), setConfirm(null)) : setConfirm(s.id))}>{confirm === s.id ? 'Tap again to delete' : 'Delete'}</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="sheet-body">
          <form className="chopbar" onSubmit={(e) => { e.preventDefault(); run(async () => { const m = await saveProjectAs(name); if (!m.startsWith('Give')) setName(''); return m; }); }}>
            <input id="proj-name" className="text" placeholder="Name for what is on screen now" value={name} onChange={(e) => setName(e.target.value)} />
            <button id="proj-save" className="btn primary" type="submit" disabled={busy || !name.trim()}>Save project</button>
          </form>
          <p className="hint">Saving with a name that already exists updates that project. Opening a project replaces what is on screen, so save first if you want to keep it.</p>
          {projects.length === 0 ? <div className="empty lib-empty"><p>No saved projects yet. The project on screen is always autosaved; save it here under a name to keep it while you start something else.</p></div> : (
            <ul className="lib-list">
              {projects.map((pr) => (
                <li key={pr.id} className="lib-row">
                  <div className="lib-info">
                    <span className="lib-name">{pr.name}</span>
                    <span className="meta">{Math.round(pr.project.bpm)} BPM · {pr.project.bars} {pr.project.bars === 1 ? 'bar' : 'bars'} · {pr.project.samples.length} {pr.project.samples.length === 1 ? 'sample' : 'samples'} · saved {new Date(pr.saved).toLocaleString()}</span>
                  </div>
                  <div className="lib-actions">
                    <button className="btn small primary" disabled={busy} onClick={() => (confirm === 'open-' + pr.id ? (setConfirm(null), run(async () => { const m = await openProject(pr); onClose(); return m; })) : setConfirm('open-' + pr.id))}>{confirm === 'open-' + pr.id ? 'Tap again to replace the screen' : 'Open'}</button>
                    <button className="btn small danger" onClick={() => (confirm === pr.id ? (removeProject(pr.id), setConfirm(null)) : setConfirm(pr.id))}>{confirm === pr.id ? 'Tap again to delete' : 'Delete'}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="hint sheet-foot">The library lives in this browser on this device. Clearing the browser's site data removes it, so download anything you can't afford to lose.</p>
    </div>
  );
}
