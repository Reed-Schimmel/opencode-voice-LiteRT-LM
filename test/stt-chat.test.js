import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildChatTranscriptionRequest,
  getWavDuration,
  resolveChatOptions,
  transcribeChat,
} from "../lib/stt-chat.js";
import {
  deliverTranscript,
  disposeRecording,
  registerSTT,
  resolveSTTSettings,
} from "../lib/stt.js";

function wav(seconds = 1, extraChunk = false) {
  const dataSize = Math.round(seconds * 32000);
  const offset = extraChunk ? 54 : 44;
  const audio = Buffer.alloc(offset + dataSize);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  if (extraChunk) {
    audio.write("JUNK", 36);
    audio.writeUInt32LE(1, 40);
  }
  audio.write("data", offset - 8);
  audio.writeUInt32LE(dataSize, offset - 4);
  return audio;
}

const config = () =>
  resolveChatOptions({ endpoint: "http://127.0.0.1:9379/v1", model: "gemma4-e2b" });
const response = (data, status = 200) => ({
  ok: status === 200,
  status,
  async json() {
    return data;
  },
});
const transcript = (content, finish = "stop") => ({
  choices: [{ message: { content }, finish_reason: finish }],
});

test("backend selection preserves legacy cleanup defaults and makes chat cleanup opt-in", () => {
  assert.deepEqual(resolveSTTSettings(), {
    backend: "whisper",
    chatOptions: null,
    normalize: true,
  });
  assert.deepEqual(resolveSTTSettings({ sttEndpoint: "http://localhost/v1" }), {
    backend: "api",
    chatOptions: null,
    normalize: true,
  });
  const chat = { sttBackend: "chat", endpoint: "http://localhost/v1", model: "e2b" };
  assert.equal(resolveSTTSettings(chat).normalize, false);
  assert.equal(resolveSTTSettings({ ...chat, sttNormalize: true }).normalize, true);
  assert.equal(resolveSTTSettings({ sttNormalize: false }).normalize, false);
  assert.equal(
    resolveSTTSettings({ sttBackend: "whisper", sttEndpoint: "http://localhost/v1" }).backend,
    "whisper",
  );
});

test("chat options inherit text endpoint/model with explicit STT overrides", () => {
  const resolved = resolveChatOptions({
    endpoint: "http://localhost:9379/v1/",
    model: "e2b",
    apiKeyEnv: "TEST_KEY",
  });
  assert.equal(resolved.endpoint, "http://localhost:9379/v1");
  assert.equal(resolved.model, "e2b");
  assert.equal(resolved.maxTokens, 512);
  assert.equal(resolved.timeoutMs, 60000);
  assert.equal(resolved.apiKeyEnv, "TEST_KEY");
  assert.equal(resolved.allowRemote, false);
  const overridden = resolveChatOptions({
    endpoint: "https://example.test/v1",
    model: "old",
    sttEndpoint: "http://[::1]:9379/v1",
    sttModel: "new",
    sttMaxTokens: 1024,
    sttTimeoutMs: 180000,
  });
  assert.equal(overridden.model, "new");
  assert.equal(overridden.maxTokens, 1024);
});

test("chat options reject missing/invalid settings and remote audio unless explicitly enabled", () => {
  assert.throws(() => resolveChatOptions({ model: "model" }), /endpoint/);
  assert.throws(() => resolveChatOptions({ endpoint: "http://localhost" }), /model/);
  assert.throws(() => resolveChatOptions({ endpoint: "file:///tmp", model: "m" }), /HTTP/);
  assert.throws(
    () => resolveChatOptions({ endpoint: "http://secret@localhost/v1", model: "m" }),
    /credentials/,
  );
  assert.throws(
    () => resolveChatOptions({ endpoint: "http://localhost/v1?secret=x", model: "m" }),
    /query/,
  );
  assert.throws(
    () => resolveChatOptions({ endpoint: "https://example.test/v1", model: "m" }),
    /loopback/,
  );
  assert.throws(
    () =>
      resolveChatOptions({
        endpoint: "https://example.test/v1",
        model: "m",
        sttAllowRemote: "true",
      }),
    /loopback/,
  );
  assert.equal(
    resolveChatOptions({ endpoint: "https://example.test/v1", model: "m", sttAllowRemote: true })
      .allowRemote,
    true,
  );
  assert.throws(
    () => resolveChatOptions({ endpoint: "http://localhost", model: "m", sttMaxTokens: 0 }),
    /positive integer/,
  );
  assert.throws(
    () => resolveChatOptions({ endpoint: "http://localhost", model: "m", sttTimeoutMs: "60000" }),
    /positive integer/,
  );
});

test("WAV duration parses additional odd-sized RIFF chunks", () => {
  assert.equal(getWavDuration(wav(10)), 10);
  assert.equal(getWavDuration(wav(10, true)), 10);
});

test("WAV validation rejects empty, incomplete, and incompatible recordings", () => {
  assert.throws(() => getWavDuration(Buffer.from("not a WAV")), /WAV/);
  assert.throws(() => getWavDuration(wav().subarray(0, 40)), /incomplete/);
  assert.throws(() => getWavDuration(wav(0)), /empty/);
  const stereo = wav();
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => getWavDuration(stereo), /mono/);
  const invalidRate = wav();
  invalidRate.writeUInt32LE(1, 28);
  assert.throws(() => getWavDuration(invalidRate), /PCM/);
});

test("chat request puts text before base64 WAV, limits output, and uses optional environment auth", () => {
  const audio = wav();
  const request = buildChatTranscriptionRequest("e2b", audio, {
    maxTokens: 1000,
    apiKey: "secret",
  });
  assert.equal(request.headers.Authorization, "Bearer secret");
  const body = JSON.parse(request.body);
  assert.equal(body.model, "e2b");
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 1000);
  assert.deepEqual(body.messages[0].content, [
    { type: "text", text: "Transcribe this audio." },
    { type: "input_audio", input_audio: { data: audio.toString("base64"), format: "wav" } },
  ]);
  assert.equal(buildChatTranscriptionRequest("e2b", audio).headers.Authorization, undefined);
});

test("chat transcription posts to chat completions with redirect blocking and no text cleanup", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return response(transcript("  I stopped at sent to  "));
  });
  assert.deepEqual(await transcribeChat(wav(), config()), { text: "I stopped at sent to" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:9379/v1/chat/completions");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.method, "POST");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test("chat transcription accepts exactly 30s but never uploads longer/invalid recordings", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response(transcript("text"));
  });
  assert.deepEqual(await transcribeChat(wav(30), config()), { text: "text" });
  assert.match((await transcribeChat(wav(30.01), config())).error, /at most 30s/);
  assert.match((await transcribeChat(Buffer.from("invalid"), config())).error, /WAV/);
  assert.equal(calls, 1);
});

test("chat transcription rechecks local-only policy and honors explicit remote permission", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response(transcript("text"));
  });
  const remote = { ...config(), endpoint: "https://example.test/v1" };
  assert.match((await transcribeChat(wav(), remote)).error, /loopback/);
  assert.equal(calls, 0);
  const allowed = resolveChatOptions({
    endpoint: remote.endpoint,
    model: "m",
    sttAllowRemote: true,
  });
  assert.deepEqual(await transcribeChat(wav(), allowed), { text: "text" });
  assert.equal(calls, 1);
});

test("chat transcription returns useful errors for HTTP, invalid JSON, and timeouts", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => response({}, 503));
  assert.match((await transcribeChat(wav(), config())).error, /HTTP 503/);
  mock.mock.mockImplementation(async () => {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  });
  assert.match((await transcribeChat(wav(), config())).error, /timed out \(60000ms\)/);
  mock.mock.mockImplementation(async () => ({
    ok: true,
    async json() {
      throw new SyntaxError("Invalid JSON");
    },
  }));
  assert.match((await transcribeChat(wav(), config())).error, /Invalid JSON/);
});

test("chat transcription rejects partial, empty, filtered, and server-error responses", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () =>
    response(transcript("partial", "length")),
  );
  assert.match((await transcribeChat(wav(), config())).error, /token limit/);
  for (const content of ["  ", null, [{ text: "unexpected structure" }]]) {
    mock.mock.mockImplementation(async () => response(transcript(content)));
    assert.match((await transcribeChat(wav(), config())).error, /no transcript/);
  }
  mock.mock.mockImplementation(async () => response(transcript("", "content_filter")));
  assert.match((await transcribeChat(wav(), config())).error, /filtered/);
  mock.mock.mockImplementation(async () =>
    response({ error: { message: "private response body" } }),
  );
  assert.equal(
    (await transcribeChat(wav(), config())).error,
    "Chat audio server returned an error",
  );
});

test("raw transcript delivery retains review and never invokes normalization", async () => {
  const calls = [];
  const api = {
    session: {
      async deliverTranscription(...args) {
        calls.push(args);
      },
    },
  };
  const complete = () => {
    throw new Error("Cleanup should not run");
  };
  await deliverTranscript(api, complete, "raw transcript", { normalize: false });
  assert.deepEqual(calls, [["raw transcript", false]]);
  await deliverTranscript(
    api,
    complete,
    "direct transcript",
    { normalize: false },
    undefined,
    undefined,
    true,
  );
  assert.deepEqual(calls[1], ["direct transcript", true]);
});

test("optional normalization keeps review and falls back to the raw transcript on failure", async () => {
  const calls = [];
  const api = {
    async activeSessionTitle() {
      return "test session";
    },
    session: {
      async deliverTranscription(...args) {
        calls.push(args);
      },
    },
  };
  const settings = { normalize: true, systemPrompt: "Normalize without changing meaning" };
  await deliverTranscript(
    api,
    async () => ({ text: "clean text" }),
    "raw",
    settings,
    () => {},
  );
  assert.deepEqual(calls[0], ["clean text", false]);
  await deliverTranscript(
    api,
    async () => ({ error: "offline" }),
    "raw",
    settings,
    () => {},
  );
  assert.deepEqual(calls[1], ["raw", false]);
});

test("chat model picker uses separate durable state and lists Gemma models", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-chat-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = new Map([
    ["stt.api.model", "old-whisper"],
    ["stt.model", "small.en"],
  ]);
  const kv = {
    get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
    set: (key, value) => state.set(key, value),
  };
  let dialog;
  const api = {
    ui: {
      toast() {},
      DialogSelect: (options) => options,
      dialog: {
        replace(render) {
          dialog = render();
        },
        clear() {},
      },
    },
  };
  const commands = registerSTT(
    api,
    kv,
    () => {},
    {},
    { sttBackend: "chat", endpoint: "http://localhost:9379/v1", model: "e2b", tmpDir: dir },
  );
  assert.match(commands.find((c) => c.value === "stt.record").title, /chat audio/);
  t.mock.method(globalThis, "fetch", async () =>
    response({ data: [{ id: "gemma4-e2b" }, { id: "gemma4-e4b" }] }),
  );
  await commands.find((c) => c.value === "stt.model").onSelect();
  assert.equal(dialog.current, "e2b");
  assert.deepEqual(
    dialog.options.map((m) => m.value),
    ["gemma4-e2b", "gemma4-e4b"],
  );
  dialog.options[1].onSelect();
  assert.equal(state.get("stt.chat.model"), "gemma4-e4b");
  assert.equal(state.get("stt.api.model"), "old-whisper");
  assert.equal(state.get("stt.model"), "small.en");
  const legacy = registerSTT(api, kv, () => {}, {}, { tmpDir: dir });
  assert.equal(legacy.find((c) => c.value === "stt.record").title, "STT: record/transcribe");
  const apiCommands = registerSTT(
    api,
    kv,
    () => {},
    {},
    { sttEndpoint: "http://localhost/v1", tmpDir: dir },
  );
  assert.match(apiCommands.find((c) => c.value === "stt.record").title, /API/);
  const reset = registerSTT(api, kv, () => {}, {}, { tmpDir: dir });
  assert.equal(reset.find((c) => c.value === "stt.record").title, "STT: record/transcribe");
});

test("registration rejects unknown backends and invalid cleanup settings", () => {
  assert.throws(() => registerSTT({}, {}, null, {}, { sttRecorder: "unknown" }), /sttRecorder/);
  assert.throws(() => registerSTT({}, {}, null, {}, { sttBackend: "unknown" }), /sttBackend/);
  assert.throws(() => registerSTT({}, {}, null, {}, { sttBackend: "api" }), /sttEndpoint/);
  assert.throws(() => registerSTT({}, {}, null, {}, { sttNormalize: "false" }), /boolean/);
});

test("PipeWire recording toggle reaches chat transcription and review without opening a microphone", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable fixture");
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-recorder-test-"));
  const fixture = path.join(dir, "fixture.wav");
  const started = path.join(dir, "started");
  await fs.writeFile(fixture, wav());
  const executable = path.join(dir, "pw-record");
  await fs.writeFile(
    executable,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.copyFileSync(${JSON.stringify(fixture)}, process.argv.at(-1));\nprocess.on('SIGINT', () => process.exit(0));\nsetInterval(() => {}, 100);\nfs.writeFileSync(${JSON.stringify(started)}, 'ready');\n`,
    { mode: 0o700 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  t.after(async () => {
    disposeRecording();
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const deliveries = [];
  const api = {
    ui: { toast() {} },
    session: {
      async deliverTranscription(...args) {
        deliveries.push(args);
      },
    },
  };
  const kv = { get: (_key, fallback) => fallback };
  const commands = registerSTT(
    api,
    kv,
    () => {
      throw new Error("Raw review must not normalize");
    },
    {},
    {
      sttBackend: "chat",
      sttRecorder: "pipewire",
      endpoint: "http://localhost/v1",
      model: "fixture-model",
      tmpDir: dir,
    },
  );
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests++;
    assert.equal(JSON.parse(options.body).model, "fixture-model");
    return response(transcript("fixture transcription"));
  });
  const record = commands.find((command) => command.value === "stt.record");
  record.onSelect();
  const deadline = Date.now() + 5000;
  while (
    !(await fs.access(started).then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() > deadline) throw new Error("Recorder fixture failed to start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await record.onSelect();
  assert.equal(requests, 1);
  assert.deepEqual(deliveries, [["fixture transcription", false]]);
  assert.equal(getWavDuration(await fs.readFile(path.join(dir, "opencode-stt.wav"))), 1);
});
