import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Dashboard, timelineBar } from "./dashboard.ts";
import { jobActivity, terminalText } from "./presentation.ts";
import type { Job } from "./durable.ts";

const job = (id: string, status: Job["status"] = "running"): Job => ({ id, agent: "default", conversationId: id as any, requestId: id,
  task: "Inspect 界界 UI", cwd: "/repo", workspace: "/repo", model: "provider/model", thinking: "high", mutating: false,
  background: true, delivered: false, status, startedAt: 1000, timeoutMs: 1000, ...(status === "done" ? { finishedAt: 2000 } : {}) });
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const keys = { matches: (data: string, key: string) => data === key };
const tick = () => new Promise((resolve) => setTimeout(resolve, 120));

test("dashboard lists live jobs, preserves selection, inspects, messages, cancels, and fits narrow terminals", async (t) => {
  let entries = [job("one"), job("two", "done")];
  let listener: (() => void) | undefined;
  let disposed = false;
  const sent: string[] = [], cancelled: string[] = [], actions: unknown[] = [];
  const manager = {
    list: async () => entries, subscribe: (fn: () => void) => { listener = fn; return () => { disposed = true; }; },
    preview: () => "bash  git status\nRunning bash", transcript: async (id: string) => [{ role: "user", content: `Task for ${id}` }],
    message: async (id: string, text: string) => { sent.push(`${id}:${text}`); }, cancel: async (id: string) => { cancelled.push(id); },
  };
  const dashboard = new Dashboard({ terminal: { rows: 30 }, requestRender: () => {} } as any, theme as any, keys as any, manager as any, (action) => actions.push(action));
  t.after(() => dashboard.dispose());
  await tick();
  assert.match(dashboard.render(120).join("\n"), /TIMELINE/);
  dashboard.handleInput("j");
  entries = [job("new"), ...entries]; listener!(); await tick();
  assert.match(dashboard.render(60).join("\n"), /❯ done.*default/);
  dashboard.handleInput("l"); await tick();
  assert.match(dashboard.render(60).join("\n"), /Task for two/);
  for (const width of [1, 20, 60, 120]) assert.ok(dashboard.render(width).every((line) => !line.includes("\n") && visibleWidth(line) <= width));
  dashboard.focused = true;
  dashboard.handleInput("i");
  dashboard.handleInput("x"); // An x in a message must not cancel the child.
  dashboard.handleInput("\r"); await tick();
  assert.deepEqual(sent, ["two:x"]);
  assert.deepEqual(cancelled, []);
  dashboard.handleInput("h"); dashboard.handleInput("k"); dashboard.handleInput("x"); await tick();
  assert.deepEqual(cancelled, ["one"]);
  dashboard.handleInput("c"); assert.deepEqual(actions, ["configure"]);
  dashboard.dispose(); assert.equal(disposed, true);
});

test("empty dashboard explains configuration and provides preset and close shortcuts", async (t) => {
  const actions: unknown[] = [];
  const dashboard = new Dashboard({ terminal: { rows: 30 }, requestRender: () => {} } as any, theme as any, keys as any, undefined, (action) => actions.push(action));
  t.after(() => dashboard.dispose());
  await tick();
  assert.match(dashboard.render(80).join("\n"), /No jobs yet/);
  dashboard.handleInput("l"); dashboard.handleInput("x");
  dashboard.handleInput("p"); dashboard.handleInput("h");
  assert.deepEqual(actions, ["preset", undefined]);
  assert.equal(timelineBar(job("a", "done"), 1000, 2000, 4), "├━━┤");
  assert.equal(timelineBar(job("a"), 1000, 2000, 4), "├━━▶");
  assert.equal(terminalText("safe\x1b[31mred\x1b]0;title\x07\r"), "safered");
});

test("inspector shows one copy of streamed text, metadata, questions, and older history", async (t) => {
  const entry = { ...job("one", "waiting"), name: "cache-review", title: "Cache review", conversationId: "conversation-1" as any,
    question: { id: "question", requestId: "one", text: "Which cache?", askedAt: 1000 } };
  const limits: number[] = [];
  const manager = { list: async () => [entry], subscribe: () => () => {}, preview: () => "One live paragraph",
    transcript: async (_id: string, limit: number) => { limits.push(limit); return [{ role: "assistant", content: [{ type: "text", text: "One live paragraph" }] }]; },
    metadata: async () => ({ usage: { input: 1000, output: 200, cacheRead: 300, cost: { total: 0.02 } }, contextUsage: { tokens: 1500, contextWindow: 10000 },
      queued: [{ mode: "steer", content: "Check timeouts" }] }) };
  const dashboard = new Dashboard({ terminal: { rows: 40 }, requestRender: () => {} } as any, theme as any, keys as any, manager as any, () => {}, "one");
  t.after(() => dashboard.dispose());
  await tick();
  const text = terminalText(dashboard.render(120).join("\n"));
  assert.equal(text.split("One live paragraph").length - 1, 1);
  assert.match(text, /conversation-1/);
  assert.match(text, /Which cache\?/);
  assert.match(text, /15%\/10k/);
  assert.match(text, /\$0\.0200/);
  assert.match(text, /Check timeouts/);
  dashboard.handleInput("o"); await tick();
  assert.deepEqual(limits, [100, 200]);
});

test("newest jobs open first and long titles keep a gap before status", async (t) => {
  const entries = [{ ...job("old"), startedAt: 1000 }, { ...job("new", "done"), startedAt: 2000, title: "Z".repeat(200) }];
  const dashboard = new Dashboard({ terminal: { rows: 30 }, requestRender: () => {} } as any, theme as any, keys as any,
    { list: async () => entries, subscribe: () => () => {}, preview: () => "" } as any, () => {});
  t.after(() => dashboard.dispose()); await tick();
  const text = terminalText(dashboard.render(120).join("\n"));
  assert.match(text, /❯.*Z/);
  assert.match(text, /START.*END/);
  assert.match(text, /Z[ …]+done/);
  const narrow = terminalText(dashboard.render(60).join("\n"));
  assert.match(narrow, /done/);
  assert.match(narrow, /00:00:02/);
});

test("question previews cannot emit terminal controls or embedded newlines", () => {
  const entry = { ...job("one", "waiting"), question: { id: "q", requestId: "one", askedAt: 1, text: "Choose?\nSecond line\x1b]52;c;SGVsbG8=\x07" } };
  assert.equal(jobActivity(entry), "? Choose? Second line");
});
