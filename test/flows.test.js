import assert from "node:assert/strict";
import test from "node:test";
import { adoptRc, attachInNewTab, backgroundPane } from "../src/lib/flows.js";

test("attachInNewTab creates tab and runs claude attach <jobId>", () => {
  const calls = [];
  const fakeSession = {
    jobId: "c1d4c56e",
    name: "repos-test",
    cwd: "/root/repos/test",
  };

  const fakeTabCreate = (ws, cwd, label) => {
    calls.push({ fn: "tabCreate", ws, cwd, label });
    return {
      root_pane: { pane_id: "w1:t2:p1" },
      tab: { tab_id: "w1:t2" },
    };
  };

  const fakePaneRun = (paneId, cmd) => {
    calls.push({ fn: "paneRun", paneId, cmd });
  };

  const result = attachInNewTab({
    session: fakeSession,
    workspaceId: "w1",
    tabCreateFn: fakeTabCreate,
    paneRunFn: fakePaneRun,
  });

  assert.equal(result.tabId, "w1:t2");
  assert.equal(result.paneId, "w1:t2:p1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].fn, "tabCreate");
  assert.equal(calls[0].label, "claude:repos-test");
  assert.equal(calls[1].fn, "paneRun");
  assert.equal(calls[1].cmd, "claude attach c1d4c56e");
});

test("backgroundPane sends /bg when pane is claude and idle", () => {
  const calls = [];
  const fakePaneGet = (id) => ({
    agent: "claude",
    agent_status: "idle",
  });
  const fakeSendText = (id, text) => calls.push({ fn: "sendText", id, text });
  const fakeSendKeys = (id, key) => calls.push({ fn: "sendKeys", id, key });
  // An id left over from an earlier /bg must not be returned.
  let reads = 0;
  const fakePaneRead = (id, opts) =>
    opts?.source === "visible"
      ? "● OK\n❯ \n"
      : reads++ === 0
      ? "backgrounded · aaaaaaaa\n"
      : "backgrounded · aaaaaaaa\n/bg\nbackgrounded · e59d991b\n";

  const jobId = backgroundPane({
    paneId: "w1:t1:p1",
    paneGetFn: fakePaneGet,
    sendTextFn: fakeSendText,
    sendKeysFn: fakeSendKeys,
    paneReadFn: fakePaneRead,
    pollMs: 1,
    settleMs: 0,
  });

  assert.equal(jobId, "e59d991b");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { fn: "sendText", id: "w1:t1:p1", text: "/bg" });
  assert.deepEqual(calls[1], { fn: "sendKeys", id: "w1:t1:p1", key: "enter" });
});

test("backgroundPane refuses if agent is not claude or status is not idle", () => {
  // Not claude
  assert.throws(
    () =>
      backgroundPane({
        paneId: "p1",
        paneGetFn: () => ({ agent: "bash", agent_status: "idle" }),
      }),
    /Le panneau p1 doit exécuter Claude/,
  );

  // Claude but busy/working
  assert.throws(
    () =>
      backgroundPane({
        paneId: "p1",
        paneGetFn: () => ({ agent: "claude", agent_status: "working" }),
      }),
    /Le panneau p1 doit exécuter Claude/,
  );
});

test("adoptRc coordinates stopRcChild, backgroundResume, attachInNewTab, and waitForBridge", async () => {
  const steps = [];
  const fakeSession = {
    pid: 1778502,
    sessionId: "4a8d19f0-281c-43bc-a514-9fc3b851cecf",
    cwd: "/root/repos",
    category: "rc",
    status: "idle",
    bridgeSessionId: "cse_01oldbridge",
    url: "https://claude.ai/code/session_01oldbridge",
  };

  const fakeStopRcChild = async (s) => {
    steps.push(`stop:${s.pid}`);
    return true;
  };

  const fakeBackgroundResume = ({ sessionId, cwd }) => {
    steps.push(`resume:${sessionId}`);
    return { jobId: "c1d4c56e" };
  };

  const fakeAttachInNewTab = ({ session, workspaceId }) => {
    steps.push(`attach:${session.jobId}`);
    return { tabId: "w1:t3", paneId: "w1:t3:p1" };
  };

  const fakeWaitForBridge = async (jobId, ms) => {
    steps.push(`waitBridge:${jobId}`);
    return `https://claude.ai/code/session_01newbridge`;
  };

  const result = await adoptRc({
    session: fakeSession,
    workspaceId: "w1",
    stopRcChildFn: fakeStopRcChild,
    backgroundResumeFn: fakeBackgroundResume,
    attachInNewTabFn: fakeAttachInNewTab,
    waitForBridgeFn: fakeWaitForBridge,
  });

  assert.equal(result.jobId, "c1d4c56e");
  assert.equal(result.oldUrl, "https://claude.ai/code/session_01oldbridge");
  assert.equal(result.newUrl, "https://claude.ai/code/session_01newbridge");
  assert.deepEqual(steps, [
    "stop:1778502",
    "resume:4a8d19f0-281c-43bc-a514-9fc3b851cecf",
    "attach:c1d4c56e",
    "waitBridge:c1d4c56e",
  ]);
});

test("promptDraft reads the text typed after the last prompt marker", async () => {
  const { promptDraft } = await import("../src/lib/flows.js");
  assert.equal(promptDraft("● OK\n────\n❯ \n────\n  ⏵⏵ auto mode on"), "");
  assert.equal(promptDraft("❯ old prompt\n● OK\n❯ draft text   │\n"), "draft text");
  assert.equal(promptDraft("root@host:~# "), null);
});

test("backgroundPane refuses when the input box holds a draft", () => {
  assert.throws(
    () =>
      backgroundPane({
        paneId: "w1:p1",
        paneGetFn: () => ({ agent: "claude", agent_status: "idle" }),
        sendTextFn: () => assert.fail("must not type"),
        sendKeysFn: () => assert.fail("must not press keys"),
        paneReadFn: () => "❯ half-written message\n",
      }),
    /n'est pas vide/,
  );
});
