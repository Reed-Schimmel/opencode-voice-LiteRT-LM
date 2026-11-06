import { spawn } from "node:child_process";

export function buildPlaybackCommand(backend = "sox", sampleRate = 22050, volume = 1) {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1) {
    throw new Error("Voice sample rate must be a positive integer");
  }
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new Error("ttsVolume must be a number between 0 and 1");
  }
  if (backend === "pipewire") {
    return {
      command: "pw-play",
      args: [
        "--raw",
        "--rate",
        String(sampleRate),
        "--channels",
        "1",
        "--format",
        "s16",
        ...(volume === 1 ? [] : ["--volume", String(volume)]),
        "-",
      ],
    };
  }
  if (backend !== "sox") throw new Error("ttsPlayer must be sox or pipewire");
  return {
    command: "play",
    args: [
      "-t",
      "raw",
      "-r",
      String(sampleRate),
      "-e",
      "signed",
      "-b",
      "16",
      "-c",
      "1",
      "-q",
      "-",
      ...(volume === 1 ? [] : ["vol", String(volume)]),
    ],
  };
}

// Each job owns its children. Stream piping supplies backpressure, and all
// writable-stream errors (including EPIPE) are handled, not thrown globally.
export function createPiperPlayer({
  backend = "sox",
  volume = 1,
  logger,
  onError = () => {},
  spawnProcess = spawn,
} = {}) {
  buildPlaybackCommand(backend, 22050, volume);
  let active = null;
  let disposed = false;

  function settle(job, result) {
    if (job.done) return;
    job.done = true;
    if (active === job) active = null;
    job.resolve(result);
  }

  function kill(job) {
    job.piper?.stdout?.unpipe(job.player?.stdin);
    job.piper?.stdin?.destroy();
    job.player?.stdin?.destroy();
    for (const child of [job.piper, job.player]) {
      try {
        child?.kill("SIGKILL");
      } catch {}
    }
  }

  function fail(job, message) {
    if (job.done) return;
    logger?.log?.("TTS", message, "error");
    settle(job, { error: message });
    kill(job);
    onError(message);
  }

  function stop() {
    if (!active) return false;
    const job = active;
    settle(job, { canceled: true });
    kill(job);
    return true;
  }

  function speak(text, voiceModel, sampleRate = 22050) {
    if (disposed) return Promise.resolve({ canceled: true });
    const line = String(text ?? "")
      .replace(/\n/g, " ")
      .trim();
    if (!line) return Promise.resolve({});
    const playback = buildPlaybackCommand(backend, sampleRate, volume);
    stop();
    return new Promise((resolve) => {
      const job = {
        resolve,
        done: false,
        piper: null,
        player: null,
        closed: new Set(),
        stderr: {},
      };
      active = job;
      function attach(child, name) {
        job.stderr[name] = "";
        child.stderr.on("data", (chunk) => {
          job.stderr[name] = (job.stderr[name] + chunk).slice(-4096);
        });
        child.on("error", (error) => fail(job, `${name} failed: ${error.message}`));
        child.stdin.on("error", (error) =>
          fail(
            job,
            `${name} input failed (${error.code ?? error.message}); ${job.stderr[name].trim()}`,
          ),
        );
        child.on("close", (code, signal) => {
          if (job.done) return;
          if (code !== 0) {
            fail(job, `${name} exited ${code ?? signal}: ${job.stderr[name].trim()}`);
            return;
          }
          job.closed.add(name);
          if (job.closed.size === 2) {
            logger?.log?.("TTS", "Piper synthesis and playback finished", "debug");
            settle(job, {});
          }
        });
      }
      try {
        job.player = spawnProcess(playback.command, playback.args, {
          stdio: ["pipe", "ignore", "pipe"],
        });
        attach(job.player, playback.command);
        job.piper = spawnProcess("piper", ["-m", voiceModel, "--output-raw"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        attach(job.piper, "piper");
        job.piper.stdout.on("error", (error) => fail(job, `Piper output failed: ${error.message}`));
        job.piper.stdout.pipe(job.player.stdin);
        job.piper.stdin.end(`${line}\n`);
      } catch (error) {
        fail(job, `Speech pipeline failed: ${error.message}`);
      }
    });
  }

  function dispose() {
    disposed = true;
    return stop();
  }

  return { speak, stop, dispose, isPlaying: () => active !== null };
}
