import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Parses /proc/<pid>/stat line.
 * Accounts for comm names with spaces or parens by finding the last ')'.
 * @param {string} statStr
 * @returns {{ ppid: number | null, procStart: string | null } | null}
 */
export function parseProcStat(statStr) {
  if (typeof statStr !== "string") return null;
  const lastParen = statStr.lastIndexOf(")");
  if (lastParen === -1) return null;
  const rest = statStr.slice(lastParen + 1).trim();
  const fields = rest.split(/\s+/);
  // fields[0] = field 3 (state)
  // fields[1] = field 4 (ppid)
  // fields[19] = field 22 (starttime / procStart)
  const ppid = parseInt(fields[1], 10);
  const procStart = fields[19];
  return {
    ppid: Number.isFinite(ppid) ? ppid : null,
    procStart: procStart ?? null,
  };
}

/**
 * Parses /proc/<pid>/cmdline NUL-separated bytes into string array.
 * @param {string} cmdlineContent
 * @returns {string[]}
 */
export function parseProcCmdline(cmdlineContent) {
  if (typeof cmdlineContent !== "string") return [];
  return cmdlineContent.split("\0").filter(Boolean);
}

/**
 * Checks whether an sdk-cli process is an rc child process.
 * Rule: cmdline has --sdk-url with /v1/code/sessions/cse_
 * AND parent process has rc or remote-control argument after executable.
 * @param {number} pid
 * @param {string} procRoot
 * @param {typeof nodeFs} fs
 * @returns {boolean}
 */
export function isRcProcess(pid, procRoot = "/proc", fs = nodeFs) {
  try {
    const cmdlinePath = path.join(procRoot, String(pid), "cmdline");
    const cmdlineStr = fs.readFileSync(cmdlinePath, "utf8");
    const args = parseProcCmdline(cmdlineStr);

    let hasSdkUrlCse = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith("--sdk-url")) {
        if (arg.includes("/v1/code/sessions/cse_")) {
          hasSdkUrlCse = true;
          break;
        }
        if (i + 1 < args.length && args[i + 1].includes("/v1/code/sessions/cse_")) {
          hasSdkUrlCse = true;
          break;
        }
      }
    }
    if (!hasSdkUrlCse) return false;

    // Check parent process
    const statPath = path.join(procRoot, String(pid), "stat");
    const statStr = fs.readFileSync(statPath, "utf8");
    const stat = parseProcStat(statStr);
    if (!stat?.ppid) return false;

    const parentCmdlinePath = path.join(procRoot, String(stat.ppid), "cmdline");
    const parentCmdlineStr = fs.readFileSync(parentCmdlinePath, "utf8");
    const parentArgs = parseProcCmdline(parentCmdlineStr);

    // Parent argv after executable must contain rc or remote-control
    const afterExec = parentArgs.slice(1);
    return afterExec.some(
      (a) => a === "rc" || a === "remote-control" || a === "--remote-control",
    );
  } catch {
    return false;
  }
}

/**
 * Classifies session category: "background" | "rc" | "interactive" | "other"
 * @param {object} session
 * @param {string} procRoot
 * @param {typeof nodeFs} fs
 * @returns {"background" | "rc" | "interactive" | "other"}
 */
export function classifyCategory(session, procRoot = "/proc", fs = nodeFs) {
  if (session.kind === "bg") {
    return "background";
  }
  if (session.entrypoint === "sdk-cli") {
    if (isRcProcess(session.pid, procRoot, fs)) {
      return "rc";
    }
    return "other";
  }
  if (session.entrypoint === "cli" && session.kind !== "bg") {
    return "interactive";
  }
  return "other";
}

/**
 * Checks if a session is alive:
 * process.kill(pid, 0) succeeds AND (if procStart present and /proc/<pid>/stat readable)
 * field 22 of /proc/<pid>/stat equals procStart.
 * @param {number} pid
 * @param {string | number | null} procStart
 * @param {object} options
 * @returns {boolean}
 */
export function isSessionLive(
  pid,
  procStart,
  { isLive, procRoot = "/proc", fs = nodeFs } = {},
) {
  if (typeof isLive === "function") {
    if (!isLive(pid, procStart)) return false;
  } else {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
  }

  if (procStart != null && String(procStart).length > 0) {
    try {
      const statPath = path.join(procRoot, String(pid), "stat");
      const statStr = fs.readFileSync(statPath, "utf8");
      const stat = parseProcStat(statStr);
      if (stat && stat.procStart != null) {
        if (String(stat.procStart) !== String(procStart)) {
          return false;
        }
      }
    } catch {
      // If stat is unreadable, do not disqualify based solely on missing stat
    }
  }

  return true;
}

/**
 * Lists all live Claude sessions.
 * @param {object} options
 * @param {string} [options.configDir]
 * @param {string} [options.procRoot]
 * @param {Function} [options.isLive]
 * @param {typeof nodeFs} [options.fs]
 * @returns {Array<object>}
 */
export function listSessions({
  configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
  procRoot = "/proc",
  isLive,
  fs = nodeFs,
} = {}) {
  const sessionsDir = path.join(configDir, "sessions");
  let files;
  try {
    files = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const result = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(sessionsDir, file);
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed.pid !== "number") continue;

    if (!isSessionLive(parsed.pid, parsed.procStart, { isLive, procRoot, fs })) {
      continue;
    }

    const category = classifyCategory(parsed, procRoot, fs);
    const bridgeSessionId = parsed.bridgeSessionId ?? null;
    const url = bridgeSessionId ? `https://claude.ai/code/${bridgeSessionId}` : null;

    result.push({
      pid: parsed.pid,
      sessionId: parsed.sessionId ?? null,
      bridgeSessionId,
      url,
      cwd: parsed.cwd ?? "",
      name: parsed.name ?? "",
      status: parsed.status ?? "unknown",
      kind: parsed.kind ?? "unknown",
      entrypoint: parsed.entrypoint ?? "unknown",
      jobId: parsed.jobId ?? null,
      category,
    });
  }

  return result;
}

/**
 * Finds a live session by bridgeSessionId, sessionId, or URL.
 * Maps cse_X <-> session_X.
 * @param {Array<object>} sessions
 * @param {string} idOrUrl
 * @returns {object | null}
 */
export function findByBridgeId(sessions, idOrUrl) {
  if (!idOrUrl || !Array.isArray(sessions)) return null;

  let raw = String(idOrUrl).trim();
  raw = raw.split("#")[0].split("?")[0].trim();
  if (raw.includes("/")) {
    const codeMatch = raw.match(/\/code\/([^/]+)/);
    if (codeMatch) {
      raw = codeMatch[1];
    } else {
      raw = raw.substring(raw.lastIndexOf("/") + 1);
    }
  }

  const targetSuffix = raw.replace(/^(session_|cse_)/, "");

  for (const s of sessions) {
    if (s.bridgeSessionId === raw) return s;
    if (s.sessionId === raw) return s;
    if (s.jobId === raw) return s;
    if (s.bridgeSessionId) {
      const sSuffix = s.bridgeSessionId.replace(/^(session_|cse_)/, "");
      if (sSuffix === targetSuffix) return s;
    }
  }

  return null;
}
