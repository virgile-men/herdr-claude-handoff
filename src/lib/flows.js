import { backgroundResume, stopRcChild, waitForBridge } from "./claude.js";
import { paneGet, paneRead, paneRun, sendKeys, sendText, tabCreate } from "./herdr.js";

/**
 * Validates that an identifier contains only hexadecimal characters and hyphens.
 * Prevents shell injection or malformed command arguments.
 * @param {string} id
 * @returns {string}
 */
export function validateId(id) {
  if (typeof id !== "string" || !/^[0-9a-f-]+$/i.test(id)) {
    throw new Error(`Invalid identifier: "${id}". Expected format matching ^[0-9a-f-]+$`);
  }
  return id;
}

/**
 * Attaches a background Claude session in a new tab.
 * @param {object} options
 * @param {object} options.session
 * @param {string} [options.workspaceId]
 * @param {Function} [options.tabCreateFn]
 * @param {Function} [options.paneRunFn]
 * @returns {{ tabId: string | null, paneId: string | null }}
 */
export function attachInNewTab({
  session,
  workspaceId,
  tabCreateFn = tabCreate,
  paneRunFn = paneRun,
}) {
  if (!session?.jobId) {
    throw new Error("Cannot attach session without a jobId");
  }
  const jobId = validateId(session.jobId);
  const label = `claude:${session.name || jobId}`;
  const tabRes = tabCreateFn(workspaceId, session.cwd, label);

  const paneId =
    tabRes?.root_pane?.pane_id ??
    tabRes?.tab?.root_pane_id ??
    tabRes?.pane_id ??
    tabRes?.tab?.active_pane_id;

  if (paneId) {
    paneRunFn(paneId, `claude attach ${jobId}`);
  }

  return {
    tabId: tabRes?.tab?.tab_id ?? tabRes?.tab_id ?? null,
    paneId: paneId ?? null,
  };
}

/**
 * Adopts an rc child session into a native background session,
 * attaches it in a new tab, and waits for its bridge URL.
 * @param {object} options
 * @param {object} options.session
 * @param {string} [options.workspaceId]
 * @param {Function} [options.stopRcChildFn]
 * @param {Function} [options.backgroundResumeFn]
 * @param {Function} [options.attachInNewTabFn]
 * @param {Function} [options.waitForBridgeFn]
 * @returns {Promise<{ jobId: string, newUrl: string | null, oldUrl: string | null }>}
 */
export async function adoptRc({
  session,
  workspaceId,
  stopRcChildFn = stopRcChild,
  backgroundResumeFn = backgroundResume,
  attachInNewTabFn = attachInNewTab,
  waitForBridgeFn = waitForBridge,
}) {
  if (!session?.sessionId) {
    throw new Error("Cannot adopt session without sessionId");
  }
  const oldUrl =
    session.url ??
    (session.bridgeSessionId ? `https://claude.ai/code/${session.bridgeSessionId}` : null);

  validateId(session.sessionId);

  await stopRcChildFn(session);

  const resumeRes = backgroundResumeFn({
    sessionId: session.sessionId,
    cwd: session.cwd,
  });
  const jobId = validateId(resumeRes.jobId ?? resumeRes);

  attachInNewTabFn({
    session: { ...session, jobId },
    workspaceId,
  });

  const newUrl = await waitForBridgeFn(jobId, 15000);

  return { jobId, newUrl, oldUrl };
}

const BG_ID_RE = /backgrounded\s*·\s*([0-9a-f]{8})/gi;

/**
 * Lists the background job ids printed by `/bg` in a chunk of pane text.
 * @param {string} text
 * @returns {string[]}
 */
export function bgIdsIn(text) {
  return [...String(text ?? "").matchAll(BG_ID_RE)].map((m) => m[1].toLowerCase());
}

/**
 * Returns the text typed in Claude Code's input box, or null when no prompt
 * line is visible. The prompt line starts with "❯".
 * @param {string} screen
 * @returns {string | null}
 */
export function promptDraft(screen) {
  const lines = String(screen ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*❯\s?(.*)$/);
    if (m) return m[1].replace(/[│\s]+$/, "");
  }
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Sends /bg in a Claude pane and returns the resulting jobId.
 * Requires pane agent === "claude" and status "idle" or "done". Ids already on
 * screen from an earlier /bg are ignored, so only a new one counts.
 * @param {object} options
 * @param {string} options.paneId
 * @param {Function} [options.paneGetFn]
 * @param {Function} [options.sendTextFn]
 * @param {Function} [options.sendKeysFn]
 * @param {Function} [options.paneReadFn]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @param {number} [options.settleMs]
 * @returns {string} jobId
 */
export function backgroundPane({
  paneId,
  paneGetFn = paneGet,
  sendTextFn = sendText,
  sendKeysFn = sendKeys,
  paneReadFn = paneRead,
  timeoutMs = 20000,
  pollMs = 300,
  settleMs = 800,
}) {
  const pane = paneGetFn(paneId);
  const agent = pane?.agent ?? pane?.pane?.agent;
  const status = pane?.agent_status ?? pane?.pane?.agent_status;

  // herdr reports "done" for a Claude that finished its turn and has not been looked at yet.
  if (agent !== "claude" || !["idle", "done"].includes(status)) {
    throw new Error(
      `Le panneau ${paneId} doit exécuter Claude et être inactif (agent="${agent}", état="${status}").`,
    );
  }

  const draft = promptDraft(paneReadFn(paneId, { source: "visible", lines: 60 }));
  if (draft) {
    throw new Error(`Le champ de saisie du panneau ${paneId} n'est pas vide (« ${draft} ») : videz-le avant.`);
  }

  const read = () => paneReadFn(paneId, { source: "recent", lines: 80 });
  const before = new Set(bgIdsIn(read()));

  sendTextFn(paneId, "/bg");
  // Claude Code's slash-command menu needs a moment before Enter runs the command.
  sleepSync(settleMs);
  sendKeysFn(paneId, "enter");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const fresh = bgIdsIn(read()).filter((id) => !before.has(id));
    if (fresh.length > 0) {
      return validateId(fresh[fresh.length - 1]);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Pas de « backgrounded · <id> » dans le panneau ${paneId} après ${timeoutMs} ms.`);
    }
    sleepSync(pollMs);
  }
}
