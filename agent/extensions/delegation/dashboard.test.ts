import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { AssistantMessageComponent, ToolExecutionComponent, createBashToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { Dashboard, showAgents } from "./dashboard.ts";
import { jobActivity, terminalText } from "./presentation.ts";
import type { Job } from "./durable.ts";

const job = (id: string, status: Job["status"] = "running"): Job => ({ id, agent: "default", conversationId: id as any, requestId: id,
  task: "Inspect 界界 UI", cwd: "/repo", workspace: "/repo", model: "provider/model", thinking: "high", mutating: false,
  background: true, delivered: false, status, startedAt: 1000, timeoutMs: 1000, ...(status === "done" ? { finishedAt: 2000 } : {}) });
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const keys = { matches: (data: string, key: string) => data === key };
const tick = () => new Promise((resolve) => setTimeout(resolve, 120));
initTheme("dark");

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
  const list = dashboard.render(120).join("\n");
  assert.match(list, /╭─+╮\n│ ● Inspect 界界 UI +Running/, "live jobs render as cards");
  assert.match(list, /│ bash git status/);
  dashboard.handleInput("j");
  entries = [job("new"), ...entries]; listener!(); await tick();
  assert.match(dashboard.render(60).join("\n"), /❯ ✓ Inspect.*Completed/, "selection follows the job, finished jobs stay one line");
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
  assert.deepEqual(cancelled, [], "the first x only asks for confirmation");
  assert.match(dashboard.render(80).join("\n"), /press x again to cancel default/);
  dashboard.handleInput("x"); await tick();
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
  assert.match(text, /Answer the child's question/, "a waiting child opens the answer box");
  assert.doesNotMatch(text, /conversation-1/, "ids stay behind the info toggle");
  assert.match(text, /Which cache\?/);
  assert.match(text, /15%\/10k/);
  assert.match(text, /\$0\.0200/);
  assert.match(text, /Queued · Check timeouts/);
  dashboard.handleInput("tui.select.cancel"); dashboard.handleInput("?");
  assert.match(terminalText(dashboard.render(120).join("\n")), /conversation-1/);
  dashboard.handleInput("o"); await tick();
  assert.deepEqual(limits, [100, 200]);
});

test("jobs that need the user sort first, newest first within a group, and long titles keep a gap before status", async (t) => {
  const entries = [{ ...job("old", "done"), startedAt: 1000 }, { ...job("new", "done"), startedAt: 2000, title: "Z".repeat(200) }, { ...job("asking", "waiting"), startedAt: 500 }];
  const dashboard = new Dashboard({ terminal: { rows: 30 }, requestRender: () => {} } as any, theme as any, keys as any,
    { list: async () => entries, subscribe: () => () => {}, preview: () => "" } as any, () => {});
  t.after(() => dashboard.dispose()); await tick();
  const text = terminalText(dashboard.render(120).join("\n"));
  const order = [text.indexOf("Waiting"), text.indexOf("ZZZ"), text.lastIndexOf("Inspect 界界 UI")];
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || order[i - 1] < at)), text);
  assert.match(text, /Z[ .…]+Completed/);
  assert.match(terminalText(dashboard.render(60).join("\n")), /Completed/);
});

test("question previews cannot emit terminal controls or embedded newlines", () => {
  const entry = { ...job("one", "waiting"), question: { id: "q", requestId: "one", askedAt: 1, text: "Choose?\nSecond line\x1b]52;c;SGVsbG8=\x07" } };
  assert.equal(jobActivity(entry), "? Choose? Second line");
});

test("inspector uses native session cards and independent tool and thinking shortcuts", async (t) => {
  const command = `python3 ${"long/path/".repeat(35)}command-end`;
  const output = `Result ${"界".repeat(80)} output-end`;
  const result = { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: `hidden-first-result\n${output}\nsecond\nthird\nfourth-result-line` }], isError: false };
  const assistant = { role: "assistant", content: [
    { type: "thinking", thinking: "Private reasoning" },
    { type: "toolCall", id: "call", name: "bash", arguments: { command } },
  ] };
  const tui = { terminal: { rows: 80 }, requestRender: () => {} } as any;
  const manager = {
    list: async () => [job("one")], subscribe: () => () => {}, preview: () => "",
    transcript: async () => [assistant, result],
  };
  const dashboard = new Dashboard(tui, theme as any, keys as any, manager as any, () => {}, "one");
  t.after(() => dashboard.dispose());
  await tick();
  const compact = terminalText(dashboard.render(60).join("\n"));
  assert.match(compact, /✓ bash python3 long\/path/, "tool calls collapse to one summary line");
  assert.doesNotMatch(compact, /output-end|hidden-first-result/);
  assert.doesNotMatch(compact, /Private reasoning/);
  dashboard.handleInput("app.tools.expand");
  const expanded = terminalText(dashboard.render(120).join("\n"));
  const nativeTool = new ToolExecutionComponent("bash", "call", { command }, { showImages: false }, createBashToolDefinition("/repo"), tui, "/repo");
  nativeTool.setExpanded(true); nativeTool.updateResult(result);
  for (const line of nativeTool.render(116)) assert.ok(expanded.includes(terminalText(line).trimEnd()), "expanded tools use Pi's native renderer");
  assert.match(expanded, /hidden-first-result/);
  assert.equal(expanded.split("fourth-result-line").length - 1, 1, "result belongs in the call card, not a second block");
  assert.doesNotMatch(expanded, /Private reasoning/);
  dashboard.handleInput("app.thinking.toggle");
  assert.match(terminalText(dashboard.render(60).join("\n")), /Private reasoning/);
  void AssistantMessageComponent;
  for (const width of [1, 20, 60, 120]) assert.ok(dashboard.render(width).every((line) => !line.includes("\n") && visibleWidth(line) <= width));
});

test("native inspector retains orphan results, tool failures, aborted calls, and live updates", async (t) => {
  let listener: (() => void) | undefined;
  let answer = "First live answer";
  const manager = {
    list: async () => [job("one")],
    subscribe: (fn: () => void) => { listener = fn; return () => {}; }, preview: () => "",
    transcript: async () => [
      { role: "toolResult", toolName: "read", toolCallId: "older-call", content: [{ type: "text", text: "Older result retained" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "failed", name: "bash", arguments: { command: "false" } }] },
      { role: "toolResult", toolName: "bash", toolCallId: "failed", isError: true, content: [{ type: "text", text: "Command exited with code 1" }] },
      { role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "aborted", name: "bash", arguments: { command: "sleep 10" } }] },
      { role: "assistant", content: [{ type: "text", text: answer }] },
    ],
  };
  const dashboard = new Dashboard({ terminal: { rows: 60 }, requestRender: () => {} } as any, theme as any, keys as any, manager as any, () => {}, "one");
  t.after(() => dashboard.dispose());
  await tick();
  const text = terminalText(dashboard.render(100).join("\n"));
  assert.match(text, /✗ bash false\s+│\n│ +Command exited with code 1/, "failures show their first error line");
  assert.doesNotMatch(text, /Older result retained/);
  dashboard.handleInput("app.tools.expand");
  assert.match(terminalText(dashboard.render(100).join("\n")), /Older result retained/);
  assert.match(text, /Operation aborted/);
  assert.match(text, /First live answer/);
  answer = "Updated live answer"; listener!(); await tick();
  const updated = terminalText(dashboard.render(100).join("\n"));
  assert.match(updated, /Updated live answer/);
  assert.doesNotMatch(updated, /First live answer/);
  assert.equal(updated.split("Command exited with code 1").length - 1, 1);
});

test("wheel events scroll the inspector and move the list selection instead of the chat behind", async (t) => {
  const lines = Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\n\n");
  const manager = { list: async () => [job("one"), job("two", "done")], subscribe: () => () => {}, preview: () => "",
    transcript: async () => [{ role: "assistant", content: [{ type: "text", text: lines }] }] };
  const dashboard = new Dashboard({ terminal: { rows: 20 }, requestRender: () => {} } as any, theme as any, keys as any, manager as any, () => {});
  t.after(() => dashboard.dispose()); await tick();
  const wheel = (wheelDelta: number) => dashboard.handleMouse({ type: "wheel", wheelDelta } as any);
  assert.deepEqual(wheel(1), { handled: true });
  assert.match(dashboard.render(80).join("\n"), /❯ ✓/);
  wheel(-1); dashboard.handleInput("l"); await tick();
  assert.match(dashboard.render(80).join("\n"), /line-79/);
  wheel(-5);
  const scrolled = dashboard.render(80).join("\n");
  assert.doesNotMatch(scrolled, /line-79/);
  assert.match(scrolled, /↓ 5 lines below/);
  assert.equal(dashboard.handleMouse({ type: "click" } as any), undefined);
});

test("dashboard covers every terminal cell in list and inspector, including after resize", async (t) => {
  const terminal = { rows: 30 };
  const dashboard = new Dashboard({ terminal, requestRender() {} } as any, theme as any, keys as any,
    { list: async () => [job("one")], subscribe: () => () => {}, preview: () => "", transcript: async () => [] } as any, () => {});
  t.after(() => dashboard.dispose()); await tick();
  for (const detail of [false, true]) {
    if (detail) { dashboard.handleInput("l"); await tick(); }
    for (const rows of [30, 12, 6]) for (const width of [1, 20, 80]) {
      terminal.rows = rows;
      const lines = dashboard.render(width);
      assert.equal(lines.length, rows, "no parent rows exposed above or below the overlay");
      assert.ok(lines.every((line) => visibleWidth(line) === width), "no parent columns exposed");
    }
  }
});

test("initial prompt has its own complete scrollable view even outside loaded history", async (t) => {
  const task = Array.from({ length: 50 }, (_, i) => `requirement-${i}`).join("\n") + "\n" + "界".repeat(50) + " wrap-end";
  const entry = { ...job("one"), task };
  const dashboard = new Dashboard({ terminal: { rows: 20 }, requestRender() {} } as any, theme as any, keys as any,
    { list: async () => [entry], subscribe: () => () => {}, preview: () => "", transcript: async () => [
      { role: "assistant", content: [{ type: "text", text: "Latest answer" }] },
    ] } as any, () => {}, "one");
  t.after(() => dashboard.dispose()); await tick();
  assert.match(terminalText(dashboard.render(60).join("\n")), /p prompt/);
  dashboard.handleInput("p");
  let text = terminalText(dashboard.render(60).join("\n"));
  assert.match(text, /Initial prompt/);
  assert.match(text, /requirement-0/);
  assert.doesNotMatch(text, /Latest answer|more lines · ctrl\+o/);
  dashboard.handleInput("app.tools.expand");
  assert.match(terminalText(dashboard.render(60).join("\n")), /requirement-0/, "tools toggle cannot collapse or jump the prompt");
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    text = terminalText(dashboard.render(30).join("\n"));
    for (const match of text.matchAll(/requirement-\d+/g)) seen.add(match[0]);
    dashboard.handleInput("j");
  }
  assert.equal(seen.size, 50, "every prompt line can be read without expanding tools or loading history");
  assert.match(text, /wrap-end/, "long wide-character lines wrap rather than truncate");
  dashboard.handleInput("p");
  assert.match(terminalText(dashboard.render(60).join("\n")), /Latest answer/);
});

test("transcript user messages remain complete with tools collapsed", async (t) => {
  const prompt = Array.from({ length: 20 }, (_, i) => `prompt-line-${i}`).join("\n\n");
  const dashboard = new Dashboard({ terminal: { rows: 80 }, requestRender() {} } as any, theme as any, keys as any,
    { list: async () => [job("one")], subscribe: () => () => {}, preview: () => "", transcript: async () => [
      { role: "user", content: prompt },
    ] } as any, () => {}, "one");
  t.after(() => dashboard.dispose()); await tick();
  const text = terminalText(dashboard.render(80).join("\n"));
  assert.match(text, /prompt-line-0/);
  assert.match(text, /prompt-line-19/);
  assert.doesNotMatch(text, /more lines · ctrl\+o/);
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) test(`inspector caller fills actual ${Renderer.name} overlay bounds without clipping or parent leakage`, async (t) => {
  let output = "";
  const terminal = { rows: 30, columns: 80, kittyProtocolActive: false,
    start() {}, stop() {}, drainInput: async () => {}, write(data: string) { output += data; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const tui = new Renderer(terminal);
  tui.start();
  tui.addChild({ invalidate() {}, render: () => Array.from({ length: terminal.rows }, () => "Received arguments:") });
  let dashboard!: Dashboard;
  let handle!: ReturnType<typeof tui.showOverlay>;
  const manager = { list: async () => [job("one")], subscribe: () => () => {}, preview: () => "", transcript: async () => [] };
  await showAgents({ ui: { custom(factory: any, options: any) {
    assert.equal(options.overlay, true);
    dashboard = factory(tui, theme, keys, () => {});
    handle = tui.showOverlay(dashboard, options.overlayOptions);
    return Promise.resolve(undefined);
  } } } as any, manager as any, "one");
  t.after(() => { dashboard.dispose(); tui.stop(); });
  await tick();
  for (const rows of [30, 12, 6]) for (const width of [1, 20, 80]) {
    terminal.rows = rows; terminal.columns = width;
    output = "";
    tui.renderNow(true);
    assert.deepEqual(handle.getBounds(), { row: 0, col: 0, width, height: rows });
    assert.doesNotMatch(output, /Received arguments:/, "the compositor must replace all parent rows");
    if (width >= 20) {
      const lines = dashboard.render(width);
      assert.ok(lines[0].startsWith("╭"), "top border remains visible");
      assert.ok(lines.at(-1)!.startsWith("╰") && lines.at(-1)!.endsWith("╯"), `bottom border remains visible at ${width}x${rows}: ${JSON.stringify(lines.at(-1))}`);
    }
  }
});
