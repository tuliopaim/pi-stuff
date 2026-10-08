import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import delegation from "./index.ts";
import { getAgents, setSubagentPreset } from "./config.ts";
import { AgentJobs } from "./durable.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AgentSession, CustomMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { terminalText } from "./presentation.ts";
import tripleEscape from "../triple-escape.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const widgetContent = (content: any) => typeof content === "function" ? content({}, plainTheme).render(120) : content;
initTheme("dark");

function harness(t: test.TestContext, createJobs?: any) {
  const directory = mkdtempSync(join(tmpdir(), "pi-agents-extension-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  setSubagentPreset(undefined);
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; setSubagentPreset(undefined); rmSync(directory, { recursive: true, force: true }); });
  const tools = new Map<string, any>(), commands = new Map<string, any>(), events = new Map<string, any>(), renderers = new Map<string, any>();
  const sent: any[] = [], persisted: any[] = [];
  let timestamp = Date.now();
  const emitter = new EventEmitter();
  const bus = {
    emit: (name: string, data: unknown) => { emitter.emit(name, data); },
    on: (name: string, handler: (data: unknown) => void) => {
      emitter.on(name, handler);
      return () => { emitter.off(name, handler); };
    },
  };
  delegation({
    events: bus,
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer), on: (name: string, handler: any) => events.set(name, handler),
    sendMessage: (message: any, options: any) => {
      const recorded = { ...message, timestamp: ++timestamp };
      sent.push({ message: recorded, options });
      persisted.push({ type: "custom_message", ...message, timestamp: new Date(recorded.timestamp).toISOString() });
    },
    appendEntry: () => {},
    getActiveTools: () => [...tools.keys()],
  } as any, createJobs);
  return { tools, commands, events, renderers, sent, persisted, bus };
}

test("triple Escape cancels pending subagents even when the parent is idle", async (t) => {
  const entries = ["running", "stalled", "waiting", "done"].map((status) => ({
    id: status, agent: "default", status, background: true, delivered: true,
  }));
  const cancelled: string[] = [];
  const manager = {
    list: async () => entries, subscribe: () => () => {}, resume: async () => {}, close: async () => {},
    result: async (id: string) => ({ job: entries.find((job) => job.id === id), output: "Working" }), preview: () => "Working",
    cancel: async (id: string) => { cancelled.push(id); },
  };
  const { events, bus, persisted } = harness(t, async () => manager);
  let editor: any;
  let parentInterrupts = 0;
  tripleEscape({
    events: bus,
    on: (_name: string, handler: any) => {
      handler({}, { mode: "tui", ui: { setEditorComponent: (factory: any) => {
        editor = factory({ requestRender() {} }, {}, {
          matches: (data: string, action: string) => data === "\x1b" && action === "app.interrupt",
        });
        editor.onEscape = () => { parentInterrupts++; };
      } } });
    },
  } as any);
  const ctx = {
    mode: "tui", hasUI: true, modelRegistry: { find: () => {}, streamSimple: () => {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted },
    ui: { theme: plainTheme, setStatus() {}, setWidget() {}, notify() {} },
  };
  await events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  editor.handleInput("\x1b");
  editor.handleInput("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancelled, []);
  editor.handleInput("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(parentInterrupts, 1);
  assert.deepEqual(cancelled.sort(), ["running", "stalled", "waiting"]);
  await events.get("session_shutdown")({}, ctx);
  editor.handleInput("\x1b");
  editor.handleInput("\x1b");
  editor.handleInput("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled.length, 3, "shutdown removes the cancellation listener");
});

test("one management tool plus focused shortcuts replace the old tool family", (t) => {
  const registered = harness(t);
  assert.deepEqual([...registered.tools.keys()], ["agent", "scout", "review", "commit"]);
  assert.deepEqual([...registered.commands.keys()], ["subagent-preset", "agents", "commit"]);
  assert.equal(registered.tools.get("agent").exposure, "model-only");
  assert.match(registered.tools.get("agent").description, /Omit agent to use default/);
  assert.ok(!registered.tools.has("subagent_spawn"));
});

test("run, repeated waits and completion reports update one native job card", async (t) => {
  let listener!: () => void;
  const job: any = { id: "demo-id", name: "ui-demo", requestId: "request", agent: "default", status: "running",
    background: true, delivered: false, model: "custom/worker", thinking: "high", startedAt: Date.now(), task: "Demo" };
  let output = "Running tests";
  const result = () => ({ job: { ...job }, output, usage: { cost: { total: 0.01 } } });
  const manager = { list: async () => [job], resume: async () => {}, close: async () => {}, preview: () => output,
    result: async () => result(), wait: async () => result(), acknowledge: async () => { job.delivered = true; },
    subscribe: (fn: () => void) => { listener = fn; return () => {}; } };
  const { tools, events, renderers, sent, persisted } = harness(t, async () => manager);
  const widgets = new Map<string, any>();
  const ctx = { hasUI: true, modelRegistry: { find() {}, streamSimple() {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted, getEntries: () => persisted },
    ui: { theme: plainTheme, setStatus() {}, setWidget: (name: string, content: any) => widgets.set(name, widgetContent(content)), notify() {} } };
  await events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  const tool = tools.get("agent");
  const tui = { requestRender() {} } as any;
  const run = new ToolExecutionComponent("agent", "run-call", { name: job.name, task: "Demo", background: true }, {}, tool, tui, process.cwd());
  const started = { content: [{ type: "text", text: "Started demo" }], details: { job: { ...job } }, isError: false };
  run.updateResult(started);
  assert.doesNotMatch(terminalText(run.render(160).join("\n")), /in background/, "the placeholder must disappear as soon as the job has a card");
  persisted.push({ type: "message", message: { role: "toolResult", toolName: "agent", toolCallId: "run-call", ...started } });
  const waits = ["wait-1", "wait-2"].map((id) => {
    const component = new ToolExecutionComponent("agent", id, { action: "wait", id: job.name }, {}, tool, tui, process.cwd());
    component.updateResult({ content: [{ type: "text", text: output }], details: result(), isError: false }, true);
    return component;
  });
  assert.ok(waits.every((component) => component.render(160).length === 0), "waits must not add another shell or block");
  job.status = "waiting"; output = "Which tests should I run?";
  listener(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(terminalText(run.render(160).join("\n")), /Which tests should I run\?/);
  assert.equal(sent[0].message.customType, "agent-question");
  assert.equal(sent[0].message.display, false, "duplicates must not create a native custom-message shell or blank row");
  assert.deepEqual(renderers.get("agent-question")(sent[0].message, {}, plainTheme).render(160), []);
  job.status = "running"; job.requestId = "answer-request"; job.delivered = false; output = "Checking the chosen tests";
  listener(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(terminalText(run.render(160).join("\n")), /Checking the chosen tests/);
  job.status = "done"; output = "Demo complete";
  listener(); await new Promise((resolve) => setTimeout(resolve, 150));
  const rendered = terminalText(run.render(160).join("\n"));
  assert.match(rendered, /ui-demo · done/);
  assert.match(rendered, /Demo complete/);
  assert.doesNotMatch(rendered, /Started demo|in background/);
  assert.ok([...widgets.values()].every((content) => content === undefined));
  assert.equal(sent.length, 2, "the model must still receive its question and completion report");
  assert.equal(sent[1].message.display, false);
  assert.deepEqual(renderers.get("agent-result")(sent[1].message, {}, plainTheme).render(160), [], "the automatic report must not duplicate the job card");
});

test("reloading rebuilds one card from the visible transcript without losing the final result", async (t) => {
  const job: any = { id: "demo-id", name: "ui-demo", requestId: "request", agent: "default", status: "done",
    background: true, delivered: true, model: "custom/worker", thinking: "high", startedAt: Date.now(), task: "Demo" };
  const done = { job, output: "Demo complete", usage: { cost: { total: 0.01 } } };
  const manager = { list: async () => [job], resume: async () => {}, close: async () => {}, preview: () => "",
    result: async () => done, subscribe: () => () => {} };
  const { tools, events, persisted, sent, renderers } = harness(t, async () => manager);
  const started = { content: [{ type: "text", text: "Started demo" }], details: { job: { ...job, status: "running" } }, isError: false };
  const waited = { content: [{ type: "text", text: done.output }], details: done, isError: false };
  const first = { type: "message", message: { role: "toolResult", toolCallId: "run-call", ...started } };
  const last = { type: "message", message: { role: "toolResult", toolCallId: "wait-call", ...waited } };
  persisted.push(first, last);
  let visible = [...persisted];
  const ctx = { hasUI: true, modelRegistry: { find() {}, streamSimple() {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted, buildContextEntries: () => visible },
    ui: { theme: plainTheme, setStatus() {}, setWidget() {}, notify() {} } };
  await events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  const tool = tools.get("agent"), tui = { requestRender() {} } as any;
  const run = new ToolExecutionComponent("agent", "run-call", { task: "Demo", background: true }, {}, tool, tui, process.cwd());
  run.updateResult(started);
  const wait = new ToolExecutionComponent("agent", "wait-call", { action: "wait", id: job.name }, {}, tool, tui, process.cwd());
  wait.updateResult(waited);
  assert.match(terminalText(run.render(160).join("\n")), /ui-demo · done/);
  assert.deepEqual(wait.render(160), []);
  visible = [last]; // Compaction removed the original run from the displayed transcript.
  await events.get("session_compact")({}, ctx);
  assert.match(terminalText(wait.render(160).join("\n")), /Demo complete/, "a visible wait must take ownership when the original card is no longer visible");
  visible = [{ type: "custom_message", customType: "agent-result", display: false, timestamp: new Date().toISOString(),
    content: done.output, details: done }];
  await events.get("session_compact")({}, ctx);
  assert.equal(sent.length, 1, "a hidden report must restore a card if compaction removed every visible owner");
  assert.equal(sent[0].message.display, true);
  assert.equal(sent[0].options.triggerTurn, false);
  const recovered = new CustomMessageComponent(sent[0].message, renderers.get("agent-progress"));
  assert.match(terminalText(recovered.render(160).join("\n")), /Demo complete/);
});

test("aborting a recovered job's native wait does not hide its later question or answer", async (t) => {
  let listener!: () => void;
  const job: any = { id: "worker-id", name: "worker-1", requestId: "request", agent: "default", status: "running",
    background: true, delivered: false, model: "custom/worker", thinking: "high", startedAt: Date.now() };
  let output = "Running tests";
  const result = () => ({ job: { ...job }, output, usage: { cost: { total: 0 } } });
  const manager = { list: async () => [job], resume: async () => {}, close: async () => {}, preview: () => output,
    subscribe: (fn: () => void) => { listener = fn; return () => {}; }, result: async () => result(),
    acknowledge: async () => { job.delivered = true; } };
  const { tools, events, persisted, sent } = harness(t, async () => manager);
  const ctx = { hasUI: true, modelRegistry: { find() {}, streamSimple() {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted },
    ui: { theme: plainTheme, setStatus() {}, setWidget() {}, notify() {} } };
  await events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  const wait = new ToolExecutionComponent("agent", "wait-call", { action: "wait", id: job.name }, {}, tools.get("agent"), { requestRender() {} } as any, process.cwd());
  wait.updateResult({ content: [{ type: "text", text: output }], details: result(), isError: false }, true);
  wait.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true });
  assert.match(terminalText(wait.render(160).join("\n")), /worker-1 · running/);
  job.status = "waiting"; output = "Which tests?";
  listener(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(terminalText(wait.render(160).join("\n")), /Which tests\?/);
  assert.equal(sent[0].message.customType, "agent-question");
  assert.equal(sent[0].message.display, false);
  job.status = "done"; job.requestId = "answer-request"; job.delivered = false; output = "Tests passed";
  listener(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(terminalText(wait.render(160).join("\n")), /Tests passed/);
});

test("all background agent types share live cards and one footer status", async (t) => {
  const statuses: any[] = [], widgets: any[] = [];
  const entries = ["default", "explore", "review", "commit"].map((agent) => ({
    id: agent, name: `${agent}-1`, agent, status: "running", background: true, startedAt: Date.now(),
    model: "custom/worker", thinking: "high", task: `Task for ${agent}`,
  }));
  const manager = {
    list: async () => entries, preview: (id: string) => `Running ${id}`,
    result: async (id: string) => ({ job: entries.find((job) => job.id === id), output: "Stale output", usage: { cost: { total: 0.03 } } }),
    subscribe: () => () => {}, resume: async () => {}, close: async () => {},
  };
  const { events, persisted } = harness(t, async () => manager);
  const ctx = {
    hasUI: true, modelRegistry: { find: () => {}, streamSimple: () => {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted },
    ui: { theme: plainTheme, setStatus: (name: string, content: any) => statuses.push({ name, content }),
      setWidget: (name: string, content: any) => widgets.push({ name, content }), notify: () => {} },
  };
  t.after(() => events.get("session_shutdown")({}, ctx));
  await events.get("session_start")({}, ctx);
  assert.match(statuses.at(-1).content, /4 running.*\/agents/);
  const monitor = widgets.find(({ name, content }) => name === "subagents-monitor" && content);
  assert.ok(monitor, "background progress must not be special-cased for commit");
  const rendered = widgetContent(monitor.content).join("\n");
  for (const { agent, name } of entries) {
    assert.ok(rendered.includes(`${name} · running · custom/worker:high`));
    assert.ok(rendered.includes(`Running ${agent}`));
    assert.ok(rendered.includes(`/agents ${name}`));
  }
  assert.match(rendered, /\$0\.0300/);
  assert.doesNotMatch(rendered, /Stale output|ctrl\+o/);
  assert.ok(widgets.every(({ name }) => name !== "commit-background"));
});

test("delegated workflow children never register orchestration tools", (t) => {
  const previous = process.env.PI_DELEGATED; process.env.PI_DELEGATED = "1";
  try { assert.equal(harness(t).tools.size, 0); }
  finally { if (previous === undefined) delete process.env.PI_DELEGATED; else process.env.PI_DELEGATED = previous; }
});

test("guidance advertises specialists and the catch-all default on every turn", (t) => {
  const { events } = harness(t);
  const guidance = events.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt;
  assert.match(guidance, /explore:/); assert.match(guidance, /plan:/); assert.match(guidance, /default:/);
  assert.match(guidance, /useful handoffs that do not fit a specialist/);
});

test("background reports are deduplicated using the persisted parent transcript", async (t) => {
  let listener: (() => void) | undefined;
  const job = { id: "job", requestId: "request", agent: "default", status: "done", background: true, delivered: false, model: "provider/model", thinking: "low", task: "task" };
  const result = { job, output: "answer", usage: { cost: { total: 0 } } };
  let ack = 0, closed = 0;
  const manager = { subscribe: (fn: () => void) => { listener = fn; return () => { listener = undefined; }; }, resume: async () => {}, list: async () => [job], result: async () => result, acknowledge: async () => { ack++; }, preview: () => "", close: async () => { closed++; } };
  const { events, sent, persisted } = harness(t, async () => manager);
  const ctx = { hasUI: false, modelRegistry: { find: () => {}, streamSimple: () => {} }, sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted }, ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} } };
  await events.get("session_start")({}, ctx);
  assert.equal(sent.length, 1); assert.equal(ack, 1);
  assert.equal(sent[0].options.triggerTurn, true);
  listener!(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 1); assert.equal(ack, 2);
  await events.get("session_shutdown")({}, ctx);
  assert.equal(closed, 1);
});

test("configuration picker saves the selected model and thinking without a reload", async (t) => {
  const { commands } = harness(t);
  const choices = ["explore · current", "custom/picked", "low"];
  const ctx = { hasUI: true, modelRegistry: { getAvailable: () => [{ provider: "custom", id: "picked" }], find: () => undefined }, ui: { select: async () => choices.shift(), notify: () => {} } };
  await commands.get("agents").handler("configure", ctx);
  assert.equal(getAgents().explore.model, "custom/picked");
  assert.equal(getAgents().explore.thinking, "low");
});

for (const [preset, provider] of [["copilot", "github-copilot"], ["anthropic-work", "anthropic"]]) {
  test(`${preset} configuration picker only offers its permitted provider`, async (t) => {
    const { commands } = harness(t);
    setSubagentPreset(preset);
    const ctx = { hasUI: true,
      modelRegistry: { getAvailable: () => [
        { provider, id: "allowed" },
        { provider: "openai", id: "blocked" },
        { provider: `${provider}-proxy`, id: "blocked" },
      ] },
      ui: { select: async (title: string, options: string[]) => {
        if (title === "Configure agent") return options[0];
        assert.deepEqual(options, [`${provider}/allowed`]);
        return undefined;
      } },
    };
    await commands.get("agents").handler("configure", ctx);
  });
}

test("queued background reports are acknowledged only after the parent stores them", async (t) => {
  const job = { id: "job", requestId: "queued", agent: "default", status: "done", background: true, delivered: false, model: "provider/model", thinking: "low", task: "task" };
  let acknowledged = 0;
  const manager = { subscribe: () => () => {}, resume: async () => {}, list: async () => [job], result: async () => ({ job, output: "answer", usage: { cost: { total: 0 } } }), acknowledge: async () => { acknowledged++; }, preview: () => "", close: async () => {} };
  const registered = harness(t, async () => manager);
  const branch: any[] = [];
  const ctx = { hasUI: false, modelRegistry: { find: () => {}, streamSimple: () => {} }, sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => branch }, ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} } };
  await registered.events.get("session_start")({}, ctx);
  assert.equal(registered.sent.length, 1);
  assert.equal(acknowledged, 0);
  registered.events.get("message_end")();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(registered.sent.length, 1, "pending reports are not queued twice");
  registered.events.get("agent_settled")();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(registered.sent.length, 2, "discarded queued reports are retried once the parent settles");
  branch.push(registered.persisted[0]);
  registered.events.get("message_end")();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(acknowledged, 1);
  await registered.events.get("session_shutdown")({}, ctx);
});

test("ephemeral parent sessions do not persist child conversations", async (t) => {
  let options: any;
  const manager = { subscribe: () => () => {}, resume: async () => {}, list: async () => [], close: async () => {} };
  const { events } = harness(t, async (input: any) => { options = input; return manager; });
  const ctx = { hasUI: false, modelRegistry: { find: () => {}, streamSimple: (_model: any, _context: any, input: any) => { assert.equal(input.sessionId, "ephemeral-session"); } }, sessionManager: { getSessionId: () => "ephemeral-session", getSessionFile: () => undefined, getBranch: () => [] }, ui: { setStatus: () => {}, setWidget: () => {} } };
  await events.get("session_start")({}, ctx);
  assert.ok(options.storage);
  assert.equal(options.database, undefined);
  options.models.streamSimple({}, { messages: [] });
  await events.get("session_shutdown")({}, ctx);
});

test("workflow children with delegation excluded neither open jobs nor reset the parent's preset", async (t) => {
  let opened = false;
  const { events, tools } = harness(t, async () => { opened = true; });
  setSubagentPreset("copilot");
  tools.clear();
  await events.get("session_start")({}, {});
  assert.equal(opened, false);
  assert.ok(Object.values(getAgents()).every((agent) => agent.model.startsWith("github-copilot/")));
  assert.equal(events.get("before_agent_start")({ systemPrompt: "base" }), undefined);
});

test("/commit shows its task and cancellation hint before setup, then clears feedback on failure", async (t) => {
  const { commands, sent } = harness(t);
  const widgets: any[] = [];
  const ctx = { cwd: process.cwd(), hasUI: true, isIdle: () => true,
    ui: { setWidget: (name: string, content: any) => widgets.push({ name, content: widgetContent(content) }), notify: () => {} } };
  const running = commands.get("commit").handler("Commit only the UI changes", ctx);
  assert.ok(widgets.length, "Feedback must appear before loading resources or starting a child");
  assert.match(JSON.stringify(widgets[0].content), /Commit only the UI changes/);
  assert.match(JSON.stringify(widgets[0].content), /esc.*cancel/i);
  await running;
  assert.equal(widgets.at(-1).content, undefined);
  assert.equal(sent.length, 1, "Setup failures must leave a result in the transcript");
  assert.match(JSON.stringify(sent[0].message.content), /failed/i);
});

test("pending questions notify the parent once and include instructions for answering", async (t) => {
  let listener: (() => void) | undefined;
  const job: any = { id: "uuid", name: "worker-1", requestId: "request", agent: "default", status: "waiting", background: true, delivered: false,
    model: "provider/model", thinking: "low", task: "task", question: { id: "question", text: "Which database?" } };
  const manager = { subscribe: (fn: () => void) => { listener = fn; return () => {}; }, resume: async () => {}, list: async () => [job],
    result: async () => ({ job, output: job.question?.text ?? "Completed", usage: { cost: { total: 0 } } }), acknowledge: async () => {}, preview: () => "", close: async () => {} };
  const { events, sent, persisted } = harness(t, async () => manager);
  const ctx = { hasUI: false, modelRegistry: { find: () => {}, streamSimple: () => {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted }, ui: { setStatus: () => {}, setWidget: () => {} } };
  await events.get("session_start")({}, ctx);
  assert.equal(sent[0].message.customType, "agent-question");
  assert.match(sent[0].message.content, /Which database\?/);
  assert.match(sent[0].message.content, /worker-1/);
  assert.match(sent[0].message.content, /message/);
  listener!(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 1);
  job.status = "done"; job.requestId = "answer-request"; delete job.question;
  listener!(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.at(-1).message.customType, "agent-result");
  await events.get("session_shutdown")({}, ctx);
});

test("the parent agent tool receives a real child question and resumes that child with an answer", async (t) => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_question", { question: "Which schema should I use?" })], { stopReason: "toolUse" })]);
  const models = createModels(); models.setProvider(faux.provider);
  const jobs = await AgentJobs.open({ models, storage: new MemoryStorage() });
  t.after(() => jobs.close());
  const { tools, events, persisted } = harness(t, async () => jobs);
  const ctx = { cwd: process.env.PI_CODING_AGENT_DIR, hasUI: false, isProjectTrusted: () => false,
    modelRegistry: { find: models.getModel.bind(models), streamSimple: models.streamSimple.bind(models) },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted, getEntries: () => persisted }, ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} } };
  await events.get("session_start")({}, ctx);
  const tool = tools.get("agent");
  const question = await tool.execute("question-call", { task: "Implement the scoped change", route: "faux/faux-1:off", name: "schema-worker" }, undefined, undefined, ctx);
  assert.equal(question.details.job.status, "waiting");
  assert.equal(question.isError, false);
  assert.match(question.content[0].text, /Which schema/);
  assert.match(question.content[0].text, /action: "message"/);
  assert.deepEqual(question.usage, question.details.usage);
  persisted.push({ type: "message", message: { role: "toolResult", ...question } });
  const repeatedQuestion = await tool.execute("repeat-question", { action: "wait", id: "schema-worker" }, undefined, undefined, ctx);
  assert.equal(repeatedQuestion.usage, undefined);
  faux.setResponses([fauxAssistantMessage("Used the existing schema.")]);
  await tool.execute("answer-call", { action: "message", id: "schema-worker", task: "Use the existing schema" }, undefined, undefined, ctx);
  const answer = await tool.execute("wait-call", { action: "wait", id: "schema-worker" }, undefined, undefined, ctx);
  assert.equal(answer.details.job.status, "done");
  assert.equal(answer.details.job.conversationId, question.details.job.conversationId);
  assert.match(answer.content[0].text, /Used the existing schema/);
  assert.match(JSON.stringify(await jobs.transcript("schema-worker")), /Use the existing schema/);
  assert.ok(answer.usage.output > 0);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
    assert.equal(question.usage[key] + answer.usage[key], answer.details.usage[key]);
  persisted.push({ type: "message", message: { role: "toolResult", ...answer } });
  const stats = AgentSession.prototype.getSessionStats.call({ sessionManager: ctx.sessionManager, getContextUsage: () => undefined } as any);
  assert.equal(stats.tokens.output, answer.details.usage.output);
  const repeatedAnswer = await tool.execute("repeat-answer", { action: "wait", id: question.details.job.id }, undefined, undefined, ctx);
  assert.equal(repeatedAnswer.usage, undefined);
  await events.get("session_shutdown")({}, ctx);
});

test("Escape during commit setup leaves a cancelled transcript card and removes its listener", async (t) => {
  let input: ((data: string) => unknown) | undefined;
  let removed = false, spawned = false;
  const manager = { list: async () => [], resume: async () => {}, subscribe: () => () => {}, close: async () => {}, spawn: async () => { spawned = true; } };
  const { events, commands, sent, persisted } = harness(t, async () => manager);
  const ctx = { cwd: process.env.PI_CODING_AGENT_DIR, hasUI: true, isProjectTrusted: () => false, isIdle: () => true,
    modelRegistry: { find: () => ({}), streamSimple: () => {} }, sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {}, onTerminalInput: (fn: typeof input) => { input = fn; return () => { removed = true; }; } } };
  await events.get("session_start")({}, ctx);
  const running = commands.get("commit").handler("Commit scoped changes", ctx);
  input!("\x1b");
  await running;
  assert.equal(spawned, false);
  assert.equal(removed, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content, /Commit agent cancelled/);
  await events.get("session_shutdown")({}, ctx);
});

test("delegation tools render model, activity, usage, task and expanded instructions", (t) => {
  const { tools } = harness(t);
  const job = { id: "job", agent: "review", name: "review-1", model: "custom/saved", thinking: "high", status: "done", startedAt: 1000, finishedAt: 3000, task: "Check cache" };
  const result = { content: [{ type: "text", text: "Checked" }], details: { job, output: "Checked", usage: { input: 1000, output: 200, cacheRead: 500, cost: { total: 0.03 } } } };
  for (const name of ["agent", "scout", "review", "commit"]) {
    const tool = tools.get(name);
    assert.equal(typeof tool.renderResult, "function", `${name} needs a result renderer`);
    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, { args: { task: "Check cache" }, state: {} }).render(100).join("\n");
    assert.match(expanded, /custom\/saved:high/);
    assert.match(expanded, /\$0\.0300/);
    assert.match(expanded, /Check cache/);
    assert.match(expanded, /instructions/i);
    assert.match(expanded, /Checked/);
  }
});

test("management cards use saved child instructions, not the default agent configuration", (t) => {
  const { tools } = harness(t);
  const tool = tools.get("agent");
  const ctx = { args: { action: "status", id: "review-1" }, state: {}, expanded: true };
  const call = tool.renderCall(ctx.args, plainTheme, ctx).render(100).join("\n");
  assert.doesNotMatch(call, /opencode-go|deepseek|Agent instructions/);
  const details = { job: { id: "review-id", name: "review-1", agent: "review", task: "Review API", model: "saved/model", thinking: "high", status: "done" },
    output: "Done", instructions: "Saved review instructions only", usage: { cost: { total: 0 } } };
  const rendered = tool.renderResult({ content: [], details }, { expanded: true, isPartial: false }, plainTheme, ctx).render(100).join("\n");
  assert.match(rendered, /Saved review instructions only/);
});

test("streamed route arguments update the call header before the configuration is frozen", (t) => {
  const tool = harness(t).tools.get("agent");
  const ctx = { state: {} };
  tool.renderCall({ task: "Inspect" }, plainTheme, ctx);
  const picked = tool.renderCall({ task: "Inspect", route: "custom/selected:high" }, plainTheme, ctx).render(100).join("\n");
  assert.match(picked, /custom\/selected:high/);
});

test("waiting by job name streams the child's model, usage and latest activity in its card", async (t) => {
  const listeners = new Set<() => void>();
  let finish!: (result: any) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  const job = { id: "worker-id", name: "default-1", requestId: "request", agent: "default", status: "running",
    background: true, delivered: false, model: "custom/worker", thinking: "high", task: "Implement the scoped change", startedAt: Date.now() };
  let activity = "bash  git diff --stat\nRunning bash";
  const result = () => ({ job, output: activity, usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200, cost: { total: 0.03 } } });
  const manager = { list: async () => [job], resume: async () => {}, close: async () => {},
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    preview: (id: string) => { assert.equal(id, job.id); return activity; }, result: async () => result(), wait: async () => pending };
  const { tools, events, persisted } = harness(t, async () => manager);
  const ctx = { hasUI: false, modelRegistry: { find: () => {}, streamSimple: () => {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted, getEntries: () => persisted },
    ui: { setStatus() {}, setWidget() {}, notify() {} } };
  await events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  const updates: any[] = [];
  const tool = tools.get("agent");
  const waiting = tool.execute("wait-call", { action: "wait", id: job.name }, undefined, (update: any) => updates.push(update), ctx);
  t.after(() => finish(result()));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(updates.length, "wait must stream updates rather than a generic Working box");
  const render = () => tool.renderResult(updates.at(-1), { expanded: false, isPartial: true }, plainTheme, { state: {} }).render(160).join("\n");
  assert.match(render(), /default-1.*running.*custom\/worker:high/);
  assert.match(render(), /\$0\.0300/);
  assert.match(render(), /Running bash/);
  activity = "Finished the implementation; checking tests.";
  for (const listener of listeners) listener();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(render(), /checking tests/);
  finish({ ...result(), job: { ...job, status: "done" }, output: "Done" });
  assert.equal((await waiting).details.job.status, "done");
  assert.equal(listeners.size, 1, "finishing wait removes its progress subscription");
});

test("commit questions persist as question cards and are acknowledged", async (t) => {
  const job: any = { id: "commit-job", name: "commit-1", requestId: "request", agent: "commit", status: "running", background: false, delivered: false, model: "custom/test", thinking: "low", task: "Commit scoped work" };
  const entries: any[] = [];
  let acknowledged = 0;
  const manager = { list: async () => entries, resume: async () => {}, subscribe: () => () => {}, spawn: async () => { entries.push(job); return job; }, preview: () => "Working",
    wait: async () => { job.status = "waiting"; job.question = { id: "q", text: "Which files?" }; return { job, output: "Which files?", usage: { cost: { total: 0 } } }; },
    result: async () => ({ job, output: "Which files?", usage: { cost: { total: 0 } } }),
    acknowledge: async () => { acknowledged++; }, close: async () => {} };
  const { events, commands, sent, persisted } = harness(t, async () => manager);
  const ctx = { cwd: process.env.PI_CODING_AGENT_DIR, hasUI: true, isProjectTrusted: () => false, isIdle: () => true,
    modelRegistry: { find: () => ({}), streamSimple: () => {} }, sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {}, theme: { fg: (_color: string, text: string) => text } } };
  await events.get("session_start")({}, ctx);
  await commands.get("commit").handler(job.task, ctx);
  assert.equal(sent[0].message.customType, "agent-progress");
  assert.equal(sent[1].message.customType, "agent-question");
  assert.equal(sent[1].options?.triggerTurn, true, "commit questions must wake the parent to ask the user");
  events.get("message_end")(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(acknowledged, 1);
  assert.equal(sent.length, 2);
  await events.get("session_shutdown")({}, ctx);
});

for (const agent of ["default", "explore", "review", "commit", "custom"]) test(`answering a ${agent} question restores shared live progress until completion`, async (t) => {
  let listener: (() => void) | undefined;
  const job: any = { id: `${agent}-job`, name: `${agent}-1`, requestId: "question-request", agent, status: "waiting",
    background: false, delivered: true, model: "custom/test", thinking: "low", task: "Commit scoped work",
    startedAt: Date.now(), question: { id: "q", text: "Which files?" } };
  let activity = "bash  git diff --stat\nRunning bash";
  const manager = { list: async () => [job], resume: async () => {}, subscribe: (fn: () => void) => { listener = fn; return () => {}; },
    preview: () => activity, result: async () => ({ job: { ...job }, output: job.status === "done" ? "Created abc123" : activity, usage: { cost: { total: 0 } } }),
    message: async () => { job.requestId = "answer-request"; job.status = "running"; job.background = true; job.delivered = false; delete job.question; listener!(); return job; },
    acknowledge: async () => { job.delivered = true; }, close: async () => {} };
  const { commands, events, sent, persisted } = harness(t, async () => manager);
  const widgets = new Map<string, any>();
  const ctx = { hasUI: true, mode: "rpc", modelRegistry: { find: () => {}, streamSimple: () => {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted },
    ui: { theme: plainTheme, setStatus() {}, setWidget: (name: string, content: any) => widgets.set(name, widgetContent(content)),
      select: async () => "Answer question", input: async () => "Only the Sync/ETL files", notify() {} } };
  await events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  await commands.get("agents").handler(job.name, ctx);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(JSON.stringify([...widgets.values()]), /git diff --stat/, "the resumed job must show activity outside the dashboard");
  activity = "bash  git commit\nRunning bash";
  listener!(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(JSON.stringify([...widgets.values()]), /git commit/);
  job.status = "done";
  listener!(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok([...widgets.values()].every((content) => content === undefined), "completion clears live feedback");
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content, /Created abc123/);
  assert.equal(sent[0].options.triggerTurn, true);
});

for (const [status, error] of [
  ["waiting", undefined], ["failed", undefined], ["cancelled", undefined],
  ["cancelled", "Timed out after 5 minutes without activity"],
] as const) test(`background progress clears and reports when a job becomes ${status}${error ? " from a timeout" : ""}`, async (t) => {
  let listener!: () => void;
  const job: any = { id: "worker-id", name: "worker-1", requestId: "request", agent: "default", status: "running",
    background: true, delivered: false, model: "custom/worker", thinking: "high", startedAt: Date.now() };
  const manager = { list: async () => [job], resume: async () => {}, close: async () => {}, preview: () => "Running tests",
    subscribe: (fn: () => void) => { listener = fn; return () => {}; },
    result: async () => ({ job: { ...job }, output: status === "waiting" ? "Which tests?" : status, usage: { cost: { total: 0 } } }),
    acknowledge: async () => { job.delivered = true; } };
  const { events, persisted, sent } = harness(t, async () => manager);
  const widgets = new Map<string, any>();
  const ctx = { hasUI: true, modelRegistry: { find() {}, streamSimple() {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted },
    ui: { theme: plainTheme, setStatus() {}, setWidget: (name: string, content: any) => widgets.set(name, widgetContent(content)), notify() {} } };
  await events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  assert.match(JSON.stringify([...widgets.values()]), /Running tests/);
  job.status = status; job.error = error;
  listener(); await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok([...widgets.values()].every((content) => content === undefined));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, status === "waiting" ? "agent-question" : "agent-result");
  assert.equal(sent[0].message.details.job.status, status);
  assert.equal(sent[0].options.triggerTurn, status !== "cancelled" || Boolean(error), "user cancellation stays idle; questions and actual failures still wake the parent");
  if (status === "cancelled" && !error) {
    events.get("agent_settled")();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(sent.length, 1, "settling the interrupted parent must not retry the cancellation report");
    assert.equal(job.delivered, true, "cancellation is still recorded and acknowledged");
  }
});

test("a foreground wait hides its background card and restores it on abort", async (t) => {
  const job = { id: "worker-id", name: "default-1", requestId: "request", agent: "default", status: "running",
    background: true, delivered: false, model: "custom/worker", thinking: "high", task: "Implement change", startedAt: Date.now() };
  const result = { job, output: "Running tests", usage: { cost: { total: 0 } } };
  const listeners = new Set<() => void>();
  const manager = { list: async () => [job], resume: async () => {}, close: async () => {}, preview: () => result.output,
    result: async () => result,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    wait: async (_id: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) };
  const { events, tools, persisted } = harness(t, async () => manager);
  const widgets = new Map<string, any>();
  const ctx = { hasUI: true, modelRegistry: { find() {}, streamSimple() {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted },
    ui: { theme: plainTheme, setStatus() {}, setWidget: (name: string, content: any) => widgets.set(name, widgetContent(content)), notify() {} } };
  await events.get("session_start")({}, ctx);
  t.after(() => events.get("session_shutdown")({}, ctx));
  assert.match(JSON.stringify([...widgets.values()]), /Running tests/);
  const controller = new AbortController();
  let update: any;
  const waiting = tools.get("agent").execute("wait", { action: "wait", id: job.name }, controller.signal, (next: any) => { update = next; }, ctx);
  const rejected = assert.rejects(waiting, /cancel wait/);
  t.after(() => controller.abort(new Error("cancel wait")));
  const other = new AbortController();
  const secondWait = tools.get("agent").execute("second-wait", { action: "wait", id: job.name }, other.signal, () => {}, ctx);
  const secondRejected = assert.rejects(secondWait, /cancel wait/);
  t.after(() => other.abort(new Error("cancel wait")));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(update.details.job.id, job.id);
  assert.ok([...widgets.values()].every((content) => content === undefined), "the same job must not appear in the wait card and widget");
  controller.abort(new Error("cancel wait"));
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok([...widgets.values()].every((content) => content === undefined), "another active wait still owns the card");
  other.abort(new Error("cancel wait"));
  await secondRejected;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(JSON.stringify([...widgets.values()]), /Running tests/);
  assert.equal(listeners.size, 1);
  await events.get("session_shutdown")({}, ctx);
  assert.ok([...widgets.values()].every((content) => content === undefined), "shutdown clears background cards");
});

test("agent result renderer shows content-block answers from /commit", (t) => {
  const { renderers } = harness(t);
  const rendered = renderers.get("agent-result")({ content: [{ type: "text", text: "Created commit abc123" }] });
  assert.match(rendered.render(80).join("\n"), /Created commit abc123/);
});

test("/agents opens a dashboard rather than a chain of selection dialogs", async (t) => {
  const { commands } = harness(t);
  let opened = false;
  const ctx = { hasUI: true, mode: "tui", ui: { custom: async () => { opened = true; },
    select: async () => { assert.fail("The default view should be the live dashboard"); } } };
  await commands.get("agents").handler("", ctx);
  assert.equal(opened, true);
  assert.equal(commands.has("subagents"), false);
});

test("/commit streams activity, renders its final answer, and removes its input listener", async (t) => {
  let finish!: (result: any) => void;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const job = { id: "commit-job", name: "commit-1", requestId: "commit-job", agent: "commit", status: "running", model: "custom/test", thinking: "low", startedAt: Date.now() };
  const usage = { cost: { total: 0.01 } };
  let listener: (() => void) | undefined;
  const manager = { list: async () => [], resume: async () => {}, subscribe: (fn: () => void) => { listener = fn; return () => {}; },
    spawn: async () => job, preview: () => "bash  git diff --stat\nRunning bash", wait: () => waiting, close: async () => {},
    result: async () => ({ job, output: "Stale output", usage }) };
  const { commands, events, sent, persisted, renderers, tools } = harness(t, async () => manager);
  const widgets: any[] = [];
  let removed = false;
  const ctx = { cwd: process.env.PI_CODING_AGENT_DIR, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => false,
    modelRegistry: { find: () => ({ provider: "custom", id: "test" }), streamSimple: () => {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => persisted },
    ui: { setWidget: (_name: string, content: any) => widgets.push(widgetContent(content)), setStatus: () => {}, notify: () => {},
      onTerminalInput: () => () => { removed = true; } } };
  await events.get("session_start")({}, ctx);
  const running = commands.get("commit").handler("Commit UI", ctx);
  const deadline = Date.now() + 5000;
  while (!sent.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const progressMessage = sent[0].message;
  const progressCard = renderers.get("agent-progress")(progressMessage, {}, plainTheme);
  listener!(); await new Promise((resolve) => setTimeout(resolve, 150));
  const live = progressCard.render(120).join("\n");
  const shared = tools.get("commit").renderResult({
    content: [], details: { job, output: manager.preview(), usage },
  }, { expanded: false, isPartial: true }, plainTheme).render(118);
  assert.ok(live.includes(shared[0]), "the command must use the same model/status/usage header as tool cards");
  assert.match(live, /\$0\.0100/);
  assert.match(live, /esc cancel/);
  assert.doesNotMatch(live, /Stale output|ctrl\+o/);
  finish({ job: { ...job, status: "done" }, output: "Created abc123", usage });
  await running;
  assert.match(live, /git diff --stat/);
  assert.equal(removed, true);
  assert.equal(widgets.at(-1), undefined);
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
  const rendered = progressCard.render(80).join("\n");
  assert.match(rendered, /commit-1 · done/);
  assert.match(rendered, /Created abc123/);
  assert.deepEqual(renderers.get("agent-result")(sent.at(-1).message, {}, theme).render(80), [], "completion updates the original command card");
  await events.get("session_shutdown")({}, ctx);
});

test("explicit background collection counts once, survives reload, and ignores automatic cards", async (t) => {
  const job = { id: "background-id", name: "worker", requestId: "request", agent: "default", status: "done", background: true,
    delivered: false, model: "provider/model", thinking: "low", task: "task" };
  const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
  const result = { job, output: "answer", usage };
  const manager = { subscribe: () => () => {}, resume: async () => {}, list: async () => [job], result: async () => result,
    wait: async () => result, message: async () => job, cancel: async () => {}, acknowledge: async () => {}, preview: () => "", close: async () => {} };
  const { tools, events, sent, persisted } = harness(t, async () => manager);
  const ctx = { hasUI: false, modelRegistry: { find: () => {}, streamSimple: () => {} },
    sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined, getBranch: () => [], getEntries: () => persisted },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} } };
  await events.get("session_start")({}, ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.usage, undefined);
  assert.deepEqual(sent[0].message.details.usage, usage);
  const tool = tools.get("agent");
  for (const action of ["status", "message", "cancel"])
    assert.equal((await tool.execute(action, { action, id: job.name, task: "guidance" }, undefined, undefined, ctx)).usage, undefined);
  const collected = await Promise.all([job.name, job.id].map((id) => tool.execute("wait", { action: "wait", id }, undefined, undefined, ctx)));
  assert.deepEqual(collected[0].usage, usage);
  assert.equal(collected[1].usage, undefined, "parallel waits reserve usage before either result is persisted");
  persisted.push({ type: "message", message: { role: "toolResult", ...collected[0] } });
  await events.get("session_shutdown")({}, ctx);
  await events.get("session_start")({}, ctx);
  assert.equal((await tool.execute("wait-again", { action: "wait", id: job.id }, undefined, undefined, ctx)).usage, undefined);
  const stats = AgentSession.prototype.getSessionStats.call({ sessionManager: ctx.sessionManager, getContextUsage: () => undefined } as any);
  assert.equal(stats.cost, usage.cost.total);
  assert.equal(stats.tokens.total, usage.totalTokens);
  result.usage = { input: 20, output: 10, cacheRead: 6, cacheWrite: 4, totalTokens: 40,
    cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 } };
  const continuation = await tool.execute("continuation", { action: "wait", id: job.name }, undefined, undefined, ctx);
  assert.deepEqual(continuation.usage, usage, "all token and cost fields report only the new delta");
  assert.deepEqual(continuation.details.usage, result.usage, "display details stay cumulative");
  assert.equal((await tool.execute("repeat", { action: "wait", id: job.id }, undefined, undefined, ctx)).usage, undefined);
  await events.get("session_shutdown")({}, ctx);
});
