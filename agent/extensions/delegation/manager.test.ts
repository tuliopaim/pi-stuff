import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentManager, type SpawnOptions } from "./manager.ts";
import { reconcileDashboardSelection, sanitizeTerminalText, Takeover } from "./dashboard.ts";

class FakeSession {
  messages: any[] = [];
  model = { id: "model", contextWindow: 1000 };
  sessionFile = "/tmp/fake-child.jsonl";
  isStreaming = false;
  extensionRunner = { hasHandlers: () => false, emit: async () => {} };
  private listeners = new Set<(event: any) => void>();
  private release?: () => void;
  readonly pending: boolean;
  disposed = false;
  stuckAbort = false;
  failBind = false;
  failNext = false;
  queueClears = 0;
  abortCalls = 0;
  preflightGate?: Promise<void>;
  constructor(pending = false) { this.pending = pending; }
  subscribe(listener: (event: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: any) { for (const listener of this.listeners) listener(event); }
  async bindExtensions() { if (this.failBind) throw new Error("bind failed"); }
  getContextUsage() { return { tokens: 30, contextWindow: 1000, percent: 3 }; }
  clearQueue() { this.queueClears++; return { steering: [], followUp: [] }; }
  async prompt(text: string) {
    this.isStreaming = true;
    await this.preflightGate;
    const user = { role: "user", content: text, timestamp: Date.now() };
    this.messages.push(user); this.emit({ type: "agent_start" }); this.emit({ type: "message_end", message: user });
    if (this.failNext) { this.failNext = false; this.isStreaming = false; throw new Error("prompt failed"); }
    if (this.pending) await new Promise<void>((resolve) => { this.release = resolve; });
    const assistant = {
      role: "assistant", content: [{ type: "text", text: `answer: ${text}` }], stopReason: "stop", timestamp: Date.now(),
      provider: "test", model: "model", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0.01 } },
    };
    this.messages.push(assistant); this.emit({ type: "message_end", message: assistant });
    this.isStreaming = false; this.emit({ type: "agent_settled" });
  }
  async steer(text: string) { return this.prompt(text); }
  async abort() { this.abortCalls++; if (this.stuckAbort) return new Promise<void>(() => {}); this.isStreaming = false; this.release?.(); }
  dispose() { this.disposed = true; this.release?.(); }
  getAllTools() { return []; }
  getToolDefinition() { return undefined; }
}

function harness(options: { pending?: boolean; registryFile?: string; parentSessionId?: string; onSettled?: (snapshot: any) => void; stuckAbort?: boolean; failBind?: boolean; resourceGate?: Promise<void>; preflightGate?: Promise<void>; createFail?: boolean } = {}) {
  const sessions: FakeSession[] = [];
  const sessionOptions: any[] = [];
  const resourceOptions: any[] = [];
  const manager = new SubagentManager({
    cwd: process.cwd(),
    modelRegistry: { find: () => ({ provider: "test", id: "model", contextWindow: 1000 }) } as any,
    isProjectTrusted: () => true,
  }, options.parentSessionId ?? "parent-test", options.onSettled, {
    registryFile: options.registryFile ?? join(mkdtempSync(join(tmpdir(), "subagents-manager-")), "registry.json"),
    createResources: async (resourceConfig) => { resourceOptions.push(resourceConfig); await options.resourceGate; return ({ loader: {}, settingsManager: {} }) as any; },
    createSessionManager: () => ({}) as any,
    createSession: async (sessionConfig) => {
      sessionOptions.push(sessionConfig);
      if (options.createFail) throw new Error("create failed");
      const session = new FakeSession(options.pending);
      session.stuckAbort = options.stuckAbort ?? false;
      session.failBind = options.failBind ?? false;
      session.preflightGate = options.preflightGate;
      sessions.push(session);
      return { session } as any;
    }, abortTimeoutMs: 10,
  });
  return { manager, sessions, sessionOptions, resourceOptions };
}

function spawnOptions(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    origin: "generic", title: "test", task: "do it", cwd: process.cwd(), model: "test/model", thinking: "low",
    mutating: false, config: { name: "Agent", prompt: "prompt", timeoutMs: 10_000 }, ...overrides,
  };
}

test("manager assigns IDs, settles, waits, and captures output", async () => {
  const { manager } = harness();
  const snapshot = await manager.spawn(spawnOptions());
  assert.match(snapshot.id, /^sa_/);
  const [done] = await manager.wait([snapshot.id]);
  assert.equal(done.status, "done");
  assert.match(done.output, /answer: Agent task: do it/);
  assert.equal(done.usage.turns, 1);
  await manager.shutdown();
});

test("synchronous consumers suppress automatic result delivery", async () => {
  const settled: any[] = [];
  const { manager } = harness({ onSettled: (snapshot) => settled.push({ consumed: snapshot.consumed }) });
  const snapshot = await manager.spawn(spawnOptions({ consumed: true }));
  await manager.wait([snapshot.id]);
  assert.deepEqual(settled, [{ consumed: true }]);
  await manager.shutdown();
});

test("focused policies keep their SDK tool allowlist and recursive denylist", async () => {
  const { manager, sessionOptions, resourceOptions } = harness();
  const snapshot = await manager.spawn(spawnOptions({
    origin: "scout",
    config: { name: "Scout", prompt: "prompt", timeoutMs: 10_000, tools: "read,grep,find,ls" },
  }));
  await manager.wait([snapshot.id]);
  assert.deepEqual(sessionOptions[0].tools, ["read", "grep", "find", "ls"]);
  assert.ok(sessionOptions[0].excludeTools.includes("agent"));
  assert.ok(sessionOptions[0].excludeTools.includes("workflow"));
  assert.ok(sessionOptions[0].excludeTools.includes("ask_user"));
  assert.equal(resourceOptions[0].noExtensions, true);
  assert.equal(resourceOptions[0].noSkills, true);
  await manager.shutdown();
});

test("manager enforces global and per-cwd mutation concurrency", async () => {
  const { manager } = harness({ pending: true });
  for (let index = 0; index < 4; index++) await manager.spawn(spawnOptions({ cwd: `/tmp/read-${index}` }));
  await assert.rejects(manager.spawn(spawnOptions({ cwd: "/tmp/read-5" })), /Max 4/);
  await manager.cancel(manager.list().map((entry) => entry.id));
  const first = await manager.spawn(spawnOptions({ mutating: true }));
  await assert.rejects(manager.spawn(spawnOptions({ mutating: true })), /mutating subagent/);
  await manager.cancel([first.id]);
  await manager.shutdown();
});

test("mutation lock covers subdirectories and symlink aliases of one worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagents-worktree-"));
  const child = join(root, "src");
  const alias = `${root}-alias`;
  mkdirSync(join(root, ".git")); mkdirSync(child); symlinkSync(root, alias);
  try {
    const { manager } = harness({ pending: true });
    const first = await manager.spawn(spawnOptions({ cwd: child, mutating: true }));
    await assert.rejects(manager.spawn(spawnOptions({ cwd: alias, mutating: true })), /mutating subagent/);
    await manager.cancel([first.id]);
    await manager.shutdown();
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(alias, { force: true }); }
});

test("hung abort force-disposes the child and releases its mutation lock", async () => {
  const { manager, sessions } = harness({ pending: true, stuckAbort: true });
  const first = await manager.spawn(spawnOptions({ mutating: true }));
  await manager.cancel([first.id]);
  assert.equal(first.status, "cancelled");
  assert.match(first.error ?? "", /force-disposed/);
  assert.equal(sessions[0].disposed, true);
  await manager.spawn(spawnOptions({ mutating: true }));
  await manager.shutdown();
});

test("cancel settles once and follow-up restarts a settled session", async () => {
  const { manager, sessions } = harness({ pending: true });
  const snapshot = await manager.spawn(spawnOptions());
  await manager.cancel([snapshot.id]);
  assert.equal(snapshot.status, "cancelled");
  assert.ok(sessions[0].queueClears > 0);
  await manager.send(snapshot.id, "continue");
  await manager.cancel([snapshot.id]);
  assert.equal(snapshot.status, "cancelled");
  await manager.shutdown();
});

test("continuing a consumed generic subagent makes the new result deliverable", async () => {
  const settled: boolean[] = [];
  const { manager } = harness({ onSettled: (snapshot) => settled.push(snapshot.consumed) });
  const snapshot = await manager.spawn(spawnOptions({ consumed: true }));
  await manager.wait([snapshot.id]);
  await manager.send(snapshot.id, "continue");
  while (snapshot.status === "running") await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settled, [true, false]);
  await manager.shutdown();
});

test("cancellation is re-applied if SDK prompt preflight starts late", async () => {
  let release!: () => void;
  const preflightGate = new Promise<void>((resolve) => { release = resolve; });
  const { manager, sessions } = harness({ preflightGate });
  const snapshot = await manager.spawn(spawnOptions());
  await manager.cancel([snapshot.id]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshot.status, "cancelled");
  assert.ok(sessions[0].abortCalls >= 2);
  await manager.shutdown();
});

test("managed runs enforce their policy timeout", async () => {
  const { manager, sessions } = harness({ pending: true });
  const snapshot = await manager.spawn(spawnOptions({ config: { name: "Agent", prompt: "prompt", timeoutMs: 10 } }));
  await manager.wait([snapshot.id]);
  assert.equal(snapshot.status, "failed");
  assert.match(snapshot.error ?? "", /Timed out/);
  assert.ok(sessions[0].queueClears > 0);
  await manager.shutdown();
});

test("timeout and cancellation cover resource loading before a child exists", async () => {
  let releaseTimeout!: () => void;
  const timeoutGate = new Promise<void>((resolve) => { releaseTimeout = resolve; });
  const timed = harness({ resourceGate: timeoutGate });
  await assert.rejects(timed.manager.spawn(spawnOptions({ config: { name: "Agent", prompt: "prompt", timeoutMs: 10 } })), /Timed out/);
  releaseTimeout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timed.sessions.length, 0);
  await timed.manager.shutdown();

  let releaseCancel!: () => void;
  const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
  const cancelled = harness({ resourceGate: cancelGate });
  const controller = new AbortController();
  const spawning = cancelled.manager.spawn(spawnOptions({ signal: controller.signal }));
  controller.abort(new Error("cancel setup"));
  await assert.rejects(spawning, /cancel setup/);
  assert.equal(cancelled.manager.list()[0].status, "cancelled");
  releaseCancel();
  await cancelled.manager.shutdown();
});

test("follow-ups sent during startup are queued instead of discarded", async () => {
  let release!: () => void;
  const resourceGate = new Promise<void>((resolve) => { release = resolve; });
  const { manager, sessions } = harness({ resourceGate });
  const spawning = manager.spawn(spawnOptions());
  await new Promise((resolve) => setImmediate(resolve));
  const id = manager.list()[0].id;
  await manager.send(id, "queued follow-up");
  release();
  const snapshot = await spawning;
  await manager.wait([snapshot.id]);
  assert.ok(sessions[0].messages.some((message) => message.role === "user" && message.content === "queued follow-up"));
  await manager.shutdown();
});

test("failed follow-up does not reuse the previous run output", async () => {
  const { manager, sessions } = harness();
  const snapshot = await manager.spawn(spawnOptions());
  await manager.wait([snapshot.id]);
  sessions[0].failNext = true;
  await manager.send(snapshot.id, "fail now");
  await manager.wait([snapshot.id]);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.output, "");
  await manager.shutdown();
});

test("live transcript and tracked history remain bounded", async () => {
  const { manager, sessions } = harness();
  const snapshot = await manager.spawn(spawnOptions());
  await manager.wait([snapshot.id]);
  sessions[0].messages = Array.from({ length: 600 }, (_, index) => ({ role: "user", content: `message ${index}`, timestamp: index }));
  await manager.send(snapshot.id, "continue");
  await manager.wait([snapshot.id]);
  assert.ok(snapshot.transcript.length > 0 && snapshot.transcript.length <= 512);
  await manager.shutdown();
});

test("binding failure disposes the created child session", async () => {
  const { manager, sessions } = harness({ failBind: true });
  await assert.rejects(manager.spawn(spawnOptions()), /bind failed/);
  assert.equal(sessions[0].disposed, true);
  await manager.shutdown();
});

test("shutdown during child creation cannot resurrect the run", async () => {
  let release!: () => void;
  const resourceGate = new Promise<void>((resolve) => { release = resolve; });
  const { manager, sessions } = harness({ resourceGate });
  const spawning = manager.spawn(spawnOptions());
  await new Promise((resolve) => setImmediate(resolve));
  await manager.shutdown();
  release();
  await assert.rejects(spawning, /shutting down/);
  assert.equal(sessions.length, 0);
});

test("pruning disposes sessions removed from bounded history", async () => {
  const { manager, sessions } = harness();
  for (let index = 0; index < 65; index++) {
    const snapshot = await manager.spawn(spawnOptions({ title: String(index) }));
    await manager.wait([snapshot.id]);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.list().length, 64);
  assert.equal(sessions[0].disposed, true);
  await manager.shutdown();
});

test("registry round trip restores settled entries and stale running entries as interrupted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-persist-"));
  const registryFile = join(dir, "registry.json");
  try {
    const first = harness({ registryFile });
    const snapshot = await first.manager.spawn(spawnOptions());
    await first.manager.wait([snapshot.id]);
    await first.manager.shutdown();
    const restored = harness({ registryFile }).manager;
    assert.equal(restored.get(snapshot.id)?.status, "done");
    assert.equal(restored.get(snapshot.id)?.restored, true);
    assert.equal(restored.get(snapshot.id)?.consumed, true);
    await restored.shutdown();

    const isolationFile = join(dir, "isolated.json");
    writeFileSync(isolationFile, readFileSync(registryFile, "utf8"));
    const isolated = harness({ registryFile: isolationFile, parentSessionId: "different-parent" }).manager;
    assert.equal(isolated.list().length, 0);
    await isolated.shutdown();

    const raw = JSON.parse(readFileSync(registryFile, "utf8"));
    raw.entries[0].snapshot.status = "running";
    writeFileSync(registryFile, JSON.stringify(raw));
    const interrupted = harness({ registryFile }).manager;
    assert.equal(interrupted.get(snapshot.id)?.status, "interrupted");
    await interrupted.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling restored-session setup interrupts creation and allows reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-restored-cancel-"));
  const registryFile = join(dir, "registry.json");
  try {
    const initial = harness({ registryFile });
    const snapshot = await initial.manager.spawn(spawnOptions());
    await initial.manager.wait([snapshot.id]);
    await initial.manager.shutdown();

    let release!: () => void;
    const resourceGate = new Promise<void>((resolve) => { release = resolve; });
    const restored = harness({ registryFile, resourceGate });
    const sending = restored.manager.send(snapshot.id, "continue");
    await new Promise((resolve) => setImmediate(resolve));
    await restored.manager.cancel([snapshot.id]);
    await assert.rejects(sending, /Cancelled/);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restored.sessions.length, 0);
    assert.equal(restored.manager.get(snapshot.id)?.status, "cancelled");
    await restored.manager.shutdown();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restored continuation clears stale output before an open failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-restore-fail-"));
  const registryFile = join(dir, "registry.json");
  try {
    const first = harness({ registryFile });
    const snapshot = await first.manager.spawn(spawnOptions());
    await first.manager.wait([snapshot.id]);
    await first.manager.shutdown();
    const restored = harness({ registryFile, createFail: true }).manager;
    const restoredSnapshot = restored.get(snapshot.id)!;
    assert.notEqual(restoredSnapshot.output, "");
    await assert.rejects(restored.send(snapshot.id, "continue"), /create failed/);
    assert.equal(restoredSnapshot.output, "");
    assert.equal(restoredSnapshot.status, "failed");
    await restored.shutdown();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restored continuation rejects missing child session state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-missing-session-"));
  const registryFile = join(dir, "registry.json");
  try {
    const first = harness({ registryFile });
    const snapshot = await first.manager.spawn(spawnOptions());
    await first.manager.wait([snapshot.id]);
    await first.manager.shutdown();
    const raw = JSON.parse(readFileSync(registryFile, "utf8"));
    delete raw.entries[0].snapshot.sessionFile;
    writeFileSync(registryFile, JSON.stringify(raw));
    const restored = harness({ registryFile }).manager;
    await assert.rejects(restored.send(snapshot.id, "continue"), /session state is unavailable/);
    await restored.shutdown();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restore reapplies per-string registry limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-string-limits-"));
  const registryFile = join(dir, "registry.json");
  try {
    const huge = "x".repeat(100_000);
    writeFileSync(registryFile, JSON.stringify({
      version: 1, parentSessionId: "parent-test", entries: [{
        snapshot: { id: "sa_limit", origin: "generic", title: huge, task: huge, cwd: process.cwd(), model: "test/model", thinking: "low", status: "done", mutating: false, createdAt: 1, output: huge, activities: [huge], usage: {}, consumed: true, sessionFile: "/tmp/fake-child.jsonl" },
        config: { name: "Agent", prompt: huge, timeoutMs: 10_000 },
      }],
    }));
    const restored = harness({ registryFile });
    const snapshot = restored.manager.get("sa_limit")!;
    assert.equal(snapshot.title.length, 160);
    assert.equal(snapshot.task.length, 16 * 1024);
    assert.equal(snapshot.output.length, 16 * 1024);
    await restored.manager.send(snapshot.id, "continue");
    await restored.manager.wait([snapshot.id]);
    assert.equal(restored.resourceOptions[0].appendSystemPrompt[0].length, 16 * 1024);
    await restored.manager.shutdown();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed and corrupt registries fail safely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-corrupt-"));
  const registryFile = join(dir, "registry.json");
  try {
    writeFileSync(registryFile, "not json");
    const corrupt = harness({ registryFile }).manager;
    assert.deepEqual(corrupt.list(), []);
    await corrupt.shutdown();
    writeFileSync(registryFile, JSON.stringify({ version: 1, parentSessionId: "parent-test", entries: [{ snapshot: { id: "bad" }, config: {} }] }));
    const malformed = harness({ registryFile }).manager;
    assert.deepEqual(malformed.list(), []);
    await malformed.shutdown();
    writeFileSync(registryFile, " ".repeat(4 * 1024 * 1024 + 1));
    const oversized = harness({ registryFile }).manager;
    assert.deepEqual(oversized.list(), []);
    await oversized.shutdown();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dashboard selection follows a stable ID across list updates", () => {
  const selection = { id: "sa_b", index: 1 };
  reconcileDashboardSelection(selection, [{ id: "sa_b" }, { id: "sa_a" }]);
  assert.deepEqual(selection, { id: "sa_b", index: 0 });
});

test("takeover sends follow-ups and exposes an explicit abort action", async () => {
  const sent: string[] = [];
  const cancelled: string[][] = [];
  const snapshot = { id: "sa_one", status: "running" };
  const manager: any = {
    subscribeTo: () => () => {}, get: () => snapshot,
    send: async (_id: string, text: string) => { sent.push(text); },
    cancel: async (ids: string[]) => { cancelled.push(ids); },
  };
  const tui: any = { terminal: { rows: 30 }, requestRender() {} };
  const theme: any = { fg: (_color: string, text: string) => text };
  const keys: any = { matches: (data: string, action: string) => data === "abort" && action === "app.clear" };
  const takeover = new Takeover(tui, theme, keys, manager, "sa_one", () => {});
  (takeover as any).input.onSubmit("continue with tests");
  await new Promise((resolve) => setImmediate(resolve));
  takeover.handleInput("abort");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ["continue with tests"]);
  assert.deepEqual(cancelled, [["sa_one"]]);
  takeover.dispose();
});

test("takeover text strips terminal controls and normalizes tabs", () => {
  assert.equal(sanitizeTerminalText("ok\x1b[31mred\x1b[0m\tcol\r\nnext\u0007"), "okred    col\nnext");
  assert.equal(sanitizeTerminalText("\x1b]0;owned\x07safe"), "safe");
});

test("takeover renders failure details and recent tool activity", () => {
  const snapshot: any = {
    id: "sa_failed", title: "failed agent", status: "failed", error: "model failed", activities: ["read src/a.ts", "✗ bash"],
    createdAt: Date.now(), settledAt: Date.now(), model: "test/model", thinking: "high", transcript: [], liveThinking: "", liveText: "", queued: [],
  };
  const manager: any = { subscribeTo: () => () => {}, get: () => snapshot };
  const tui: any = { terminal: { rows: 30 }, requestRender() {} };
  const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const takeover = new Takeover(tui, theme, { matches: () => false } as any, manager, snapshot.id, () => {});
  const rendered = takeover.render(100).join("\n");
  assert.match(rendered, /RECENT ACTIVITY/);
  assert.match(rendered, /read src\/a\.ts/);
  assert.match(rendered, /ERROR: model failed/);
  takeover.dispose();
});
