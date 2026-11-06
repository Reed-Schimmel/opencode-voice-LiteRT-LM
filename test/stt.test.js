import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAudioHint,
  buildCaptureCommand,
  buildOpenRouterTranscriptionRequest,
  buildRecordArgs,
  buildWhisperArgs,
  isOpenRouterEndpoint,
  isWSL,
  parsePactlSources,
  parsePactlSourcesShort,
} from "../lib/stt.js";

test("detects OpenRouter STT endpoints", () => {
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1/"), true);
  assert.equal(isOpenRouterEndpoint("https://api.openai.com/v1"), false);
});

test("builds OpenRouter STT requests as JSON with base64 audio", () => {
  const audioBuffer = Buffer.from("RIFFfakewav", "utf8");
  const request = buildOpenRouterTranscriptionRequest(
    "openai/whisper-large-v3-turbo",
    audioBuffer,
    "secret",
  );

  assert.deepEqual(request.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
  });

  const body = JSON.parse(request.body);
  assert.deepEqual(body, {
    model: "openai/whisper-large-v3-turbo",
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  });
});

test("parses pactl JSON sources and filters out monitors", () => {
  const json = JSON.stringify([
    { name: "RDPSink.monitor", description: "Monitor of RDP Sink" },
    { name: "RDPSource", description: "RDP Source" },
    { name: "alsa_input.usb-mic" },
  ]);
  assert.deepEqual(parsePactlSources(json), [
    { name: "RDPSource", label: "RDP Source (RDPSource)" },
    { name: "alsa_input.usb-mic", label: "alsa_input.usb-mic" },
  ]);
});

test("parses pactl short sources and filters out monitors", () => {
  const short = [
    "1\tRDPSink.monitor\tmodule-rdp-sink.c\ts16le 2ch 44100Hz\tSUSPENDED",
    "2\tRDPSource\tmodule-rdp-source.c\ts16le 1ch 44100Hz\tSUSPENDED",
    "",
  ].join("\n");
  assert.deepEqual(parsePactlSourcesShort(short), [{ name: "RDPSource", label: "RDPSource" }]);
});

test("builds sox record args per audio backend", () => {
  assert.deepEqual(buildRecordArgs("pulseaudio", "RDPSource"), ["-t", "pulseaudio", "RDPSource"]);
  assert.deepEqual(buildRecordArgs("pulseaudio", null), ["-t", "pulseaudio", "default"]);
  assert.deepEqual(buildRecordArgs("coreaudio", "USB Microphone"), [
    "-t",
    "coreaudio",
    "USB Microphone",
  ]);
  assert.deepEqual(buildRecordArgs("coreaudio", null), ["-d"]);
  assert.deepEqual(buildRecordArgs("default", null), ["-d"]);
});

test("native PipeWire capture needs no SoX and records the plugin WAV format", () => {
  assert.deepEqual(
    buildCaptureCommand("pulseaudio", null, "/fixture/audio.wav", { sttRecorder: "pipewire" }),
    {
      command: "pw-record",
      args: ["--rate", "16000", "--channels", "1", "--format", "s16", "/fixture/audio.wav"],
    },
  );
  const named = buildCaptureCommand("pulseaudio", "fixture-mic", "/fixture/audio.wav", {
    sttRecorder: "pipewire",
    trimSilence: true,
  });
  assert.deepEqual(named.args.slice(0, 2), ["--target", "fixture-mic"]);
  assert.equal(named.args.includes("silence"), false);
  assert.throws(
    () => buildCaptureCommand("default", null, "audio.wav", { sttRecorder: "invalid" }),
    /sttRecorder/,
  );
});

test("SoX remains the default recorder with unchanged silence trimming", () => {
  assert.deepEqual(buildCaptureCommand("pulseaudio", null, "/fixture/audio.wav"), {
    command: "sox",
    args: [
      "-t",
      "pulseaudio",
      "default",
      "-r",
      "16000",
      "-c",
      "1",
      "-b",
      "16",
      "/fixture/audio.wav",
      "silence",
      "1",
      "0.1",
      "1%",
    ],
  });
  assert.equal(
    buildCaptureCommand("default", null, "audio.wav", { trimSilence: false }).args.includes(
      "silence",
    ),
    false,
  );
});

test("builds audio hints per backend and server state", () => {
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: true }),
    /wsl --shutdown/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: false }),
    /PipeWire\/PulseAudio/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: true, isWsl: false }),
    /input source configuration/,
  );
  assert.equal(
    buildAudioHint({ backend: "coreaudio", serverOk: false, isWsl: false }),
    "No input devices found",
  );
});

test("detects WSL via environment variables", () => {
  const savedDistro = process.env.WSL_DISTRO_NAME;
  const savedInterop = process.env.WSL_INTEROP;
  try {
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    assert.equal(isWSL(), false);
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    assert.equal(isWSL(), true);
  } finally {
    if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = savedDistro;
    if (savedInterop === undefined) delete process.env.WSL_INTEROP;
    else process.env.WSL_INTEROP = savedInterop;
  }
});

test("builds whisper-cli args with language", () => {
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", "zh"), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "zh",
    "-np",
    "-nt",
  ]);
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", null), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "auto",
    "-np",
    "-nt",
  ]);
});
