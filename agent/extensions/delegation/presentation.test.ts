import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentSnapshot } from "./domain.ts";
import { formatWaitingSubagents, renderSubagentMonitor } from "./presentation.ts";

const theme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa_visible", origin: "generic", title: "implementation", task: "build it", cwd: "/repo",
    model: "openai-codex/gpt-5.6-sol", thinking: "medium", status: "running", mutating: true,
    createdAt: 1_000, output: "", liveText: "", liveThinking: "", activities: ["bash: npm test"], queued: [], transcript: [],
    usage: { turns: 3, input: 43_000, output: 2_100, cacheRead: 80_000, cacheWrite: 0, cost: 0.1482, contextTokens: 51_000, contextWindow: 272_000 },
    consumed: false, ...overrides,
  };
}

test("monitor exposes live agent identity, model, usage, cost, and activity", () => {
  const lines = renderSubagentMonitor([snapshot()], 180, theme, 103_000);
  const text = lines.join("\n");
  assert.match(text, /SUBAGENTS 1 running/);
  assert.match(text, /implementation · generic · sa_visible/);
  assert.match(text, /openai-codex\/gpt-5\.6-sol:medium/);
  assert.match(text, /19%\/272k ctx/);
  assert.match(text, /43k in · 2\.1k out · R80k · \$0\.1482/);
  assert.match(text, /bash: npm test/);
});

test("monitor prioritizes running work and bounds its height", () => {
  const entries = Array.from({ length: 6 }, (_, index) => snapshot({
    id: `sa_${index}`, title: `agent ${index}`, createdAt: index,
    status: index === 0 ? "running" : "done",
  }));
  const lines = renderSubagentMonitor(entries, 120, theme, 10_000);
  assert.equal(lines.length, 14);
  assert.match(lines[1], /agent 0/);
  assert.match(lines.at(-1)!, /2 more/);
});

test("wait progress uses the same operational summary", () => {
  const text = formatWaitingSubagents([snapshot()], 103_000);
  assert.match(text, /■ implementation · sa_visible/);
  assert.match(text, /openai-codex\/gpt-5\.6-sol:medium/);
  assert.match(text, /bash: npm test/);
});
