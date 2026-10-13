import { spawnSync } from "node:child_process";
import { listSessions } from "./registry.js";

/**
 * Parses an 8-hex jobId from `claude --bg --resume` stdout.
 * Example line: `  claude attach c1d4c56e    open in this terminal`
 * @param {string} text
 * @returns {string | null}
 */
export function parseResumeJobId(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/claude attach\s+([0-9a-f]{8})/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Parses an 8-hex jobId from `/bg` pane output.
 * Example line: `backgrounded · e59d991b`
 * @param {string} text
 * @returns {string | null}
 */
export function parseBgJobId(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/backgrounded\s*·\s*([0-9a-f]{8})/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Helper delay function.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default process liveness check for PID exit.
 * @param {number} pid
 * @returns {boolean}
 */
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment for a background session started from a plugin command.
 * Drops herdr's plugin/pane variables (the session outlives this pane) and
 * CLAUDE_CODE_OAUTH_TOKEN, which Remote Control refuses: it needs the /login
 * credentials.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function backgroundEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("HERDR_") || key === "CLAUDE_CODE_OAUTH_TOKEN") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Resumes a Claude session in the background with remote control.
 * Spawns `claude --bg --resume <sessionId> --remote-control`.
 * @param {object} options
 * @param {string} options.sessionId
 * @param {string} [options.cwd]
 * @param {string} [options.claudeBin]
 * @param {typeof spawnSync} [options.spawn]
 * @returns {{ jobId: string }}
 */
export function backgroundResume({
  sessionId,
  cwd,
  claudeBin = process.env.CLAUDE_BIN ?? "claude",
  spawn = spawnSync,
}) {
  if (!sessionId) {
    throw new Error("sessionId is required for backgroundResume");
  }
  const args = ["--bg", "--resume", sessionId, "--remote-control"];
  const res = spawn(claudeBin, args, {
    cwd: cwd || process.cwd(),
    encoding: "utf8",
    env: backgroundEnv(),
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || "").trim();
    throw new Error(`claude --bg --resume failed with exit code ${res.status}: ${err}`);
  }
  const stdout = res.stdout || "";
  const jobId = parseResumeJobId(stdout);
  if (!jobId) {
    throw new Error(`Could not parse jobId from claude resume output:\n${stdout}`);
  }
  return { jobId };
}

/**
 * Polls until process exits or timeout.
 * @param {number} pid
 * @param {number} [ms]
 * @param {object} [options]
 * @param {number} [options.pollIntervalMs]
 * @param {Function} [options.isAlive]
 * @returns {Promise<boolean>}
 */
export async function waitForExit(
  pid,
  ms = 15000,
  { pollIntervalMs = 100, isAlive = defaultIsPidAlive } = {},
) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!isAlive(pid)) {
      return true;
    }
    await sleep(pollIntervalMs);
  }
  if (!isAlive(pid)) {
    return true;
  }
  throw new Error(`Timeout waiting for process ${pid} to exit after ${ms}ms`);
}

/**
 * Stops an rc child process safely:
 * Re-verifies category "rc" and status "idle" in registry right before,
 * sends SIGTERM, waits for exit up to 15s.
 * @param {object} session
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
export async function stopRcChild(
  session,
  {
    listSessionsFn = listSessions,
    kill = (pid, sig) => process.kill(pid, sig),
    waitForExitFn = waitForExit,
    configDir,
    procRoot,
  } = {},
) {
  const liveSessions = listSessionsFn({ configDir, procRoot });
  const cur = liveSessions.find((s) => s.pid === session.pid);
  if (!cur) {
    throw new Error(
      `Session ${session.pid} introuvable dans le registre. / Session ${session.pid} not found in registry.`,
    );
  }
  if (cur.category !== "rc") {
    throw new Error(
      `La session ${session.pid} n'est pas une session rc (${cur.category}). / Session ${session.pid} is not an rc session.`,
    );
  }
  if (cur.status !== "idle") {
    throw new Error(
      `La session rc ${session.pid} n'est pas inactive (${cur.status}). / rc session ${session.pid} is not idle.`,
    );
  }

  kill(session.pid, "SIGTERM");
  await waitForExitFn(session.pid, 15000);
  return true;
}

/**
 * Polls the registry for a live session with matching jobId and a bridgeSessionId.
 * @param {string} jobId
 * @param {number} [ms]
 * @param {object} [options]
 * @returns {Promise<string | null>} URL or null
 */
export async function waitForBridge(
  jobId,
  ms = 15000,
  {
    listSessionsFn = listSessions,
    pollIntervalMs = 500,
    configDir,
    procRoot,
  } = {},
) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const sessions = listSessionsFn({ configDir, procRoot });
    const found = sessions.find((s) => s.jobId === jobId && s.bridgeSessionId);
    if (found) {
      return found.url ?? `https://claude.ai/code/${found.bridgeSessionId}`;
    }
    await sleep(pollIntervalMs);
  }
  const finalCheck = listSessionsFn({ configDir, procRoot });
  const found = finalCheck.find((s) => s.jobId === jobId && s.bridgeSessionId);
  if (found) {
    return found.url ?? `https://claude.ai/code/${found.bridgeSessionId}`;
  }
  return null;
}
