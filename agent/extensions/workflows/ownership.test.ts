import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  createWorkflowOwnership,
  readWorkflowOwnership,
  stopWorkflowOwnership,
  WORKFLOW_OWNERSHIP_HEARTBEAT_INTERVAL_MS,
  WORKFLOW_OWNERSHIP_LEASE_TIMEOUT_MS,
} from "./ownership.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-workflow-ownership-"));
}

test("fresh lease is active and contains run/session metadata", () => {
  const dir = tempDir();
  try {
    const ownership = createWorkflowOwnership({
      runDir: dir,
      runId: "wf_active",
      sessionId: "session_active",
    });
    assert.ok(ownership.ownerToken.length > 0);

    const status = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_active",
      sessionId: "session_active",
    });
    assert.equal(status.active, true);
    assert.equal(status.ownerToken, ownership.ownerToken);

    const raw = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
    assert.equal(raw.runId, "wf_active");
    assert.equal(raw.sessionId, "session_active");
    assert.equal(raw.pid, process.pid);
    assert.equal(typeof raw.heartbeatAt, "number");

    ownership.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heartbeat refreshes lease age", async () => {
  const dir = tempDir();
  try {
    const ownership = createWorkflowOwnership({
      runDir: dir,
      runId: "wf_heartbeat",
      sessionId: "session_heartbeat",
      heartbeatIntervalMs: 20,
    });
    await delay(60);

    const status = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_heartbeat",
      sessionId: "session_heartbeat",
      leaseTimeoutMs: 100,
    });
    assert.equal(status.active, true);

    ownership.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale lease is rejected", async () => {
  const dir = tempDir();
  try {
    const ownership = createWorkflowOwnership({
      runDir: dir,
      runId: "wf_stale",
      sessionId: "session_stale",
      heartbeatIntervalMs: 1_000,
    });
    ownership.stop();

    const immediately = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_stale",
      sessionId: "session_stale",
      leaseTimeoutMs: 0,
    });
    assert.equal(immediately.active, false);

    writeFileSync(
      join(dir, "owner.json"),
      JSON.stringify({
        version: 1,
        runId: "wf_stale",
        sessionId: "session_stale",
        ownerToken: "old",
        pid: 1,
        heartbeatAt: Date.now() - WORKFLOW_OWNERSHIP_LEASE_TIMEOUT_MS - 1,
      }),
    );
    const aged = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_stale",
      sessionId: "session_stale",
    });
    assert.equal(aged.active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed lease is rejected", () => {
  const dir = tempDir();
  try {
    for (const content of [
      "not json",
      JSON.stringify({ version: 1 }),
      JSON.stringify({
        version: 1,
        runId: "wf_malformed",
        sessionId: "session_malformed",
        ownerToken: "",
        pid: 1,
        heartbeatAt: Date.now(),
      }),
    ]) {
      writeFileSync(join(dir, "owner.json"), content);
      const status = readWorkflowOwnership({
        runDir: dir,
        runId: "wf_malformed",
        sessionId: "session_malformed",
      });
      assert.equal(status.active, false, `content: ${content}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized lease is rejected without parsing it", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "owner.json"), " ".repeat(20 * 1024));
    const status = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_oversized",
      sessionId: "session_oversized",
    });
    assert.equal(status.active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mismatched run or session is rejected", () => {
  const dir = tempDir();
  try {
    const ownership = createWorkflowOwnership({
      runDir: dir,
      runId: "wf_owned",
      sessionId: "session_owned",
    });

    const wrongRun = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_other",
      sessionId: "session_owned",
    });
    assert.equal(wrongRun.active, false);

    const wrongSession = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_owned",
      sessionId: "session_other",
    });
    assert.equal(wrongSession.active, false);
    ownership.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh lease from a dead owner process is rejected", () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "owner.json"),
      JSON.stringify({
        version: 1,
        runId: "wf_dead",
        sessionId: "session_dead",
        ownerToken: "dead-owner",
        pid: 2_147_483_647,
        heartbeatAt: Date.now(),
      }),
    );
    const status = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_dead",
      sessionId: "session_dead",
    });
    assert.equal(status.active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopWorkflowOwnership removes only when token matches", () => {
  const dir = tempDir();
  try {
    const first = createWorkflowOwnership({
      runDir: dir,
      runId: "wf_token",
      sessionId: "session_token",
    });

    stopWorkflowOwnership({ runDir: dir, ownerToken: "wrong-token" });
    const stillActive = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_token",
      sessionId: "session_token",
    });
    assert.equal(stillActive.active, true);
    assert.equal(stillActive.ownerToken, first.ownerToken);

    first.stop();
    const removed = readWorkflowOwnership({
      runDir: dir,
      runId: "wf_token",
      sessionId: "session_token",
    });
    assert.equal(removed.active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default heartbeat interval matches ownership constants", () => {
  assert.equal(WORKFLOW_OWNERSHIP_HEARTBEAT_INTERVAL_MS, 1_000);
  assert.equal(WORKFLOW_OWNERSHIP_LEASE_TIMEOUT_MS, 10_000);
});
