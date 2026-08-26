import assert from "node:assert/strict";
import * as fs from "node:fs";
const { mkdtempSync, rmSync } = fs;
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  budgetExceededMessage,
  isTransientProviderError,
  shouldRetryAgentFailure,
  loadReplayCache,
  mergeReplayEntry,
  mergeUsage,
  promptHash,
  replayKey,
  replayPath,
  sanitizeBudget,
  saveReplayEntry,
} from "./reliability.ts";
import { emptyUsage } from "./model.ts";

test("isTransientProviderError matches upstream/provider failures", () => {
  const transient = [
    '503: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}',
    "HTTP 503 Service Unavailable",
    "502 Bad Gateway",
    "504 Gateway Timeout from upstream",
    "500: internal server error",
    "upstream request failed for unknown reason",
    "fetch failed",
    "Error: ECONNRESET",
    "connect ETIMEDOUT 1.2.3.4:443",
    "socket hang up",
    "429: too many requests",
    "rate limit exceeded",
    "provider is overloaded",
  ];
  for (const error of transient) {
    assert.equal(isTransientProviderError(error), true, error);
  }
});

test("shouldRetryAgentFailure honors structured retryable failures", () => {
  assert.equal(
    shouldRetryAgentFailure({
      ok: false,
      aborted: false,
      retryable: true,
      error: "first response timeout",
    }),
    true,
  );
  assert.equal(
    shouldRetryAgentFailure({
      ok: false,
      aborted: true,
      retryable: true,
      error: "first response timeout",
    }),
    false,
  );
});

test("isTransientProviderError rejects aborts, schema misses, and task errors", () => {
  const permanent = [
    undefined,
    "",
    "Agent was aborted",
    "Agent finished without calling structured_output; no structured result matching the schema was produced.",
    "`model` must include its provider (use `provider/model-id`)",
    "unknown model \"nope/nope\" (use provider/id)",
    "openai-codex/gpt-5.6-sol:max is not in the active preset routes.",
    "Agent failed",
  ];
  for (const error of permanent) {
    assert.equal(isTransientProviderError(error), false, String(error));
  }
});

test("mergeUsage sums billing fields and keeps the max contextTokens", () => {
  const merged = mergeUsage(
    { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, cost: 0.01, turns: 3, contextTokens: 40 },
    { input: 20, output: 7, cacheRead: 50, cacheWrite: 0, cost: 0.02, turns: 4, contextTokens: 30 },
  );
  assert.deepEqual(merged, {
    input: 30,
    output: 12,
    cacheRead: 150,
    cacheWrite: 2,
    cost: 0.03,
    turns: 7,
    contextTokens: 40,
  });
});

test("mergeUsage omits contextTokens when neither side has it", () => {
  const merged = mergeUsage(emptyUsage(), emptyUsage());
  assert.equal("contextTokens" in merged, false);
});

test("replayKey is stable per name and differs across names", () => {
  assert.equal(replayKey("my-workflow", "source"), replayKey(" my-workflow ", "other"));
  assert.notEqual(replayKey("a", "source"), replayKey("b", "source"));
});

test("replayKey falls back to source hash when unnamed", () => {
  assert.equal(replayKey(undefined, "script-a"), replayKey("", "script-a"));
  assert.notEqual(replayKey(undefined, "script-a"), replayKey(undefined, "script-b"));
});

test("promptHash changes when the prompt changes", () => {
  assert.equal(promptHash("same"), promptHash("same"));
  assert.notEqual(promptHash("same"), promptHash("same "));
});

test("replay cache round-trips entries through the filesystem", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "wf-replay-"));
  try {
    const key = replayKey("wf-test", "src");
    saveReplayEntry(base, key, "step-1", {
      promptHash: promptHash("do a thing"),
      label: "recon",
      ok: true,
      output: "the thing was done",
      truncated: true,
      structured: { files: ["a.ts"] },
    });
    const cache = loadReplayCache(base, key);
    assert.equal(cache["step-1"][0].ok, true);
    assert.equal(cache["step-1"][0].output, "the thing was done");
    assert.equal(cache["step-1"][0].truncated, true);
    assert.deepEqual(cache["step-1"][0].structured, { files: ["a.ts"] });
    assert.equal(replayPath(base, key), path.join(base, "replay", `${key}.json`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadReplayCache returns an empty cache for missing or corrupt files", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "wf-replay-"));
  try {
    const key = replayKey("missing", "x");
    assert.equal(Object.keys(loadReplayCache(base, key)).length, 0);
    mkdirReplayWith(base, `${key}.json`, "{ not json !!!");
    assert.equal(Object.keys(loadReplayCache(base, key)).length, 0);
    mkdirReplayWith(base, `${key}.json`, JSON.stringify({ bad: { nope: 1 } }));
    assert.equal(Object.keys(loadReplayCache(base, key)).length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("saveReplayEntry caps stored output size and entry count", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "wf-replay-"));
  try {
    const key = replayKey("caps", "x");
    saveReplayEntry(base, key, "big", {
      promptHash: "h",
      ok: true,
      output: "x".repeat(128 * 1024),
    });
    const cache = loadReplayCache(base, key);
    const byteLength = Buffer.byteLength(cache["big"][0].output, "utf8");
    assert.ok(byteLength <= 64 * 1024, `output not bounded: ${byteLength}`);

    for (let i = 0; i < 70; i++) {
      saveReplayEntry(base, key, `entry-${i}`, {
        promptHash: `hash-${i}`,
        ok: true,
        output: `out-${i}`,
      });
    }
    const reloaded = loadReplayCache(base, key);
    assert.ok(Object.keys(reloaded).length <= 65);
    // Original entry survives cap churn.
    assert.ok("big" in reloaded);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("sanitizeBudget accepts positive numbers only", () => {
  assert.equal(sanitizeBudget(undefined), undefined);
  assert.equal(sanitizeBudget("budget"), undefined);
  assert.equal(sanitizeBudget({}), undefined);
  assert.equal(sanitizeBudget({ maxCost: -1 }), undefined);
  assert.deepEqual(sanitizeBudget({ maxCost: 5 }), { maxCost: 5 });
  assert.deepEqual(sanitizeBudget({ maxTokens: 1_000_000 }), { maxTokens: 1_000_000 });
  assert.deepEqual(
    sanitizeBudget({ maxCost: 2, maxTokens: 500, junk: true }),
    { maxCost: 2, maxTokens: 500 },
  );
});

test("budgetExceededMessage reports token and cost overruns separately", () => {
  const usage = (over: Partial<ReturnType<typeof emptyUsage>>) => ({
    ...emptyUsage(),
    ...over,
  });
  assert.equal(budgetExceededMessage(undefined, usage({ cost: 999 })), undefined);

  const tokensOnly = budgetExceededMessage(
    { maxTokens: 100 },
    usage({ input: 60, output: 60 }),
  );
  assert.match(tokensOnly!, /tokens used > maxTokens 100/);

  const costOnly = budgetExceededMessage(
    { maxCost: 1 },
    usage({ cost: 1.5 }),
  );
  assert.match(costOnly!, /cost > maxCost \$1/);

  // Token breach takes precedence.
  const both = budgetExceededMessage(
    { maxCost: 1, maxTokens: 100 },
    usage({ input: 200, cost: 2 }),
  );
  assert.match(both!, /tokens used/);
});

function mkdirReplayWith(base: string, fileName: string, content: string) {
  fs.mkdirSync(path.join(base, "replay"), { recursive: true });
  fs.writeFileSync(path.join(base, "replay", fileName), content);
}

test("saveReplayEntry keeps distinct prompt variants per id without evicting each other", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "wf-replay-"));
  try {
    const key = replayKey("variants", "x");
    saveReplayEntry(base, key, "step", { promptHash: "aaa", ok: true, output: "v1" });
    saveReplayEntry(base, key, "step", { promptHash: "bbb", ok: true, output: "v2" });
    // Re-saving an identical variant replaces it instead of duplicating.
    saveReplayEntry(base, key, "step", { promptHash: "aaa", ok: true, output: "v1b" });
    const variants = loadReplayCache(base, key)["step"];
    assert.equal(variants.length, 2);
    assert.deepEqual(
      variants.map((v) => [v.promptHash, v.output]),
      [
        ["bbb", "v2"],
        ["aaa", "v1b"],
      ],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("loadReplayCache never returns a prototype-bearing object", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "wf-replay-"));
  try {
    const missing = loadReplayCache(base, replayKey("nope", "x"));
    assert.equal(Object.getPrototypeOf(missing), null);

    mkdirReplayWith(
      base,
      `${replayKey("proto", "x")}.json`,
      JSON.stringify({ constructor: { promptHash: "h", ok: true, output: "o" } }),
    );
    const poisoned = loadReplayCache(base, replayKey("proto", "x"));
    // No prototype: even an id named like an Object property resolves only to
    // its own stored data, never to inherited members.
    assert.equal(Object.getPrototypeOf(poisoned), null);
    const variants = poisoned["constructor"];
    assert.ok(Array.isArray(variants) && variants[0]?.promptHash === "h");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("mergeReplayEntry keeps the in-memory cache shaped like loaded caches", () => {
  const cache = Object.create(null);
  mergeReplayEntry(cache, "step", { promptHash: "aaa", ok: true, output: "v1" });
  mergeReplayEntry(cache, "step", { promptHash: "bbb", ok: true, output: "v2" });
  mergeReplayEntry(cache, "step", { promptHash: "aaa", ok: true, output: "v1b" });
  assert.ok(Array.isArray(cache.step));
  assert.equal(cache.step.length, 2);
  assert.deepEqual(
    cache.step.map((v) => v.output),
    ["v2", "v1b"],
  );
});
