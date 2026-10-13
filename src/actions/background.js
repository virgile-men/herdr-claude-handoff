import { backgroundPane } from "../lib/flows.js";
import { notify } from "../lib/herdr.js";

function resolvePaneId() {
  if (process.env.HERDR_PANE_ID) {
    return process.env.HERDR_PANE_ID;
  }
  if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
    try {
      const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON);
      return ctx.pane_id ?? ctx.focused_pane_id ?? null;
    } catch {
      // ignore
    }
  }
  return null;
}

const paneId = resolvePaneId();

if (!paneId) {
  notify(
    "Claude: aucun panneau",
    "Aucun panneau cible trouvé pour la commande. / No target pane found for command.",
  );
  process.exit(1);
}

try {
  const jobId = backgroundPane({ paneId });
  notify(
    "Claude: session en arrière-plan",
    `Session ${jobId} en arrière-plan — \`claude attach ${jobId}\` / Session ${jobId} backgrounded — \`claude attach ${jobId}\``,
  );
  process.exit(0);
} catch (err) {
  notify(
    "Claude: échec du passage en arrière-plan",
    err.message,
  );
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
