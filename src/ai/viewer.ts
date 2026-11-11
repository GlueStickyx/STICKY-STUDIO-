// When the studio is opened as a Claude artifact, the Claude app itself can answer on the viewer's own
// account, with no API key. This file wraps that runtime (`window.claude`) behind the same interface as
// the API-key assistant. Outside an artifact `window.claude` does not exist and everything here resolves null.
import { uid } from '../core/types';
import { SYSTEM_PROMPT } from './assistant';
import type { ChatBackend, TurnCallbacks, TurnResult } from './assistant';
import { TOOLS, runTool } from './tools';
import type { StudioDeps } from './tools';

interface SampleTool { name: string; description: string; inputSchema?: object; execute: (input: Record<string, unknown>) => unknown }
interface SampleOptions { onText?: (u: { text: string; delta: string }) => void; signal?: AbortSignal; tools?: SampleTool[]; cache?: boolean; modelTier?: 'default' | 'complex' | 'quick' }
type Turn = { role: 'user' | 'assistant'; content: string };
type Sample = (input: string | Turn[], options?: SampleOptions) => Promise<{ text: string; truncated: boolean }>;
interface Downloads { save: (r: { filename: string; data: Blob | ArrayBuffer | string }) => Promise<{ status: string }> }
interface ClaudeRuntime { use(name: 'sample'): Promise<Sample | null>; use(name: 'downloads'): Promise<Downloads | null>; use(name: string): Promise<unknown> }

const runtime = (): ClaudeRuntime | null => (window as unknown as { claude?: ClaudeRuntime }).claude ?? null;
const safeUse = async <T>(name: string): Promise<T | null> => {
  try { return ((await runtime()?.use(name)) as T | undefined) ?? null; } catch { return null; }
};
/** True when the page is running inside a Claude artifact viewer. */
export const inArtifact = () => runtime() !== null;
export const useSample = () => safeUse<Sample>('sample');
export const useDownloads = () => safeUse<Downloads>('downloads');

const MESSAGES: Record<string, string> = {
  cancelled: 'Stopped.',
  not_granted: 'Claude access was declined for this page. Reload the page to be asked again.',
  rate_limited: 'Too many requests at once. Wait a moment and send again.',
  session_expired: 'Your Claude session expired. Reload the page.',
  sampling_disabled: 'Asking Claude is switched off for this page or account.',
  tools_unavailable: 'This Claude app cannot let the assistant operate the studio. Update the app or open the page in a browser.',
  refused: 'The assistant declined this request.',
  prompt_too_large: 'The conversation got too long. Start a new chat.',
  upstream_error: 'Claude had a problem answering. Try again shortly.',
};
/** Turn a failure from the artifact runtime into a sentence the user can act on, or null if it is not one. */
export function explainViewerError(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? (MESSAGES[code] ?? 'The assistant is unavailable right now.') : null;
}

export class ViewerAssistant implements ChatBackend {
  private turns: Turn[] = [];
  private abort: AbortController | null = null;
  constructor(private sample: Sample, private deps: StudioDeps) {}
  stop() { this.abort?.abort(); }
  reset() { this.turns = []; }

  async send(text: string, cb: TurnCallbacks): Promise<TurnResult> {
    const group = 'ai-' + uid();
    let changed = false;
    this.abort = new AbortController(); // a new controller per call
    const tools: SampleTool[] = TOOLS.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.input_schema,
      execute: (input) => {
        const out = runTool(t.name, input, this.deps, group);
        if (out.isError) throw new Error(out.text); // the runtime reports a thrown message back to Claude
        if (out.change) { changed = true; cb.onChange(out.change); }
        return out.text;
      },
    }));
    // There is no system prompt here: standing instructions are a leading user turn that is always kept.
    const history = this.turns.slice(-24);
    const input: Turn[] = [{ role: 'user', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: text }];
    try {
      const r = await this.sample(input, { tools, cache: false, signal: this.abort.signal, onText: ({ delta }) => cb.onText(delta) });
      this.turns.push({ role: 'user', content: text }, { role: 'assistant', content: r.text });
      return { group, changed, note: r.truncated ? 'The reply was cut short. Ask for less at a time.' : null };
    } finally {
      this.abort = null;
    }
  }
}
