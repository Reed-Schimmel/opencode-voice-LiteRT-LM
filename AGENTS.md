# AGENTS.md - opencode-voice

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single TUI plugin exported from `index.js` with logic split into `lib/`.

## Key invariants

- Single TUI plugin via `Plugin.define` from `@opencode/plugin/tui`; `setup`
  returns a cleanup that detaches data listeners and disposes owned recorder/
  playback jobs, including late playback after reload. No server-side plugin.
- LLM calls use the OpenAI chat completions API, not the Anthropic messages API.
- Chat audio (`lib/stt-chat.js`) and native PipeWire capture/playback are optional.
  Preserve Whisper/API and SoX defaults; do not require Linux tools on other OSes.
- Chat transcription puts the text instruction before audio. Enforce the 30-second
  audio limit independently of context size; no silent truncation or remote
  fallback. Non-loopback audio requires explicit `sttAllowRemote: true`.
- Configuration uses `options` (static) and the storage-backed `api.kv`
  (runtime). No dotfile I/O.
- Keep `sttNormalize` (dictation cleanup), `ttsNormalize` (speech preprocessing),
  and stored `tts.mode` (automatic speech) independent. Chat cleanup defaults off;
  legacy cleanup and TTS normalization default on.
- Apply plugin `options.keybinds` to registered commands, not top-level CLI
  overrides. Translate `"none"` to `false` without removing slash/palette access.
  Preserve handler return values, especially idle Escape's `false` fallthrough.
- Playback (`lib/tts-audio.js`) uses the voice-config sample rate and backpressure.
  Handle stream errors such as EPIPE; stop only owned children, and prevent old
  subprocess callbacks from clearing newer jobs.
- Auto TTS triggers on `session.execution.started` / `succeeded` /
  `interrupted` events and only speaks for the session the TUI is showing.
  V1's `session.status` / `session.idle` events have no producer in V2.
- Diagnostics go through `lib/logger.js`, which is a no-op unless
  `OPENCODE_VOICE_DEBUG` is set (V2 removed the `client.app.log` sink).
- No build step. Plain ESM JavaScript, shipped as-is.
- Never commit weights, recordings, transcripts, credentials, or benchmark results.
  Use synthetic test fixtures; never silently activate the microphone. Mock tests
  do not prove actual TUI keyboard dispatch or audible playback.

## Scripts

```bash
npm run test         # node --test
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` and `npm test` with zero errors/failures.

Keep installation details in `docs/litert-audio.md`, `docs/piper-pipewire.md`, and
`docs/transcription-ab.md`, not machine-specific paths or setup history here.

CI runs on every PR and push to main (lint, test, build). See
RELEASE_PROCESS.md for release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
