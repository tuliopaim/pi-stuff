import { Type } from "typebox";
import type { ContextUtilization } from "../shared/context-utilization.ts";
import { CHILD_TOOL_CALL_TIMEOUT_MS, runWithToolCallTimeout } from "../shared/tool-call-timeout.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, withCancel } from "@earendil-works/chord/context";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import type { Message, Models, Usage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createReadTool, createGrepTool, createFindTool, createLsTool, createBashTool, createEditTool, createWriteTool, createReadOnlyTools, truncateHead, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentDoc, AssistantEntry, GenerationTask, hook, InboxDoc, LiveDoc, configure, createRegistry, defineDoc, defineExtension, defineTool, Harness, UsageDoc, type Conversation, type ConversationId, type ConversationView, type LiveState, type InboxItem, type Storage, type Submission, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { TOOL_NAMES, type AgentConfig } from "./config.ts";
import { toolSummary } from "./presentation.ts";

export type Job = {
  id: string;
  agent: string;
  name?: string;
  title?: string;
  createdAt?: number;
  lastActivityAt?: number;
  activeMs?: number;
  question?: { id: string; requestId: string; text: string; askedAt: number };
  conversationId: ConversationId;
  requestId: string;
  task: string;
  cwd: string;
  workspace: string;
  model: string;
  thinking: string;
  mutating: boolean;
  background: boolean;
  delivered: boolean;
  status: "running" | "stalled" | "waiting" | "done" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  timeoutMs: number;
  error?: string;
};
export type JobMetadata = { usage: Usage; contextUsage: ContextUtilization; queued: InboxItem[]; live?: LiveState };
export type JobResult = { job: Job; output: string; truncated: boolean; usage: Usage; database?: string; contextUsage?: ContextUtilization; queued?: InboxItem[]; instructions?: string };
const Jobs = defineDoc<{ jobs: Record<string, Job> }>({ kind: "dotfiles.agents", version: 1, scope: "session", initial: () => ({ jobs: {} }) });
const factories: Record<typeof TOOL_NAMES[number], (cwd: string) => ReturnType<typeof createReadOnlyTools>[number]> = { read: createReadTool, grep: createGrepTool, find: createFindTool, ls: createLsTool, bash: createBashTool, edit: createEditTool, write: createWriteTool };
const textOf = (parts: readonly { type: string; text?: string }[] = []) => parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
const isActive = (job: Job) => job.status === "running" || job.status === "stalled";
const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** Keep the parent's OAuth, custom providers, and runtime API keys; do not create a second auth runtime. */
export function modelsFromRegistry(registry: ExtensionContext["modelRegistry"], sessionId: string): Models {
  const models = createModels();
  models.getModel = registry.find.bind(registry);
  models.streamSimple = (model, context, options) => registry.streamSimple(model, context, { ...options, sessionId: options?.sessionId ?? sessionId });
  models.completeSimple = (model, context, options) => models.streamSimple(model, context, options).result();
  return models;
}

function workspace(cwd: string) {
  let current = realpathSync(cwd);
  const fallback = current;
  while (!existsSync(join(current, ".git"))) {
    const parent = dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
  return current;
}

/** Atomic PID ownership in the same database avoids stale-file recovery races. */
export function acquireDatabaseLock(file: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const owner = new DatabaseSync(file);
  const token = randomUUID();
  try {
    owner.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS dotfiles_agent_owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, token TEXT NOT NULL); BEGIN IMMEDIATE");
    const row = owner.prepare("SELECT pid FROM dotfiles_agent_owner WHERE id = 1").get();
    if (row) {
      const pid = Number(row.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Unreadable agent database owner: ${file}`);
      try { process.kill(pid, 0); throw new Error(`Agent database is already open by process ${pid}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    owner.prepare("INSERT OR REPLACE INTO dotfiles_agent_owner VALUES (1, ?, ?)").run(process.pid, token);
    owner.exec("COMMIT");
  } finally { owner.close(); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const database = new DatabaseSync(file);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      database.prepare("DELETE FROM dotfiles_agent_owner WHERE id = 1 AND token = ?").run(token);
    } finally { database.close(); }
  };
}

export class AgentJobs {
  private readonly lifetime = withCancel(BACKGROUND_CONTEXT);
  private readonly activityTimes = new Map<string, { requestId: string; at: number }>();
  private readonly latest = new Map<string, string>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Promise<{ child: Conversation; submission: Submission }>>();
  private readonly controls = new Map<string, Promise<void>>();
  private readonly previews = new Map<string, string>();
  private readonly live = new Map<string, LiveState>();
  private readonly activities = new Map<string, Map<string, string>>();
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private closePromise?: Promise<void>;
  readonly harness: Harness;
  readonly database?: string;
  private readonly models: Models;
  private readonly tools: ToolRegistration[];
  private readonly release?: () => void;
  private constructor(harness: Harness, models: Models, tools: ToolRegistration[], database?: string, release?: () => void) {
    this.harness = harness; this.models = models; this.tools = tools; this.database = database; this.release = release;
  }

  static async open(options: { models: Models; database?: string; storage?: Storage }) {
    const release = options.database ? acquireDatabaseLock(options.database) : undefined;
    try {
      const registry = createRegistry<ToolRegistration>();
      registry.install(defineExtension({
        name: "coding",
        // Durable requires every sibling result to terminate. A prior/invalid call may
        // not agree, so also block the next generation before it reaches the model.
        hooks: [hook(GenerationTask, { beforeRequest: async (_request, api, context) => {
          const job = Object.values((await api.snapshot(Jobs, context))?.jobs ?? {}).find((job) => job.conversationId === api.conversationId);
          if (job?.question) throw new Error("Waiting for parent answer");
          return undefined;
        } })],
        tools: [defineTool({
          name: "ask_question", description: "Ask the parent one question and stop this turn until it answers.",
          parameters: Type.Object({ question: Type.String({ minLength: 1 }) }),
          replay: "safe", executionMode: "sequential",
          execute: async (args, api, context) => {
            const text = args.question.trim();
            if (!text) throw new Error("Question must not be empty");
            await api.commit(async (tx) => {
              const job = Object.values((await tx.doc(Jobs)).jobs).find((job) => job.conversationId === api.conversationId);
              if (!job || !isActive(job)) throw new Error("Job is not running");
              job.question ??= { id: api.callId, requestId: job.requestId, text: text.slice(0, 4096), askedAt: Date.now() };
              job.delivered = false;
            }, context);
            return { content: [{ type: "text", text: "Waiting for parent answer" }], control: { terminate: true } };
          },
        }), ...TOOL_NAMES.map((name) => {
          const tool = factories[name](process.cwd());
          return defineTool({
            name, description: tool.description, parameters: tool.parameters,
            executionMode: "sequential",
            replay: ["read", "grep", "find", "ls"].includes(name) ? "safe" : "unsafe",
            execute: async (args, api, context) => {
              const parked = Object.values((await api.snapshot(Jobs, context))?.jobs ?? {}).find((job) => job.conversationId === api.conversationId)?.question;
              if (parked) return { content: [{ type: "text", text: "Skipped while waiting for parent answer" }], control: { terminate: true } };
              const local = factories[name](api.env!.cwd);
              let execution: ReturnType<typeof local.execute> | undefined;
              let output = "";
              try {
                const result = await runWithToolCallTimeout(name, CHILD_TOOL_CALL_TIMEOUT_MS, context.abortSignal, (signal) => {
                  execution = local.execute(api.callId, args, signal, (update) => {
                    const next = textOf(update.content);
                    api.output(next.startsWith(output) ? next.slice(output.length) : next);
                    output = next;
                  });
                  return execution;
                });
                return { content: result.content, isError: result.isError };
              } finally {
                // The shared timeout aborts execution, but its race can resolve before
                // a process exits or an in-flight file write finishes. Keep ownership.
                await execution?.catch(() => {});
              }
            },
          });
        })],
      }));
      const storage = options.storage ?? await openNodeSqliteStorage(options.database!);
      const harness = await Harness.open(storage, {
        models: options.models, registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
        settings: { stream: { timeoutMs: 120_000, deferred: false } },
      }, BACKGROUND_CONTEXT);
      return new AgentJobs(harness, options.models, registry.snapshot().tools().map(({ tool }) => tool), options.database, release);
    } catch (error) { release?.(); throw error; }
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { for (const listener of this.listeners) { try { listener(); } catch {} } }
  async list(): Promise<Job[]> { return Object.values((await this.harness.snapshot(Jobs, BACKGROUND_CONTEXT))?.jobs ?? {}); }
  async get(id: string) {
    const job = (await this.list()).find((entry) => entry.id === id || entry.name === id);
    if (!job) throw new Error(`Unknown agent job "${id}"`);
    return job;
  }
  /** Synchronous streaming lookup uses the UUID; resolve a name with get() first. */
  preview(id: string) { return this.previews.get(id) ?? ""; }

  async transcript(id: string, limit = 100): Promise<Message[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Transcript limit must be a positive integer");
    const job = await this.get(id);
    const child = (await this.harness.conversation(job.conversationId, BACKGROUND_CONTEXT))!;
    const history = await child.entries({}, limit, undefined, BACKGROUND_CONTEXT);
    const messages = [...history.items].reverse().flatMap((entry) => entry.model ?? []);
    const partial = this.live.get(job.id)?.generation?.message;
    if (partial && !messages.some((message) => message.role === "assistant" && message.timestamp === partial.timestamp)) messages.push(partial as Message);
    return messages;
  }

  /** Reattach unfinished submissions. Even interrupted foreground runs are reported after a restart. */
  async resume() {
    // Older records have UUIDs but no human handle. Allocate handles on the same
    // commit line as new spawns, without importing any outside session history.
    await this.harness.commit(async (tx) => {
      const jobs = Object.values((await tx.doc(Jobs)).jobs);
      const names = new Set(jobs.flatMap((job) => [job.id, ...(job.name ? [job.name] : [])]));
      for (const job of jobs) {
        if (job.name) continue;
        const base = job.agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "agent";
        let suffix = 1, name: string;
        do { name = `${base}-${suffix++}`; } while (names.has(name));
        job.name = name; names.add(name);
        job.createdAt ??= job.startedAt;
      }
    }, BACKGROUND_CONTEXT);
    for (const job of await this.list()) {
      if (!job.delivered && !job.background) {
        await this.harness.commit(async (tx) => { (await tx.doc(Jobs)).jobs[job.id].background = true; }, BACKGROUND_CONTEXT);
      }
      if (isActive(job)) {
        this.track({ ...job, background: true });
      }
    }
    this.harness.resume();
  }

  async spawn(agent: string, config: AgentConfig, task: string, cwd: string, background: boolean, signal?: AbortSignal, options: { name?: string; title?: string } = {}) {
    if (this.closing) throw new Error("Agent jobs are closing");
    signal?.throwIfAborted();
    if (!task.trim()) throw new Error("Task must not be empty");
    if (options.name !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.name)) throw new Error("Invalid job name: use 1-64 lowercase letters, numbers, or hyphens");
    if (options.title !== undefined && (options.title.length > 200 || /[\x00-\x1f\x7f]/.test(options.title))) throw new Error("Invalid job title: use at most 200 characters without control characters");
    const slash = config.model.indexOf("/");
    if (!this.models.getModel(config.model.slice(0, slash), config.model.slice(slash + 1))) throw new Error(`Unknown model "${config.model}"`);
    const canonical = realpathSync(cwd);
    const root = workspace(canonical);
    const id = randomUUID();
    const job = await this.harness.commit(async (tx) => {
      const state = await tx.doc(Jobs);
      const mutating = config.mutating ?? config.tools.some((name) => ["bash", "edit", "write"].includes(name));
      this.assertCapacity(Object.values(state.jobs), root, mutating);
      const base = agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "agent";
      const names = new Set(Object.values(state.jobs).map((job) => job.name ?? job.id));
      let name = options.name?.trim();
      if (name && (names.has(name) || Object.values(state.jobs).some((job) => job.id === name))) throw new Error(`Job name "${name}" is already in use`);
      if (options.name !== undefined && !name) throw new Error("Job name must not be empty");
      if (!name) { let suffix = 1; do { name = `${base}-${suffix++}`; } while (names.has(name)); }
      const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, child.id, {
        model: { provider: config.model.slice(0, slash), modelId: config.model.slice(slash + 1) },
        thinkingLevel: config.thinking, cwd: canonical, instructions: config.instructions,
        tools: this.tools.filter((tool) => tool.name === "ask_question" || config.tools.includes(tool.name)),
      });
      const created: Job = { id, agent, name, ...(options.title?.trim() ? { title: options.title.trim() } : {}), createdAt: Date.now(), lastActivityAt: Date.now(), activeMs: 0, conversationId: child.id, requestId: id, task, cwd: canonical, workspace: root,
        model: config.model, thinking: config.thinking, mutating, background, delivered: false, status: "running", startedAt: Date.now(), timeoutMs: (config.timeoutMinutes ?? 30) * 60_000 };
      state.jobs[id] = created;
      return created;
    }, BACKGROUND_CONTEXT);
    this.track(job);
    if (signal?.aborted) { await this.cancel(id); signal.throwIfAborted(); }
    return job;
  }

  private assertCapacity(jobs: readonly Job[], root: string, mutating: boolean, ignore?: string) {
    const running = jobs.filter((job) => isActive(job) && job.id !== ignore);
    if (running.length >= 4) throw new Error("At most four agent jobs may run at once");
    if (mutating && running.some((job) => job.mutating && job.workspace === root)) throw new Error("A mutating agent is already working in this working tree");
  }

  private track(job: Job) {
    if (this.active.has(job.requestId)) return;
    this.latest.set(job.id, job.requestId);
    const admission = this.admit(job);
    this.admissions.set(job.requestId, admission);
    const operation = this.observe(job, admission).finally(() => { this.active.delete(job.requestId); this.admissions.delete(job.requestId); this.notify(); });
    this.active.set(job.requestId, operation);
    // Errors stay visible in the job rather than becoming unhandled background rejections.
    void operation.catch(() => {});
  }

  private async admit(job: Job) {
    const child = (await this.harness.conversation(job.conversationId, this.lifetime.context))!;
    const submission = await child.submit({ type: "input", content: job.task, requestId: job.requestId, whenBusy: "steer" }, this.lifetime.context);
    return { child, submission };
  }

  /** Admit every input in order; cancellation also owns this queue until tools stop. */
  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.controls.get(id) ?? Promise.resolve()).then(operation);
    const tail = next.then(() => {}, () => {});
    this.controls.set(id, tail);
    void tail.then(() => { if (this.controls.get(id) === tail) this.controls.delete(id); });
    return next;
  }

  private async observe(job: Job, admission: Promise<{ child: Conversation; submission: Submission }>) {
    const context = this.lifetime.context;
    let child: Conversation | undefined;
    let view: AttachedReplicatedState<ConversationView> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    this.activityTimes.set(job.id, { requestId: job.requestId, at: Date.now() });
    let fingerprint = "";
    try {
      const admitted = await admission;
      child = admitted.child;
      const submission = admitted.submission;
      if ((await this.get(job.id)).error) await child.abort(context);
      view = await child.viewState(context);
      const update = (value: ConversationView) => {
        if (this.latest.get(job.id) !== job.requestId) return;
        const nextFingerprint = JSON.stringify([value.entries.at(-1), value.docs["pi.live"]]);
        if (nextFingerprint !== fingerprint) { fingerprint = nextFingerprint; this.activityTimes.set(job.id, { requestId: job.requestId, at: Date.now() }); }
        const live = value.docs["pi.live"] as LiveState | undefined;
        if (live) this.live.set(job.id, live);
        const content = live?.generation?.message?.content ?? [];
        let activities = this.activities.get(job.id);
        if (!activities) { activities = new Map(); this.activities.set(job.id, activities); }
        // Fast responses can commit without publishing a partial generation.
        const recent = value.entries.slice(-12).flatMap((entry) => entry.model ?? []).flatMap((message) => message.role === "assistant" ? message.content : []);
        for (const part of [...recent, ...content]) if (part.type === "toolCall") activities.set(part.id, toolSummary(part.name, part.arguments));
        while (activities.size > 6) activities.delete(activities.keys().next().value!);
        const activeTools = live?.tools?.filter((tool) => tool.status !== "done").map((tool) => tool.name).join(", ");
        const thinking = content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("\n");
        const status = live?.generation?.retry ? `Retrying: ${live.generation.retry.error}`
          : live?.compactions?.length ? "Compacting context" : activeTools ? `Running ${activeTools}`
          : textOf(content) || (thinking ? `Thinking · ${thinking.slice(-400)}` : "Waiting for model");
        this.previews.set(job.id, [...activities.values(), status.slice(-800)].join("\n"));
        this.notify();
      };
      view.subscribe(update);
      update(view.value);
      timer = setTimeout(() => { void this.cancelRequest(job, "Agent exceeded its time limit").catch(() => {}); }, Math.max(1, job.timeoutMs - (job.activeMs ?? 0) - (Date.now() - job.startedAt)));
      watchdog = setInterval(() => { void this.refreshStatuses().catch(() => {}); }, 1000);
      const settled = await submission.wait(context);
      // Aborted queued inputs settle before an older in-flight tool does.
      // Never publish a terminal/waiting state until the whole child is idle.
      await child.waitForIdle(context);
      await this.harness.commit(async (tx) => {
        const current = (await tx.doc(Jobs)).jobs[job.id];
        if (current.requestId !== job.requestId) return;
        if (current.question && !current.error) {
          current.status = "waiting";
          current.activeMs = (current.activeMs ?? 0) + Date.now() - current.startedAt;
          return;
        }
        current.status = settled.status === "done" ? "done" : settled.reason === "aborted" ? "cancelled" : "failed";
        current.finishedAt = Date.now();
        current.delivered = false;
        delete current.question;
        if (settled.status === "unanswered" && !current.error) current.error = settled.reason;
      }, context);
    } catch (error) {
      if (!this.closing && (await this.get(job.id)).requestId === job.requestId) {
        await child?.abort(BACKGROUND_CONTEXT);
        await this.harness.commit(async (tx) => {
          const current = (await tx.doc(Jobs)).jobs[job.id];
          if (current.requestId !== job.requestId) return;
          current.status = "failed";
          current.finishedAt = Date.now();
          current.error = error instanceof Error ? error.message : String(error);
          current.delivered = false;
          delete current.question;
        }, BACKGROUND_CONTEXT);
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
      view?.dispose();
      if (this.latest.get(job.id) === job.requestId) {
        this.previews.delete(job.id);
        this.live.delete(job.id);
        this.activities.delete(job.id);
        this.activityTimes.delete(job.id);
      }
    }
  }

  /** Recheck inactivity; also usable by a UI refresh without waiting for the watchdog tick. */
  async refreshStatuses(now = Date.now()) {
    const timedOut = await this.harness.commit(async (tx) => {
      const expired: Job[] = [];
      for (const current of Object.values((await tx.doc(Jobs)).jobs)) {
        if (!isActive(current)) continue;
        const activity = this.activityTimes.get(current.id);
        const at = activity?.requestId === current.requestId ? activity.at : current.lastActivityAt ?? current.startedAt;
        current.lastActivityAt = at;
        current.status = now - at > 60_000 ? "stalled" : "running";
        if (now - at >= 5 * 60_000) expired.push({ ...current });
      }
      return expired;
    }, BACKGROUND_CONTEXT);
    await Promise.all(timedOut.map((job) => this.cancelRequest(job, "Timed out after 5 minutes without activity")));
    this.notify();
  }

  async wait(id: string, signal?: AbortSignal) {
    let job = await this.get(id);
    // Ownership belongs to this wait, not the submission/reporting mode changed by guidance.
    const foreground = !job.background;
    const jobId = job.id;
    const abort = () => { if (foreground) void this.cancel(jobId, "Cancelled").catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) { if (foreground) await this.cancel(jobId, "Cancelled"); signal.throwIfAborted(); }
      // Cancelling a foreground wait cancels its job. Background waits leave the job running.
      while (isActive(job)) {
        this.track(job);
        await awaitWithContext(this.active.get(job.requestId) ?? Promise.resolve(), signal ? withAbortSignal(signal, this.lifetime.context) : this.lifetime.context);
        job = await this.get(id);
      }
      signal?.throwIfAborted();
      return await this.result(id);
    } finally { signal?.removeEventListener("abort", abort); }
  }

  async result(id: string): Promise<JobResult> {
    const job = await this.get(id);
    const child = (await this.harness.conversation(job.conversationId, BACKGROUND_CONTEXT))!;
    const settled = await this.harness.commit((tx) => tx.submissionByRequest(job.conversationId, job.requestId), BACKGROUND_CONTEXT);
    let output = job.question?.text ?? job.error ?? (isActive(job) ? this.preview(job.id) || "Working" : "No answer");
    if (job.status === "done" && !job.question && settled?.status === "done" && settled.type === "input") {
      const entry = await this.harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
      output = textOf(entry?.model?.[0]?.role === "assistant" ? entry.model[0].content : []) || "No answer";
    } else if (job.status === "failed") {
      const history = await child.entries({}, 10, undefined, BACKGROUND_CONTEXT);
      const failure = history.items.flatMap((entry) => entry.model ?? []).find((message) => message.role === "assistant" && message.errorMessage);
      if (failure?.role === "assistant") output = failure.errorMessage ?? output;
    }
    const metadata = await this.metadata(job.id);
    const bounded = truncateHead(output, { maxBytes: 32 * 1024, maxLines: 300 });
    const instructions = (await this.harness.snapshot(AgentDoc, job.conversationId, BACKGROUND_CONTEXT))?.instructions;
    return { job, output: bounded.content + (bounded.truncated ? `\n[Output truncated. Full conversation ${job.conversationId} in ${this.database ?? "memory"}]` : ""), truncated: bounded.truncated, ...metadata, instructions, database: this.database };
  }

  /** Durable usage/inbox and last reported model context size. Tokens are unknown after compaction. */
  async metadata(id: string): Promise<JobMetadata> {
    const job = await this.get(id);
    const child = (await this.harness.conversation(job.conversationId, BACKGROUND_CONTEXT))!;
    const ledger = await this.harness.snapshot(UsageDoc, job.conversationId, BACKGROUND_CONTEXT);
    const usage = emptyUsage();
    for (const part of Object.values(ledger?.models ?? {})) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += part[key];
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += part.cost[key];
    }
    const inbox = await this.harness.snapshot(InboxDoc, job.conversationId, BACKGROUND_CONTEXT);
    const live = await this.harness.snapshot(LiveDoc, job.conversationId, BACKGROUND_CONTEXT);
    const history = await child.entries({}, 20, undefined, BACKGROUND_CONTEXT);
    let tokens: number | null = null;
    for (const entry of history.items) {
      if (entry.kind === "pi.compaction") break;
      const answer = entry.model?.find((message) => message.role === "assistant");
      if (answer?.role === "assistant") {
        tokens = answer.usage.input + answer.usage.cacheRead + answer.usage.cacheWrite + answer.usage.output;
        break;
      }
    }
    const slash = job.model.indexOf("/");
    const contextWindow = this.models.getModel(job.model.slice(0, slash), job.model.slice(slash + 1))?.contextWindow;
    return { usage, contextUsage: { tokens, contextWindow }, queued: inbox?.items.filter((item) => item.mode !== "write") ?? [], live };
  }

  async acknowledge(id: string, requestId: string) {
    id = (await this.get(id)).id;
    await this.harness.commit(async (tx) => {
      const job = (await tx.doc(Jobs)).jobs[id];
      if (job.requestId === requestId) job.delivered = true;
    }, BACKGROUND_CONTEXT);
  }
  async message(id: string, task: string) {
    if (this.closing) throw new Error("Agent jobs are closing");
    if (!task.trim()) throw new Error("Message must not be empty");
    id = (await this.get(id)).id;
    return this.serialize(id, () => this.send(id, task));
  }
  private async send(id: string, task: string) {
    if (this.closing) throw new Error("Agent jobs are closing");
    let job = await this.get(id);
    await this.admissions.get(job.requestId);
    job = await this.get(id);
    id = job.id;
    if (job.error && isActive(job)) throw new Error("Job is stopping");
    const next = await this.harness.commit(async (tx) => {
      const state = await tx.doc(Jobs);
      this.assertCapacity(Object.values(state.jobs), job.workspace, job.mutating, id);
      const current = state.jobs[id];
      if (current.error && isActive(current)) throw new Error("Job is stopping");
      if (current.question && isActive(current)) throw new Error("Job is parking; wait until its status is waiting before answering");
      const wasActive = isActive(current);
      const wasWaiting = current.status === "waiting";
      current.requestId = randomUUID(); current.task = task; current.status = "running";
      current.background = true; current.delivered = false;
      delete current.finishedAt;
      if (!wasActive) current.startedAt = Date.now();
      if (!wasWaiting && !wasActive) current.activeMs = 0;
      delete current.question;
      delete current.error;
      return { ...current } as Job;
    }, BACKGROUND_CONTEXT);
    this.track(next);
    return next;
  }
  private async cancelRequest(job: Job, reason: string) {
    await this.cancel(job.id, reason, job.requestId);
  }
  async cancel(id: string, reason = "Cancelled", requestId?: string) {
    id = (await this.get(id)).id;
    return this.serialize(id, () => this.stop(id, reason, requestId));
  }
  private async stop(id: string, reason: string, requestId?: string) {
    const job = await this.get(id);
    const stopping = await this.harness.commit(async (tx) => {
      const current = (await tx.doc(Jobs)).jobs[job.id];
      if (requestId !== undefined && current.requestId !== requestId) return false;
      if (current.status === "waiting") {
        current.status = "cancelled"; current.error = reason; current.finishedAt = Date.now();
        current.requestId = randomUUID(); // A cancellation is a new delivery, not the acknowledged question.
        current.delivered = false; delete current.question;
        return false;
      }
      if (!isActive(current)) return false;
      current.error = reason;
      return true;
    }, BACKGROUND_CONTEXT);
    if (stopping) {
      await this.admissions.get(job.requestId);
      await (await this.harness.conversation(job.conversationId, BACKGROUND_CONTEXT))!.abort(BACKGROUND_CONTEXT);
      await this.active.get(this.latest.get(job.id) ?? job.requestId);
    }
    this.notify();
  }
  close() {
    return this.closePromise ??= (async () => {
      this.closing = true;
      this.lifetime.cancel();
      await Promise.allSettled(this.active.values());
      try { await this.harness.close(BACKGROUND_CONTEXT); } finally { this.release?.(); this.listeners.clear(); }
    })();
  }
}
