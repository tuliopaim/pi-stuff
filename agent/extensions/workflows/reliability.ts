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

/** Stable FNV-1a 32-bit hash rendered as hex. Not cryptographic — collision avoidance only. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Replay cache key for a run: the workflow's meta.name when present, else a
 * hash of the script source. Reruns of the same named workflow share a cache.
 */
export function replayKey(name: string | undefined, source: string): string {
  const basis = name?.trim() ? `name:${name.trim()}` : `source:${source}`;
  return fnv1a(basis);
}

export function promptHash(prompt: string): string {
  return fnv1a(prompt);
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
  structured?: unknown;
}

export type ReplayCache = Record<string, ReplayEntry[]>;

export function replayPath(baseDir: string, key: string): string {
  return path.join(baseDir, "replay", `${key}.json`);
}

/** Load a replay cache; any corruption or absence yields an empty cache. */
export function loadReplayCache(baseDir: string, key: string): ReplayCache {
  try {
    const raw = fs.readFileSync(replayPath(baseDir, key), "utf8");
    if (raw.length > REPLAY_FILE_MAX_BYTES) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
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
          ...(item.structured !== undefined
            ? { structured: item.structured }
            : {}),
        });
      }
      if (valid.length > 0) cache[id] = valid.slice(-REPLAY_VARIANTS_PER_ID);
    }
    return cache;
  } catch {
    return {};
  }
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
    const variants = (cache[id] ?? []).filter(
      (candidate) => candidate.promptHash !== stored.promptHash,
    );
    variants.push(stored);
    cache[id] = variants.slice(-REPLAY_VARIANTS_PER_ID);
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
