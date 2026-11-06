// Local multimodal chat transcription, separate from text normalization.
// Gemma 4's documented audio limit is independent of the LLM context size.
export const MAX_AUDIO_SECONDS = 30;
const MAX_WAV_BYTES = 2 * 1024 * 1024;

export function resolveChatOptions(options = {}) {
  const endpoint = options.sttEndpoint ?? options.endpoint;
  const model = options.sttModel ?? options.model;
  if (!endpoint) throw new Error("Chat audio requires sttEndpoint or endpoint");
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("Chat audio requires sttModel or model");
  }
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Chat audio endpoint must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Chat audio endpoint must not contain credentials, a query, or a fragment");
  }
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    options.sttAllowRemote !== true
  ) {
    throw new Error(
      "Chat audio requires a loopback endpoint unless sttAllowRemote is explicitly true",
    );
  }
  const maxTokens = options.sttMaxTokens ?? 512;
  const timeoutMs = options.sttTimeoutMs ?? 60000;
  for (const [name, value] of [
    ["sttMaxTokens", maxTokens],
    ["sttTimeoutMs", timeoutMs],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    model: model.trim(),
    apiKeyEnv: options.sttApiKeyEnv ?? options.apiKeyEnv,
    allowRemote: options.sttAllowRemote === true,
    maxTokens,
    timeoutMs,
  };
}

// Read RIFF chunks rather than assuming the data starts at byte 44. SoX can
// include additional chunks. Reject incomplete headers/files instead of sending
// an unchecked recording that the model might truncate or misinterpret.
export function getWavDuration(audio) {
  if (
    !Buffer.isBuffer(audio) ||
    audio.length < 12 ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Chat audio requires a WAV recording");
  }
  const end = audio.readUInt32LE(4) + 8;
  if (end > audio.length || end < 12) throw new Error("WAV recording is incomplete");
  let format;
  let dataBytes = null;
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) throw new Error("WAV chunk header is incomplete");
    const name = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > end) throw new Error("WAV recording is incomplete");
    if (name === "fmt ") {
      if (size < 16 || format) throw new Error("Invalid WAV format chunk");
      format = {
        encoding: audio.readUInt16LE(start),
        channels: audio.readUInt16LE(start + 2),
        rate: audio.readUInt32LE(start + 4),
        byteRate: audio.readUInt32LE(start + 8),
        blockAlign: audio.readUInt16LE(start + 12),
        bits: audio.readUInt16LE(start + 14),
      };
    } else if (name === "data") {
      if (dataBytes !== null) throw new Error("Multiple WAV data chunks are not supported");
      dataBytes = size;
    }
    offset = start + size + (size % 2);
    if (offset > end) throw new Error("WAV chunk padding is incomplete");
  }
  if (!format || dataBytes === null) throw new Error("WAV format or audio data is missing");
  if (
    format.encoding !== 1 ||
    format.channels !== 1 ||
    format.rate !== 16000 ||
    format.bits !== 16 ||
    format.blockAlign !== 2 ||
    format.byteRate !== 32000
  ) {
    throw new Error("Chat audio requires 16 kHz, mono, 16-bit PCM WAV (the SoX recording format)");
  }
  if (!dataBytes) throw new Error("Recording is empty - no audio captured");
  if (dataBytes % format.blockAlign) throw new Error("WAV audio data is incomplete");
  return dataBytes / format.byteRate;
}

export function buildChatTranscriptionRequest(model, audio, { maxTokens = 512, apiKey } = {}) {
  return {
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            // Audio must follow text: this matches Google's model card and the
            // tested request. Putting instructions after audio leaked into output.
            { type: "text", text: "Transcribe this audio." },
            { type: "input_audio", input_audio: { data: audio.toString("base64"), format: "wav" } },
          ],
        },
      ],
    }),
  };
}

export async function transcribeChat(audio, options, logger) {
  try {
    // Validate even when called independently from the plugin's setup.
    const config = resolveChatOptions({
      sttEndpoint: options.endpoint,
      sttModel: options.model,
      sttApiKeyEnv: options.apiKeyEnv,
      sttMaxTokens: options.maxTokens,
      sttTimeoutMs: options.timeoutMs,
      sttAllowRemote: options.allowRemote,
    });
    const duration = getWavDuration(audio);
    if (duration > MAX_AUDIO_SECONDS) {
      return {
        error: `Recording is ${duration.toFixed(2)}s; Gemma chat audio supports at most 30s. Record a shorter clip; audio was not sent or truncated.`,
      };
    }
    if (audio.length > MAX_WAV_BYTES) return { error: "WAV recording is too large for chat audio" };
    const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : null;
    const request = buildChatTranscriptionRequest(config.model, audio, {
      maxTokens: config.maxTokens,
      apiKey,
    });
    logger?.log(
      "STT",
      `Chat audio requested model=${config.model} duration=${duration.toFixed(2)}s`,
      "debug",
    );
    const response = await fetch(`${config.endpoint}/chat/completions`, {
      method: "POST",
      ...request,
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      // Do not echo an arbitrary response body: it might include recorded text
      // or submitted audio. The HTTP status is enough for a user-facing error.
      return { error: `Chat audio request failed (HTTP ${response.status})` };
    }
    const data = await response.json();
    if (data.error) return { error: "Chat audio server returned an error" };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") {
      return {
        error:
          "Chat audio reached the output token limit; nothing was submitted. Increase sttMaxTokens or record a shorter clip.",
      };
    }
    if (choice?.finish_reason === "content_filter")
      return { error: "Chat audio response was filtered" };
    if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
      return { error: "Chat audio returned no transcript" };
    }
    const text = choice.message.content.trim();
    logger?.log("STT", `Chat audio succeeded chars=${text.length}`, "debug");
    return { text };
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return { error: `Chat audio request timed out (${options.timeoutMs ?? 60000}ms)` };
    }
    logger?.log("STT", `Chat audio failed: ${error.message}`, "warn");
    return { error: `Chat audio failed: ${error.message}` };
  }
}
