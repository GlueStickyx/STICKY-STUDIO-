// Assistant panel: a slide-over sheet with the conversation, key setup, and one-tap undo of the assistant's changes.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Assistant, explainError, getKey, setKey } from '../ai/assistant';
import type { ChatBackend, TurnCallbacks } from '../ai/assistant';
import type { StudioDeps } from '../ai/tools';
import { ViewerAssistant, explainViewerError, inArtifact, useSample } from '../ai/viewer';
import { engine } from '../audio/engine';
import { getProject, lastGroup, subscribe, undo } from '../core/bus';
import { monoOf } from './actions';

interface Item { role: 'user' | 'assistant' | 'error'; text: string; changes: string[]; group?: string }

const STARTERS = [
  'Which pads are kicks, snares and hats?',
  'Build a beat from these pads',
  'Give this pattern more swing and ghost notes',
  'How do I get a less generic sound out of Suno?',
];

export function Chat({ onClose }: { onClose: () => void }) {
  useSyncExternalStore(subscribe, getProject); // re-render when the project changes, so the undo button stays honest
  const deps = useMemo<StudioDeps>(() => ({
    audio: monoOf,
    isPlaying: () => engine.playing,
    setPlaying: (on) => (on ? engine.play() : engine.stop()),
  }), []);
  // Inside a Claude artifact the app answers on the viewer's own account; anywhere else an API key is needed.
  const [mode, setMode] = useState<'checking' | 'viewer' | 'key'>(inArtifact() ? 'checking' : 'key');
  const backend = useRef<ChatBackend>(new Assistant(deps));
  useEffect(() => {
    if (mode !== 'checking') return;
    let live = true;
    useSample().then((sample) => {
      if (!live) return;
      if (sample) { backend.current = new ViewerAssistant(sample, deps); setMode('viewer'); } else setMode('key');
    });
    return () => { live = false; };
  }, []); // eslint-disable-line
  const assistant = { send: (t: string, cb: TurnCallbacks) => backend.current.send(t, cb), stop: () => backend.current.stop(), reset: () => backend.current.reset() };
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [key, setKeyState] = useState(getKey);
  const [keyDraft, setKeyDraft] = useState('');
  const [editKey, setEditKey] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [items]);

  const patchLast = (f: (it: Item) => Item) => setItems((list) => list.map((it, i) => (i === list.length - 1 ? f(it) : it)));

  const send = async (text: string) => {
    text = text.trim();
    if (!text || busy) return;
    setDraft('');
    setBusy(true);
    setItems((l) => [...l, { role: 'user', text, changes: [] }, { role: 'assistant', text: '', changes: [] }]);
    try {
      const r = await assistant.send(text, {
        onText: (d) => patchLast((it) => ({ ...it, text: it.text + d })),
        onChange: (c) => patchLast((it) => ({ ...it, changes: [...it.changes, c] })),
      });
      patchLast((it) => ({ ...it, text: (it.text.trim() + (r.note ? `\n${r.note}` : '')).trim(), group: r.changed ? r.group : undefined }));
    } catch (e) {
      patchLast((it) => ({ ...it, text: it.text.trim() }));
      setItems((l) => [...l.filter((it, i) => !(i === l.length - 1 && !it.text && !it.changes.length)), { role: 'error', text: explainViewerError(e) ?? explainError(e), changes: [] }]);
    }
    setBusy(false);
  };

  const saveKey = () => {
    const k = keyDraft.trim();
    if (!setKey(k)) return;
    setKeyState(k); setKeyDraft(''); setEditKey(false);
  };

  return (
    <aside className="chat" aria-label="Assistant">
      <div className="chat-head">
        <strong>Assistant</strong>
        <div className="group">
          {mode === 'key' && key && <button className="btn small" onClick={() => setEditKey(!editKey)}>Key</button>}
          {items.length > 0 && !busy && <button className="btn small" onClick={() => { assistant.reset(); setItems([]); }}>New chat</button>}
          <button id="chat-close" className="btn small" aria-label="Close assistant" onClick={onClose}>Close</button>
        </div>
      </div>

      {mode === 'checking' ? (
        <p className="hint">Connecting to Claude…</p>
      ) : mode === 'key' && (!key || editKey) ? (
        <div className="chat-key">
          <p>The assistant runs on Claude through your own Anthropic API key. Create one at console.anthropic.com under API keys; usage is billed to that account.</p>
          <label htmlFor="api-key">Anthropic API key</label>
          <input id="api-key" type="password" autoComplete="off" placeholder="sk-ant-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
          <div className="row">
            <button id="save-key" className="btn primary" disabled={!keyDraft.trim()} onClick={saveKey}>Save key</button>
            {key && <button className="btn danger" onClick={() => { setKey(''); setKeyState(''); setEditKey(false); }}>Remove key</button>}
          </div>
          <p className="hint">The key is stored only in this browser on this device and is sent only to Anthropic. Anyone who can use this browser profile can use it, so don't save it on a shared device.</p>
        </div>
      ) : (
        <>
          <div className="chat-log" ref={log}>
            {items.length === 0 && (
              <div className="chat-empty">
                {mode === 'viewer' && <p>Runs on your own Claude account. The first message asks your permission.</p>}
                <p>Ask for a beat, a variation, or advice. It can read your pads and change the studio; every change it makes can be undone in one tap.</p>
                {STARTERS.map((s) => <button key={s} className="btn starter" onClick={() => send(s)}>{s}</button>)}
              </div>
            )}
            {items.map((it, i) => (
              <div key={i} className={`msg ${it.role}`}>
                {it.changes.map((c, k) => <div key={k} className="change">{c}</div>)}
                {it.text || (busy && i === items.length - 1 ? <span className="hint">Thinking…</span> : null)}
                {it.group && it.group === lastGroup() && (
                  <button className="btn small undo-ai" onClick={() => { undo(); patchGroup(setItems, it.group!); }}>Undo these changes</button>
                )}
              </div>
            ))}
          </div>
          <form className="chat-form" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
            <textarea id="chat-input" rows={2} placeholder="Ask the assistant…" value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); } }} />
            {busy ? <button type="button" className="btn" onClick={() => assistant.stop()}>Stop</button>
              : <button id="chat-send" type="submit" className="btn primary" disabled={!draft.trim()}>Send</button>}
          </form>
        </>
      )}
    </aside>
  );
}

function patchGroup(setItems: (f: (l: Item[]) => Item[]) => void, group: string) {
  setItems((l) => l.map((it) => (it.group === group ? { ...it, group: undefined, changes: [...it.changes, 'Undone'] } : it)));
}
