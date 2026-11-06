# Piper Ryan high with native PipeWire playback

The special fork can use PipeWire for both recording and playback. Set
`ttsPlayer: "pipewire"` to stream Piper's raw audio into `pw-play`, without SoX.
Existing installations still default to `ttsPlayer: "sox"`.

## Dependencies and voice

Tested on Fedora with:

- `piper-tts==1.8.0`, installed in an isolated `uv` tool environment using Python 3.11.
- `pw-play` from the existing PipeWire installation.
- Ryan high at these expected locations:

```text
~/.local/share/piper-voices/en_US-ryan-high.onnx
~/.local/share/piper-voices/en_US-ryan-high.onnx.json
```

An isolated install does not replace system Python or LiteRT-LM:

```sh
uv tool install --python 3.11 piper-tts==1.8.0
```

Voice source:

```text
Repository: rhasspy/piper-voices
Revision: e7229f7d33a10e145e109b886d661984201ac3c4
Files: en/en_US/ryan/high/en_US-ryan-high.onnx
       en/en_US/ryan/high/en_US-ryan-high.onnx.json
ONNX SHA-256: b3990d7606e183ec8dbfba70a4607074f162de1a0c412e0180d1ff60bb154eca
Config SHA-256: c6d3b98f08315cb4bebf0d49d50fc4ff491b503c64b940cd3d5ca28543b48011
```

Only Ryan high is needed. Keep model weights and generated audio outside Git.
The model/config were checked on 2026-11-05. Ryan uses **22050 Hz, mono, signed
16-bit PCM**. The plugin reads the voice config's sample rate instead of assuming
that all voices use Ryan's rate.

## Configuration

Merge these fields into the existing plugin `options` in `cli.json`:

```json
{
  "ttsPlayer": "pipewire",
  "ttsVolume": 0.6
}
```

`ttsVolume` is a number from 0 to 1, defaults to 1, and adjusts only this playback
stream. It does not modify the system sink volume. Speech normalization uses the
existing plugin `endpoint`/`model`; for this setup that is the local LiteRT-LM
Gemma service. Piper itself also runs locally on CPU.

Automatic speech defaults to off. Installation/configuration does not toggle
existing runtime mode or voice selection. Ryan is the default voice; select it
with `/tts-voice` if a different voice was previously saved.

## Test in the TUI

1. Run `/reload`.
2. Press Ctrl+X then J, or run `/tts-speak`, to read the latest response.
3. Press Escape during playback to stop. When idle, Escape falls through normally.
4. Optionally enable automatic speech with Ctrl+X then V or `/tts-mode` after
   manual playback works. The same command disables it again.

Only use those shortcuts if the plugin-level overrides from this fork are
configured. The existing leader is unchanged.

## Pipeline and failures

```text
Assistant text → local LLM speech normalization
→ Piper --output-raw → pw-play --raw → speakers/headphones
```

The player pipes streams with backpressure, catches writable-stream errors such
as `EPIPE`, reports subprocess exits/stderr, and kills only its own subprocesses.
Replacing speech, pressing stop, or reloading/disabling the plugin cancels the
active playback job. Old subprocess callbacks cannot clear a newer job.

Synthetic tests cover format arguments, volume, streaming, subprocess failures,
broken pipes, cancellation, and stale callbacks. Standalone WAV synthesis and
real pipeline playback check dependencies, but actual TUI keyboard dispatch and
audibility still need a user test. No tests silently activate the microphone.

To update Piper, use `uv tool install --python 3.11 --upgrade piper-tts` and verify
the CLI/raw output path again. Keep the model/config pair together when updating
a voice. Removing this speech setup should not remove the Gemma service or voice
input configuration: remove only `ttsPlayer`/`ttsVolume` as appropriate and
uninstall Piper with `uv tool uninstall piper-tts` if no other application uses it.
