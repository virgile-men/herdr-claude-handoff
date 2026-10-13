import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachInNewTab } from "../lib/flows.js";
import { currentWorkspace, notify } from "../lib/herdr.js";
import { findByBridgeId, listSessions } from "../lib/registry.js";

function resolveContext() {
  if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
    try {
      return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON);
    } catch {
      // ignore
    }
  }
  return {};
}

const ctx = resolveContext();
const url =
  process.env.HERDR_PLUGIN_CLICKED_URL ?? ctx.clicked_url ?? process.argv[2];

if (!url) {
  notify(
    "Claude: URL manquante",
    "Aucune URL fournie au gestionnaire de lien. / No URL provided to link handler.",
  );
  process.exit(1);
}

const sessions = listSessions();
const session = findByBridgeId(sessions, url);

if (!session) {
  notify(
    "Claude: session introuvable",
    "La session n'est pas en cours d'exécution sur cette machine. / Session is not running on this machine.",
  );
  process.exit(0);
}

if (session.category === "background") {
  const ws = currentWorkspace(ctx);
  attachInNewTab({ session, workspaceId: ws });
  notify(
    "Claude: session attachée",
    `Session ${session.jobId} ouverte dans un nouvel onglet. / Session ${session.jobId} opened in new tab.`,
  );
  process.exit(0);
}

if (session.category === "rc") {
  const stateDir =
    process.env.HERDR_PLUGIN_STATE_DIR ??
    path.join(os.homedir(), ".local", "state", "herdr", "plugins", "claude-handoff");

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "pending.json"),
      JSON.stringify({ url, pid: session.pid, sessionId: session.sessionId, timestamp: Date.now() }),
      "utf8",
    );
  } catch (err) {
    process.stderr.write(`Failed to write pending.json: ${err.message}\n`);
  }

  const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
  const pluginId = process.env.HERDR_PLUGIN_ID ?? "claude-handoff";
  spawnSync(
    herdrBin,
    ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "picker"],
    { stdio: "inherit" },
  );
  process.exit(0);
}

if (session.category === "interactive") {
  notify(
    "Claude: session déjà active",
    `La session est déjà ouverte dans un terminal (PID ${session.pid}, ${session.cwd}). / Session is already open in a terminal.`,
  );
  process.exit(0);
}

notify(
  "Claude: session non gérée",
  `Type de session non supporté (${session.category}). / Unsupported session type.`,
);
process.exit(0);
