import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptRc, attachInNewTab } from "../lib/flows.js";
import { currentWorkspace } from "../lib/herdr.js";
import { findByBridgeId, listSessions } from "../lib/registry.js";

/** Shortens a filesystem path by replacing $HOME with ~. */
export function formatCwd(cwd) {
  if (!cwd) return "";
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

/** Categorizes sessions into TUI sections and builds a flat navigation list. */
export function buildSections(sessions) {
  const bg = sessions.filter((s) => s.category === "background");
  const rc = sessions.filter((s) => s.category === "rc");
  const term = sessions.filter((s) => s.category === "interactive");
  const sections = [
    { id: "bg", title: "En arrière-plan", items: bg },
    { id: "rc", title: "claude rc", items: rc },
    { id: "term", title: "Dans un terminal", items: term },
  ];
  return { sections, flatItems: [...bg, ...rc, ...term] };
}

/** Pure render function transforming state into terminal ANSI output. */
export function render(state) {
  const lines = [];
  if (state.view === "confirm") {
    const s = state.confirmSession;
    lines.push("\x1b[1;33m=== Confirmation de l'adoption (claude rc → herdr) ===\x1b[0m\n");
    lines.push(`Session : \x1b[1m${s.name || s.sessionId || "inconnue"}\x1b[0m (PID ${s.pid})`);
    lines.push(`Dossier : ${formatCwd(s.cwd)}`);
    lines.push(`Statut  : ${s.status}\n`);
    lines.push("\x1b[1;31mAttention :\x1b[0m");
    lines.push(`  • Le processus rc (PID ${s.pid}) va être arrêté proprement (SIGTERM).`);
    lines.push("  • L'historique de la session est intégralement conservé.");
    lines.push("  • L'URL claude.ai va CHANGER (nouvel identifiant bridge).");
    lines.push("  • L'ancienne URL ne doit plus être utilisée.\n");
    lines.push("\x1b[1mConfirmer l'adoption ?\x1b[0m");
    lines.push("  [y/o] Confirmer et ouvrir dans un nouvel onglet");
    lines.push("  [autre touche] Annuler");
    return lines.join("\n");
  }

  if (state.view === "result") {
    const r = state.resultInfo || {};
    lines.push(`\x1b[1;32m=== ${r.title || "Succès"} ===\x1b[0m\n`);
    if (r.details) lines.push(`  ${r.details}`);
    if (r.jobId) lines.push(`  Job ID       : \x1b[1m${r.jobId}\x1b[0m`);
    if (r.newUrl) lines.push(`  Nouvelle URL : \x1b[1;34m${r.newUrl}\x1b[0m`);
    if (r.oldUrl) lines.push(`  Ancienne URL : \x1b[90m${r.oldUrl} (obsolète)\x1b[0m`);
    lines.push("\nFermeture de la fenêtre en cours...");
    return lines.join("\n");
  }

  lines.push("\x1b[1m=== Sessions Claude Code ===\x1b[0m\n");
  if (!state.flatItems || state.flatItems.length === 0) {
    lines.push("Aucune session Claude active trouvée.\n");
    lines.push("\x1b[90m[r] Actualiser   [q/Échap] Quitter\x1b[0m");
    return lines.join("\n");
  }

  let indexOffset = 0;
  for (const section of state.sections) {
    lines.push(`\x1b[1;36m▼ ${section.title} (${section.items.length})\x1b[0m`);
    if (section.items.length === 0) {
      lines.push("    \x1b[90m(aucune session)\x1b[0m");
    } else {
      for (const item of section.items) {
        const isSelected = indexOffset === state.selectedIndex;
        const ptr = isSelected ? "❯ " : "  ";
        const idTag = item.jobId ?? (item.bridgeSessionId ? item.bridgeSessionId.slice(0, 16) : `pid:${item.pid}`);
        const col = item.status === "idle" ? "\x1b[32m" : "\x1b[33m";
        const row = `${ptr}${item.name || "sans-nom"}  ${col}[${item.status}]\x1b[0m  ${formatCwd(item.cwd)}  \x1b[90m(${idTag})\x1b[0m`;
        lines.push(isSelected ? `  \x1b[7m${row}\x1b[0m` : `  ${row}`);
        indexOffset++;
      }
    }
    lines.push("");
  }

  if (state.feedback) lines.push(`\x1b[33m! ${state.feedback}\x1b[0m\n`);
  lines.push("\x1b[90m[↑/↓/j/k] Naviguer  [Entrée] Sélectionner  [r] Actualiser  [q/Échap] Quitter\x1b[0m");
  return lines.join("\n");
}

/** Checks for a pending URL adoption request from open-url. */
export function checkPendingRequest(stateDir, sessions) {
  if (!stateDir) return null;
  const pendingFile = path.join(stateDir, "pending.json");
  try {
    if (fs.existsSync(pendingFile)) {
      const data = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
      try { fs.unlinkSync(pendingFile); } catch {}
      // Ignore a request left behind by a popup that never opened.
      const fresh = Date.now() - (data?.timestamp ?? 0) < 60_000;
      if (fresh && data?.url) return findByBridgeId(sessions, data.url);
    }
  } catch {}
  return null;
}

/** Interactive CLI runner for the picker popup pane. */
export async function run() {
  const isTTY = Boolean(process.stdin.isTTY);
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "herdr", "plugins", "claude-handoff");
  let sessions = listSessions();
  let { sections, flatItems } = buildSections(sessions);
  const state = { view: "list", sections, flatItems, selectedIndex: 0, confirmSession: null, resultInfo: null, feedback: null };
  const pending = checkPendingRequest(stateDir, sessions);
  if (pending && pending.category === "rc") {
    state.view = "confirm";
    state.confirmSession = pending;
  }

  function cleanup() {
    if (isTTY) {
      process.stdout.write("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
  function renderScreen() {
    if (isTTY) process.stdout.write("\x1b[2J\x1b[H\x1b[?25l" + render(state) + "\n");
  }

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  if (isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
  }
  renderScreen();

  process.stdin.on("data", async (chunk) => {
    const key = String(chunk);
    if (key === "\u0003") { cleanup(); process.exit(0); }
    if (state.view === "result") { cleanup(); process.exit(0); return; }

    if (state.view === "confirm") {
      if (key === "y" || key === "Y" || key === "o" || key === "O") {
        state.feedback = "Adoption en cours (arrêt du processus rc puis reprise en arrière-plan)...";
        renderScreen();
        try {
          const ws = currentWorkspace();
          const { jobId, newUrl, oldUrl } = await adoptRc({ session: state.confirmSession, workspaceId: ws });
          state.view = "result";
          state.resultInfo = { title: "Session adoptée avec succès", jobId, newUrl: newUrl || "(en cours d'attribution)", oldUrl: oldUrl || "(inconnue)" };
          renderScreen();
          setTimeout(() => { cleanup(); process.exit(0); }, 2000);
        } catch (err) {
          state.view = "list";
          state.feedback = `Erreur lors de l'adoption : ${err.message}`;
          renderScreen();
        }
      } else {
        state.view = "list";
        state.confirmSession = null;
        renderScreen();
      }
      return;
    }

    if (key === "q" || key === "\u001b") {
      cleanup(); process.exit(0);
    } else if (key === "\u001b[A" || key === "k") {
      if (state.flatItems.length > 0) {
        state.selectedIndex = (state.selectedIndex - 1 + state.flatItems.length) % state.flatItems.length;
        state.feedback = null;
        renderScreen();
      }
    } else if (key === "\u001b[B" || key === "j") {
      if (state.flatItems.length > 0) {
        state.selectedIndex = (state.selectedIndex + 1) % state.flatItems.length;
        state.feedback = null;
        renderScreen();
      }
    } else if (key === "r") {
      sessions = listSessions();
      const updated = buildSections(sessions);
      state.sections = updated.sections;
      state.flatItems = updated.flatItems;
      state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.flatItems.length - 1));
      state.feedback = "Sessions actualisées.";
      renderScreen();
    } else if (key === "\r" || key === "\n") {
      if (state.flatItems.length === 0) return;
      const selected = state.flatItems[state.selectedIndex];
      if (selected.category === "background") {
        try {
          const ws = currentWorkspace();
          attachInNewTab({ session: selected, workspaceId: ws });
          state.view = "result";
          state.resultInfo = { title: "Session attachée avec succès", details: `Session ${selected.jobId} ouverte dans un nouvel onglet.`, jobId: selected.jobId };
          renderScreen();
          setTimeout(() => { cleanup(); process.exit(0); }, 1800);
        } catch (err) {
          state.feedback = `Erreur d'attachement : ${err.message}`;
          renderScreen();
        }
      } else if (selected.category === "rc") {
        if (selected.status !== "idle") {
          state.feedback = `Adoption impossible : statut "${selected.status}" (inactif requis).`;
          renderScreen();
          return;
        }
        state.view = "confirm";
        state.confirmSession = selected;
        state.feedback = null;
        renderScreen();
      } else if (selected.category === "interactive") {
        state.feedback = `Session déjà active dans un terminal (PID ${selected.pid}, ${formatCwd(selected.cwd)}).`;
        renderScreen();
      }
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  run().catch((err) => {
    process.stderr.write(`Picker fatal error: ${err.message}\n`);
    process.exit(1);
  });
}
