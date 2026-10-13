import { spawnSync } from "node:child_process";

/**
 * Runs herdr CLI subcommand and returns parsed JSON result.
 * Throws on spawn error or non-zero exit code.
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.binPath]
 * @param {typeof spawnSync} [options.spawn]
 * @returns {any}
 */
export function herdr(args, { binPath = process.env.HERDR_BIN_PATH ?? "herdr", spawn = spawnSync } = {}) {
  const res = spawn(binPath, args, { encoding: "utf8" });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    const errOutput = (res.stderr || res.stdout || "").trim();
    throw new Error(`herdr exited with code ${res.status}: ${errOutput}`);
  }
  // Some commands (send-text, send-keys) print nothing on success.
  if (!res.stdout || !res.stdout.trim()) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`Failed to parse herdr output as JSON: ${err.message}\n${res.stdout}`);
  }
  return parsed.result !== undefined ? parsed.result : parsed;
}

/**
 * Runs a herdr CLI command whose stdout is plain text.
 * @param {string[]} args
 * @param {object} [options]
 * @returns {string}
 */
export function herdrText(args, { binPath = process.env.HERDR_BIN_PATH ?? "herdr", spawn = spawnSync } = {}) {
  const res = spawn(binPath, args, { encoding: "utf8" });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    const errOutput = (res.stderr || res.stdout || "").trim();
    throw new Error(`herdr exited with code ${res.status}: ${errOutput}`);
  }
  return res.stdout ?? "";
}

/**
 * Gets details for a pane.
 * @param {string} paneId
 * @param {object} [opts]
 * @returns {object}
 */
export function paneGet(paneId, opts) {
  const res = herdr(["pane", "get", paneId], opts);
  return res?.pane ?? res;
}

/**
 * Sends literal text to a pane.
 * @param {string} paneId
 * @param {string} text
 * @param {object} [opts]
 */
export function sendText(paneId, text, opts) {
  return herdr(["pane", "send-text", paneId, text], opts);
}

/**
 * Sends key presses to a pane.
 * @param {string} paneId
 * @param {string | string[]} key
 * @param {object} [opts]
 */
export function sendKeys(paneId, key, opts) {
  const keys = Array.isArray(key) ? key : [key];
  return herdr(["pane", "send-keys", paneId, ...keys], opts);
}

/**
 * Waits for matching output in a pane.
 * @param {string} paneId
 * @param {string} regex
 * @param {number} [ms]
 * @param {object} [opts]
 */
export function waitOutput(paneId, regex, ms, opts) {
  const args = ["pane", "wait-output", "--regex", regex, "--source", "recent"];
  if (ms !== undefined && ms !== null) {
    args.push("--timeout", String(ms));
  }
  args.push(paneId);
  return herdr(args, opts);
}

/**
 * Creates a tab in a workspace with focus.
 * @param {string} [ws]
 * @param {string} [cwd]
 * @param {string} [label]
 * @param {object} [opts]
 * @returns {object}
 */
export function tabCreate(ws, cwd, label, opts) {
  const args = ["tab", "create"];
  if (ws) args.push("--workspace", ws);
  if (cwd) args.push("--cwd", cwd);
  if (label) args.push("--label", label);
  args.push("--focus");
  return herdr(args, opts);
}

/**
 * Runs a command in a pane (text + Enter).
 * @param {string} paneId
 * @param {string} cmd
 * @param {object} [opts]
 */
export function paneRun(paneId, cmd, opts) {
  return herdr(["pane", "run", paneId, cmd], opts);
}

/**
 * Closes a pane.
 * @param {string} paneId
 * @param {object} [opts]
 */
export function paneClose(paneId, opts) {
  return herdr(["pane", "close", paneId], opts);
}

/**
 * Reads terminal output from a pane.
 * @param {string} paneId
 * @param {object} [readOpts]
 * @returns {any}
 */
export function paneRead(paneId, { source = "recent", lines = 40, format = "text", ...opts } = {}) {
  // `pane read` prints the pane text itself, not a JSON envelope.
  return herdrText(
    ["pane", "read", paneId, "--source", source, "--lines", String(lines), "--format", format],
    opts,
  );
}

/**
 * Shows a Herdr notification. Never throws.
 * @param {string} title
 * @param {string} [body]
 * @param {object} [opts]
 */
export function notify(title, body, opts) {
  try {
    const args = ["notification", "show", title];
    if (body) args.push("--body", body);
    return herdr(args, opts);
  } catch {
    return null;
  }
}

/**
 * Resolves the current workspace ID:
 * from HERDR_WORKSPACE_ID, else ctx.workspace_id, else focused workspace from workspace list.
 * @param {object} [ctx]
 * @param {object} [opts]
 * @returns {string | null}
 */
export function currentWorkspace(ctx = pluginContext(), opts) {
  if (process.env.HERDR_WORKSPACE_ID) {
    return process.env.HERDR_WORKSPACE_ID;
  }
  if (ctx?.workspace_id) {
    return ctx.workspace_id;
  }
  try {
    const res = herdr(["workspace", "list"], opts);
    const workspaces = res?.workspaces ?? res?.result?.workspaces ?? [];
    const focused = workspaces.find((w) => w.focused);
    return focused?.workspace_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Parses HERDR_PLUGIN_CONTEXT_JSON (popups only get their workspace from it).
 * @returns {object}
 */
export function pluginContext() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}") ?? {};
  } catch {
    return {};
  }
}
