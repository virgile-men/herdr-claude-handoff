import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyCategory,
  findByBridgeId,
  isRcProcess,
  isSessionLive,
  listSessions,
  parseProcCmdline,
  parseProcStat,
} from "../src/lib/registry.js";

function createMockProc(tmpDir, pid, { stat, cmdline }) {
  const dir = path.join(tmpDir, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  if (stat) fs.writeFileSync(path.join(dir, "stat"), stat, "utf8");
  if (cmdline) fs.writeFileSync(path.join(dir, "cmdline"), cmdline, "utf8");
}

test("parseProcStat correctly parses ppid and field 22 starttime", () => {
  // Test stat with normal comm name
  const stat1 = "1000 (node) S 999 1000 1000 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 14543144 5000 0";
  const parsed1 = parseProcStat(stat1);
  assert.equal(parsed1.ppid, 999);
  assert.equal(parsed1.procStart, "14543144");

  // Test stat with spaces and parens in comm
  const stat2 = "2000 (claude-code (worker)) S 1500 2000 2000 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 98765432 5000 0";
  const parsed2 = parseProcStat(stat2);
  assert.equal(parsed2.ppid, 1500);
  assert.equal(parsed2.procStart, "98765432");

  assert.equal(parseProcStat(null), null);
  assert.equal(parseProcStat("invalid"), null);
});

test("parseProcCmdline splits NUL-separated arguments", () => {
  const buf = "node\0/path/to/claude\0--sdk-url\0https://example.com\0";
  const args = parseProcCmdline(buf);
  assert.deepEqual(args, ["node", "/path/to/claude", "--sdk-url", "https://example.com"]);
  assert.deepEqual(parseProcCmdline(null), []);
});

test("isRcProcess identifies rc child with rc parent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-proc-"));
  try {
    const childPid = 5001;
    const parentPid = 4001;

    createMockProc(tmp, childPid, {
      stat: `${childPid} (claude) S ${parentPid} 5001 5001 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1000 0 0`,
      cmdline: `node\0/claude\0--sdk-url\0https://api.anthropic.com/v1/code/sessions/cse_abc123\0`,
    });
    createMockProc(tmp, parentPid, {
      stat: `${parentPid} (supervisor) S 1 4001 4001 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 900 0 0`,
      cmdline: `node\0/bin/claude\0rc\0`,
    });

    assert.equal(isRcProcess(childPid, tmp, fs), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isRcProcess returns false when parent does not have rc argument", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-proc-"));
  try {
    const childPid = 5002;
    const parentPid = 4002;

    createMockProc(tmp, childPid, {
      stat: `${childPid} (claude) S ${parentPid} 5002 5002 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1000 0 0`,
      cmdline: `node\0/claude\0--sdk-url=https://api.anthropic.com/v1/code/sessions/cse_xyz\0`,
    });
    // Parent is an ordinary bash script, not claude rc
    createMockProc(tmp, parentPid, {
      stat: `${parentPid} (bash) S 1 4002 4002 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 900 0 0`,
      cmdline: `/bin/bash\0/scripts/run-test.sh\0`,
    });

    assert.equal(isRcProcess(childPid, tmp, fs), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("classifyCategory assigns background, rc, interactive, and other", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-proc-"));
  try {
    // 1. Background session
    assert.equal(classifyCategory({ kind: "bg", entrypoint: "cli" }, tmp, fs), "background");

    // 2. Interactive session
    assert.equal(classifyCategory({ kind: "interactive", entrypoint: "cli" }, tmp, fs), "interactive");

    // 3. RC child
    const rcPid = 6001;
    const rcParentPid = 6000;
    createMockProc(tmp, rcPid, {
      stat: `${rcPid} (claude) S ${rcParentPid} 6001 6001 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1000 0 0`,
      cmdline: `node\0/claude\0--sdk-url\0https://api.anthropic.com/v1/code/sessions/cse_test\0`,
    });
    createMockProc(tmp, rcParentPid, {
      stat: `${rcParentPid} (claude) S 1 6000 6000 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 900 0 0`,
      cmdline: `claude\0remote-control\0`,
    });
    assert.equal(
      classifyCategory({ pid: rcPid, kind: "interactive", entrypoint: "sdk-cli" }, tmp, fs),
      "rc",
    );

    // 4. sdk-cli without rc parent -> "other"
    const scriptPid = 7001;
    const scriptParentPid = 7000;
    createMockProc(tmp, scriptPid, {
      stat: `${scriptPid} (claude) S ${scriptParentPid} 7001 7001 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1000 0 0`,
      cmdline: `node\0/claude\0--sdk-url\0https://api.anthropic.com/v1/code/sessions/cse_test\0`,
    });
    createMockProc(tmp, scriptParentPid, {
      stat: `${scriptParentPid} (python) S 1 7000 7000 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 900 0 0`,
      cmdline: `python\0script.py\0`,
    });
    assert.equal(
      classifyCategory({ pid: scriptPid, kind: "interactive", entrypoint: "sdk-cli" }, tmp, fs),
      "other",
    );

    // 5. Unrecognized entrypoint
    assert.equal(classifyCategory({ kind: "unknown", entrypoint: "daemon" }, tmp, fs), "other");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isSessionLive checks liveness and filters mismatched procStart", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-proc-"));
  try {
    const pid = 8001;
    createMockProc(tmp, pid, {
      stat: `${pid} (claude) S 1 8001 8001 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0`,
    });

    // Matching procStart and alive
    assert.equal(
      isSessionLive(pid, "12345", { isLive: () => true, procRoot: tmp, fs }),
      true,
    );

    // Mismatched procStart filtered
    assert.equal(
      isSessionLive(pid, "99999", { isLive: () => true, procRoot: tmp, fs }),
      false,
    );

    // Dead pid filtered
    assert.equal(
      isSessionLive(pid, "12345", { isLive: () => false, procRoot: tmp, fs }),
      false,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("listSessions filters dead sessions and correctly models live sessions", () => {
  const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "test-claude-"));
  const tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), "test-proc-"));
  const sessionsDir = path.join(tmpConfig, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  try {
    // Session 1: Live background session
    createMockProc(tmpProc, 101, {
      stat: `101 (claude) S 1 101 101 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1000 0 0`,
    });
    fs.writeFileSync(
      path.join(sessionsDir, "101.json"),
      JSON.stringify({
        pid: 101,
        sessionId: "session-uuid-1",
        kind: "bg",
        entrypoint: "cli",
        jobId: "abcd1234",
        status: "idle",
        procStart: "1000",
        bridgeSessionId: "session_bg_1",
      }),
    );

    // Session 2: Dead process file
    fs.writeFileSync(
      path.join(sessionsDir, "102.json"),
      JSON.stringify({
        pid: 102,
        sessionId: "session-uuid-2",
        kind: "interactive",
        entrypoint: "cli",
        procStart: "2000",
      }),
    );

    // Session 3: procStart mismatch (PID recycled)
    createMockProc(tmpProc, 103, {
      stat: `103 (claude) S 1 103 103 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5555 0 0`,
    });
    fs.writeFileSync(
      path.join(sessionsDir, "103.json"),
      JSON.stringify({
        pid: 103,
        sessionId: "session-uuid-3",
        kind: "interactive",
        entrypoint: "cli",
        procStart: "3000",
      }),
    );

    const livePids = new Set([101, 103]);
    const sessions = listSessions({
      configDir: tmpConfig,
      procRoot: tmpProc,
      isLive: (pid) => livePids.has(pid),
      fs,
    });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].pid, 101);
    assert.equal(sessions[0].category, "background");
    assert.equal(sessions[0].jobId, "abcd1234");
    assert.equal(sessions[0].url, "https://claude.ai/code/session_bg_1");
  } finally {
    fs.rmSync(tmpConfig, { recursive: true, force: true });
    fs.rmSync(tmpProc, { recursive: true, force: true });
  }
});

test("findByBridgeId handles session_X, cse_X, and URLs with query/hash", () => {
  const sessions = [
    {
      pid: 201,
      sessionId: "uuid-201",
      bridgeSessionId: "session_01ABCDEF123456",
      jobId: "20102010",
    },
    {
      pid: 202,
      sessionId: "uuid-202",
      bridgeSessionId: "cse_01GXYZ987654",
      jobId: "20202020",
    },
  ];

  // Exact match session_
  assert.equal(findByBridgeId(sessions, "session_01ABCDEF123456")?.pid, 201);

  // Mapping cse_ -> session_
  assert.equal(findByBridgeId(sessions, "cse_01ABCDEF123456")?.pid, 201);

  // Mapping session_ -> cse_
  assert.equal(findByBridgeId(sessions, "session_01GXYZ987654")?.pid, 202);

  // Full URL with query and hash
  assert.equal(
    findByBridgeId(sessions, "https://claude.ai/code/session_01ABCDEF123456?env=prod#chat")?.pid,
    201,
  );

  // Full URL with cse_
  assert.equal(
    findByBridgeId(sessions, "https://claude.ai/code/cse_01GXYZ987654?foo=bar")?.pid,
    202,
  );

  // Not found
  assert.equal(findByBridgeId(sessions, "session_UNKNOWN"), null);
  assert.equal(findByBridgeId(sessions, ""), null);
  assert.equal(findByBridgeId(null, "session_123"), null);
});
