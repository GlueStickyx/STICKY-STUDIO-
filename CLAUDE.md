# Sticky Studio — build rules

A browser sampler/groovebox, tablet-first (Android Chrome), growing one finished slice at a time
toward a full studio. A desktop build with real VST hosting is the long-term goal.

## Who this is for and what it is (owner's words, Nov 2026 — read this first)

The owner is **not a trained producer** and does not know how most DAW features work. They are short on
credits, so do not make them re-explain this, and do not spend turns on status chatter.

The goal is **both**: the complete set of DAW tools (the owner was emphatic: they still want every tool), **and**
a guided co-pilot on top that helps them use those tools. Never frame it as one instead of the other:
- Suno's output is generic. The owner wants to take songs they have downloaded, cut and reshape them into
  **new samples and loops, and feed those back into Suno** (and keep a library of them).
- They ask in plain words — "make a tech house drum line from my drum samples", "I need a MIDI part for a
  tech house track", "add the next part" — and the assistant **does it, step by step, and shows what it
  just did and why**, so the owner learns (tempo, key, chords, pattern, sound choices).
- **Point and ask:** a mode where the owner taps a pad, control or section and sends the assistant a
  question or instruction about that thing.
- The assistant should be able to **research an artist's production style** and turn it into steps/recipes.
- They want **a new way of making samples that is not already out there** (idea on the table: assistant-written
  "recipes" that run a chain of stretch/scatter/resample/chop steps to breed batches of new sounds from one source).
- **Vocal samples** matter as much as drums.
- **Other AI providers** (Google Gemini, GPT, local) must be pluggable with clear setup instructions, because
  Claude credits run out; plus Suno through MCP, with a Suno workstation like the two reference screenshots
  (7-pillar style/lyric builder, generate queue, library).
- **VST/plugins** for extra sounds: impossible in a browser; needs the desktop build. Until then, built-in
  instruments/effects. Set the UI up so slots exist for things that arrive later.
- Look: skeuomorphic dark DAW with a tab per module and a library sidebar (see the owner's reference build
  spec: Analyze, Sampler, Chop, Drums, Melody, Clips, Mutate, Arrange). Missing so far: Clips, Arrange,
  mixer, that layout/skin.

Wanted soon: **co-pilot mode** (guided "build a track" sessions with visible, explained
steps; point-and-ask; a built-in starter drum/synth kit so the assistant can make a part from nothing).
Then: provider settings (Gemini/GPT), workstation shell + Clips + Arrange, Suno workstation, recipes.

## Rules (do not change without asking the owner)

1. Every user action is a named command in `src/core/bus.ts`. The UI never mutates the project
   or touches audio state directly. Undo, autosave and the future AI assistant all use `dispatch()`.
2. All timing is scheduled against the audio clock (`src/core/sequence.ts` + `src/audio/engine.ts`).
   Live playback and offline export share the same `hitsInWindow()`; keep it that way.
   No Tone.js, no WebAssembly, no cross-origin isolation headers.
3. The project (`src/core/types.ts`) is plain serialisable data and autosaves on every change.
4. No control appears on screen unless it does something audible or visible. No placeholders.
   One owner-requested exception: `src/ui/modules.ts` lists tools not built yet; each has a tab marked
   "soon" and an honest page (what it will do, build-order number, what works today). No fake controls on those pages.
   When a module is built, set `built: true` and replace its page.
5. Touch first: controls at least 44px, pads large, `touch-action` set on anything dragged.
6. Every audio feature has a test: pure logic in `tests/*.test.ts` (vitest), behaviour in a real
   browser in `tests/e2e.mjs` (renders audio and checks the samples).
7. Do not add a library or change these rules without asking. In use: React, and the
   official `@anthropic-ai/sdk` for the assistant (added with the assistant slice; owner told, may veto).
8. The assistant (`src/ai/`) changes the studio only through `runTool()` -> `dispatch()`, validates
   every model-supplied input, and groups each turn into one undo step.

## Commands

- `npm run dev` — local dev server
- `npm test` — unit tests
- `npm run build:artifact` — single-file build for publishing as a Claude artifact (assistant runs
  on the viewer's Claude account via `src/ai/viewer.ts`, no API key)
- `npm run guide` — rebuild, then re-photograph the app for the Guide (needs Playwright)
- `npm run build && npm run e2e` — production build, then browser checks (needs Playwright)

## Build order

Done: import, chop (manual + transient + grid), 16 pads, pad edit, loop recording of pad hits,
step sequencer, undo/redo, autosave, WAV export, AI assistant (Claude: own API key on the web build, viewer's account in the artifact build),

four pad banks (A-D, 64 pads; assistant addresses pads as "A1".."D16").
per-pad effects (filter, drive, tempo-synced echo, stutter, reverb, granular stretch and scatter) and
resampling a pad into a new sample. Random choices in audio use the seeded `prng()` so export = playback.
piano roll per pad (the pad's sound repitched, scale-folded rows), MIDI file export/import
(`src/core/midi.ts`), MIDI keyboard input (`src/audio/midiin.ts`; untested on real hardware).
library of saved sounds and named projects (`src/core/storage.ts`, `src/ui/Library.tsx`; library data is outside
the project, so it is not on the command bus or undo stack).
Guide (`src/ui/Guide.tsx`): text in `src/guide/guide.json`, pictures and marker positions generated from
the running app. **After changing any screen, run `npm run guide` and rebuild, and update guide.json
when a control is added, renamed or removed** — the script warns about markers with nothing on screen.

Workstation shell: module tabs (`src/ui/modules.ts`) and the skeuomorphic skin (end of `styles.css`).

Clips (`src/ui/Clips.tsx`): saved loops on 4 tracks, launched on bar lines (`segmentHits` in sequence.ts,
`engine.launch`); the transport plays clips on the Clips page and the Sampler loop elsewhere (`engine.setMode`).
Clips store patterns only; they play the pads' current sounds and effects.

Arrange (`src/ui/Arrange.tsx`): placements of clips on a bar timeline (`arrangementSegments`), song playback
(`engine.mode = 'song'`), `engine.renderSong` for export. The top-bar Export still exports the Sampler loop.

Mixer (`src/ui/MixerView.tsx`, `Mixer` class in engine.ts): one strip per pad bank (EQ, pan, fader, mute,
solo, meter) + master bus; applied in live playback and every export except `renderPad` (neutral mix).
The assistant has no mixer tool yet.

Analyze (`src/ui/Analyze.tsx`, `src/audio/trackanalysis.ts`): suggested loops (bar-aligned, self-similar),
hits (labelled by tone) and voice-like lines (steady pitch 90-900 Hz; no AI model, so a lead synth can match).
A real vocal finder would need a downloadable model: ask the owner before adding one (rule 7).

Suno (`src/ui/Suno.tsx`): 7-part style builder, negative, lyrics with tags (works everywhere); in the artifact,
generate/queue/library/download links/upload hand-off through the Suno connector (`mcp` capability, server "Suno";
the artifact must be published with that capability). The page cannot fetch Suno audio (CSP): download then Import.
The audio-create result shape was not observed live (a real call spends credits); Suno.tsx accepts an array,
{clips} or {items}. The assistant can fill the draft (`write_suno_prompt`) but never generates.
Stems skipped by the owner for now.

Next, in the order shown on the module tabs: AI setup (Gemini/GPT/local keys, knowledge shelf, research mode) → Plugins (desktop).
Alongside: co-pilot mode (explained steps, point-and-ask, starter kit), sample "recipes", sampler extras
(attack/decay, choke groups, velocity, 8/16-bar loops, 32 steps, probability, pattern chains, chords,
arpeggiator), library sidebar, Suno URL field, downloadable project file, mic sampling (web build only).
