# Sticky Studio — build rules

A browser sampler/groovebox, tablet-first (Android Chrome), growing one finished slice at a time
toward a full studio. A desktop build with real VST hosting is the long-term goal.

## Rules (do not change without asking the owner)

1. Every user action is a named command in `src/core/bus.ts`. The UI never mutates the project
   or touches audio state directly. Undo, autosave and the future AI assistant all use `dispatch()`.
2. All timing is scheduled against the audio clock (`src/core/sequence.ts` + `src/audio/engine.ts`).
   Live playback and offline export share the same `hitsInWindow()`; keep it that way.
   No Tone.js, no WebAssembly, no cross-origin isolation headers.
3. The project (`src/core/types.ts`) is plain serialisable data and autosaves on every change.
4. No control appears on screen unless it does something audible or visible. No placeholders.
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
- `npm run build && npm run e2e` — production build, then browser checks (needs Playwright)

## Build order

Done: import, chop (manual + transient + grid), 16 pads, pad edit, loop recording of pad hits,
step sequencer, undo/redo, autosave, WAV export, AI assistant (Claude, owner's own API key).

Next, one slice at a time: mic sampling and pad banks →
piano roll and MIDI → FX/mutation lab → Suno studio tab → stems → clip launcher and arrangement →
knowledge library and local-model/MCP connections for the assistant → workflow canvas →
desktop shell with plugin hosting.
