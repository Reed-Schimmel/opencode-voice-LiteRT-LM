# Gemma / Whisper transcription A/B test

Compare raw transcription of the **same WAV** without modifying OpenCode, recording
new audio, applying LLM cleanup, or submitting a prompt. This is a standalone
benchmark, not the plugin's LiteRT integration.

## Requirements

- Node.js with built-in `fetch`, `AbortSignal.timeout`, and `util.parseArgs`.
- A running local LiteRT-LM server with an audio-capable model imported as
  `gemma4-e2b`. The installed Gemma 4 E2B audio encoder uses CPU.
- `whisper-cli` on PATH and the `large-v3-turbo-q5_0` model at
  `~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin`.
- A short WAV recording, preferably 16 kHz, mono, 16-bit PCM. Start with 10–20
  seconds before testing longer dictation and context limits.

Only loopback HTTP endpoints are accepted. Local service requests are not redirected.
The recording is sent only to the local LiteRT service; Whisper reads it locally.

## Run

```sh
node scripts/transcription-ab.js \
  --audio /absolute/path/to/recording.wav \
  --runs 3 \
  --output-dir /tmp/opencode
```

Optional arguments: `--endpoint`, `--gemma-model`, `--whisper-model`, `--threads`
(default 6), `--timeout` (per operation, milliseconds; default 180000), and
`--reference-file`.

For a quantitative accuracy comparison, write the exact words actually spoken to
a **private text file outside the repository**, including false starts and the
actual ending. Do not use either model's output as ground truth.

```sh
node scripts/transcription-ab.js \
  --audio /absolute/path/to/recording.wav \
  --reference-file /absolute/path/to/reference.txt \
  --runs 3 \
  --output-dir /tmp/opencode
```

Results include transcripts, elapsed times, Gemma time to first text, audio SHA-256,
and optional word error rate (WER). The output directory is private (`0700`) and
outside this repository. Treat all outputs, including Whisper stderr logs, as
private: they can contain speech or local paths. No audio is copied into Git.

## Interpretation and fairness

- Backend order alternates between runs; requests are sequential, not competing
  for CPU at the same time.
- Gemma uses a persistent service that may already be warm. Whisper starts and
  loads the model on every run, like the plugin does. OS file caches may be warm.
  This compares deployment latency, **not equally warmed inference engines**.
- Whisper is forced to CPU with six threads by default. Gemma's backend and thread
  count come from its service configuration. A service-level CPU quota is distinct
  from a thread count. Record these settings when sharing a comparison.
- Whisper uses the plugin's `buildWhisperArgs` helper with English selected, plus
  CPU/thread and text-output options. Gemma uses `Transcribe this audio.` **before**
  the audio, avoiding the instruction-after-audio layout that leaked into a prior
  transcript. Both receive the identical file bytes.
- Gemma generation is limited to 512 output tokens; verify that long recordings
  are not truncated before treating their output as a quality result.
- WER ignores case and punctuation, but still penalizes wrong names, missing
  words, extra words, and different word boundaries. WER can exceed 100% when
  many words are added. Without a supplied reference, no accuracy score is claimed.
- One recording is only a smoke test. Compare several clips with names, coding
  identifiers, pauses, false starts, background noise, and longer dictation before
  deciding on a default.

## Model source

The Whisper model download is approximately 547 MiB:

```text
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
SHA-256: 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
```

Keep weights, recordings, reference transcripts, and benchmark results outside the
repository. Do not commit or publish them.
