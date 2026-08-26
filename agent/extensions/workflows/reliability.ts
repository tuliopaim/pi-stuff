import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentUsage } from "./model.ts";
import { writeFileAtomic } from "./serialization.ts";

/**
 * Reliability helpers for workflow runs: transient-error detection for one-shot
 * provider retries, usage merging across retry attempts, replay caches that let
 * a rerun of the same workflow skip already-completed agents, and budget
 * guardrails. Everything here is pure or filesystem-local so it can be unit
 * tested without a live session.
 */

/** Patterns matching transient upstream/provider failures worth one retry. */
const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /^5\d{2}\s*[:;]/, // "503: {...}", "500: internal"
  /^HTTP\s+5\d{2}\b/i, // "HTTP 503 Service Unavailable"
  /\b5\d{2}\s*(bad gateway|service unavailable|internal server error|gateway timeout)/i,
  /\bserver error\b/i,
  /upstream request failed/i,
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN)\b/,
  /socket hang up/i,
  /fetch failed/i,
  /\b429\s*[:;]/,
  /rate limit/i,
  /too many requests/i,
  /overloaded/i,
];

/**
 * Decide whether an agent failure looks like a transient provider/upstream
 * error (as opposed to aborts, schema misses, or genuine task failures).
 */
export function isTransientProviderError(error: string | undefined): boolean {
  if (!error) return false;
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

interface AgentFailure {
  ok: boolean;
  aborted: boolean;
  retryable?: boolean;
  error?: string;
}

/** Retry explicit retryable failures and recognized transient provider errors. */
export function shouldRetryAgentFailure(failure: AgentFailure): boolean {
  return (
    !failure.ok &&
    !failure.aborted &&
    (failure.retryable === true || isTransientProviderError(failure.error))
  );
}

/** Sum usage across attempts so telemetry reflects every provider request. */
export function mergeUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  const contextTokens =
    a.contextTokens !== undefined || b.contextTokens !== undefined
      ? Math.max(a.contextTokens ?? 0, b.contextTokens ?? 0)
      : undefined;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
    turns: a.turns + b.turns,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
}

/** Collision-resistant content hash rendered as hex (first 128 bits of SHA-256). */
function stableHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/**
 * Replay cache key for a run: the workflow's meta.name when present, else a
 * hash of the script source. Reruns of the same named workflow share a cache.
 */
export function replayKey(name: string | undefined, source: string): string {
  const basis = name?.trim() ? `name:${name.trim()}` : `source:${source}`;
  return stableHash(basis);
}

export function promptHash(prompt: string): string {
  return stableHash(prompt);
}

const REPLAY_MAX_IDS = 64;
/** Prompt variants remembered per id so interleaved rewordings don't evict each other. */
const REPLAY_VARIANTS_PER_ID = 4;
const REPLAY_OUTPUT_MAX_BYTES = 64 * 1024;
const REPLAY_FILE_MAX_BYTES = 8 * 1024 * 1024;

export interface ReplayEntry {
  promptHash: string;
  label?: string;
  ok: boolean;
  output: string;
  /** Preserved so replayed results still carry the truncation warning. */
  truncated?: boolean;
  structured?: unknown;
}

export type ReplayCache = Record<string, ReplayEntry[]>;

export function replayPath(baseDir: string, key: string): string {
  return path.join(baseDir, "replay", `${key}.json`);
}

/** Load a replay cache; any corruption or absence yields an empty cache. */
export function loadReplayCache(baseDir: string, key: string): ReplayCache {
  try {
    const empty: ReplayCache = Object.create(null);
    const raw = fs.readFileSync(replayPath(baseDir, key), "utf8");
    if (raw.length > REPLAY_FILE_MAX_BYTES) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return empty;
    }
    const cache: ReplayCache = Object.create(null);
    for (const [id, value] of Object.entries(parsed)) {
      // Accept both the current list shape and legacy single-entry objects.
      const entries = Array.isArray(value) ? value : [value];
      const valid: ReplayEntry[] = [];
      for (const candidate of entries) {
        if (!candidate || typeof candidate !== "object") continue;
        const item = candidate as Partial<ReplayEntry>;
        if (
          typeof item.promptHash !== "string" ||
          typeof item.ok !== "boolean" ||
          typeof item.output !== "string"
        ) {
          continue;
        }
        valid.push({
          promptHash: item.promptHash,
          ok: item.ok,
          output: item.output,
          ...(typeof item.label === "string" ? { label: item.label } : {}),
          ...(item.truncated === true ? { truncated: true } : {}),
          ...(item.structured !== undefined
            ? { structured: item.structured }
            : {}),
        });
      }
      if (valid.length > 0) cache[id] = valid.slice(-REPLAY_VARIANTS_PER_ID);
    }
    return cache;
  } catch {
    return Object.create(null);
  }
}

/**
 * Merge an entry into an in-memory replay cache: replace any existing variant
 * with the same prompt hash, then keep only the newest variants per id. Shared
 * by saveReplayEntry and the live in-run cache so both stay consistent.
 */
export function mergeReplayEntry(
  cache: ReplayCache,
  id: string,
  entry: ReplayEntry,
): void {
  const variants = (cache[id] ?? []).filter(
    (candidate) => candidate.promptHash !== entry.promptHash,
  );
  variants.push(entry);
  cache[id] = variants.slice(-REPLAY_VARIANTS_PER_ID);
}

/** Persist one completed entry; best-effort, bounded, never throws. */
export function saveReplayEntry(
  baseDir: string,
  key: string,
  id: string,
  entry: ReplayEntry,
): void {
  try {
    const cache = loadReplayCache(baseDir, key);
    const ids = Object.keys(cache);
    if (ids.length >= REPLAY_MAX_IDS && !(id in cache)) return;
    const boundedOutput =
      Buffer.byteLength(entry.output, "utf8") > REPLAY_OUTPUT_MAX_BYTES
        ? Buffer.from(entry.output, "utf8")
            .subarray(0, REPLAY_OUTPUT_MAX_BYTES)
            .toString("utf8")
        : entry.output;
    const stored: ReplayEntry = { ...entry, output: boundedOutput };
    mergeReplayEntry(cache, id, stored);
    writeFileAtomic(
      replayPath(baseDir, key),
      JSON.stringify(cache, null, 2),
    );
  } catch {
    // Replay persistence is opportunistic; losing it only costs tokens later.
  }
}

export interface WorkflowBudget {
  maxCost?: number;
  maxTokens?: number;
}

/** Validate a `meta.budget` literal; returns undefined when absent/invalid. */
export function sanitizeBudget(raw: unknown): WorkflowBudget | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as { maxCost?: unknown; maxTokens?: unknown };
  const budget: WorkflowBudget = {};
  if (typeof candidate.maxCost === "number" && candidate.maxCost > 0) {
    budget.maxCost = candidate.maxCost;
  }
  if (typeof candidate.maxTokens === "number" && candidate.maxTokens > 0) {
    budget.maxTokens = candidate.maxTokens;
  }
  return budget.maxCost !== undefined || budget.maxTokens !== undefined
    ? budget
    : undefined;
}

/**
 * Human-readable over-budget message, or undefined when within budget.
 * Token accounting uses billed volume (input + output + cache traffic).
 */
export function budgetExceededMessage(
  budget: WorkflowBudget | undefined,
  usage: AgentUsage,
): string | undefined {
  if (!budget) return undefined;
  const totalTokens =
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (budget.maxTokens !== undefined && totalTokens > budget.maxTokens) {
    return `Workflow budget exceeded: ${totalTokens.toLocaleString()} tokens used > maxTokens ${budget.maxTokens.toLocaleString()}`;
  }
  if (budget.maxCost !== undefined && usage.cost > budget.maxCost) {
    return `Workflow budget exceeded: $${usage.cost.toFixed(4)} cost > maxCost $${budget.maxCost}`;
  }
  return undefined;
}
