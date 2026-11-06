import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  buildGemmaRequest,
  normalizeWords,
  requireLocalEndpoint,
  transcribeGemma,
  wordErrorRate,
} from "../scripts/transcription-ab.js";

test("A/B request puts the short transcription instruction before WAV audio", () => {
  const audio = Buffer.from("test audio");
  const request = buildGemmaRequest(audio, "test-model");
  assert.equal(request.model, "test-model");
  assert.equal(request.stream, true);
  assert.deepEqual(request.messages[0].content, [
    { type: "text", text: "Transcribe this audio." },
    { type: "input_audio", input_audio: { data: audio.toString("base64"), format: "wav" } },
  ]);
});

test("WER ignores capitalization and punctuation but retains words", () => {
  assert.deepEqual(normalizeWords("Hello, WORLD!"), ["hello", "world"]);
  assert.equal(wordErrorRate("Hello, world!", "hello world").rate, 0);
});

test("WER counts substitutions, omissions, and added words", () => {
  assert.equal(wordErrorRate("one two three", "one four three").edits, 1);
  assert.equal(wordErrorRate("one two three", "one three").edits, 1);
  assert.equal(wordErrorRate("one two", "one two three").rate, 0.5);
  assert.equal(wordErrorRate("one", "one two three").rate, 2);
  assert.equal(wordErrorRate("one two", "").rate, 1);
  assert.throws(() => wordErrorRate("...", "hello"), /Reference/);
});

test("A/B audio stays on a loopback endpoint", () => {
  assert.equal(requireLocalEndpoint("http://127.0.0.1:9379/v1/"), "http://127.0.0.1:9379/v1");
  assert.equal(requireLocalEndpoint("http://localhost:9379/v1"), "http://localhost:9379/v1");
  assert.equal(requireLocalEndpoint("http://[::1]:9379/v1"), "http://[::1]:9379/v1");
  assert.throws(() => requireLocalEndpoint("https://example.com/v1"), /local/);
  assert.throws(() => requireLocalEndpoint("http://192.168.1.2:9379/v1"), /local/);
  assert.throws(() => requireLocalEndpoint("http://user:secret@localhost:9379/v1"), /credentials/);
});

async function mockServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    "gemma-model": "test-model",
    timeout: 1000,
  };
}

test("A/B parser handles split SSE chunks and ignores non-content deltas", async (t) => {
  const options = await mockServer(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(JSON.parse(body).model, "test-model");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"hello');
    response.end(' world"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const result = await transcribeGemma(Buffer.from("audio fixture"), options);
  assert.equal(result.transcript, "hello world");
  assert.equal(result.finishReason, "stop");
  assert.equal(typeof result.firstTextMs, "number");
  assert.ok(result.totalMs >= result.firstTextMs);
});

test("A/B parser rejects empty and truncated transcripts", async (t) => {
  const empty = await mockServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end("data: [DONE]\n\n");
  });
  await assert.rejects(transcribeGemma(Buffer.from("audio fixture"), empty), /no transcript/);
  const truncated = await mockServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
    );
  });
  await assert.rejects(transcribeGemma(Buffer.from("audio fixture"), truncated), /truncated/);
});

test("A/B parser reports HTTP and streaming failures", async (t) => {
  const failed = await mockServer(t, (_request, response) => {
    response.writeHead(500);
    response.end("model failed");
  });
  await assert.rejects(transcribeGemma(Buffer.from("audio fixture"), failed), /HTTP 500/);
  const stream = await mockServer(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"error":{"message":"audio decode failed"}}\n\n');
  });
  await assert.rejects(
    transcribeGemma(Buffer.from("audio fixture"), stream),
    /audio decode failed/,
  );
});
