import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { buildPlaybackCommand, createPiperPlayer } from "../lib/tts-audio.js";
import { registerTTS } from "../lib/tts.js";

function fakeChildren() {
  const children = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    Object.assign(child, {
      command,
      args,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      input: [],
    });
    child.stdin.on("data", (data) => child.input.push(data));
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", null, "SIGKILL"));
    };
    children.push(child);
    return child;
  };
  return { children, spawnProcess };
}

test("PipeWire playback accepts Piper's raw mono signed 16-bit PCM at the voice rate", () => {
  assert.deepEqual(buildPlaybackCommand("pipewire"), {
    command: "pw-play",
    args: ["--raw", "--rate", "22050", "--channels", "1", "--format", "s16", "-"],
  });
  assert.equal(buildPlaybackCommand("pipewire", 24000).args.includes("24000"), true);
  assert.equal(buildPlaybackCommand().command, "play");
  assert.throws(() => buildPlaybackCommand("invalid"), /ttsPlayer/);
  assert.throws(() => buildPlaybackCommand("pipewire", 0), /sample rate/);
});

test("playback volume is per stream and rejects amplification or invalid values", () => {
  const native = buildPlaybackCommand("pipewire", 22050, 0.6);
  assert.deepEqual(native.args.slice(-3), ["--volume", "0.6", "-"]);
  assert.deepEqual(buildPlaybackCommand("sox", 22050, 0.6).args.slice(-2), ["vol", "0.6"]);
  assert.throws(() => buildPlaybackCommand("pipewire", 22050, 2), /ttsVolume/);
  assert.throws(() => buildPlaybackCommand("pipewire", 22050, "0.6"), /ttsVolume/);
});

test("Piper streams bytes to playback and waits for both subprocesses", async () => {
  const fake = fakeChildren();
  const player = createPiperPlayer({ backend: "pipewire", spawnProcess: fake.spawnProcess });
  const result = player.speak("Test\nvoice", "/fixture/ryan.onnx");
  const [playback, piper] = fake.children;
  assert.equal(player.isPlaying(), true);
  assert.equal(playback.command, "pw-play");
  assert.deepEqual(piper.args, ["-m", "/fixture/ryan.onnx", "--output-raw"]);
  assert.equal(Buffer.concat(piper.input).toString(), "Test voice\n");
  const pcm = Buffer.from([1, 0, 2, 0]);
  piper.stdout.end(pcm);
  piper.emit("close", 0);
  assert.equal(player.isPlaying(), true);
  await new Promise((resolve) => setImmediate(resolve));
  playback.emit("close", 0);
  assert.deepEqual(await result, {});
  assert.deepEqual(Buffer.concat(playback.input), pcm);
  assert.equal(player.stop(), false);
});

test("stop cancels the current job, kills both owned children, and falls through when idle", async () => {
  const fake = fakeChildren();
  const player = createPiperPlayer({ spawnProcess: fake.spawnProcess });
  assert.equal(player.stop(), false);
  const result = player.speak("Test", "/fixture/voice.onnx");
  assert.equal(player.stop(), true);
  assert.deepEqual(await result, { canceled: true });
  assert.equal(
    fake.children.every((child) => child.killed),
    true,
  );
  assert.equal(player.isPlaying(), false);
  assert.equal(player.stop(), false);
});

test("old subprocess callbacks cannot clear newer playback", async () => {
  const fake = fakeChildren();
  const player = createPiperPlayer({ spawnProcess: fake.spawnProcess });
  const first = player.speak("First", "/fixture/voice.onnx");
  const second = player.speak("Second", "/fixture/voice.onnx");
  assert.deepEqual(await first, { canceled: true });
  fake.children[0].emit("close", 0);
  fake.children[1].emit("close", 0);
  assert.equal(player.isPlaying(), true);
  player.stop();
  assert.deepEqual(await second, { canceled: true });
});

test("EPIPE is reported and cleaned up without an unhandled stream error", async () => {
  const fake = fakeChildren();
  const errors = [];
  const player = createPiperPlayer({
    spawnProcess: fake.spawnProcess,
    onError: (message) => errors.push(message),
  });
  const result = player.speak("Test", "/fixture/voice.onnx");
  fake.children[0].stdin.emit("error", Object.assign(new Error("Broken pipe"), { code: "EPIPE" }));
  assert.match((await result).error, /EPIPE/);
  assert.equal(errors.length, 1);
  assert.equal(
    fake.children.every((child) => child.killed),
    true,
  );
  assert.equal(player.isPlaying(), false);
});

test("failed synthesis includes stderr and cancels playback", async () => {
  const fake = fakeChildren();
  const player = createPiperPlayer({ spawnProcess: fake.spawnProcess });
  const result = player.speak("Test", "/fixture/voice.onnx");
  fake.children[1].stderr.write("fixture model failed");
  fake.children[1].emit("close", 2);
  assert.match((await result).error, /piper exited 2: fixture model failed/);
  assert.equal(fake.children[0].killed, true);
});

test("missing executables return errors rather than hanging", async () => {
  const fake = fakeChildren();
  const player = createPiperPlayer({ spawnProcess: fake.spawnProcess });
  const result = player.speak("Test", "/fixture/voice.onnx");
  fake.children[0].emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  assert.match((await result).error, /ENOENT/);
  const throwing = createPiperPlayer({
    spawnProcess() {
      throw new Error("spawn failed");
    },
  });
  assert.match((await throwing.speak("Test", "/fixture/voice.onnx")).error, /spawn failed/);
});

test("disposal prevents late normalization results from starting playback after reload", async () => {
  const fake = fakeChildren();
  const player = createPiperPlayer({ spawnProcess: fake.spawnProcess });
  const result = player.speak("Active", "/fixture/voice.onnx");
  player.dispose();
  assert.deepEqual(await result, { canceled: true });
  assert.deepEqual(await player.speak("Late result", "/fixture/voice.onnx"), { canceled: true });
  assert.equal(fake.children.length, 2);
  assert.equal(player.isPlaying(), false);
});

test("empty speech does not spawn subprocesses", async () => {
  const player = createPiperPlayer({
    spawnProcess() {
      throw new Error("Must not spawn");
    },
  });
  assert.deepEqual(await player.speak("  ", "/fixture/voice.onnx"), {});
});

test("manual command awaits normalization and uses the actual manual speech prompt", async () => {
  const requests = [];
  const api = {
    client: {},
    ui: { toast() {} },
    event: { on() {} },
    route: { current: { name: "session", params: { sessionID: "fixture-session" } } },
    state: {
      session: {
        messages: () => [
          {
            type: "assistant",
            id: "fixture-message",
            content: [{ type: "text", text: "**Fixture response**" }],
          },
        ],
      },
    },
  };
  const kv = { get: (_key, fallback) => fallback };
  const complete = async (request) => {
    requests.push(request);
    return { error: "fixture stops before playback" };
  };
  const cleanups = [];
  const commands = registerTTS(
    api,
    kv,
    complete,
    {},
    undefined,
    { ttsPlayer: "pipewire" },
    (cleanup) => cleanups.push(cleanup),
  );
  await commands.find((command) => command.value === "tts.speak-last").onSelect();
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /\*\*Fixture response\*\*/);
  assert.equal(requests[0].config.maxTokens, 4096);
  assert.equal(cleanups.length, 1);
  cleanups[0]();
  assert.equal(commands.find((command) => command.value === "tts.stop").onSelect(), false);
});
