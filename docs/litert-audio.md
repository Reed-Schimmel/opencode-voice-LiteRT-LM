# Gemma audio transcription with LiteRT-LM

The optional `chat` transcription backend sends the plugin's WAV recording
to `/v1/chat/completions` as base64 `input_audio`. No additional adapter service or
Whisper model is required. Piper speech output remains separate.

## Prerequisites

- OpenCode V2 and this fork's local TUI plugin checkout.
- A recorder on the **TUI machine**, with access to its microphone and audio server:
  SoX by default, or native `pw-record` with `sttRecorder: "pipewire"` on Linux.
- A reachable LiteRT-LM OpenAI-compatible server and an audio-capable model.
  Gemma 4 E2B was tested with LiteRT-LM 0.19.1 using CPU text/audio backends.
- Keep recordings short: this backend enforces Gemma 4's documented **30-second
  maximum**, independent of the model's configured context size.

Both recorders produce **16 kHz, mono, 16-bit PCM WAV**. Chat mode validates this
format and the complete WAV chunks before sending. Recordings over 30 seconds
are rejected explicitly: they are **not uploaded, truncated, or chunked**. The
recording stays at the existing temporary WAV path. Stop recording before 30
seconds; automatic stop/chunking is not implemented yet.

## Configuration fragment

Merge this into the global `cli.json`; do not replace unrelated configuration.
Replace the package and temporary directory paths for your machine. Load one
copy only, outside any automatically discovered `plugins/` directory.

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-voice-LiteRT-LM",
      "options": {
        "endpoint": "http://127.0.0.1:9379/v1",
        "model": "gemma4-e2b",
        "sttBackend": "chat",
        "sttRecorder": "pipewire",
        "sttNormalize": false,
        "sttMaxTokens": 512,
        "sttTimeoutMs": 60000,
        "tmpDir": "/absolute/path/to/private/voice-temp",
        "keybinds": {
          "stt.record": "<leader>k",
          "stt.submit": "none",
          "tts.speak-last": "<leader>j"
        }
      }
    }
  ]
}
```

**Shortcut compatibility comes from a separate commit**, now included in this
fork. Plugin-level binding options in the fragment above avoid conflicts with
session rename, redo, and status without changing the global leader. With the
default Ctrl+X leader, use Ctrl+X then K to record/review and Ctrl+X then J to read
the latest response. The direct-submit shortcut is disabled, but `/stt-submit`
remains available. Verify keyboard dispatch in the actual TUI after `/reload`;
slash commands remain a fallback.

## Native PipeWire capture

`sttRecorder: "pipewire"` uses `pw-record` directly and needs no SoX for input.
The source defaults to PipeWire's default microphone unless a microphone is
selected. The existing picker enumerates sources through `pactl`, available with
this machine's PipeWire PulseAudio compatibility. `sttRecorder: "sox"` remains
the default for existing installations.

`trimSilence` applies only to SoX. Native capture retains leading/trailing silence.
Reload/disable cleanup stops only the recorder child owned by this plugin.
Native capture does **not** replace the separate Piper/SoX speech-output path.

## Options

| Option           | Behavior                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sttBackend`     | `chat`, `api`, or `whisper`. If absent, existing behavior is preserved: `api` when `sttEndpoint` is set, otherwise `whisper`.                                                                        |
| `sttEndpoint`    | Chat endpoint base URL; defaults to text-normalization `endpoint`. Do not append `/chat/completions`.                                                                                                |
| `sttModel`       | Initial chat transcription model; defaults to text-normalization `model`.                                                                                                                            |
| `sttMaxTokens`   | Maximum generated transcript tokens; default 512. Not the shared context limit. Truncated responses are rejected, not sent to the session.                                                           |
| `sttTimeoutMs`   | Positive integer request timeout in milliseconds; default 60000.                                                                                                                                     |
| `sttNormalize`   | Defaults to **false for chat mode**, true for legacy modes. Enable explicitly to run the existing cleanup LLM after transcription.                                                                   |
| `sttApiKeyEnv`   | Optional environment variable containing the chat API key; defaults to `apiKeyEnv`. Never put a key in configuration.                                                                                |
| `sttAllowRemote` | Defaults to false. A non-loopback endpoint requires the literal boolean `true`, explicitly authorizing transmission of audio. HTTP redirects are never followed. Leave this unset for a local setup. |

New chat mode reviews **raw transcription by default**. A second normalization
pass can change wording or aggressively correct technical homophones, so it is
opt-in. TTS normalization and old Whisper/API cleanup defaults are unchanged.

## Commands and review

- `/stt-record`: start recording; repeat to stop, transcribe, and review.
- Return in review sends the edited transcript; Escape cancels.
- `/stt-submit`: stop an **active** recording, transcribe, and send without review.
  This remains an explicitly requested bypass; chat mode does not automatically
  bypass review.
- `/stt-stop`: cancel an active recording.
- `/stt-model`: list models advertised by the chat server. Choose an audio-capable
  model; listing alone does not prove audio support. Chat selection is persisted
  separately from Whisper/API selection and does not change the TTS model.
- `/stt-language`: chat audio detects the spoken language automatically. This
  picker remains for Whisper; it does not silently translate chat transcripts.

Audio follows a short text instruction (`Transcribe this audio.`), matching
Google's recommended modality order and the successful local A/B test. There is
no post-hoc deletion of suspected hallucinations; review is still important.

## Verification scope

Unit tests cover request shape, WAV validation, the duration guard, local-only
defaults, explicit remote permission, timeouts/errors, truncation, model selection,
and review-preserving transcript delivery. Test fixtures are synthetic and do not
record or upload the user's speech.

A standalone call to `transcribeChat` can verify real service inference on an
existing recording without touching the microphone or sending an OpenCode prompt.
Neither this check nor mocked review delivery proves real recorder capture, actual TUI
review editability, or keyboard dispatch. Those need an end-to-end TUI test after
dependencies and configuration are installed.

## Model provenance and future upgrades

The tested CPU-compatible model is
`litert-community/gemma-4-E2B-it-litert-lm/gemma-4-E2B-it.litertlm`:

```text
Model-file upload: 2026-05-04
SHA-256: 181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c
```

Checked against Hugging Face on 2026-11-05. Repository updates do not necessarily
change this file. Check the exact artifact checksum before downloading again.

Start with E2B. If quality is insufficient, import and test a current E4B model
before changing `sttModel` or selecting it in `/stt-model`. No model downloads,
upgrades, or fallback changes happen automatically.

Sources:

- [Gemma 4 model card: audio and modality order](https://huggingface.co/google/gemma-4-E2B-it)
- [LiteRT-LM OpenAI-compatible server](https://developers.google.com/edge/litert-lm/cli/openai_server)
- [LiteRT-community E2B artifacts](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/tree/main)
