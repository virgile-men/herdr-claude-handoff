import assert from "node:assert/strict";
import test from "node:test";
import { parseBgJobId, parseResumeJobId } from "../src/lib/claude.js";
import { validateId } from "../src/lib/flows.js";

test("parseBgJobId extracts 8-hex jobId from /bg pane outputs", () => {
  // Sample exact output from brief
  const sample1 = "backgrounded · e59d991b";
  assert.equal(parseBgJobId(sample1), "e59d991b");

  // Output with surrounding text and ansi escapes
  const sample2 = "\r\n\x1b[32mbackgrounded · 01ab23cd\x1b[0m\r\nSession moved to daemon.\r\n";
  assert.equal(parseBgJobId(sample2), "01ab23cd");

  // Uppercase hex converted to lowercase
  const sample3 = "backgrounded · A1B2C3D4";
  assert.equal(parseBgJobId(sample3), "a1b2c3d4");

  // Invalid or missing outputs
  assert.equal(parseBgJobId(""), null);
  assert.equal(parseBgJobId("backgrounded · not-a-hex"), null);
  assert.equal(parseBgJobId("random output text"), null);
});

test("parseResumeJobId extracts 8-hex jobId from claude --bg --resume stdout", () => {
  // Sample exact stdout from brief
  const sample1 = "  claude attach c1d4c56e    open in this terminal";
  assert.equal(parseResumeJobId(sample1), "c1d4c56e");

  // Multi-line stdout with typical daemon banner
  const sample2 = `
Claude Code background session launched.
Resume session id: 4a8d19f0-281c-43bc-a514-9fc3b851cecf

  claude attach 7f8e9a0b    open in this terminal

Use 'claude --help' for options.
`;
  assert.equal(parseResumeJobId(sample2), "7f8e9a0b");

  // Invalid or missing outputs
  assert.equal(parseResumeJobId(""), null);
  assert.equal(parseResumeJobId("claude attach xyz"), null);
  assert.equal(parseResumeJobId("Process running in background"), null);
});

test("validateId allows only ^[0-9a-f-]+$ and rejects unsafe identifiers", () => {
  // Valid 8-hex IDs
  assert.equal(validateId("c1d4c56e"), "c1d4c56e");
  assert.equal(validateId("E59D991B"), "E59D991B");

  // Valid UUIDs
  const uuid = "4a8d19f0-281c-43bc-a514-9fc3b851cecf";
  assert.equal(validateId(uuid), uuid);

  // Unsafe characters that could attempt shell injection or command tampering
  assert.throws(() => validateId("c1d4c56e; rm -rf /"), /Invalid identifier/);
  assert.throws(() => validateId("c1d4c56e && touch hacked"), /Invalid identifier/);
  assert.throws(() => validateId("`whoami`"), /Invalid identifier/);
  assert.throws(() => validateId("$(reboot)"), /Invalid identifier/);
  assert.throws(() => validateId(""), /Invalid identifier/);
  assert.throws(() => validateId(null), /Invalid identifier/);
  assert.throws(() => validateId(12345), /Invalid identifier/);
});
