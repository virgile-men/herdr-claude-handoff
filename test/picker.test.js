import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSections,
  checkPendingRequest,
  formatCwd,
  render,
} from "../src/popup/picker.js";

test("formatCwd shortens home directory to ~", () => {
  const home = os.homedir();
  assert.equal(formatCwd(home), "~");
  assert.equal(formatCwd(path.join(home, "projects", "test")), "~/projects/test");
  assert.equal(formatCwd("/tmp/scratch"), "/tmp/scratch");
  assert.equal(formatCwd(""), "");
});

test("buildSections partitions sessions into three sections and flat list", () => {
  const sessions = [
    { pid: 1, name: "bg-1", category: "background", status: "idle" },
    { pid: 2, name: "rc-1", category: "rc", status: "idle" },
    { pid: 3, name: "term-1", category: "interactive", status: "busy" },
    { pid: 4, name: "bg-2", category: "background", status: "idle" },
  ];

  const { sections, flatItems } = buildSections(sessions);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].title, "En arrière-plan");
  assert.equal(sections[0].items.length, 2);
  assert.equal(sections[1].title, "claude rc");
  assert.equal(sections[1].items.length, 1);
  assert.equal(sections[2].title, "Dans un terminal");
  assert.equal(sections[2].items.length, 1);

  assert.equal(flatItems.length, 4);
  assert.equal(flatItems[0].name, "bg-1");
  assert.equal(flatItems[1].name, "bg-2");
  assert.equal(flatItems[2].name, "rc-1");
  assert.equal(flatItems[3].name, "term-1");
});

test("render renders empty state when no sessions are active", () => {
  const output = render({
    view: "list",
    sections: [],
    flatItems: [],
    selectedIndex: 0,
  });

  assert.match(output, /Sessions Claude Code/);
  assert.match(output, /Aucune session Claude active trouvée/);
  assert.match(output, /\[r\] Actualiser/);
  assert.match(output, /\[q\/Échap\] Quitter/);
});

test("render renders list with section headers and highlights selection", () => {
  const sessions = [
    {
      pid: 100,
      name: "task-bg",
      category: "background",
      status: "idle",
      cwd: "/root/repos",
      jobId: "a1b2c3d4",
    },
    {
      pid: 200,
      name: "task-rc",
      category: "rc",
      status: "idle",
      cwd: "/root/repos",
      bridgeSessionId: "session_01ABC",
    },
  ];
  const { sections, flatItems } = buildSections(sessions);
  const output = render({
    view: "list",
    sections,
    flatItems,
    selectedIndex: 0,
    feedback: null,
  });

  assert.match(output, /En arrière-plan \(1\)/);
  assert.match(output, /claude rc \(1\)/);
  assert.match(output, /Dans un terminal \(0\)/);
  assert.match(output, /task-bg/);
  assert.match(output, /a1b2c3d4/);
  // Highlighting code check
  assert.match(output, /\x1b\[7m/);
});

test("render renders confirmation dialog with warnings and adoption instructions", () => {
  const output = render({
    view: "confirm",
    confirmSession: {
      pid: 300,
      name: "worker-rc",
      cwd: "/root/repos/test",
      status: "idle",
    },
  });

  assert.match(output, /Confirmation de l'adoption/);
  assert.match(output, /PID 300/);
  assert.match(output, /Le processus rc \(PID 300\) va être arrêté proprement/);
  assert.match(output, /L'historique de la session est intégralement conservé/);
  assert.match(output, /L'URL claude\.ai va CHANGER/);
  assert.match(output, /L'ancienne URL ne doit plus être utilisée/);
  assert.match(output, /\[y\/o\] Confirmer et ouvrir/);
  assert.match(output, /\[autre touche\] Annuler/);
});

test("render renders result view with job and URL metadata", () => {
  const output = render({
    view: "result",
    resultInfo: {
      title: "Session adoptée avec succès",
      jobId: "e59d991b",
      newUrl: "https://claude.ai/code/session_NEW",
      oldUrl: "https://claude.ai/code/session_OLD",
    },
  });

  assert.match(output, /Session adoptée avec succès/);
  assert.match(output, /Job ID\s+:\s+.*e59d991b/);
  assert.match(output, /Nouvelle URL\s+:\s+.*https:\/\/claude\.ai\/code\/session_NEW/);
  assert.match(output, /Ancienne URL\s+:\s+.*https:\/\/claude\.ai\/code\/session_OLD \(obsolète\)/);
  assert.match(output, /Fermeture de la fenêtre en cours/);
});

test("checkPendingRequest finds matching session and deletes pending.json", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-state-"));
  try {
    const pendingFile = path.join(tmp, "pending.json");
    fs.writeFileSync(
      pendingFile,
      JSON.stringify({ url: "https://claude.ai/code/session_01XYZ", timestamp: Date.now() }),
      "utf8",
    );

    const sessions = [
      { pid: 50, bridgeSessionId: "session_01XYZ", category: "rc" },
    ];

    const match = checkPendingRequest(tmp, sessions);
    assert.equal(match?.pid, 50);
    // Verify file was cleaned up
    assert.equal(fs.existsSync(pendingFile), false);

    // Subsequent call returns null
    assert.equal(checkPendingRequest(tmp, sessions), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
