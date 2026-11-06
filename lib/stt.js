// Speech-to-text: SoX/PipeWire recording, Whisper/API/chat audio, optional normalization.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { resolveChatOptions, transcribeChat } from "./stt-chat.js";

let sttApiEndpoint = null;
let sttApiModel = null;
let sttApiKeyEnv = null;

const WAV_FILENAME = "opencode-stt.wav";
let tmpDir = "/tmp";

const MODELS_DIRS = [
  path.join(os.homedir(), ".local", "share", "whisper-cpp"),
  "/opt/homebrew/share/whisper-cpp/models",
  "/usr/local/share/whisper-cpp/models",
];

const MODELS = {
  "large-v3-turbo-q5_0": {
    label: "Large v3 Turbo Q5 (recommended)",
    file: "ggml-large-v3-turbo-q5_0.bin",
  },
  "large-v3-turbo-q8_0": { label: "Large v3 Turbo Q8", file: "ggml-large-v3-turbo-q8_0.bin" },
  "large-v3-turbo": { label: "Large v3 Turbo (full)", file: "ggml-large-v3-turbo.bin" },
  "medium-q5_0": { label: "Medium Q5 (multilingual, faster)", file: "ggml-medium-q5_0.bin" },
  "small.en": { label: "Small English", file: "ggml-small.en.bin" },
  small: { label: "Small Multilingual", file: "ggml-small.bin" },
  "base.en": { label: "Base English", file: "ggml-base.en.bin" },
  base: { label: "Base Multilingual", file: "ggml-base.bin" },
  "tiny.en": { label: "Tiny English (fastest)", file: "ggml-tiny.en.bin" },
  tiny: { label: "Tiny Multilingual (fastest)", file: "ggml-tiny.bin" },
};
const DEFAULT_MODEL = "large-v3-turbo-q5_0";

const DEFAULT_LANGUAGE = "auto";
// Curated subset for the /stt-language picker; options.sttLanguage accepts any
// whisper.cpp language code.
const LANGUAGES = {
  auto: { label: "Auto-detect" },
  en: { label: "English" },
  zh: { label: "Chinese" },
  yue: { label: "Cantonese" },
  ja: { label: "Japanese" },
  ko: { label: "Korean" },
  de: { label: "German" },
  fr: { label: "French" },
  es: { label: "Spanish" },
  pt: { label: "Portuguese" },
  ru: { label: "Russian" },
  it: { label: "Italian" },
};
let sttDefaultLanguage = DEFAULT_LANGUAGE;

export function isOpenRouterEndpoint(endpoint) {
  return /(^https?:\/\/)?([^/]+\.)?openrouter\.ai(\/|$)/i.test(endpoint || "");
}

function buildMultipartTranscriptionRequest(model, audioBuffer, apiKey) {
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");

  const headers = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  return {
    headers,
    body: form,
  };
}

export function buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const payload = {
    model,
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  };

  return {
    headers,
    body: JSON.stringify(payload),
  };
}

function getModelsDir() {
  for (const dir of MODELS_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return MODELS_DIRS[0];
}

// ---- Audio backend detection (coreaudio / pulseaudio / sox default) ----

function detectAudioBackend() {
  if (process.platform === "darwin") return "coreaudio";
  try {
    execSync("pactl --version", { stdio: "ignore", timeout: 3000 });
    return "pulseaudio";
  } catch {
    return "default";
  }
}

// ---- Audio server diagnostics ----

export function isWSL() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

// Unlike `pactl --version`, `pactl info` actually connects to the server.
function pulseServerHealth() {
  try {
    execSync("pactl info", { stdio: "ignore", timeout: 3000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// User-facing hint for missing devices / recording failures. On WSL the audio
// server is WSLg's PulseAudio, which can wedge and needs a `wsl --shutdown`.
export function buildAudioHint({ backend, serverOk, isWsl }) {
  if (backend !== "pulseaudio") return "No input devices found";
  if (serverOk) return "No input devices found - check your audio input source configuration";
  if (isWsl) {
    return 'Audio server unreachable. On WSL, WSLg\'s PulseAudio may be stuck - run "wsl --shutdown" on Windows, then reopen Ubuntu';
  }
  return "Audio server unreachable - check that PipeWire/PulseAudio is running";
}

// Appends a server-health hint to recording failure messages when the
// PulseAudio server is unreachable (e.g. wedged WSLg on WSL).
function audioFailureSuffix(backend) {
  if (backend !== "pulseaudio") return "";
  if (pulseServerHealth().ok) return "";
  return `. ${buildAudioHint({ backend, serverOk: false, isWsl: isWSL() })}`;
}

// Input device descriptors: name is the value passed to sox, label is shown in the UI.
export function parsePactlSources(jsonText) {
  const data = JSON.parse(jsonText);
  return (Array.isArray(data) ? data : [])
    .filter((s) => s?.name && !s.name.endsWith(".monitor"))
    .map((s) => ({
      name: s.name,
      label: s.description ? `${s.description} (${s.name})` : s.name,
    }));
}

export function parsePactlSourcesShort(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name) => name && !name.endsWith(".monitor"))
    .map((name) => ({ name, label: name }));
}

function listInputDevices(backend) {
  if (backend === "coreaudio") {
    try {
      const json = execSync("system_profiler SPAudioDataType -json 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const data = JSON.parse(json);
      return (data.SPAudioDataType?.[0]?._items || [])
        .filter((d) => d.coreaudio_input_source != null)
        .map((d) => {
          const name = d.coreaudio_device_name || d._name;
          return { name, label: name };
        });
    } catch {
      return [];
    }
  }
  if (backend === "pulseaudio") {
    try {
      const json = execSync("pactl -f json list sources 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      });
      return parsePactlSources(json);
    } catch {
      try {
        const out = execSync("pactl list sources short 2>/dev/null", {
          encoding: "utf-8",
          timeout: 5000,
        });
        return parsePactlSourcesShort(out);
      } catch {
        return [];
      }
    }
  }
  return [];
}

export function buildRecordArgs(backend, mic) {
  if (backend === "pulseaudio") return ["-t", "pulseaudio", mic || "default"];
  if (backend === "coreaudio" && mic) return ["-t", "coreaudio", mic];
  return ["-d"];
}

// ---- Recording state and control ----

let recordingProc = null;
let recording = false;
let processing = false;

function forceKillRecording(logger) {
  if (recordingProc) {
    try {
      recordingProc.kill("SIGKILL");
      logger?.log("STT", `Killed recorder pid=${recordingProc.pid}`, "debug");
    } catch {}
    recordingProc = null;
  }
}

export function buildCaptureCommand(
  backend,
  mic,
  wavFile,
  { sttRecorder = "sox", trimSilence = true } = {},
) {
  if (sttRecorder === "pipewire") {
    return {
      command: "pw-record",
      args: [
        ...(mic ? ["--target", mic] : []),
        "--rate",
        "16000",
        "--channels",
        "1",
        "--format",
        "s16",
        wavFile,
      ],
    };
  }
  if (sttRecorder !== "sox") throw new Error("sttRecorder must be sox or pipewire");
  return {
    command: "sox",
    args: [
      ...buildRecordArgs(backend, mic),
      "-r",
      "16000",
      "-c",
      "1",
      "-b",
      "16",
      wavFile,
      ...(trimSilence ? ["silence", "1", "0.1", "1%"] : []),
    ],
  };
}

export function disposeRecording(logger) {
  recording = false;
  forceKillRecording(logger);
}

function startRecording(kv, backend, toast, logger, opts) {
  if (recordingProc) {
    logger?.log("STT", "Start recording skipped: recorder already running", "debug");
    return;
  }

  const wavFile = path.join(tmpDir, WAV_FILENAME);
  forceKillRecording(logger);
  try {
    fs.unlinkSync(wavFile);
  } catch {}

  let stderr = "";
  const mic = kv.get("stt.mic", "") || null;
  const capture = buildCaptureCommand(backend, mic, wavFile, opts);
  logger?.log(
    "STT",
    `Starting recording command=${capture.command} backend=${backend} mic=${mic || "system default"}`,
    "debug",
  );

  const proc = spawn(capture.command, capture.args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });
  recordingProc = proc;

  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  proc.on("error", (err) => {
    if (recordingProc !== proc) return;
    recordingProc = null;
    logger?.log("STT", `Recording failed: ${err.message}`, "error");
    if (recording) {
      recording = false;
      toast(
        `Recording failed: ${err.message}${capture.command === "sox" ? audioFailureSuffix(backend) : ""}`,
        "error",
      );
    }
  });

  proc.on("exit", (code) => {
    // A previously stopped child must not clear a newer recording's state.
    if (recordingProc !== proc) return;
    recordingProc = null;
    logger?.log(
      "STT",
      `${capture.command} exited code=${code} stderr=${stderr.trim()}`,
      code === 0 || code === null ? "debug" : "warn",
    );
    if (recording && code !== 0 && code !== null && !processing) {
      recording = false;
      const errLine = stderr.trim().split("\n").pop();
      toast(
        `Recording error: ${errLine || `${capture.command} exited (code=${code})`}${capture.command === "sox" ? audioFailureSuffix(backend) : ""}`,
        "error",
      );
    }
  });

  recording = true;
}

function stopRecording(logger) {
  logger?.log("STT", "Stopping recording", "debug");
  if (recordingProc) recordingProc.kill("SIGINT");
}

async function waitForRecorderExit(logger, timeoutMs = 2000) {
  const start = Date.now();
  while (recordingProc && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (recordingProc) {
    logger?.log("STT", "Recorder did not stop before timeout", "warn");
    forceKillRecording(logger);
  }
}

function getModelName(kv) {
  const model = kv.get("stt.model", DEFAULT_MODEL);
  return MODELS[model] ? model : DEFAULT_MODEL;
}

function getModelPath(kv) {
  return path.join(getModelsDir(), MODELS[getModelName(kv)].file);
}

function getLanguage(kv) {
  return kv.get("stt.language") || sttDefaultLanguage;
}

export function buildWhisperArgs(modelPath, wavFile, language) {
  return ["-m", modelPath, "-f", wavFile, "-l", language || DEFAULT_LANGUAGE, "-np", "-nt"];
}

function transcribe(kv, logger) {
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  const mp = getModelPath(kv);
  const lang = getLanguage(kv);
  logger?.log("STT", `Local transcription requested model=${mp} language=${lang}`, "debug");
  if (!fs.existsSync(mp)) {
    logger?.log("STT", `Whisper model missing: ${mp}`, "error");
    return Promise.resolve({
      error: `Model not found: ${getModelName(kv)}. Download from huggingface.co/ggerganov/whisper.cpp`,
    });
  }
  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return Promise.resolve({ error: "No recording file - sox may have failed to capture audio" });
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return Promise.resolve({ error: "Recording is empty - no audio captured" });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("whisper-cli", buildWhisperArgs(mp, wavFile, lang), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    logger?.log("STT", `Started whisper-cli pid=${proc.pid}`, "debug");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      logger?.log("STT", "whisper-cli timed out after 60s", "error");
      resolve({ error: "Transcription timed out (60s)" });
    }, 60000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      logger?.log("STT", `whisper-cli error: ${err.message}`, "error");
      resolve({ error: `Transcription failed: ${err.message}` });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      // whisper-cli exits 0 even for an unknown language, printing the error to
      // stderr instead; surface it rather than reporting "no speech detected".
      const langError = stderr.match(/error: unknown language '([^']+)'/);
      if (langError) {
        logger?.log("STT", `whisper-cli rejected language: ${langError[1]}`, "error");
        resolve({ error: `Unknown whisper language: ${langError[1]}` });
        return;
      }
      if (code !== 0) {
        logger?.log("STT", `whisper-cli exited code=${code} stderr=${stderr.trim()}`, "error");
        resolve({ error: stderr.trim().split("\n").pop() || `whisper-cli exited (code=${code})` });
        return;
      }
      logger?.log("STT", `Local transcription succeeded stdoutChars=${stdout.length}`, "debug");
      resolve({
        text: stdout
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    });
  });
}

const STT_SYSTEM_PROMPT = `You are a speech-to-text normalizer for a coding assistant CLI.

Clean up raw whisper transcription into a clear, well-punctuated prompt. Rules:
- Fix punctuation, capitalization, and grammar
- Remove filler words (um, uh, like, you know, etc.)
- Keep technical terms, file names, and code references exact
- If the user is dictating code, format it appropriately
- Use the session context above to resolve ambiguous references (e.g. "that function", "the file", "it")
- Output ONLY the cleaned text, nothing else
- Do not add any commentary or explanation
- Keep the user's intent and meaning intact

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound similar to programming terminology.`;

async function normalizeTranscription(complete, rawText, sessionTitle, systemPrompt, logger) {
  const contextLine = sessionTitle ? ` The user is currently working on: "${sessionTitle}"` : "";
  const system = `${systemPrompt}${contextLine}`;

  logger?.log("STT", `Normalizing transcription chars=${rawText.length}`, "debug");
  const result = await complete({
    system,
    prompt: `Clean up this speech-to-text transcription:\n\n${rawText}`,
  });
  return result;
}

async function getApiModels(logger, chatOptions = null) {
  const endpoint = chatOptions?.endpoint || sttApiEndpoint;
  const apiKeyEnv = chatOptions?.apiKeyEnv || sttApiKeyEnv;
  if (!endpoint) return [];
  try {
    const url = `${endpoint.replace(/\/+$/, "")}/models`;
    const headers = {};
    if (apiKeyEnv && process.env[apiKeyEnv]) {
      headers["Authorization"] = "Bearer " + process.env[apiKeyEnv];
    }
    const resp = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    logger?.log("STT", `Fetched STT API models status=${resp.status}`, resp.ok ? "debug" : "warn");
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.data || [])
      .filter((m) => m.id && (chatOptions || /whisper/i.test(m.id)))
      .map((m) => ({ value: m.id, label: m.id }));
  } catch (err) {
    logger?.log("STT", `Failed to fetch STT API models: ${err.message}`, "error");
    return [];
  }
}

async function transcribeApi(kv, logger) {
  if (!sttApiEndpoint || !sttApiModel) {
    logger?.log("STT", "STT API transcription skipped: API not configured", "warn");
    return { error: "STT API not configured" };
  }
  const wavFile = path.join(tmpDir, WAV_FILENAME);
  const model = kv.get("stt.api.model") || sttApiModel;
  logger?.log("STT", `STT API transcription requested model=${model}`, "debug");

  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return { error: "No recording file - sox may have failed to capture audio" };
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return { error: "Recording is empty - no audio captured" };
  }

  try {
    const audioBuffer = await fs.promises.readFile(wavFile);
    const apiKey = sttApiKeyEnv ? process.env[sttApiKeyEnv] : null;
    const useOpenRouterFormat = isOpenRouterEndpoint(sttApiEndpoint);

    const url = sttApiEndpoint.endsWith("/")
      ? `${sttApiEndpoint}audio/transcriptions`
      : `${sttApiEndpoint}/audio/transcriptions`;

    const request = useOpenRouterFormat
      ? buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey)
      : buildMultipartTranscriptionRequest(model, audioBuffer, apiKey);

    const resp = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(60000),
    });
    logger?.log("STT", `STT API response status=${resp.status}`, resp.ok ? "debug" : "error");

    if (!resp.ok) {
      const responseBody = await resp.text();
      let msg = `STT API error ${resp.status}`;
      try {
        const err = JSON.parse(responseBody);
        msg = err?.error?.message || msg;
      } catch {}
      return { error: msg };
    }

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      logger?.log("STT", `STT API returned invalid JSON: ${err.message}`, "error");
      return { error: `STT API returned invalid JSON: ${err.message}` };
    }
    logger?.log("STT", `STT API transcription succeeded chars=${data.text?.length || 0}`, "debug");
    return { text: data.text?.trim() || "" };
  } catch (err) {
    logger?.log("STT", `STT API request failed: ${err.message}`, "error");
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { error: "STT API request timed out (60s)" };
    }
    return { error: `STT API request failed: ${err.message}` };
  }
}

// V2 has no composer append; the plugin adapter opens an editable review
// dialog prefilled with the transcript (Enter sends, Esc cancels).
async function appendTranscription(api, text, submit) {
  await api.session.deliverTranscription(text, submit);
}

// Both paths keep the adapter's review dialog unless /stt-submit was explicitly
// used. New chat mode reviews raw text by default; legacy cleanup stays enabled.
export async function deliverTranscript(
  api,
  complete,
  text,
  settings,
  toast,
  logger,
  submit = false,
) {
  if (!settings.normalize) {
    await appendTranscription(api, text, submit);
    return;
  }
  toast("Normalizing...");
  const sessionTitle = await api.activeSessionTitle();
  const result = await normalizeTranscription(
    complete,
    text,
    sessionTitle,
    settings.systemPrompt,
    logger,
  );
  if (!result.text) {
    logger?.log("STT", `Normalization failed, using raw input: ${result.error}`, "warn");
    toast(`Normalization failed, using raw input: ${result.error}`, "warning");
  }
  await appendTranscription(api, result.text || text, submit);
}

async function doTranscribePipeline(
  kv,
  complete,
  api,
  toast,
  systemPrompt,
  submit = false,
  logger,
  settings,
) {
  processing = true;
  try {
    logger?.log("STT", `Pipeline started submit=${submit}`, "debug");
    stopRecording(logger);
    await waitForRecorderExit(logger);

    toast("Transcribing...");
    let result;
    if (settings.backend === "chat") {
      const wavFile = path.join(tmpDir, WAV_FILENAME);
      // Bound reads before base64 encoding. A 30s plugin WAV is under 1 MiB.
      if (fs.statSync(wavFile).size > 2 * 1024 * 1024) {
        result = { error: "Chat audio recording is too large; record a clip of at most 30s" };
      } else {
        result = await transcribeChat(
          await fs.promises.readFile(wavFile),
          {
            ...settings.chatOptions,
            model: kv.get("stt.chat.model") || settings.chatOptions.model,
          },
          logger,
        );
      }
    } else {
      result =
        settings.backend === "api" ? await transcribeApi(kv, logger) : await transcribe(kv, logger);
    }

    if (result.error) {
      logger?.log("STT", `Transcription failed: ${result.error}`, "error");
      toast(result.error, "error");
      return;
    }
    if (!result.text) {
      logger?.log("STT", "Transcription produced no text", "warn");
      toast("No speech detected", "warning");
      return;
    }

    await deliverTranscript(
      api,
      complete,
      result.text,
      { ...settings, systemPrompt },
      toast,
      logger,
      submit,
    );
    logger?.log("STT", "Pipeline completed", "debug");
    // The review dialog and its result toasts are owned by deliverTranscription.
  } catch (err) {
    logger?.log("STT", `Pipeline error: ${err.message}`, "error");
    toast(`STT error: ${err.message}`, "error");
  } finally {
    processing = false;
    recording = false;
  }
}

// ---- Public API for TUI plugin ----

export function resolveSTTSettings(opts) {
  if (opts?.sttRecorder !== undefined && !["sox", "pipewire"].includes(opts.sttRecorder)) {
    throw new Error("sttRecorder must be sox or pipewire");
  }
  const transcriptionBackend = opts?.sttBackend || (opts?.sttEndpoint ? "api" : "whisper");
  if (!["whisper", "api", "chat"].includes(transcriptionBackend)) {
    throw new Error("sttBackend must be whisper, api, or chat");
  }
  if (transcriptionBackend === "api" && !opts?.sttEndpoint) {
    throw new Error("API transcription requires sttEndpoint");
  }
  if (opts?.sttNormalize !== undefined && typeof opts.sttNormalize !== "boolean") {
    throw new Error("sttNormalize must be a boolean");
  }
  return {
    backend: transcriptionBackend,
    chatOptions: transcriptionBackend === "chat" ? resolveChatOptions(opts) : null,
    normalize: opts?.sttNormalize ?? transcriptionBackend !== "chat",
  };
}

export function registerSTT(api, kv, complete, prompts, opts, logger) {
  const systemPrompt = prompts?.stt || STT_SYSTEM_PROMPT;
  const settings = resolveSTTSettings(opts);
  const transcriptionBackend = settings.backend;
  const backend = detectAudioBackend();
  logger?.log("STT", `Audio backend=${backend}`, "debug");
  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  // Reset static API settings on setup/reload, so disabling an API endpoint
  // cannot leave a previously configured remote backend selected.
  sttApiEndpoint = null;
  sttApiModel = null;
  sttApiKeyEnv = null;
  sttDefaultLanguage = DEFAULT_LANGUAGE;
  if (transcriptionBackend === "api") {
    sttApiEndpoint = opts.sttEndpoint;
    sttApiModel = opts.sttModel || "whisper-large-v3-turbo";
    sttApiKeyEnv = opts.sttApiKeyEnv || null;
    logger?.log(
      "STT",
      `Configured STT API endpoint=${sttApiEndpoint} model=${sttApiModel}`,
      "debug",
    );
  }

  if (opts?.sttLanguage) {
    sttDefaultLanguage = opts.sttLanguage;
  }
  logger?.log("STT", `Default language=${sttDefaultLanguage}`, "debug");

  tmpDir = opts?.tmpDir || "/tmp";
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    logger?.log("STT", `Failed to create tmpDir ${tmpDir}: ${err.message}`, "warn");
  }
  logger?.log("STT", `STT temp dir=${tmpDir}`, "debug");

  return [
    {
      title: settings.chatOptions
        ? "STT: record/transcribe (chat audio, max 30s)"
        : sttApiEndpoint
          ? "STT: record/transcribe (API)"
          : "STT: record/transcribe",
      value: "stt.record",
      description: settings.chatOptions
        ? "Toggle recording; press again to transcribe up to 30s with chat audio and review"
        : sttApiEndpoint
          ? "Toggle recording; press again to stop and transcribe via API"
          : "Toggle recording; press again to stop and transcribe",
      keybind: "ctrl+r",
      slash: { name: "stt-record" },
      onSelect() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (recording) {
          toast("Stopping, transcribing...");
          return doTranscribePipeline(
            kv,
            complete,
            api,
            toast,
            systemPrompt,
            false,
            logger,
            settings,
          );
        } else {
          startRecording(kv, backend, toast, logger, opts);
          if (recording)
            toast(
              settings.chatOptions
                ? "Recording... stop within 30s, then review the transcript"
                : "Recording... press again to transcribe",
            );
        }
      },
    },
    {
      title: settings.chatOptions
        ? "STT: submit recording (chat audio)"
        : sttApiEndpoint
          ? "STT: submit recording (API)"
          : "STT: submit recording",
      value: "stt.submit",
      description: settings.chatOptions
        ? "Stop recording, transcribe up to 30s with chat audio, and send without review"
        : sttApiEndpoint
          ? "Stop recording, transcribe via API, and submit prompt"
          : "Stop recording, transcribe, and submit prompt",
      keybind: "<leader>r",
      slash: { name: "stt-submit" },
      onSelect() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (!recording) {
          toast("No recording in progress", "warning");
          return;
        }
        toast("Stopping, transcribing...");
        return doTranscribePipeline(kv, complete, api, toast, systemPrompt, true, logger, settings);
      },
    },
    {
      title: "STT: cancel recording",
      value: "stt.stop",
      description: "Cancel current recording",
      slash: { name: "stt-stop" },
      onSelect() {
        if (recording) {
          recording = false;
          forceKillRecording(logger);
          logger?.log("STT", "Recording cancelled", "debug");
          toast("Recording cancelled");
        }
      },
    },
    {
      title: settings.chatOptions
        ? "STT: select model (chat audio)"
        : sttApiEndpoint
          ? "STT: select model (API)"
          : "STT: select model",
      value: "stt.model",
      description: settings.chatOptions
        ? "Choose an audio-capable chat model from the local service"
        : sttApiEndpoint
          ? "Choose whisper model via API"
          : "Choose whisper model",
      slash: { name: "stt-model" },
      async onSelect() {
        if (sttApiEndpoint || settings.chatOptions) {
          const modelKey = settings.chatOptions ? "stt.chat.model" : "stt.api.model";
          const current = kv.get(modelKey) || settings.chatOptions?.model || sttApiModel;
          const apiModels = await getApiModels(logger, settings.chatOptions);
          const options = apiModels.length > 0 ? apiModels : [{ value: current, label: current }];
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: settings.chatOptions
                ? "Select chat audio model"
                : "Select whisper model (API)",
              current,
              options: options.map((m) => ({
                title: m.label,
                value: m.value,
                onSelect() {
                  kv.set(modelKey, m.value);
                  toast(`${settings.chatOptions ? "Chat audio" : "Whisper API"} model: ${m.label}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        } else {
          const current = getModelName(kv);
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select whisper model",
              current,
              options: Object.entries(MODELS).map(([key, v]) => ({
                title: v.label,
                value: key,
                onSelect() {
                  kv.set("stt.model", key);
                  toast(`Whisper model: ${v.label}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        }
      },
    },
    {
      title: "STT: select language",
      value: "stt.language",
      description: "Choose transcription language (local whisper-cli only)",
      slash: { name: "stt-language" },
      onSelect() {
        if (settings.chatOptions) {
          toast(
            "Chat audio detects the spoken language automatically; this picker is for Whisper",
            "info",
          );
          return;
        }
        const current = getLanguage(kv);
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select transcription language",
            current,
            options: Object.entries(LANGUAGES).map(([key, v]) => ({
              title: v.label,
              value: key,
              onSelect() {
                kv.set("stt.language", key);
                toast(`Whisper language: ${v.label}`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "STT: select microphone",
      value: "stt.mic",
      description: "Choose audio input device",
      slash: { name: "stt-mic" },
      onSelect() {
        const current = kv.get("stt.mic", "");
        const devices = listInputDevices(backend);
        if (devices.length === 0) {
          const serverOk = backend !== "pulseaudio" || pulseServerHealth().ok;
          const hint = buildAudioHint({ backend, serverOk, isWsl: isWSL() });
          logger?.log("STT", `No input devices: ${hint}`, "warn");
          toast(hint);
          return;
        }
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select microphone",
            current,
            options: [
              {
                title: "System default",
                value: "",
                onSelect() {
                  kv.set("stt.mic", "");
                  toast("Mic: system default");
                  api.ui.dialog.clear();
                },
              },
              ...devices.map((d) => ({
                title: d.label,
                value: d.name,
                onSelect() {
                  kv.set("stt.mic", d.name);
                  toast(`Mic: ${d.label}`);
                  api.ui.dialog.clear();
                },
              })),
            ],
          }),
        );
      },
    },
  ];
}
