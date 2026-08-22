/**
 * Workflow ownership lease: a per-run, versioned owner.json written by the
 * process executing a workflow and read by resumed Pi processes to decide
 * whether a persisted `running` status is still actively owned.
 *
 * A resumed process must never restart, abort, or settle a workflow owned by
 * another process. It may only display externally-owned runs while their lease
 * heartbeat remains fresh.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./serialization.ts";

export const WORKFLOW_OWNERSHIP_VERSION = 1;
export const WORKFLOW_OWNERSHIP_HEARTBEAT_INTERVAL_MS = 1_000;
export const WORKFLOW_OWNERSHIP_LEASE_TIMEOUT_MS = 10_000;
const WORKFLOW_OWNERSHIP_MAX_BYTES = 16 * 1024;
const WORKFLOW_OWNERSHIP_FIELD_MAX_LENGTH = 256;

export interface WorkflowLease {
  version: number;
  runId: string;
  sessionId: string;
  ownerToken: string;
  pid: number;
  heartbeatAt: number;
}

export interface WorkflowOwnershipHandle {
  ownerToken: string;
  stop(): void;
}

interface ReadOwnershipResult {
  active: boolean;
  ownerToken?: string;
}

function ownerPath(runDir: string): string {
  return path.join(runDir, "owner.json");
}

function writeLease(runDir: string, lease: WorkflowLease): void {
  writeFileAtomic(ownerPath(runDir), JSON.stringify(lease, null, 2));
}

function readRawOwnership(runDir: string): { ok: true; lease: WorkflowLease } | { ok: false } {
  let raw: string;
  try {
    if (fs.statSync(ownerPath(runDir)).size > WORKFLOW_OWNERSHIP_MAX_BYTES) {
      return { ok: false };
    }
    raw = fs.readFileSync(ownerPath(runDir), "utf8");
  } catch {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false };
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== WORKFLOW_OWNERSHIP_VERSION ||
    typeof record.runId !== "string" ||
    !record.runId ||
    record.runId.length > WORKFLOW_OWNERSHIP_FIELD_MAX_LENGTH ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    record.sessionId.length > WORKFLOW_OWNERSHIP_FIELD_MAX_LENGTH ||
    typeof record.ownerToken !== "string" ||
    !record.ownerToken ||
    record.ownerToken.length > WORKFLOW_OWNERSHIP_FIELD_MAX_LENGTH ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.heartbeatAt !== "number" ||
    !Number.isFinite(record.heartbeatAt)
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    lease: {
      version: record.version,
      runId: record.runId,
      sessionId: record.sessionId,
      ownerToken: record.ownerToken,
      pid: record.pid,
      heartbeatAt: record.heartbeatAt,
    },
  };
}

/**
 * Create a fresh ownership lease and begin heartbeating.
 * The returned stop() clears the interval and removes owner.json only when
 * the token still matches, so one process cannot erase another's evidence.
 */
export function createWorkflowOwnership(options: {
  runDir: string;
  runId: string;
  sessionId: string;
  heartbeatIntervalMs?: number;
}): WorkflowOwnershipHandle {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? WORKFLOW_OWNERSHIP_HEARTBEAT_INTERVAL_MS;
  const ownerToken = randomBytes(16).toString("hex");
  const lease: WorkflowLease = {
    version: WORKFLOW_OWNERSHIP_VERSION,
    runId: options.runId,
    sessionId: options.sessionId,
    ownerToken,
    pid: process.pid,
    heartbeatAt: Date.now(),
  };
  writeLease(options.runDir, lease);

  const interval = setInterval(() => {
    lease.heartbeatAt = Date.now();
    try {
      writeLease(options.runDir, lease);
    } catch {
      // A failed heartbeat will eventually make the lease look stale to
      // observers; the owner process keeps running regardless.
    }
  }, heartbeatIntervalMs);
  interval.unref?.();

  return {
    ownerToken,
    stop() {
      clearInterval(interval);
      stopWorkflowOwnership({ runDir: options.runDir, ownerToken });
    },
  };
}

/**
 * Read an ownership lease and decide whether it is active evidence of
 * ownership for the requested run/session. A missing, malformed, mismatched,
 * or stale lease is not active evidence.
 */
export function readWorkflowOwnership(options: {
  runDir: string;
  runId: string;
  sessionId: string;
  leaseTimeoutMs?: number;
}): ReadOwnershipResult {
  const leaseTimeoutMs =
    options.leaseTimeoutMs ?? WORKFLOW_OWNERSHIP_LEASE_TIMEOUT_MS;
  const raw = readRawOwnership(options.runDir);
  if (!raw.ok) return { active: false };
  const { lease } = raw;
  if (lease.runId !== options.runId || lease.sessionId !== options.sessionId) {
    return { active: false };
  }
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM") return { active: false };
  }
  const age = Date.now() - lease.heartbeatAt;
  if (age > leaseTimeoutMs || age < -5_000) return { active: false };
  return { active: true, ownerToken: lease.ownerToken };
}

/**
 * Remove a lease file only when the stored token matches the one provided.
 * This prevents a late or resumed process from cleaning up another owner's
 * evidence.
 */
export function stopWorkflowOwnership(options: {
  runDir: string;
  ownerToken: string;
}): void {
  const raw = readRawOwnership(options.runDir);
  if (!raw.ok || raw.lease.ownerToken !== options.ownerToken) return;
  try {
    fs.unlinkSync(ownerPath(options.runDir));
  } catch {
    // Cleanup is best-effort; a stale lease will be ignored by readers.
  }
}
