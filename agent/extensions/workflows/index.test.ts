import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import registerWorkflows from "./index.ts";
import { createWorkflowOwnership } from "./ownership.ts";

interface Harness {
  events: Map<string, (event: unknown, ctx: unknown) => void>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  status: Array<{ running: number; done: number; failed: number } | undefined>;
  messages: unknown[];
}

function createHarness(): Harness {
  const events = new Map<string, (event: unknown, ctx: unknown) => void>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const status: Array<{ running: number; done: number; failed: number } | undefined> = [];
  const messages: unknown[] = [];
  registerWorkflows({
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      events.set(name, handler);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    registerTool() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    sendUserMessage(message: unknown) {
      messages.push(message);
    },
  } as any);
  return { events, commands, status, messages };
}

function makeCtx(
  sessionId: string,
  mode: "tui" | "headless" = "headless",
  status: unknown[] = [],
): any {
  return {
    mode,
    hasUI: mode === "tui",
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setStatus(_key: string, value: { running: number; done: number; failed: number } | undefined) {
        status.push(value);
      },
      notify() {},
    },
  };
}

function createRunDir(agentDir: string, runId: string, sessionId: string, status: string): string {
  const runDir = join(agentDir, "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "workflow.json"),
    JSON.stringify({
      runId,
      sessionId,
      status,
      background: true,
      startedAt: Date.now(),
      phases: [],
      agents: [],
    }),
  );
  return runDir;
}

async function withAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-index-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("session_start observes a fresh external run and treats it as running", async () => {
  await withAgentDir(async (agentDir) => {
    const harness = createHarness();
    const sessionId = "session_fresh";
    const runId = "wf_fresh_external";
    const runDir = createRunDir(agentDir, runId, sessionId, "running");
    const ownership = createWorkflowOwnership({ runDir, runId, sessionId });

    const ctx = makeCtx(sessionId);
    harness.events.get("session_start")?.({}, ctx);

    const listed = await listWorkflows(harness, ctx);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.runId, runId);
    assert.equal(listed[0]?.status, "running");
    assert.equal(listed[0]?.active, true);
    await harness.events.get("session_shutdown")?.({}, ctx);
    ownership.stop();
  });
});

test("session_start restores the footer indicator for an external run", async () => {
  await withAgentDir(async (agentDir) => {
    const harness = createHarness();
    const sessionId = "session_indicator";
    const runId = "wf_indicator_external";
    const runDir = createRunDir(agentDir, runId, sessionId, "running");
    const ownership = createWorkflowOwnership({ runDir, runId, sessionId });
    const statuses: unknown[] = [];
    const ctx = makeCtx(sessionId, "tui", statuses);

    harness.events.get("session_start")?.({}, ctx);

    assert.match(String(statuses.at(-1)), /1 running/);
    assert.match(String(statuses.at(-1)), /\/workflows to view/);
    await harness.events.get("session_shutdown")?.({}, ctx);
    assert.equal(statuses.at(-1), undefined);
    ownership.stop();
  });
});

test("session_start ignores a stale running run and dashboard falls back to aborted", async () => {
  await withAgentDir(async (agentDir) => {
    const harness = createHarness();
    const sessionId = "session_stale";
    const runId = "wf_stale_external";
    const runDir = createRunDir(agentDir, runId, sessionId, "running");
    writeFileSync(
      join(runDir, "owner.json"),
      JSON.stringify({
        version: 1,
        runId,
        sessionId,
        ownerToken: "old",
        pid: 1,
        heartbeatAt: Date.now() - 20_000,
      }),
    );

    const ctx = makeCtx(sessionId);
    harness.events.get("session_start")?.({}, ctx);

    const listed = await listWorkflows(harness, ctx);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, "aborted");
    assert.equal(listed[0]?.active, false);
    const detailMessages: string[] = [];
    await harness.commands.get("workflows")?.handler(runId, {
      ...ctx,
      ui: {
        ...ctx.ui,
        notify(message: string) {
          detailMessages.push(message);
        },
      },
    });
    assert.match(detailMessages.at(-1) ?? "", /aborted/);
    assert.doesNotMatch(detailMessages.at(-1) ?? "", /status: running/);
    await harness.events.get("session_shutdown")?.({}, ctx);
  });
});

test("observer discovers a fresh owner lease created after session_start", async () => {
  process.env.PI_WORKFLOW_OBSERVER_INTERVAL_MS = "50";
  try {
    await withAgentDir(async (agentDir) => {
      const harness = createHarness();
      const sessionId = "session_late_lease";
      const runId = "wf_late_lease";
      const runDir = createRunDir(agentDir, runId, sessionId, "running");
      const ctx = makeCtx(sessionId);
      harness.events.get("session_start")?.({}, ctx);

      let listed = await listWorkflows(harness, ctx);
      assert.equal(listed[0]?.status, "aborted");
      assert.equal(listed[0]?.active, false);

      const ownership = createWorkflowOwnership({ runDir, runId, sessionId });
      await delay(150);
      listed = await listWorkflows(harness, ctx);
      assert.equal(listed[0]?.status, "running");
      assert.equal(listed[0]?.active, true);
      await harness.events.get("session_shutdown")?.({}, ctx);
      ownership.stop();
    });
  } finally {
    delete process.env.PI_WORKFLOW_OBSERVER_INTERVAL_MS;
  }
});

test("observer follows persisted completion of an external run", async () => {
  process.env.PI_WORKFLOW_OBSERVER_INTERVAL_MS = "50";
  try {
    await withAgentDir(async (agentDir) => {
      const harness = createHarness();
      const sessionId = "session_complete";
      const runId = "wf_complete_external";
      const runDir = createRunDir(agentDir, runId, sessionId, "running");
      const ownership = createWorkflowOwnership({ runDir, runId, sessionId });

      const ctx = makeCtx(sessionId);
      harness.events.get("session_start")?.({}, ctx);
      let listed = await listWorkflows(harness, ctx);
      assert.equal(listed[0]?.status, "running");

      writeFileSync(
        join(runDir, "workflow.json"),
        JSON.stringify({
          runId,
          sessionId,
          status: "completed",
          background: true,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          phases: [],
          agents: [],
        }),
      );

      await delay(150);
      listed = await listWorkflows(harness, ctx);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.status, "completed");
      assert.equal(listed[0]?.active, false);
      await harness.events.get("session_shutdown")?.({}, ctx);
      ownership.stop();
    });
  } finally {
    delete process.env.PI_WORKFLOW_OBSERVER_INTERVAL_MS;
  }
});

test("observer stops claiming an orphaned run without rewriting its artifact", async () => {
  process.env.PI_WORKFLOW_OBSERVER_INTERVAL_MS = "50";
  try {
    await withAgentDir(async (agentDir) => {
      const harness = createHarness();
      const sessionId = "session_orphan";
      const runId = "wf_orphan_external";
      const runDir = createRunDir(agentDir, runId, sessionId, "running");
      const ownership = createWorkflowOwnership({ runDir, runId, sessionId });

      const ctx = makeCtx(sessionId);
      harness.events.get("session_start")?.({}, ctx);
      let listed = await listWorkflows(harness, ctx);
      assert.equal(listed[0]?.status, "running");

      ownership.stop();
      writeFileSync(
        join(runDir, "owner.json"),
        JSON.stringify({
          version: 1,
          runId,
          sessionId,
          ownerToken: ownership.ownerToken,
          pid: 1,
          heartbeatAt: Date.now() - 10_000,
        }),
      );
      await delay(150);

      listed = await listWorkflows(harness, ctx);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.status, "aborted");
      assert.equal(listed[0]?.active, false);
      const workflow = JSON.parse(readFileSync(join(runDir, "workflow.json"), "utf8"));
      assert.equal(workflow.status, "running");
      await harness.events.get("session_shutdown")?.({}, ctx);
    });
  } finally {
    delete process.env.PI_WORKFLOW_OBSERVER_INTERVAL_MS;
  }
});

test("session_shutdown clears observed runs without removing external leases", async () => {
  await withAgentDir(async (agentDir) => {
    const harness = createHarness();
    const sessionId = "session_shutdown";
    const runId = "wf_shutdown_external";
    const runDir = createRunDir(agentDir, runId, sessionId, "running");
    const ownership = createWorkflowOwnership({ runDir, runId, sessionId });

    const ctx = makeCtx(sessionId);
    harness.events.get("session_start")?.({}, ctx);
    let listed = await listWorkflows(harness, ctx);
    assert.equal(listed[0]?.status, "running");

    await harness.events.get("session_shutdown")?.({}, ctx);

    listed = await listWorkflows(harness, ctx);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.active, false);
    assert.doesNotThrow(() => readFileSync(join(runDir, "owner.json"), "utf8"));
    ownership.stop();
  });
});

async function listWorkflows(harness: Harness, ctx: any): Promise<Array<{ runId: string; status: string; active: boolean }>> {
  const lines: string[] = [];
  const captureCtx = {
    ...ctx,
    ui: {
      ...ctx.ui,
      notify(message: string) {
        lines.push(...message.split("\n"));
      },
    },
  };
  await harness.commands.get("workflows")?.handler("", captureCtx);
  return lines
    .map((line) => {
      const match = line.match(/^\s*[*]?\s+(wf_\S+)\s+(\S+)/);
      if (!match) return undefined;
      return { runId: match[1]!, status: match[2]!, active: line.trim().startsWith("*") };
    })
    .filter((entry): entry is { runId: string; status: string; active: boolean } => entry !== undefined);
}
