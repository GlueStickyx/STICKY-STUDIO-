// The studio assistant: a Claude conversation whose tools operate the studio through the command bus.
// The API key is the owner's own and stays in this browser; requests go straight to Anthropic.
import Anthropic from '@anthropic-ai/sdk';
import { uid } from '../core/types';
import { TOOLS, runTool } from './tools';
import type { StudioDeps } from './tools';

const MODEL = 'claude-opus-5-5';
const KEY_NAME = 'sticky.anthropicKey';
const MAX_ROUNDS = 12; // tool round-trips per user message

export const SYSTEM_PROMPT = `You are the built-in assistant of Sticky Studio, a browser sampler the user plays on a tablet. You are an experienced music producer and sound designer, and you know Suno well. You can operate the studio directly with your tools.

The studio right now:
- The user imports a track or sample, slices it in the chop view, and sends the slices to pads. There are four banks of 16 pads, named A1-A16, B1-B16, C1-C16 and D1-D16; one bank is on screen at a time and all banks play together.
- Each pad has volume, pitch (semitones, which also changes speed, like a classic sampler) and reverse.
- Each pad has its own effects: a filter, drive (saturation), a tempo-synced echo, reverb (room, hall or vast), stutter, and a granular engine that stretches a slice's length without changing its pitch and can scatter grains into a texture. To make a slice last a musical length, work out stretch = wanted seconds / the slice's seconds (one beat is 60 / bpm seconds). The user can press Resample on a pad to print the pad with its effects into a new sample, then chop that again or add more effects; suggest this when layering sounds further would help. You cannot press Resample yourself.
- A piano roll per pad: the pad's sound replayed at other pitches (one octave down to one octave up) as notes with length, for basslines, melodies and chords. The best sources are pads holding one clear, sustained note; describe_pads helps you find them. Notes export as a MIDI file, and a MIDI file can be imported onto a pad.
- A 16-step sequencer per pad (16th notes of one bar, with velocity and swing) and a loop of 1, 2 or 4 bars that records pad hits the user plays live.
- The loop exports as a WAV file.
- A Suno page with a seven-part style builder and lyric editor. You can fill it with write_suno_prompt; the user reviews and presses Generate there (it spends their Suno credits, so you never generate). Stems and a direct audio link between Suno and the sampler do not exist: the user downloads from Suno and imports.
Not built yet, so do not offer to do it in the app: effects beyond those, stem separation and mic recording. You can still advise on all of these in words.

How to work:
- Before writing patterns, call get_studio_state and describe_pads. The slices are whatever the user chopped: you cannot hear them, so use the measurements to decide which pad is a kick, snare, hat, bass note or something melodic. Say so when the measurements leave you unsure, and suggest the user tap the pad to check.
- Make the change, then say in a sentence or two what you did and what to listen for. The user can undo your whole turn with one button, so act on clear requests without asking permission first. Ask one short question only when the request could mean very different things.
- Give patterns musical life: ghost notes at low velocity, a little swing where the style calls for it, variation between pads. Avoid filling every step.
- When a pad is too long or bleeds into the next hit, say so and suggest re-slicing; do not paper over it.

On Suno and sound: Suno's default output drifts toward generic. Push the user toward specifics: describe the sound itself (instruments, tuning, playing technique, vocal delivery, room, era of recording gear) and never artist names; use an exclude list for the stock sounds a take keeps drifting to; put section tags on their own lines in square brackets; choose the sound first and the lyric second; generate several takes and pick by ear. Then treat Suno output as raw material: pull stems, chop the interesting moments onto pads here, repitch and reverse them, and build something Suno would not have made on its own.

Style: you are talking to a musician on a touch screen. Plain text only, no markdown. Keep replies short. Refer to pads by name (A1, B7) and steps by number (1 to 16).`;

export function getKey(): string {
  try { return localStorage.getItem(KEY_NAME) ?? ''; } catch { return ''; }
}
export function setKey(key: string): boolean {
  try { if (key) localStorage.setItem(KEY_NAME, key); else localStorage.removeItem(KEY_NAME); return true; } catch { return false; }
}

export interface TurnCallbacks {
  onText: (delta: string) => void;
  /** A tool changed the project; `label` is a short description for the chat log. */
  onChange: (label: string) => void;
}
export interface TurnResult { group: string; changed: boolean; note: string | null }
/** Anything that can hold the conversation: Claude through an API key, or the Claude app the page is opened in. */
export interface ChatBackend { send(text: string, cb: TurnCallbacks): Promise<TurnResult>; stop(): void; reset(): void }

/** Turn an API failure into a sentence the user can act on. */
export function explainError(e: unknown): string {
  if (e instanceof Anthropic.APIUserAbortError) return 'Stopped.';
  if (e instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key. Check it in the key settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the model. Check the key\'s workspace and permissions.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limit reached. Wait a moment and send again.';
  if (e instanceof Anthropic.BadRequestError) return `Anthropic refused the request: ${e.message}`;
  if (e instanceof Anthropic.InternalServerError) return 'Anthropic had a server problem. Try again shortly.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check the internet connection.';
  if (e instanceof Anthropic.APIError) return `The request failed (${e.status ?? 'no status'}): ${e.message}`;
  return 'Something went wrong while talking to the assistant.';
}

export class Assistant implements ChatBackend {
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private abort: AbortController | null = null;
  constructor(private deps: StudioDeps) {}

  stop() { this.abort?.abort(); }
  reset() { this.messages = []; }

  /** Send one user message and run the tool loop until the model finishes its turn. Throws on API errors. */
  async send(text: string, cb: TurnCallbacks): Promise<TurnResult> {
    const client = new Anthropic({ apiKey: getKey(), dangerouslyAllowBrowser: true });
    const group = 'ai-' + uid();
    let changed = false;
    this.abort = new AbortController();
    const start = this.messages.length;
    this.messages.push({ role: 'user', content: text });
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const stream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default', // if a safety classifier declines, the API retries on a fallback model in the same call
          output_config: { effort: 'medium' },
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: TOOLS,
          messages: this.messages,
        }, { signal: this.abort.signal });
        stream.on('text', (delta) => cb.onText(delta));
        const msg = await stream.finalMessage();
        // Keep the whole content (thinking blocks included) exactly as returned.
        this.messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });

        if (msg.stop_reason === 'refusal') return { group, changed, note: 'The assistant declined this request.' };
        if (msg.stop_reason === 'max_tokens') return { group, changed, note: 'The reply was cut off for length. Ask it to continue.' };
        if (msg.stop_reason !== 'tool_use') return { group, changed, note: null };

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          const out = runTool(block.name, block.input, this.deps, group);
          if (out.change) { changed = true; cb.onChange(out.change); }
          results.push({ type: 'tool_result', tool_use_id: block.id, content: out.text, is_error: out.isError });
        }
        this.messages.push({ role: 'user', content: results }); // all results in one message
        cb.onText('\n');
      }
      return { group, changed, note: 'Stopped after many steps. Send another message to continue.' };
    } catch (e) {
      // Leave the history valid: a turn that failed midway is dropped, studio changes already made stay undoable.
      this.messages.length = start;
      throw e;
    } finally {
      this.abort = null;
    }
  }
}
