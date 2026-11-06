// Local-only, raw transcription comparison. Never records or submits prompts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildWhisperArgs } from "../lib/stt.js";
import { buildChatTranscriptionRequest } from "../lib/stt-chat.js";

export function normalizeWords(text) {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  );
}

export function wordErrorRate(reference, transcript) {
  const expected = normalizeWords(reference);
  const actual = normalizeWords(transcript);
  if (!expected.length) throw new Error("Reference must contain at least one word");
  let previous = Array.from({ length: actual.length + 1 }, (_, i) => i);
  for (let i = 1; i <= expected.length; i++) {
    const current = [i];
    for (let j = 1; j <= actual.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + Number(expected[i - 1] !== actual[j - 1]),
      );
    }
    previous = current;
  }
  const edits = previous[actual.length];
  return { edits, referenceWords: expected.length, rate: edits / expected.length };
}

export function buildGemmaRequest(audio, model) {
  const request = buildChatTranscriptionRequest(model, audio);
  return { ...JSON.parse(request.body), stream: true };
}

export function requireLocalEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Only local HTTP endpoints are allowed; audio must stay on this machine");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Endpoint must not contain credentials, a query, or a fragment");
  }
  return endpoint.replace(/\/+$/, "");
}

export async function transcribeGemma(audio, options) {
  const body = JSON.stringify(buildGemmaRequest(audio, options["gemma-model"]));
  const start = performance.now();
  const response = await fetch(`${options.endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(options.timeout),
  });
  if (!response.ok) throw new Error(`Gemma HTTP ${response.status}: ${await response.text()}`);
  let transcript = "";
  let firstTextMs = null;
  let finishReason = null;
  let pending = "";
  const decoder = new TextDecoder();
  function parseLine(line) {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    if (event.error) throw new Error(`Gemma stream error: ${JSON.stringify(event.error)}`);
    for (const choice of event.choices ?? []) {
      finishReason = choice.finish_reason ?? finishReason;
      const text = choice.delta?.content;
      if (text) {
        firstTextMs ??= performance.now() - start;
        transcript += text;
      }
    }
  }
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) parseLine(line.trimEnd());
  }
  pending += decoder.decode();
  if (pending.trim()) parseLine(pending.trimEnd());
  if (!transcript.trim()) throw new Error("Gemma returned no transcript");
  if (finishReason === "length")
    throw new Error("Gemma reached its output token limit; transcript may be truncated");
  return {
    transcript: transcript.trim(),
    totalMs: performance.now() - start,
    firstTextMs,
    finishReason,
  };
}

function runProcess(command, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} timed out after ${timeout} ms`));
      else if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function whisper(audioPath, options, outputDir, run) {
  const prefix = path.join(outputDir, `whisper-run-${run}`);
  const args = [
    ...buildWhisperArgs(options["whisper-model"], audioPath, "en"),
    "--no-gpu",
    "--threads",
    String(options.threads),
    "--output-txt",
    "--output-file",
    prefix,
  ];
  const start = performance.now();
  const output = await runProcess("whisper-cli", args, options.timeout);
  const totalMs = performance.now() - start;
  const transcript = (await fs.readFile(`${prefix}.txt`, "utf8")).trim();
  await fs.writeFile(`${prefix}.stderr.log`, output.stderr, { mode: 0o600 });
  if (!transcript) throw new Error("Whisper returned no transcript");
  return { transcript, totalMs, firstTextMs: null };
}

async function main() {
  const { values: options } = parseArgs({
    options: {
      audio: { type: "string" },
      "reference-file": { type: "string" },
      endpoint: { type: "string", default: "http://127.0.0.1:9379/v1" },
      "gemma-model": { type: "string", default: "gemma4-e2b" },
      "whisper-model": {
        type: "string",
        default: path.join(os.homedir(), ".local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin"),
      },
      "output-dir": { type: "string", default: path.join(os.tmpdir(), "opencode") },
      runs: { type: "string", default: "3" },
      threads: { type: "string", default: "6" },
      timeout: { type: "string", default: "180000" },
      help: { type: "boolean", default: false },
    },
  });
  if (options.help) {
    console.log(
      "Usage: node scripts/transcription-ab.js --audio recording.wav [--reference-file reference.txt] [--runs 3] [--output-dir /tmp/opencode]",
    );
    return;
  }
  if (!options.audio) throw new Error("--audio is required; this script does not record audio");
  for (const key of ["runs", "threads", "timeout"]) {
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < 1)
      throw new Error(`${key} must be a positive integer`);
  }
  options.endpoint = requireLocalEndpoint(options.endpoint);
  const audioPath = await fs.realpath(options.audio);
  const audio = await fs.readFile(audioPath);
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Input must be a WAV file; convert compressed audio before comparing");
  }
  await fs.access(options["whisper-model"]);
  const reference = options["reference-file"]
    ? await fs.readFile(options["reference-file"], "utf8")
    : null;
  if (reference !== null) wordErrorRate(reference, "");
  const outputBase = path.resolve(options["output-dir"]);
  await fs.mkdir(outputBase, { recursive: true });
  const realOutput = await fs.realpath(outputBase);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const relative = path.relative(repo, realOutput);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    throw new Error("Save recordings/results outside this repository");
  }
  const outputDir = await fs.mkdtemp(path.join(realOutput, "transcription-ab-"));
  await fs.chmod(outputDir, 0o700);
  const results = {
    created: new Date().toISOString(),
    audioPath,
    audioSha256: createHash("sha256").update(audio).digest("hex"),
    gemmaModel: options["gemma-model"],
    whisperModel: options["whisper-model"],
    nodeVersion: process.version,
    threads: options.threads,
    referenceProvided: reference !== null,
    measurements: [],
    notes: [
      "Raw transcription only: no cleanup LLM.",
      "Same WAV, sequential runs, alternating backend order.",
      "Gemma uses an existing persistent service; its first run is not necessarily cold.",
      "Whisper loads a fresh process/model each run; the OS file cache may be warm.",
      "Thread counts are not hard CPU quotas; the Gemma service may have a separate quota.",
      "WER ignores case/punctuation, but spelling and word boundaries still matter.",
    ],
  };
  async function save() {
    await fs.writeFile(
      path.join(outputDir, "results.json"),
      `${JSON.stringify(results, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  console.log(`Results directory: ${outputDir}`);
  await save();
  for (let run = 1; run <= options.runs; run++) {
    for (const backend of run % 2 ? ["gemma", "whisper"] : ["whisper", "gemma"]) {
      const measurement = { backend, run };
      try {
        Object.assign(
          measurement,
          backend === "gemma"
            ? await transcribeGemma(audio, options)
            : await whisper(audioPath, options, outputDir, run),
        );
        if (reference !== null) measurement.wer = wordErrorRate(reference, measurement.transcript);
        console.log(
          `${backend} run ${run}: ${(measurement.totalMs / 1000).toFixed(2)} s${measurement.firstTextMs === null ? "" : `; first text ${(measurement.firstTextMs / 1000).toFixed(2)} s`}`,
        );
        console.log(measurement.transcript);
      } catch (error) {
        measurement.error = error.message;
        process.exitCode = 1;
        console.error(`${backend} run ${run}: ${error.message}`);
      }
      results.measurements.push(measurement);
      await save();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
