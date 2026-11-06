import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import plugin, { toCommand } from "../index.js";

function registeredCommands(t, keybinds) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-keybind-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  let layer;
  const state = {};
  const context = {
    options: { tmpDir, ...(keybinds === undefined ? {} : { keybinds }) },
    client: {},
    ui: { toast: { show() {} }, dialog: { clear() {} } },
    storage: { store: () => [state, (update) => update(state)] },
    data: { on: () => () => {} },
    keymap: {
      layer: (factory) => {
        layer = factory();
      },
    },
  };
  const dispose = plugin.setup(context);
  t.after(dispose);
  assert.equal(layer.mode, "global");
  return new Map(layer.commands.map((command) => [command.id, command]));
}

test("plugin options override the actual registered STT/TTS bindings", (t) => {
  const commands = registeredCommands(t, {
    "stt.record": "<leader>k",
    "stt.submit": "none",
    "tts.speak-last": "<leader>j",
  });
  assert.equal(commands.get("stt.record").bind, "<leader>k");
  assert.equal(commands.get("stt.submit").bind, false);
  assert.equal(commands.get("tts.speak-last").bind, "<leader>j");
  assert.equal(commands.get("tts.mode").bind, "<leader>v");
  assert.equal(commands.get("tts.stop").bind, "escape");
  assert.equal(commands.get("stt.stop").bind, undefined);
});

test("a disabled shortcut keeps slash/palette access and its handler", (t) => {
  for (const binding of ["none", false]) {
    const command = registeredCommands(t, { "stt.submit": binding }).get("stt.submit");
    assert.equal(command.bind, false);
    assert.equal(command.palette, true);
    assert.deepEqual(command.slash, { name: "stt-submit" });
    assert.equal(typeof command.run, "function");
    // With no active recording this only displays a warning; no microphone or
    // transcription is started by the test.
    assert.equal(command.run(), undefined);
  }
});

test("missing or empty options retain upstream defaults", (t) => {
  for (const keybinds of [undefined, {}, null]) {
    const commands = registeredCommands(t, keybinds);
    assert.equal(commands.get("stt.record").bind, "ctrl+r");
    assert.equal(commands.get("stt.submit").bind, "<leader>r");
    assert.equal(commands.get("tts.speak-last").bind, "<leader>s");
  }
});

test("registered Escape handler returns false when speech is idle", (t) => {
  const command = registeredCommands(t, {}).get("tts.stop");
  assert.equal(command.run(), false);
});

test("conversion preserves synchronous and asynchronous handler return values", async () => {
  const base = { value: "fixture.command", title: "Fixture", keybind: "ctrl+k" };
  assert.equal(toCommand({ ...base, onSelect: () => false }).run(), false);
  assert.equal(toCommand({ ...base, onSelect: () => "result" }).run(), "result");
  const promise = Promise.resolve("async result");
  const result = toCommand({ ...base, onSelect: () => promise }).run();
  assert.equal(result, promise);
  assert.equal(await result, "async result");
});

test("conversion forwards array/object bindings without modifying them", () => {
  const command = { value: "fixture.command", title: "Fixture", keybind: "ctrl+k", onSelect() {} };
  for (const binding of [["ctrl+k", "<leader>k"], { key: "ctrl+k", preventDefault: false }]) {
    assert.equal(toCommand(command, { "fixture.command": binding }).bind, binding);
  }
});

test("only own plugin overrides are applied", () => {
  const keybinds = Object.create({ "fixture.command": "<leader>k" });
  const command = { value: "fixture.command", title: "Fixture", keybind: "ctrl+k", onSelect() {} };
  assert.equal(toCommand(command, keybinds).bind, "ctrl+k");
});
