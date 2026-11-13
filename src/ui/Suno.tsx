// The Suno workspace: a style and lyric builder (works everywhere), and, when the studio is opened in Claude
// with the Suno connector, generation, a queue, the user's Suno library, credits and the upload hand-off.
import { useEffect, useRef, useState } from 'react';
import { useMcp } from '../ai/viewer';
import type { Mcp } from '../ai/viewer';
import { dispatch, getProject } from '../core/bus';
import { PILLARS, sunoStyle } from '../core/types';
import type { PillarId, Project, SunoDraft } from '../core/types';
import { exportLoopWav } from './actions';

const SERVER = 'Suno';
const CHIPS: Record<PillarId, string[]> = {
  era: ['late-90s UK garage', 'early-2000s minimal techno', '1970s Italian library music', '2010s Berlin warehouse', 'lo-fi 1980s cassette demo', 'modern Afro house'],
  key: ['F minor, brooding', 'A minor, hypnotic', 'D Dorian, warm and hopeful', 'E Phrygian, dark and tense', 'C major, bright and simple'],
  tempo: ['124 BPM four-on-the-floor', '128 BPM driving', '140 BPM halftime', '90 BPM swung', '174 BPM rolling breaks'],
  vocal: ['breathy female chopped vocal hooks', 'deep male spoken word', 'pitched-up soul vocal samples', 'whispered close-mic vocals', 'no lead vocal, vocal chops only'],
  instrument: ['detuned saw stabs', 'rubbery 303 acid line', 'warm Rhodes chords', 'plucked marimba', 'distorted bitcrushed synth lead', 'dusty sampled strings'],
  low: ['punchy 909 kick, offbeat open hats', 'rolling sub bass', 'shuffled hi-hats and shakers', 'sidechained bassline', 'live funk drum breaks'],
  mix: ['dry and upfront', 'wide reverb tails', 'tape saturation', 'club-loud master', 'room mics, raw and unpolished', 'stereo delay throws'],
};
const TAGS = ['[Intro]', '[Verse]', '[Pre-Chorus]', '[Chorus]', '[Build]', '[Drop]', '[Breakdown]', '[Bridge]', '[Instrumental]', '[Outro]', '[End]'];

interface Song { id: string; title: string; status: string; song_url?: string; metadata?: { style?: string; duration?: number; model?: string }; error?: string | null }
type Conn = 'checking' | 'none' | 'ready' | 'error';

/** One sentence the user can act on, from a connector failure. */
function explain(e: unknown): string {
  const code = (e as { code?: string })?.code;
  const msg = (e as { message?: string })?.message ?? '';
  if (code === 'needs_reauth') return 'Your Suno connection has expired. Reconnect Suno in claude.ai Settings → Connectors.';
  if (code === 'server_not_connected') return 'Suno is not connected. Add the Suno connector in claude.ai Settings → Connectors.';
  if (code === 'not_in_manifest' || code === 'approval_required') return 'Suno access was not allowed for this page. Allow it from the page\'s permissions to use this section.';
  if (code === 'selection_required') return 'You have more than one Suno connection. Choose one in the prompt claude.ai shows.';
  if (code === 'server_unavailable' || code === 'rate_limited') return 'Suno did not answer in time. Try again in a moment.';
  if (code === 'tool_error') return `Suno refused: ${msg.slice(0, 220)}`;
  return 'Suno is unavailable right now.';
}
const asSongs = (payload: unknown): { items: Song[]; next: string | null } => {
  const p = payload as { items?: Song[]; next_cursor?: string | null } | undefined;
  return { items: Array.isArray(p?.items) ? p!.items : [], next: p?.next_cursor ?? null };
};
const mins = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

export function Suno({ p, say }: { p: Project; say: (m: string | null) => void }) {
  const d = p.suno;
  const set = (patch: Omit<Partial<SunoDraft>, 'pillars'> & { pillars?: Partial<SunoDraft['pillars']> }) => dispatch('suno.set', { patch });
  const style = sunoStyle(d);
  const lyricsBox = useRef<HTMLTextAreaElement>(null);
  const [mcp, setMcp] = useState<Mcp | null>(null);
  const [conn, setConn] = useState<Conn>('checking');
  const [connMsg, setConnMsg] = useState('');
  const [usage, setUsage] = useState<{ credits?: number; models: string[] }>({ models: [] });
  const [confirmGen, setConfirmGen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    useMcp().then(async (m) => {
      if (!live) return;
      if (!m) { setConn('none'); return; }
      setMcp(m);
      try {
        const r = await m.callTool(SERVER, 'account-usage', {});
        const u = r.payload as { allowed_models?: string[]; suno_account?: { credits_remaining?: number } };
        if (!live) return;
        setUsage({ credits: u?.suno_account?.credits_remaining, models: u?.allowed_models ?? [] });
        setConn('ready');
      } catch (e) { if (live) { setConn('error'); setConnMsg(explain(e)); } }
    });
    return () => { live = false; };
  }, []);

  // Poll unfinished jobs every 6 s while this page is open.
  const pending = d.jobs.filter((j) => !['streaming', 'complete', 'error'].includes(j.status)).map((j) => j.id).join(',');
  useEffect(() => {
    if (!mcp || !pending) return;
    const t = setInterval(async () => {
      for (const id of pending.split(',')) {
        try {
          const r = await mcp.callTool(SERVER, 'audio-retrieve', { id }, { cache: false });
          const s = r.payload as Song;
          if (s?.status) dispatch('suno.jobs', { jobs: [{ id, status: s.status, title: s.title || undefined, error: s.error ?? null }] });
        } catch { /* keep the last known state; the next tick tries again */ }
      }
    }, 6000);
    return () => clearInterval(t);
  }, [mcp, pending]);

  const insertTag = (tag: string) => {
    const el = lyricsBox.current, text = d.lyrics;
    const at = el ? el.selectionStart : text.length;
    const before = text.slice(0, at), after = text.slice(at);
    const piece = `${before && !before.endsWith('\n') ? '\n' : ''}${tag}\n`;
    set({ lyrics: (before + piece + after).slice(0, 5000) });
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = before.length + piece.length; } });
  };
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); say(`${what} copied. Paste it into Suno.`); }
    catch { say('Copying is blocked here. Select the text and copy it by hand.'); }
  };

  const generate = async () => {
    if (!mcp) return;
    setBusy(true); setConfirmGen(false);
    const controls: Record<string, number> = {};
    if (d.weirdness !== null) controls.weirdness = d.weirdness;
    if (d.styleInfluence !== null) controls.style_influence = d.styleInfluence;
    if (d.variety !== null) controls.variety = d.variety;
    const input: Record<string, unknown> = { style, instrumental: d.instrumental };
    if (d.title.trim()) input.title = d.title.trim();
    if (!d.instrumental && d.lyrics.trim()) input.lyrics = d.lyrics;
    if (d.negative.trim()) input.negative_style = d.negative.trim();
    if (d.model) input.model = d.model;
    if (d.vocalGender && !d.instrumental) input.vocal_gender = d.vocalGender;
    if (Object.keys(controls).length) input.controls = controls;
    try {
      const r = await mcp.callTool(SERVER, 'audio-create', input, { cache: false });
      const pay = r.payload as Song | Song[] | { clips?: Song[]; items?: Song[] };
      const songs: Song[] = Array.isArray(pay) ? pay : (pay as { clips?: Song[] }).clips ?? (pay as { items?: Song[] }).items ?? ((pay as Song)?.id ? [pay as Song] : []);
      if (!songs.length) { say('Suno accepted the request but sent back no song ids. Check your Suno library in a minute.'); }
      else {
        dispatch('suno.jobs', { jobs: songs.map((s) => ({ id: s.id, title: s.title || d.title || 'Untitled', status: s.status || 'queued', created: Date.now() })) });
        say(`${songs.length} ${songs.length === 1 ? 'song is' : 'songs are'} being made. They appear in the queue as they finish.`);
      }
    } catch (e) { say(explain(e)); }
    setBusy(false);
  };

  return (
    <section className="suno">
      <div className="suno-builder panel">
        <div className="suno-row">
          <input id="suno-title" className="text" placeholder="Song title (optional)" value={d.title} onChange={(e) => set({ title: e.target.value })} aria-label="Song title" />
        </div>
        <p className="panel-title">Style, in seven parts <span className="meta">tap a suggestion to add it, or type your own</span></p>
        <div className="pillars">
          {PILLARS.map(([k, label], i) => (
            <div key={k} className="pillar">
              <label htmlFor={`pillar-${k}`}><span className="pill-n">{i + 1}</span>{label}</label>
              <input id={`pillar-${k}`} className="text" value={d.pillars[k]} onChange={(e) => set({ pillars: { [k]: e.target.value } })} />
              <div className="chips">
                {CHIPS[k].map((c) => <button key={c} className="chip" onClick={() => set({ pillars: { [k]: d.pillars[k] ? `${d.pillars[k]}, ${c}` : c } })}>+ {c}</button>)}
              </div>
            </div>
          ))}
        </div>
        <div className="suno-block">
          <div className="suno-block-head">
            <b>Style sent to Suno</b>
            <span className={style.length > 1000 ? 'meta warn' : 'meta'}>{style.length} / 1000</span>
            {d.styleOverride === null
              ? <button className="btn small" onClick={() => set({ styleOverride: style })}>Edit by hand</button>
              : <button className="btn small" onClick={() => set({ styleOverride: null })}>Rebuild from the seven parts</button>}
            <button id="copy-style" className="btn small" disabled={!style} onClick={() => copy(style, 'Style')}>Copy</button>
          </div>
          {d.styleOverride === null
            ? <p className="suno-style">{style || <span className="hint">Fill in any of the seven parts above and the style appears here.</span>}</p>
            : <textarea id="style-text" className="text area" rows={3} value={d.styleOverride} onChange={(e) => set({ styleOverride: e.target.value })} aria-label="Style text" />}
          <label className="field wide">Keep out of the sound
            <input id="suno-negative" className="text" placeholder="e.g. generic EDM drop, autotune, acoustic guitar" value={d.negative} onChange={(e) => set({ negative: e.target.value })} /></label>
          <p className="hint">Describe sounds, not artists: Suno removes artist names. Use “Keep out” for the stock sounds a take keeps drifting to.</p>
        </div>
        <div className="suno-block">
          <div className="suno-block-head">
            <b>Lyrics</b>
            <label className="check"><input id="suno-instrumental" type="checkbox" checked={d.instrumental} onChange={(e) => set({ instrumental: e.target.checked })} /> Instrumental</label>
            <span className={d.lyrics.length > 4800 ? 'meta warn' : 'meta'}>{d.lyrics.length} / 5000</span>
            <button className="btn small" disabled={!d.lyrics} onClick={() => copy(d.lyrics, 'Lyrics')}>Copy</button>
          </div>
          {!d.instrumental && (
            <>
              <div className="chips">{TAGS.map((t) => <button key={t} className="chip tag" onClick={() => insertTag(t)}>{t}</button>)}</div>
              <textarea id="suno-lyrics" ref={lyricsBox} className="text area" rows={9} placeholder={'[Verse]\nYour words here\n\n[Chorus]\n…'} value={d.lyrics} onChange={(e) => set({ lyrics: e.target.value })} aria-label="Lyrics" />
              <p className="hint">Section tags go on their own line in square brackets. Words in round brackets get sung as ad-libs.</p>
            </>
          )}
        </div>
      </div>

      <div className="suno-side">
        <div className="panel">
          <div className="suno-block-head"><b>Generate</b>{usage.credits !== undefined && <span className="meta">{usage.credits.toLocaleString()} credits left</span>}</div>
          {conn === 'none' && <p className="hint">Generating, your queue and your Suno library work when the studio is opened in Claude with the Suno connector. Here you can still build the style and lyrics and copy them into Suno.</p>}
          {conn === 'checking' && <p className="hint">Connecting to Suno…</p>}
          {conn === 'error' && <p className="warn-text">{connMsg}</p>}
          {conn === 'ready' && (
            <>
              <div className="suno-settings">
                <label className="field">Model
                  <select id="suno-model" value={d.model} onChange={(e) => set({ model: e.target.value })}>
                    <option value="">Plan default</option>
                    {usage.models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select></label>
                {!d.instrumental && (
                  <label className="field">Voice
                    <select id="suno-gender" value={d.vocalGender} onChange={(e) => set({ vocalGender: e.target.value as SunoDraft['vocalGender'] })}>
                      <option value="">Any</option><option value="female">Female</option><option value="male">Male</option>
                    </select></label>
                )}
              </div>
              {([['weirdness', 'Weirdness', 'how far it may stray from the expected'], ['styleInfluence', 'Style strength', 'how tightly it follows your style']] as const).map(([k, label, what]) => (
                <label key={k} className="slider">{label} <span>{d[k] === null ? 'Suno decides' : `${Math.round(d[k]! * 100)}%`}</span>
                  <input id={`suno-${k}`} type="range" min={0} max={1} step={0.05} value={d[k] ?? 0.5} onChange={(e) => set({ [k]: Number(e.target.value) })} />
                  <small className="hint">{what}{d[k] !== null && <> · <button className="link" onClick={() => set({ [k]: null })}>let Suno decide</button></>}</small></label>
              ))}
              <label className="slider">Variety <span>{d.variety === null ? 'Suno decides' : ['Off', 'Normal', 'High', 'Extra', 'Max'][d.variety]}</span>
                <input id="suno-variety" type="range" min={0} max={4} step={1} value={d.variety ?? 1} onChange={(e) => set({ variety: Number(e.target.value) })} />
                <small className="hint">how freely Suno reinterprets your style{d.variety !== null && <> · <button className="link" onClick={() => set({ variety: null })}>let Suno decide</button></>}</small></label>
              {!confirmGen
                ? <button id="suno-generate" className="btn primary big-wide" disabled={busy || !style || style.length > 1000} onClick={() => setConfirmGen(true)}>{busy ? 'Sending…' : 'Generate'}</button>
                : (
                  <div className="confirm">
                    <p>This makes 2 songs and spends Suno credits from your account.</p>
                    <div className="row"><button id="suno-confirm" className="btn primary" onClick={generate}>Make 2 songs</button><button className="btn" onClick={() => setConfirmGen(false)}>Cancel</button></div>
                  </div>
                )}
              {!style && <p className="hint">Add some style first.</p>}
            </>
          )}
        </div>
        {d.jobs.length > 0 && (
          <div className="panel">
            <div className="suno-block-head"><b>Queue</b><span className="meta">updates every few seconds</span></div>
            {d.jobs.map((j) => <SongRow key={j.id} mcp={mcp} song={{ id: j.id, title: j.title, status: j.status, error: j.error }} say={say} onRemove={() => dispatch('suno.jobs', { jobs: [], remove: j.id })} />)}
          </div>
        )}
        {conn === 'ready' && mcp && <LibraryPanel mcp={mcp} say={say} />}
        {conn === 'ready' && mcp && <UploadPanel mcp={mcp} say={say} />}
      </div>
    </section>
  );
}

/** One song with its links. Download asks Suno for a file link; a download credit is only spent after the user agrees. */
function SongRow({ mcp, song, say, onRemove, onUseStyle }: { mcp: Mcp | null; song: Song; say: (m: string | null) => void; onRemove?: () => void; onUseStyle?: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [needsCredit, setNeedsCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = ['streaming', 'complete'].includes(song.status);
  const getLink = async (confirm: boolean) => {
    if (!mcp) return;
    setBusy(true); setNeedsCredit(false);
    try {
      const r = await mcp.callTool(SERVER, 'audio-download', { id: song.id, format: 'wav', ...(confirm ? { confirm: true } : {}) }, { cache: false });
      const pay = r.payload as { url?: string; status?: string };
      if (pay?.url) setLink(pay.url);
      else if (pay?.status === 'requires_credit') setNeedsCredit(true);
      else if (pay?.status === 'processing') say('Suno is still preparing that file. Tap again in a moment.');
      else say('Suno did not return a file link.');
    } catch (e) { say(explain(e)); }
    setBusy(false);
  };
  return (
    <div className="song">
      <div className="song-info">
        <b>{song.title || 'Untitled'}</b>
        <span className="meta">{song.status === 'error' ? `Failed${song.error ? `: ${song.error}` : ''}` : ready ? (song.metadata?.duration ? mins(song.metadata.duration) : 'Ready') : `${song.status}…`}{song.metadata?.style ? ` · ${song.metadata.style.slice(0, 90)}` : ''}</span>
      </div>
      <div className="row">
        {ready && <a className="btn small" href={song.song_url ?? `https://suno.com/song/${song.id}`} target="_blank" rel="noreferrer">Open in Suno</a>}
        {ready && !link && !needsCredit && <button className="btn small" disabled={busy || !mcp} onClick={() => getLink(false)}>{busy ? '…' : 'Get WAV'}</button>}
        {needsCredit && <><span className="meta">Uses 1 download credit.</span><button className="btn small primary" onClick={() => getLink(true)}>Use credit</button><button className="btn small" onClick={() => setNeedsCredit(false)}>Cancel</button></>}
        {link && <a className="btn small primary" href={link} target="_blank" rel="noreferrer">Download WAV</a>}
        {onUseStyle && song.metadata?.style && <button className="btn small" onClick={onUseStyle}>Use its style</button>}
        {onRemove && <button className="btn small" aria-label={`Remove ${song.title} from the queue`} onClick={onRemove}>✕</button>}
      </div>
      {link && <p className="hint">After it downloads, bring it in with Import audio in the Sampler or Analyze.</p>}
    </div>
  );
}

function LibraryPanel({ mcp, say }: { mcp: Mcp; say: (m: string | null) => void }) {
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const load = async (cursor?: string) => {
    setError('');
    try {
      const q = query.trim();
      const r = await mcp.callTool(SERVER, q ? 'library-search' : 'library-list', { limit: 12, ...(q ? { query: q } : {}), ...(cursor ? { cursor } : {}) });
      const { items, next: n } = asSongs(r.payload);
      setSongs((old) => (cursor ? [...(old ?? []), ...items] : items));
      setNext(n);
    } catch (e) { setError(explain(e)); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line
  return (
    <div className="panel">
      <div className="suno-block-head"><b>Your Suno library</b></div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setSongs(null); load(); }}>
        <input id="suno-search" className="text" type="search" placeholder="Search titles and styles" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" type="submit">Search</button>
      </form>
      {error && <p className="warn-text">{error}</p>}
      {songs === null && !error && <p className="hint">Loading…</p>}
      {songs?.length === 0 && <p className="hint">No songs found.</p>}
      {songs?.map((s) => (
        <SongRow key={s.id} mcp={mcp} song={s} say={say} onUseStyle={() => { dispatch('suno.set', { patch: { styleOverride: s.metadata?.style ?? '' } }); say(`The style of "${s.title}" is now in the style box, ready to change.`); }} />
      ))}
      {next && <button className="btn" onClick={() => load(next)}>Load more</button>}
    </div>
  );
}

/** Getting a studio sound into Suno: export it here, then pick the file on Suno's upload page. */
function UploadPanel({ mcp, say }: { mcp: Mcp; say: (m: string | null) => void }) {
  const [session, setSession] = useState<{ id: string; page: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const r = await mcp.callTool(SERVER, 'audio-upload-create', { title: `Sticky Studio loop ${Math.round(getProject().bpm)} BPM` }, { cache: false });
      const pay = r.payload as { id?: string; upload_page_url?: string };
      if (pay?.id && pay.upload_page_url) setSession({ id: pay.id, page: pay.upload_page_url });
      else say('Suno did not return an upload page.');
    } catch (e) { say(explain(e)); }
    setBusy(false);
  };
  const finish = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await mcp.callTool(SERVER, 'audio-upload-complete', { id: session.id }, { cache: false });
      dispatch('suno.jobs', { jobs: [{ id: session.id, title: 'Uploaded from the studio', status: 'processing', created: Date.now() }] });
      setSession(null);
      say('Suno is processing your upload. It appears in the queue and then in your Suno library.');
    } catch (e) {
      say((e as { code?: string })?.code === 'tool_error' ? 'Suno has not received the file yet. Finish picking it on the upload page, then tap again.' : explain(e));
    }
    setBusy(false);
  };
  return (
    <div className="panel">
      <div className="suno-block-head"><b>Send a studio sound to Suno</b></div>
      {!session ? (
        <>
          <ol className="steps-list">
            <li>Export the sound: <button className="link" onClick={async () => say(await exportLoopWav())}>export the Sampler loop</button>, Export song on Arrange, or Download in the Library.</li>
            <li>Tap Start upload, then pick that file on Suno's page.</li>
          </ol>
          <button id="suno-upload" className="btn" disabled={busy} onClick={start}>Start upload</button>
        </>
      ) : (
        <>
          <a className="btn primary" href={session.page} target="_blank" rel="noreferrer">Open Suno's upload page</a>
          <p className="hint">Pick the file there. When it says the upload finished, come back and tap Done. The page works for one hour.</p>
          <div className="row"><button id="suno-upload-done" className="btn" disabled={busy} onClick={finish}>Done, I uploaded it</button><button className="btn" onClick={() => setSession(null)}>Cancel</button></div>
        </>
      )}
    </div>
  );
}
