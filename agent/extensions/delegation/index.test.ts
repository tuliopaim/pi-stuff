import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerDelegation from "./index.ts";
import { setSubagentPreset } from "./runtime.ts";

function registrationHarness() {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const renderers: string[] = [];
  const entries: string[] = [];
  registerDelegation({
    registerTool(tool: any) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
    registerMessageRenderer(name: string) { renderers.push(name); },
    registerEntryRenderer(name: string) { entries.push(name); },
    on(name: string) { events.push(name); },
  } as any);
  return { tools, commands, events, renderers, entries };
}

function withAgentEnabled<T>(run: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegation-enabled-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      subagents: { preset: "test", presets: { test: {
        agent: { model: "opencode-go/kimi-k2.7-code", thinking: "high", routes: [] },
      } } },
    }));
    process.env.PI_CODING_AGENT_DIR = dir;
    setSubagentPreset(undefined);
    return run();
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("registers existing and persistent subagent APIs", () => {
  const registered = withAgentEnabled(registrationHarness);
  assert.deepEqual(registered.tools, [
    "scout", "review", "commit", "agent",
    "subagent_spawn", "subagent_wait", "subagent_cancel", "subagent_check", "subagent_list",
  ]);
  assert.deepEqual(registered.commands, ["commit", "subagents", "btw", "subagent-preset"]);
  assert.deepEqual(registered.renderers, ["commit-result", "subagent-result"]);
  assert.deepEqual(registered.entries, ["btw-result"]);
  assert.ok(registered.events.includes("session_start"));
  assert.ok(registered.events.includes("session_shutdown"));
});

test("model guidance scales delegation by independent workstreams", () => {
  const tools = new Map<string, any>();
  withAgentEnabled(() => registerDelegation({
      registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, on() {},
    } as any));
  assert.match(tools.get("scout").promptGuidelines.join("\n"), /Use one scout by default/);
  assert.match(tools.get("agent").promptGuidelines.join("\n"), /default to zero for clear local work/);
  assert.match(tools.get("agent").promptGuidelines.join("\n"), /Do not split connected implementation/);
  assert.match(tools.get("subagent_spawn").promptGuidelines.join("\n"), /Treat four as a hard ceiling, not a target/);

  const orchestrate = readFileSync(join(process.cwd(), "prompts/orchestrate.md"), "utf8");
  assert.match(orchestrate, /Use at most one mutating agent in the workflow/);
});

test("agent renderer replaces its Kimi default when streamed arguments select Sol", () => {
  let agentTool: any;
  withAgentEnabled(() => registerDelegation({
      registerTool(tool: any) { if (tool.name === "agent") agentTool = tool; },
      registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, on() {},
    } as any));
  const context: any = { state: {}, expanded: false };
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  agentTool.renderCall({ task: "review this" }, theme, context);
  agentTool.renderCall({ task: "review this", model: "openai-codex/gpt-5.6-sol", thinking: "high" }, theme, context);
  assert.equal(context.state.config.model, "openai-codex/gpt-5.6-sol");
  assert.equal(context.state.config.thinking, "high");
});

test("delegated children do not register delegation tools", () => {
  const previous = process.env.PI_DELEGATED;
  const tools: any[] = [];
  try {
    process.env.PI_DELEGATED = "1";
    registerDelegation({ registerTool: (tool: any) => tools.push(tool) } as any);
    assert.deepEqual(tools, []);
  } finally {
    if (previous === undefined) delete process.env.PI_DELEGATED;
    else process.env.PI_DELEGATED = previous;
  }
});

test("does not register predefined policies explicitly disabled in settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegation-disabled-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      subagents: { preset: "test", presets: { test: { scout: { enabled: false }, commit: { enabled: false } } } },
    }));
    process.env.PI_CODING_AGENT_DIR = dir;
    setSubagentPreset(undefined);
    const registered = registrationHarness();
    assert.deepEqual(registered.tools.slice(0, 2), ["review", "agent"]);
    assert.ok(!registered.commands.includes("commit"));
    assert.ok(registered.commands.includes("subagent-preset"));
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/commit keeps progress, Escape cancellation, and custom result delivery", async () => {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: any[] = [];
  const widgets: any[] = [];
  let terminalInput: ((data: string) => unknown) | undefined;
  let finishWait!: () => void;
  const waiting = new Promise<void>((resolve) => { finishWait = resolve; });
  const snapshot: any = {
    id: "sa_commit", origin: "commit", title: "commit", task: "commit", cwd: process.cwd(), model: "test/model", thinking: "low",
    status: "running", mutating: true, createdAt: Date.now(), output: "", liveText: "working", liveThinking: "", activities: ["git status"], queued: [], transcript: [],
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 }, consumed: true,
  };
  const listeners = new Set<() => void>();
  const manager: any = {
    list: () => [snapshot], get: () => snapshot, subscribe: () => () => {}, subscribeTo: (_id: string, listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    spawn: async (options: any) => { options.signal?.addEventListener("abort", () => void manager.cancel([snapshot.id]), { once: true }); return snapshot; },
    wait: async () => { await waiting; return [snapshot]; },
    cancel: async () => { snapshot.status = "cancelled"; snapshot.error = "Cancelled"; snapshot.settledAt = Date.now(); for (const listener of listeners) listener(); finishWait(); return [snapshot]; },
    shutdown: async () => {}, consume: () => {},
  };
  registerDelegation({
    registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command); },
    registerMessageRenderer() {}, registerEntryRenderer() {}, on(name: string, handler: any) { events.set(name, handler); },
    sendMessage(message: any) { messages.push(message); }, getThinkingLevel: () => "low",
  } as any, () => manager);
  const ui: any = {
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    setStatus() {}, notify() {}, setWidget: (key: string, content: any) => widgets.push([key, content]),
    onTerminalInput(handler: any) { terminalInput = handler; return () => {}; },
  };
  const ctx: any = { cwd: process.cwd(), mode: "tui", hasUI: true, isIdle: () => true, ui, sessionManager: { getSessionId: () => "parent" } };
  events.get("session_start")({}, ctx);
  const running = commands.get("commit").handler("commit this", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof widgets.at(-1)?.[1], "function");
  assert.deepEqual(terminalInput?.("\x1b"), { consume: true });
  await running;
  assert.equal(messages[0].customType, "commit-result");
  assert.equal(messages[0].details.status, "cancelled");
  assert.deepEqual(widgets.at(-1), ["commit", undefined]);
});

test("Escape during /commit setup is reported as cancellation", async () => {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: any[] = [];
  let terminalInput: ((data: string) => unknown) | undefined;
  const manager: any = {
    list: () => [], subscribe: () => () => {}, shutdown: async () => {},
    spawn: async (options: any) => new Promise((_resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      if (options.signal.aborted) abort(); else options.signal.addEventListener("abort", abort, { once: true });
    }),
  };
  registerDelegation({
    registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, registerEntryRenderer() {},
    on(name: string, handler: any) { events.set(name, handler); }, sendMessage(message: any) { messages.push(message); },
  } as any, () => manager);
  const ctx: any = {
    cwd: process.cwd(), mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "parent" },
    ui: { theme: { fg: (_color: string, text: string) => text }, setStatus() {}, setWidget() {}, notify() {}, onTerminalInput(handler: any) { terminalInput = handler; return () => {}; } },
  };
  events.get("session_start")({}, ctx);
  const running = commands.get("commit").handler("commit", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  terminalInput?.("\x1b");
  await running;
  assert.equal(messages[0].details.status, "cancelled");
  assert.match(messages[0].content, /cancelled/i);
});

test("restored unconsumed background results are delivered once and consumed", async () => {
  const events = new Map<string, any>();
  const messages: any[] = [];
  const consumed: string[] = [];
  const snapshot: any = {
    id: "sa_restored", origin: "generic", title: "done", task: "task", cwd: process.cwd(), model: "test/model", thinking: "low",
    status: "done", mutating: true, createdAt: Date.now(), settledAt: Date.now(), output: "answer", liveText: "", liveThinking: "", activities: [], queued: [], transcript: [],
    usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2 }, consumed: false, restored: true,
  };
  const manager: any = { list: () => [snapshot], subscribe: () => () => {}, shutdown: async () => {}, consume: (id: string) => { consumed.push(id); snapshot.consumed = true; } };
  registerDelegation({
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    on(name: string, handler: any) { events.set(name, handler); }, sendMessage(message: any) { messages.push(message); },
  } as any, () => manager);
  const ctx: any = {
    hasUI: false, isIdle: () => true, ui: { setStatus() {}, notify() {}, theme: {} },
    sessionManager: { getSessionId: () => "parent" },
  };
  events.get("session_start")({}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  events.get("agent_settled")();
  assert.equal(messages.length, 1);
  assert.deepEqual(consumed, ["sa_restored"]);
});

test("/btw persists a TUI entry without injecting the answer into model context", async () => {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const appended: any[] = [];
  const messages: any[] = [];
  let onSettled!: (snapshot: any) => void;
  const snapshot: any = {
    id: "btw_one", origin: "btw", title: "side question", task: "side question", cwd: process.cwd(), model: "test/model", thinking: "low",
    status: "done", mutating: false, createdAt: Date.now(), settledAt: Date.now(), output: "side answer", liveText: "", liveThinking: "", activities: [], queued: [], transcript: [],
    usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2 }, consumed: false,
  };
  const manager: any = { list: () => [], get: () => snapshot, subscribe: () => () => {}, subscribeTo: () => () => {}, spawn: async () => { queueMicrotask(() => onSettled(snapshot)); return snapshot; }, shutdown: async () => {} };
  registerDelegation({
    registerTool() {}, registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, registerEntryRenderer() {},
    on(name: string, handler: any) { events.set(name, handler); }, sendMessage(message: any) { messages.push(message); },
    appendEntry(type: string, data: any) { appended.push([type, data]); }, getThinkingLevel: () => "low",
  } as any, (_ctx, _id, settled) => { onSettled = settled; return manager; });
  const ctx: any = {
    cwd: process.cwd(), mode: "tui", hasUI: true, model: { provider: "test", id: "model" }, isIdle: () => true,
    sessionManager: { getSessionId: () => "parent" },
    ui: { theme: {}, setStatus() {}, notify() {}, custom: async () => {} },
  };
  events.get("session_start")({}, ctx);
  await commands.get("btw").handler("side question", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appended[0][0], "btw-result");
  assert.equal(appended[0][1].answer, "side answer");
  assert.deepEqual(messages, []);
});

test("model-facing management tools reject TUI-only /btw sessions", async () => {
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const btw: any = { id: "btw_secret", origin: "btw", status: "done" };
  const manager: any = {
    list: () => [btw], get: (id: string) => id === btw.id ? btw : undefined, subscribe: () => () => {}, shutdown: async () => {},
    wait: async () => [btw], cancel: async () => [btw],
  };
  registerDelegation({
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    on(name: string, handler: any) { events.set(name, handler); },
  } as any, () => manager);
  events.get("session_start")({}, { hasUI: false, ui: { setStatus() {}, notify() {} }, sessionManager: { getSessionId: () => "parent" } });
  await assert.rejects(tools.get("subagent_wait").execute("call", { ids: [btw.id] }), /only available through the TUI/);
  await assert.rejects(tools.get("subagent_cancel").execute("call", { ids: [btw.id] }), /only available through the TUI/);
  await assert.rejects(tools.get("subagent_check").execute("call", { id: btw.id }), /Unknown subagent/);
  const listed = await tools.get("subagent_list").execute("call", {});
  assert.equal(listed.content[0].text, "No subagents.");
});

test("subagent_wait caps combined output across many agents", async () => {
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const snapshots = Array.from({ length: 8 }, (_, index) => ({
    id: `sa_${index}`, origin: "generic", title: `agent ${index}`, status: "done", output: "x".repeat(16 * 1024), consumed: false,
  }));
  const manager: any = {
    list: () => snapshots, get: (id: string) => snapshots.find((entry) => entry.id === id), subscribe: () => () => {}, shutdown: async () => {},
    wait: async () => snapshots, consume: () => {},
  };
  registerDelegation({
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    on(name: string, handler: any) { events.set(name, handler); },
  } as any, () => manager);
  events.get("session_start")({}, { hasUI: false, ui: { setStatus() {}, notify() {} }, sessionManager: { getSessionId: () => "parent" } });
  const result = await tools.get("subagent_wait").execute("call", { ids: snapshots.map((entry) => entry.id) });
  assert.match(result.content[0].text, /combined subagent output truncated/);
  assert.ok(Buffer.byteLength(result.content[0].text) < 70 * 1024);
});
