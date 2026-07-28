import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import {
  createAgentSession,
  getAgentDir,
  SessionManager,
  truncateHead,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import { transcriptFromMessages } from "../workflows/runner.ts";
import { writeFileAtomic } from "../workflows/serialization.ts";
import { emptySubagentUsage, type SubagentOrigin, type SubagentSnapshot } from "./domain.ts";
import type { DelegationConfig } from "./runtime.ts";

const MAX_RUNNING = 4;
const MAX_TRACKED = 64;
const OUTPUT_MAX_BYTES = 1024 * 1024;
const LIVE_MAX_CHARS = 128 * 1024;
const MAX_TRANSCRIPT_ITEMS = 512;
const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;
const PERSISTED_STRING_MAX = 16 * 1024;
const STATUSES = new Set(["running", "done", "failed", "cancelled", "interrupted"]);

interface PersistedConfig {
  name: string;
  prompt: string;
  timeoutMs: number;
  tools?: string;
  skills?: readonly string[];
  inheritResources?: boolean;
}

export interface SpawnOptions {
  origin: SubagentOrigin;
  title: string;
  task: string;
  cwd: string;
  model: string;
  thinking: string;
  mutating: boolean;
  config: PersistedConfig;
  consumed?: boolean;
  signal?: AbortSignal;
}

interface Entry {
  snapshot: SubagentSnapshot;
  config: PersistedConfig;
  controller?: AbortController;
  session?: AgentSession;
  unsubscribe?: () => void;
  completion: Deferred.Deferred<SubagentSnapshot>;
  scope: Scope.Closeable;
  setupFiber?: Fiber.Fiber<unknown, unknown>;
  runFiber?: Fiber.Fiber<void, never>;
  timeoutFiber?: Fiber.Fiber<void, never>;
  reserved?: boolean;
  active?: boolean;
  runStart?: number;
  deadlineAt?: number;
  workspace: string;
  removeExternalAbort?: () => void;
  pendingSteers?: string[];
}

interface PersistedRegistry {
  version: 1;
  parentSessionId: string;
  entries: Array<{ snapshot: Omit<SubagentSnapshot, "transcript" | "liveText" | "liveThinking" | "queued">; config: PersistedConfig }>;
}

export interface SubagentManagerOptions {
  registryFile?: string;
  createSession?: typeof createAgentSession;
  createResources?: typeof createChildResources;
  createSessionManager?: (cwd: string, sessionFile?: string) => SessionManager;
  abortTimeoutMs?: number;
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 16 * 1024);
}

/** Promise interop that lets Effect interruption win while still cleaning up a late resource. */
function promiseEffect<T>(operation: Promise<T>, late?: (value: T) => void | Promise<void>) {
  return Effect.callback<T, unknown>((resume) => {
    let interrupted = false;
    operation.then(
      (value) => interrupted ? void late?.(value) : resume(Effect.succeed(value)),
      (error) => { if (!interrupted) resume(Effect.fail(error)); },
    );
    return Effect.sync(() => { interrupted = true; });
  });
}

async function abortBounded(session: AgentSession, timeoutMs = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const stopped = await Promise.race([session.abort().then(() => true as const, () => true as const), timeout]);
  if (timer) clearTimeout(timer);
  return stopped;
}

async function stopSession(session: AgentSession, timeoutMs: number) {
  session.clearQueue();
  return abortBounded(session, timeoutMs);
}

function clipped(value: string, max?: number): string;
function clipped(value: unknown, max?: number): string | undefined;
function clipped(value: unknown, max = PERSISTED_STRING_MAX) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function finalOutput(session: AgentSession, start = 0) {
  for (let index = session.messages.length - 1; index >= start; index--) {
    const message = session.messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (text) return text;
  }
  return "";
}

function workspaceFor(cwd: string) {
  let current: string;
  try { current = fs.realpathSync(cwd); } catch { current = path.resolve(cwd); }
  const fallback = current;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function restoredEntry(value: unknown, interruptedAt: number) {
  const item = record(value);
  const raw = record(item?.snapshot);
  const config = record(item?.config);
  if (!raw || !config || typeof raw.id !== "string" || typeof raw.origin !== "string" || typeof raw.cwd !== "string"
    || typeof raw.model !== "string" || typeof raw.thinking !== "string" || typeof config.name !== "string"
    || typeof config.prompt !== "string" || typeof config.timeoutMs !== "number") return;
  const persistedStatus = typeof raw.status === "string" && STATUSES.has(raw.status) ? raw.status : "failed";
  const status = (persistedStatus === "running" ? "interrupted" : persistedStatus) as SubagentSnapshot["status"];
  const usage = record(raw.usage);
  const snapshot: SubagentSnapshot = {
    id: clipped(raw.id),
    origin: (["scout", "review", "commit", "agent", "generic", "btw"].includes(raw.origin) ? raw.origin : "generic") as SubagentOrigin,
    title: typeof raw.title === "string" ? clipped(raw.title, 160) : clipped(raw.id, 160),
    task: clipped(raw.task) ?? "",
    cwd: clipped(raw.cwd),
    model: clipped(raw.model),
    thinking: clipped(raw.thinking),
    status,
    mutating: raw.mutating === true,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : interruptedAt,
    settledAt: status === "interrupted" ? interruptedAt : typeof raw.settledAt === "number" ? raw.settledAt : undefined,
    error: status === "interrupted" ? "Parent session ended while subagent was running" : clipped(raw.error),
    output: typeof raw.output === "string" ? raw.output.slice(0, Math.min(OUTPUT_MAX_BYTES, PERSISTED_STRING_MAX)) : "",
    liveText: "", liveThinking: "", queued: [], transcript: [],
    activities: Array.isArray(raw.activities) ? raw.activities.filter((activity): activity is string => typeof activity === "string").slice(-100).map((activity) => activity.slice(0, 1024)) : [],
    usage: {
      turns: typeof usage?.turns === "number" ? usage.turns : 0,
      input: typeof usage?.input === "number" ? usage.input : 0,
      output: typeof usage?.output === "number" ? usage.output : 0,
      cacheRead: typeof usage?.cacheRead === "number" ? usage.cacheRead : 0,
      cacheWrite: typeof usage?.cacheWrite === "number" ? usage.cacheWrite : 0,
      cost: typeof usage?.cost === "number" ? usage.cost : 0,
      contextTokens: typeof usage?.contextTokens === "number" ? usage.contextTokens : 0,
      contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : undefined,
    },
    sessionFile: clipped(raw.sessionFile),
    consumed: raw.consumed === true,
    restored: true,
  };
  const normalizedConfig: PersistedConfig = {
    name: clipped(config.name), prompt: clipped(config.prompt), timeoutMs: config.timeoutMs,
    tools: clipped(config.tools),
    skills: Array.isArray(config.skills) ? config.skills.filter((skill): skill is string => typeof skill === "string").slice(0, 64).map((skill) => skill.slice(0, 1024)) : undefined,
    inheritResources: config.inheritResources === true,
  };
  return { snapshot, config: normalizedConfig };
}

function toolActivity(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>) {
  const args = event.args as Record<string, unknown>;
  const target = String(args.path ?? args.file_path ?? "");
  return target ? `${event.toolName} ${target}` : event.toolName;
}

export class SubagentManager {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private idListeners = new Map<string, Set<() => void>>();
  private waitInterest = new Map<string, number>();
  private disposed = false;
  private reserved = 0;
  private persistenceTimer?: ReturnType<typeof setTimeout>;
  private readonly file: string;
  private readonly parent: Pick<ExtensionContext, "cwd" | "modelRegistry" | "isProjectTrusted">;
  readonly parentSessionId: string;
  private readonly onSettled?: (snapshot: SubagentSnapshot) => void;
  private readonly createSession: typeof createAgentSession;
  private readonly createResources: typeof createChildResources;
  private readonly createSessionManager: (cwd: string, sessionFile?: string) => SessionManager;
  private readonly abortTimeoutMs: number;

  constructor(
    parent: Pick<ExtensionContext, "cwd" | "modelRegistry" | "isProjectTrusted">,
    parentSessionId: string,
    onSettled?: (snapshot: SubagentSnapshot) => void,
    options: SubagentManagerOptions = {},
  ) {
    this.parent = parent;
    this.parentSessionId = parentSessionId;
    this.onSettled = onSettled;
    this.createSession = options.createSession ?? createAgentSession;
    this.createResources = options.createResources ?? createChildResources;
    this.createSessionManager = options.createSessionManager ?? ((cwd, sessionFile) => sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd));
    this.abortTimeoutMs = options.abortTimeoutMs ?? 5_000;
    this.file = options.registryFile ?? path.join(getAgentDir(), "subagents", `${parentSessionId}.json`);
    this.restore();
  }

  list() { return [...this.entries.values()].map((entry) => entry.snapshot).sort((a, b) => b.createdAt - a.createdAt); }
  get(id: string) { return this.entries.get(id)?.snapshot; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeTo(id: string, listener: () => void) {
    const listeners = this.idListeners.get(id) ?? new Set();
    listeners.add(listener);
    this.idListeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.idListeners.delete(id); };
  }

  private notify(id?: string) {
    for (const listener of [...this.listeners]) { try { listener(); } catch {} }
    if (id) for (const listener of [...(this.idListeners.get(id) ?? [])]) { try { listener(); } catch {} }
    this.persistSoon();
  }

  private runningCount() {
    return [...this.entries.values()].filter((entry) => entry.active).length + this.reserved;
  }

  private assertSafe(cwd: string, mutating: boolean, ignoreId?: string) {
    const workspace = workspaceFor(cwd);
    if (this.runningCount() >= MAX_RUNNING) throw new Error(`Max ${MAX_RUNNING} subagents can run concurrently.`);
    if (mutating && [...this.entries.values()].some((entry) => entry.snapshot.id !== ignoreId && (entry.active || entry.reserved) && entry.snapshot.mutating && entry.workspace === workspace)) {
      throw new Error(`A mutating subagent is already running in ${cwd}. Wait for it to finish or cancel it.`);
    }
  }

  private beginLifecycle(entry: Entry, signal?: AbortSignal) {
    entry.controller = new AbortController();
    entry.deadlineAt = Date.now() + entry.config.timeoutMs;
    if (signal) {
      const abort = () => entry.controller?.abort(signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));
      if (signal.aborted) abort();
      else {
        signal.addEventListener("abort", abort, { once: true });
        entry.removeExternalAbort = () => signal.removeEventListener("abort", abort);
      }
    }
  }

  private finishLifecycle(entry: Entry) {
    entry.controller = undefined;
    entry.deadlineAt = undefined;
    entry.removeExternalAbort?.();
    entry.removeExternalAbort = undefined;
  }

  async spawn(options: SpawnOptions) {
    if (this.disposed) throw new Error("Subagent manager is shutting down.");
    this.assertSafe(options.cwd, options.mutating);
    this.reserved++;
    const snapshot: SubagentSnapshot = {
      id: `${options.origin === "btw" ? "btw" : "sa"}_${randomBytes(5).toString("hex")}`,
      origin: options.origin,
      title: options.title.slice(0, 160), task: options.task, cwd: options.cwd,
      model: options.model, thinking: options.thinking, status: "running", mutating: options.mutating,
      createdAt: Date.now(), output: "", liveText: "", liveThinking: "", activities: [], queued: [], transcript: [],
      usage: emptySubagentUsage(), consumed: options.consumed ?? false,
    };
    const entry: Entry = {
      snapshot,
      config: options.config,
      completion: Deferred.makeUnsafe(),
      scope: Scope.makeUnsafe("parallel"),
      reserved: true,
      workspace: workspaceFor(options.cwd),
    };
    this.entries.set(snapshot.id, entry);
    this.prune();
    this.notify(snapshot.id);
    try {
      this.beginLifecycle(entry, options.signal);
      const setup = this.open(entry, false).pipe(Effect.timeoutOrElse({
        duration: options.config.timeoutMs,
        orElse: () => Effect.fail(new Error(`Timed out after ${options.config.timeoutMs / 60_000} minutes`)),
      }), Effect.as(snapshot));
      entry.setupFiber = Effect.runSync(Effect.forkIn(setup, entry.scope));
      const interruptSetup = () => entry.setupFiber?.interruptUnsafe();
      entry.controller!.signal.addEventListener("abort", interruptSetup, { once: true });
      try { await Effect.runPromise(Fiber.join(entry.setupFiber)); }
      finally { entry.controller?.signal.removeEventListener("abort", interruptSetup); }
      entry.reserved = false;
      this.reserved--;
      if (this.disposed || snapshot.status !== "running") {
        await Effect.runPromise(Scope.close(entry.scope, Exit.void).pipe(Effect.timeout(this.abortTimeoutMs), Effect.ignore));
        this.finishLifecycle(entry);
        return snapshot;
      }
      this.run(entry, `${options.config.name} task: ${options.task}`);
      return snapshot;
    } catch (error) {
      if (entry.reserved) { entry.reserved = false; this.reserved--; }
      const aborted = entry.controller?.signal.aborted;
      const reason = entry.controller?.signal.reason;
      const message = errorText(reason ?? error);
      this.finishLifecycle(entry);
      snapshot.consumed = true;
      this.settle(entry, aborted && !message.startsWith("Timed out after") ? "cancelled" : "failed", message);
      await Effect.runPromise(Scope.close(entry.scope, Exit.void).pipe(Effect.timeout(this.abortTimeoutMs), Effect.ignore));
      throw aborted && reason instanceof Error ? reason : error;
    }
  }

  private open(entry: Entry, restored: boolean) {
    if (entry.session) return Effect.succeed(entry.session);
    const self = this;
    const snapshot = entry.snapshot;
    const modelParts = snapshot.model.split("/");
    const model = modelParts.length > 1 ? this.parent.modelRegistry.find(modelParts[0], modelParts.slice(1).join("/")) : undefined;
    if (!model) return Effect.fail(new Error(`Unknown model "${snapshot.model}" (use provider/model-id).`));
    const skills = entry.config.skills ?? [];
    return Effect.gen(function* () {
      const resources = yield* promiseEffect(self.createResources({
        cwd: snapshot.cwd,
        projectTrusted: resolveStandaloneChildProjectTrust({
          parentCwd: self.parent.cwd, childCwd: snapshot.cwd, parentTrusted: self.parent.isProjectTrusted(),
        }),
        appendSystemPrompt: [entry.config.prompt],
        noExtensions: !entry.config.inheritResources,
        noPromptTemplates: true,
        noSkills: !entry.config.inheritResources && !skills.includes("*"),
        ...(!entry.config.inheritResources && !skills.includes("*") && skills.length ? { additionalSkillPaths: [...skills] } : {}),
      }));
      if (self.disposed) return yield* Effect.fail(new Error("Subagent manager is shutting down."));
      const sessionManager = self.createSessionManager(snapshot.cwd, restored ? snapshot.sessionFile : undefined);
      const { session } = yield* promiseEffect(self.createSession({
        cwd: snapshot.cwd, model, thinkingLevel: snapshot.thinking as any,
        modelRegistry: self.parent.modelRegistry, resourceLoader: resources.loader, settingsManager: resources.settingsManager,
        sessionManager,
        ...(entry.config.tools ? { tools: entry.config.tools.split(",").map((name) => name.trim()).filter(Boolean) } : {}),
        ...childToolPolicy(),
      }), ({ session }) => shutdownAndDisposeChildSession(session));
      entry.session = session;
      yield* Scope.addFinalizer(entry.scope, Effect.suspend(() => {
        entry.unsubscribe?.();
        return promiseEffect(shutdownAndDisposeChildSession(session)).pipe(
          Effect.ensuring(Effect.sync(() => { if (entry.session === session) entry.session = undefined; })),
          Effect.ignore,
        );
      }));
      yield* promiseEffect(bindChildSessionExtensions(session));
      const guard = createToolCallTimeoutGuard();
      guard.apply(session);
      entry.unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_start") {
          guard.apply(session);
          if (entry.controller?.signal.aborted) Effect.runFork(promiseEffect(stopSession(session, self.abortTimeoutMs)).pipe(Effect.ignore));
        }
        self.fold(entry, event);
      });
      snapshot.sessionFile = session.sessionFile;
      if (restored) self.sync(entry);
      return session;
    });
  }

  private fold(entry: Entry, event: AgentSessionEvent) {
    const snapshot = entry.snapshot;
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") snapshot.liveText = (snapshot.liveText + update.delta).slice(-LIVE_MAX_CHARS);
      if (update.type === "thinking_delta") snapshot.liveThinking = (snapshot.liveThinking + update.delta).slice(-LIVE_MAX_CHARS);
    } else if (event.type === "message_end") {
      if (event.message.role === "assistant") { snapshot.liveText = ""; snapshot.liveThinking = ""; }
      this.sync(entry);
    } else if (event.type === "tool_execution_start") {
      snapshot.activities.push(toolActivity(event));
      snapshot.activities = snapshot.activities.slice(-100);
    } else if (event.type === "tool_execution_end" && event.isError) {
      snapshot.activities.push(`✗ ${event.toolName}`);
      snapshot.activities = snapshot.activities.slice(-100);
    } else if (event.type === "queue_update") {
      snapshot.queued = [
        ...event.steering.map((text) => ({ text, kind: "steer" as const })),
        ...event.followUp.map((text) => ({ text, kind: "follow-up" as const })),
      ];
    }
    this.notify(snapshot.id);
  }

  private sync(entry: Entry) {
    const session = entry.session;
    if (!session) return;
    const snapshot = entry.snapshot;
    snapshot.output = finalOutput(session, entry.runStart ?? 0).slice(0, OUTPUT_MAX_BYTES);
    snapshot.transcript = transcriptFromMessages(session.messages).slice(-MAX_TRANSCRIPT_ITEMS);
    const usage = emptySubagentUsage();
    for (const message of session.messages) {
      if (message.role !== "assistant") continue;
      usage.turns++;
      usage.input += message.usage?.input ?? 0; usage.output += message.usage?.output ?? 0;
      usage.cacheRead += message.usage?.cacheRead ?? 0; usage.cacheWrite += message.usage?.cacheWrite ?? 0;
      usage.cost += message.usage?.cost?.total ?? 0;
    }
    const context = session.getContextUsage();
    usage.contextTokens = context?.tokens ?? 0;
    usage.contextWindow = context?.contextWindow ?? session.model?.contextWindow;
    snapshot.usage = usage;
    snapshot.sessionFile = session.sessionFile;
  }

  private run(entry: Entry, prompt: string) {
    const self = this;
    const snapshot = entry.snapshot;
    const session = entry.session!;
    snapshot.status = "running"; snapshot.settledAt = undefined; snapshot.error = undefined;
    snapshot.output = ""; snapshot.liveText = ""; snapshot.liveThinking = ""; snapshot.queued = [];
    entry.runStart = session.messages.length;
    entry.active = true;
    this.notify(snapshot.id);
    const controller = entry.controller ?? new AbortController();
    entry.controller = controller;
    entry.deadlineAt ??= Date.now() + entry.config.timeoutMs;
    const timedOut = () => errorText(controller.signal.reason ?? "").startsWith("Timed out after");
    const onAbort = () => {
      Effect.runFork(promiseEffect(stopSession(session, this.abortTimeoutMs)).pipe(
        Effect.tap((stopped) => Effect.sync(() => {
          if (snapshot.status === "running") this.settle(entry, timedOut() ? "failed" : "cancelled", errorText(controller.signal.reason ?? "Cancelled"));
          // If abort could not stop the SDK session, run remains active and keeps
          // its workspace lock until prompt really exits.
          if (!stopped) this.notify(snapshot.id);
        })),
        Effect.ignore,
      ));
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    entry.timeoutFiber = Effect.runSync(Effect.forkIn(
      Effect.sleep(Math.max(0, entry.deadlineAt - Date.now())).pipe(Effect.tap(() => Effect.sync(() => {
        controller.abort(new Error(`Timed out after ${entry.config.timeoutMs / 60_000} minutes`));
      })), Effect.asVoid),
      entry.scope,
    ));

    const work = Effect.gen(function* () {
      const prompting = session.prompt(prompt);
      for (const text of entry.pendingSteers?.splice(0) ?? []) yield* promiseEffect(session.steer(text));
      yield* promiseEffect(prompting);
      self.sync(entry);
      const last = [...session.messages].reverse().find((message) => message.role === "assistant");
      if (controller.signal.aborted) self.settle(entry, timedOut() ? "failed" : "cancelled", errorText(controller.signal.reason ?? "Cancelled"));
      else if (last?.role === "assistant" && last.stopReason === "error") self.settle(entry, "failed", last.errorMessage ?? "Agent failed");
      else if (last?.role === "assistant" && last.stopReason && last.stopReason !== "stop" && last.stopReason !== "toolUse") self.settle(entry, "failed", `Agent ended with stopReason: ${last.stopReason}`);
      else self.settle(entry, "done");
    }).pipe(
      Effect.catchCause((cause) => Effect.sync(() => {
        this.sync(entry);
        this.settle(entry, controller.signal.aborted && !timedOut() ? "cancelled" : "failed", errorText(controller.signal.reason ?? Cause.squash(cause)));
      })),
      Effect.ensuring(Effect.sync(() => {
        controller.signal.removeEventListener("abort", onAbort);
        entry.timeoutFiber?.interruptUnsafe();
        this.finishLifecycle(entry);
        entry.active = false;
        this.notify(snapshot.id);
        this.prune();
      })),
    );
    entry.runFiber = Effect.runSync(Effect.forkIn(work, entry.scope));
  }

  private settle(entry: Entry, status: SubagentSnapshot["status"], error?: string) {
    const snapshot = entry.snapshot;
    if (snapshot.status !== "running") return;
    snapshot.status = status; snapshot.settledAt = Date.now(); snapshot.error = error; snapshot.queued = [];
    entry.pendingSteers = [];
    if ((this.waitInterest.get(snapshot.id) ?? 0) > 0) snapshot.consumed = true;
    Effect.runSync(Deferred.succeed(entry.completion, snapshot));
    this.notify(snapshot.id);
    try { this.onSettled?.(snapshot); } catch {}
  }

  async wait(ids: readonly string[], signal?: AbortSignal) {
    const entries = ids.map((id) => this.entries.get(id));
    const unknown = ids.filter((_id, index) => !entries[index]);
    if (unknown.length) throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}.`);
    for (const id of ids) this.waitInterest.set(id, (this.waitInterest.get(id) ?? 0) + 1);
    try {
      const waiting = Effect.all((entries as Entry[]).map((entry) => entry.snapshot.status === "running" ? Deferred.await(entry.completion) : Effect.succeed(entry.snapshot)), { concurrency: "unbounded" });
      try { return await Effect.runPromise(waiting, signal ? { signal } : undefined); }
      catch (error) { throw signal?.aborted ? (signal.reason instanceof Error ? signal.reason : new Error("Wait aborted. Subagents keep running.")) : error; }
    } finally {
      for (const id of ids) {
        const count = (this.waitInterest.get(id) ?? 1) - 1;
        if (count <= 0) this.waitInterest.delete(id); else this.waitInterest.set(id, count);
      }
    }
  }

  async cancel(ids: readonly string[]) {
    const snapshots: SubagentSnapshot[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown subagent id "${id}".`);
      this.consume(id);
      if (entry.snapshot.status === "running") {
        entry.controller?.abort(new Error("Cancelled"));
        if (entry.session) await Effect.runPromise(promiseEffect(stopSession(entry.session, this.abortTimeoutMs)));
        if (entry.snapshot.status === "running") this.settle(entry, "cancelled", "Cancelled");
      }
      snapshots.push(entry.snapshot);
    }
    return snapshots;
  }

  async send(id: string, text: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown subagent id "${id}".`);
    if (entry.snapshot.status === "running") {
      if (entry.controller?.signal.aborted) throw new Error(`Subagent ${id} is stopping.`);
      if (entry.reserved || !entry.session) {
        (entry.pendingSteers ??= []).push(text);
        entry.snapshot.queued.push({ text, kind: "steer" });
        this.notify(id);
        return;
      }
      await entry.session?.steer(text);
      return;
    }
    if (entry.active) throw new Error(`Subagent ${id} is still stopping.`);
    if (entry.snapshot.restored && !entry.session && !entry.snapshot.sessionFile) throw new Error(`Cannot continue restored subagent ${id}: child session state is unavailable.`);
    this.assertSafe(entry.snapshot.cwd, entry.snapshot.mutating, id);
    entry.completion = Deferred.makeUnsafe();
    entry.snapshot.status = "running"; entry.snapshot.settledAt = undefined; entry.snapshot.error = undefined;
    entry.snapshot.output = ""; entry.snapshot.liveText = ""; entry.snapshot.liveThinking = ""; entry.snapshot.queued = [];
    entry.reserved = true; this.reserved++; this.notify(id);
    try {
      this.beginLifecycle(entry);
      if (!entry.session) {
        if (entry.scope.state._tag === "Closed") entry.scope = Scope.makeUnsafe("parallel");
        const setup = this.open(entry, true).pipe(Effect.timeoutOrElse({
          duration: entry.config.timeoutMs,
          orElse: () => Effect.fail(new Error(`Timed out after ${entry.config.timeoutMs / 60_000} minutes`)),
        }));
        entry.setupFiber = Effect.runSync(Effect.forkIn(setup, entry.scope));
        const interruptSetup = () => entry.setupFiber?.interruptUnsafe();
        entry.controller!.signal.addEventListener("abort", interruptSetup, { once: true });
        try { await Effect.runPromise(Fiber.join(entry.setupFiber)); }
        finally { entry.controller?.signal.removeEventListener("abort", interruptSetup); }
      }
      entry.reserved = false; this.reserved--;
      if (this.disposed || entry.snapshot.status !== "running") {
        await Effect.runPromise(Scope.close(entry.scope, Exit.void).pipe(Effect.timeout(this.abortTimeoutMs), Effect.ignore));
        this.finishLifecycle(entry);
        return;
      }
      this.run(entry, text);
    } catch (error) {
      if (entry.reserved) { entry.reserved = false; this.reserved--; }
      const aborted = entry.controller?.signal.aborted;
      const reason = entry.controller?.signal.reason;
      const message = errorText(reason ?? error);
      this.finishLifecycle(entry);
      this.settle(entry, aborted && !message.startsWith("Timed out after") ? "cancelled" : "failed", message);
      await Effect.runPromise(Scope.close(entry.scope, Exit.void).pipe(Effect.timeout(this.abortTimeoutMs), Effect.ignore));
      throw aborted && reason instanceof Error ? reason : error;
    }
  }

  consume(id: string) { const entry = this.entries.get(id); if (entry && !entry.snapshot.consumed) { entry.snapshot.consumed = true; this.notify(id); } }

  private prune() {
    const settled = [...this.entries.values()].filter((entry) => entry.snapshot.status !== "running" && !entry.active).sort((a, b) => a.snapshot.createdAt - b.snapshot.createdAt);
    while (this.entries.size > MAX_TRACKED && settled.length) {
      const entry = settled.shift()!;
      this.entries.delete(entry.snapshot.id);
      Effect.runFork(Scope.close(entry.scope, Exit.void).pipe(Effect.timeout(this.abortTimeoutMs), Effect.ignore));
    }
  }

  private persistSoon() {
    if (this.persistenceTimer) return;
    this.persistenceTimer = setTimeout(() => { this.persistenceTimer = undefined; this.persist(); }, 200);
  }

  private persisted(): PersistedRegistry {
    return {
      version: 1, parentSessionId: this.parentSessionId,
      entries: [...this.entries.values()].map(({ snapshot, config }) => {
        const { transcript: _transcript, liveText: _liveText, liveThinking: _liveThinking, queued: _queued, ...compact } = snapshot;
        return {
          snapshot: {
            ...compact,
            id: clipped(compact.id), title: clipped(compact.title), task: clipped(compact.task), cwd: clipped(compact.cwd),
            model: clipped(compact.model), thinking: clipped(compact.thinking), output: clipped(compact.output),
            error: clipped(compact.error), sessionFile: clipped(compact.sessionFile),
            activities: compact.activities.slice(-20).map((activity) => activity.slice(0, 1024)),
          },
          config: {
            name: clipped(config.name), prompt: clipped(config.prompt), timeoutMs: config.timeoutMs,
            tools: clipped(config.tools), skills: config.skills?.slice(0, 64).map((skill) => skill.slice(0, 1024)),
            inheritResources: config.inheritResources,
          },
        };
      }),
    };
  }

  private persist() {
    try {
      const json = JSON.stringify(this.persisted(), null, 2);
      if (Buffer.byteLength(json) <= REGISTRY_MAX_BYTES) writeFileAtomic(this.file, json);
    } catch {}
  }

  private restore() {
    try {
      if (fs.statSync(this.file).size > REGISTRY_MAX_BYTES) return;
      const registry = JSON.parse(fs.readFileSync(this.file, "utf8")) as PersistedRegistry;
      if (registry.version !== 1 || registry.parentSessionId !== this.parentSessionId || !Array.isArray(registry.entries)) return;
      for (const item of registry.entries.slice(-MAX_TRACKED)) {
        const restored = restoredEntry(item, Date.now());
        if (!restored) continue;
        const { snapshot, config } = restored;
        const completion = Deferred.makeUnsafe<SubagentSnapshot>();
        this.entries.set(snapshot.id, { snapshot, config, completion, scope: Scope.makeUnsafe("parallel"), workspace: workspaceFor(snapshot.cwd) });
        Effect.runSync(Deferred.succeed(completion, snapshot));
        if (snapshot.sessionFile) {
          try {
            const manager = SessionManager.open(snapshot.sessionFile);
            snapshot.transcript = transcriptFromMessages(manager.buildSessionContext().messages as any).slice(-MAX_TRANSCRIPT_ITEMS);
          } catch {}
        }
      }
      this.persist();
    } catch {
      // Missing or corrupt registries never prevent Pi startup.
    }
  }

  async shutdown() {
    this.disposed = true;
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    for (const entry of this.entries.values()) {
      if (entry.snapshot.status === "running") {
        entry.controller?.abort(new Error("Session is shutting down"));
        this.settle(entry, "interrupted", "Parent session shut down");
      }
    }
    this.persist();
    await Effect.runPromise(Effect.forEach([...this.entries.values()], (entry) =>
      Scope.close(entry.scope, Exit.void).pipe(Effect.timeout(this.abortTimeoutMs), Effect.ignore),
    { concurrency: "unbounded", discard: true }));
    this.listeners.clear(); this.idListeners.clear();
  }
}

export function delegationDetails(snapshot: SubagentSnapshot, config: DelegationConfig) {
  return {
    task: snapshot.task, model: snapshot.model, thinking: snapshot.thinking, prompt: config.prompt,
    status: snapshot.status === "interrupted" ? "failed" : snapshot.status,
    error: snapshot.error, activities: [...snapshot.activities], output: snapshot.output,
    elapsedMs: (snapshot.settledAt ?? Date.now()) - snapshot.createdAt,
    usage: { ...snapshot.usage }, sessionFile: snapshot.sessionFile,
  };
}

export function truncateSubagentOutput(output: string, maxLines: number, maxBytes: number, message: string, sessionFile?: string) {
  const truncated = truncateHead(output, { maxLines, maxBytes });
  return {
    output: truncated.truncated
      ? `${truncated.content}\n\n${message}${sessionFile ? `\nFull child session: ${sessionFile}` : ""}`
      : truncated.content,
    truncated: truncated.truncated,
  };
}
