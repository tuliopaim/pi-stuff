import * as fs from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, Text, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { showSubagents, showTakeover } from "./dashboard.ts";
import { SubagentManager, truncateSubagentOutput } from "./manager.ts";
import type { SubagentSnapshot } from "./domain.ts";
import { renderDelegationMessage } from "./render.ts";
import {
  createDelegationDetails,
  DelegationAbortError,
  getActiveSubagentPresetName,
  getDelegationConfig,
  getSubagentPresetNames,
  isSubagentEnabled,
  registerDelegatedTool,
  setSubagentPreset,
  validateRoute,
  type DelegationDetails,
  type DelegationPolicy,
} from "./runtime.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const SCOUT: DelegationPolicy = {
  key: "scout",
  name: "Scout",
  model: "opencode-go/deepseek-v4-flash",
  thinking: "medium",
  mutating: false,
  timeoutMs: 5 * 60_000,
  tools: "read,grep,find,ls",
  description: "Delegate focused, read-only codebase reconnaissance to a cheaper model.",
  snippet: "Delegate focused codebase reconnaissance to a cheaper read-only model",
  guidelines: [
    "Use scout before broad exploration when locating the answer likely requires more than 2-3 files.",
    "Do not use scout for work answerable with one or two direct reads, after equivalent reconnaissance is already done, for implementation, or for decisions requiring your own judgment.",
    "Use one scout by default. Use a second only when two reconnaissance questions are independent and combining them would make either scout broad or duplicative.",
    "After scout returns, read only its recommended targets and verify only claims that affect edits or important decisions.",
  ],
  parameter: "One narrow, self-contained reconnaissance question, including the evidence the parent needs",
  prompt: `You are a read-only codebase scout. Your job is to reduce the parent agent's context usage. Investigate one delegated question; do not implement, edit files, run builds, or run tests.

Return only this compact handoff:
## Answer
Direct answer in at most 3 bullets.

## Relevant flow
- symbol — path:line
- → caller or consumer — path:line
- → test, when relevant — path:line

## Parent should read
- At most 3 exact files or line ranges required for the next decision.

## Unknowns
- Only uncertainties that could change the implementation, or "None".

Rules:
- Stop when the delegated question is answered.
- Include at most 8 evidence references and 500 words.
- Prefer exact symbols, paths, and line numbers over prose.
- Trace definitions and callers when relevant.
- Do not include large code excerpts or general architecture commentary unless requested.`,
  maxLines: 200,
  maxBytes: 24 * 1024,
  emptyOutput: "(scout returned no output)",
  truncationMessage: "[Scout output truncated to 200 lines / 24KB]",
};

const REVIEW: DelegationPolicy = {
  key: "review",
  name: "Review",
  model: "openai-codex/gpt-5.6-sol",
  thinking: "high",
  mutating: false,
  timeoutMs: 15 * 60_000,
  tools: "read,grep,find,ls",
  description: "Delegate focused, read-only code review to a high-reasoning model.",
  snippet: "Delegate focused code review to a high-reasoning model",
  guidelines: [
    "Use review only when the user explicitly requests it, or after a high-risk change where an independent fresh-context review is materially useful; do not invoke it automatically.",
    "Give review the exact scope: working tree, commit/range, or named files, plus intended behavior.",
    "Use review at most once per change unless new code is added after the review.",
    "Treat review findings as leads; verify each finding yourself before changing code or reporting it as fact.",
  ],
  parameter: "Review scope and intended behavior, including commit/range or files when known",
  prompt: `You are a read-only code reviewer. Review the delegated change or scope; do not edit files.

Return only this compact handoff:
## Findings
For each real issue, ordered by severity:
### [P0-P3] Short title
- Evidence: path:line
- Impact: what breaks and under which conditions
- Fix: smallest correct change

If there are no findings, write "No findings."

## Validation gaps
- Important behavior you could not verify, or "None".

## Verdict
One sentence stating whether the change is safe to merge.

Rules:
- Prioritize correctness, security, data loss, regressions, and missing validation.
- Review the actual diff and trace affected callers when relevant.
- Do not report style preferences, speculative concerns, or pre-existing issues unrelated to the change.
- Use only the provided read-only tools; do not modify files or run commands.
- Do not run builds or tests unless the delegated task explicitly asks.
- Prefer exact file paths and line numbers over prose.
- Stay under 1,200 words.`,
  maxLines: 250,
  maxBytes: 32 * 1024,
  emptyOutput: "(review returned no output)",
  truncationMessage: "[Review output truncated to 250 lines / 32KB]",
};

const COMMIT: DelegationPolicy = {
  key: "commit",
  name: "Commit",
  model: "opencode-go/deepseek-v4-flash",
  thinking: "medium",
  mutating: true,
  timeoutMs: 15 * 60_000,
  tools: "read,grep,find,ls,bash",
  description: "Delegate completed-work analysis and intentional git commits to a specialized model.",
  snippet: "Delegate git commit creation to a specialized child",
  guidelines: [
    "Use commit only when the user explicitly asks to commit completed work.",
    "Pass any requested scope or commit-splitting instructions in the task.",
    "Do not inspect, stage, or commit in the parent; the specialized commit agent owns the complete workflow.",
  ],
  parameter: "Optional commit scope, ticket context, or commit-splitting instructions",
  prompt: "You are a specialized git commit agent sharing the current working tree. Use the commit-work skill and follow it exactly. Inspect all changes before staging, keep unrelated work uncommitted, never expose secrets, never amend or force push, and report each created commit's SHA and message.",
  maxLines: 200,
  maxBytes: 24 * 1024,
  emptyOutput: "(commit agent returned no output)",
  truncationMessage: "[Commit output truncated to 200 lines / 24KB]",
};

const AGENT: DelegationPolicy = {
  key: "agent",
  name: "Agent",
  model: "opencode-go/kimi-k2.7-code",
  thinking: "high",
  mutating: true,
  dynamicModel: true,
  inheritResources: true,
  timeoutMs: 30 * 60_000,
  description: "Delegate general-purpose coding work to a persistent agent using a task-appropriate model and reasoning level.",
  snippet: "Delegate implementation or other general-purpose coding work to a persistent agent",
  guidelines: [
    "Use the fewest agents that materially reduce context, uncertainty, or elapsed time: default to zero for clear local work, and use one for a self-contained delegated workstream.",
    "Use agent when the user asks to delegate, or when one agent can independently own a substantial implementation or investigation while the parent avoids overlapping edits.",
    "Do not split connected implementation across agents in one working tree. Fan out only independent read-only work, or mutating work in separate working trees.",
    "When calling agent, choose its model and thinking level for the task: opencode-go/deepseek-v4-flash with medium for reconnaissance or diagnosis; opencode-go/kimi-k2.7-code with high for routine or clearly scoped implementation; openai-codex/gpt-5.6-sol with medium for difficult implementation, ambiguous behavior, architecture-sensitive changes, or hard debugging; openai-codex/gpt-5.6-sol with high for consequential planning, adversarial review, security, or data-loss work.",
    "The agent inherits extensions, skills, and project context. Give it a self-contained task with the intended behavior and validation requirements.",
    "Run agent synchronously and do not edit the same working tree while it is running.",
  ],
  parameter: "A self-contained task, including intended behavior and validation requirements",
  prompt: `You are a delegated general-purpose coding agent. Complete the assigned task independently in the current working tree.

Inspect the relevant code before editing. Make the smallest correct change, run focused validation, and report the files changed and checks run. Follow inherited project instructions and skills. Do not spawn other agents. Do not commit unless the task explicitly asks you to.`,
  maxLines: 300,
  maxBytes: 40 * 1024,
  emptyOutput: "(agent returned no output)",
  truncationMessage: "[Agent output truncated to 300 lines / 40KB]",
};

export default function (
  pi: ExtensionAPI,
  createManager: (ctx: ExtensionContext, parentSessionId: string, onSettled: (snapshot: SubagentSnapshot) => void) => SubagentManager
    = (ctx, parentSessionId, onSettled) => new SubagentManager(ctx, parentSessionId, onSettled),
) {
  if (process.env.PI_DELEGATED === "1") return;

  let manager: SubagentManager | undefined;
  let context: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  const acknowledged = new Set<string>();
  const pendingResults = new Map<string, SubagentSnapshot>();
  const getManager = () => {
    if (!manager) throw new Error("Subagent manager is not ready yet.");
    return manager;
  };
  const updateStatus = () => {
    if (!context?.hasUI || !manager) return;
    const entries = manager.list();
    const running = entries.filter((entry) => entry.status === "running").length;
    const done = entries.filter((entry) => entry.status === "done" && !acknowledged.has(entry.id)).length;
    const failed = entries.filter((entry) => entry.status !== "running" && entry.status !== "done" && !acknowledged.has(entry.id)).length;
    context.ui.setStatus("subagents", running || done || failed
      ? formatActivityStatus(context.ui.theme, "subagents", { running, done, failed })
      : undefined);
  };
  const settled = (snapshot: SubagentSnapshot) => {
    if (!context) return;
    if (snapshot.origin === "btw") {
      const answer = truncateSubagentOutput(snapshot.output || "(no output)", 300, 24 * 1024, "[Answer truncated]", snapshot.sessionFile).output;
      pi.appendEntry("btw-result", {
        id: snapshot.id, title: snapshot.title, status: snapshot.status, question: snapshot.task,
        answer, error: snapshot.error, sessionFile: snapshot.sessionFile,
      });
      context.ui.notify(`By the way “${snapshot.title}” ${snapshot.status === "done" ? "answered" : "failed"} — /subagents to reopen`, snapshot.status === "done" ? "info" : "error");
    } else if (snapshot.origin === "generic" && !snapshot.consumed) {
      pendingResults.set(snapshot.id, { ...snapshot });
      if (context.isIdle()) flushResults();
    }
    updateStatus();
  };
  const flushResults = () => {
    for (const snapshot of pendingResults.values()) {
      const bounded = truncateSubagentOutput(snapshot.output || "(no output)", 300, 40 * 1024, "[Subagent output truncated]", snapshot.sessionFile);
      try {
        pi.sendMessage({
          customType: "subagent-result", display: true,
          content: `Subagent ${snapshot.id} “${snapshot.title}” ${snapshot.status}.\n\n${snapshot.error ? `Error: ${snapshot.error}\n\n` : ""}${bounded.output}`,
          details: { id: snapshot.id, title: snapshot.title, status: snapshot.status },
        }, { deliverAs: "followUp", triggerTurn: true });
        manager?.consume(snapshot.id);
        pendingResults.delete(snapshot.id);
      } catch {}
    }
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    manager = createManager(ctx, ctx.sessionManager.getSessionId(), settled);
    for (const entry of manager.list()) {
      if (entry.status !== "running") acknowledged.add(entry.id);
      if (entry.origin === "generic" && entry.status !== "running" && !entry.consumed) pendingResults.set(entry.id, entry);
    }
    unsubscribe = manager.subscribe(updateStatus);
    updateStatus();
    if (pendingResults.size) queueMicrotask(flushResults);
    const active = getActiveSubagentPresetName();
    if (active && !getSubagentPresetNames().includes(active)) ctx.ui.notify(`Unknown subagent preset "${active}"`, "warning");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribe?.(); unsubscribe = undefined;
    ctx.ui.setStatus("subagents", undefined);
    pendingResults.clear();
    const closing = manager; manager = undefined; context = undefined;
    await closing?.shutdown();
  });
  pi.on("agent_settled", flushResults);

  if (isSubagentEnabled(SCOUT.key)) registerDelegatedTool(pi, SCOUT, getManager);
  if (isSubagentEnabled(REVIEW.key)) registerDelegatedTool(pi, REVIEW, getManager);

  if (isSubagentEnabled(COMMIT.key)) {
    const runCommit = registerDelegatedTool(pi, COMMIT, getManager);
    pi.registerMessageRenderer<DelegationDetails>("commit-result", (message, { expanded }, theme) =>
      message.details ? renderDelegationMessage("Commit", message.details, expanded, theme) : undefined,
    );

    pi.registerCommand("commit", {
    description: "Create intentional commits with the specialized commit agent",
      handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy", "warning");
        return;
      }
      const task = args.trim() || "Analyze all completed work and create the appropriate commit or commits.";
      const controller = new AbortController();
      let latest: DelegationDetails | undefined;

      const showWidget = (details: DelegationDetails) => {
        latest = details;
        ctx.ui.setWidget("commit", (_tui, theme) => renderDelegationMessage("Commit", details, false, theme));
      };
      // The command path gets no harness-supplied signal, so escape is wired up by hand.
      const stopListening = ctx.ui.onTerminalInput?.((data) => {
        if (!matchesKey(data, Key.escape)) return undefined;
        controller.abort();
        return { consume: true };
      });

      try {
        const details = await runCommit(task, ctx.cwd, controller.signal, showWidget);
        pi.sendMessage({ customType: "commit-result", content: details.output, display: true, details });
      } catch (error) {
        const cancelled = error instanceof DelegationAbortError;
        const message = error instanceof Error ? error.message : String(error);
        const details: DelegationDetails = {
          ...(latest ?? createDelegationDetails(getDelegationConfig(COMMIT.key, COMMIT), task)),
          status: cancelled ? "cancelled" : "failed",
          error: message,
        };
        pi.sendMessage({
          customType: "commit-result",
          content: details.output || `Commit agent ${cancelled ? "cancelled" : "failed"}: ${message}`,
          display: true,
          details,
        });
        if (!cancelled) ctx.ui.notify(message, "error");
      } finally {
        stopListening?.();
        ctx.ui.setWidget("commit", undefined);
      }
      },
    });
  }

  if (isSubagentEnabled(AGENT.key)) registerDelegatedTool(pi, AGENT, getManager);

  pi.registerTool({
    name: "subagent_spawn", label: "Spawn Subagent",
    description: "Start a persistent Pi subagent in the background and return its ID. Max four running; one mutating agent per working tree.",
    promptSnippet: "Start a persistent background subagent for an independent workstream",
    promptGuidelines: [
      "Default to no background subagent for clear local work. Spawn one only when it can proceed independently without overlapping the parent's edits.",
      "Use two to four only for genuinely independent workstreams in separate working trees. For parallel read-only fan-out in one tree, use workflow instead.",
      "Treat four as a hard ceiling, not a target. Wait for results only when the parent needs them for its next decision.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Self-contained task" }),
      name: Type.String({ description: "Short display name" }),
      model: Type.String({ description: "Exact provider/model id" }),
      thinking: Type.String({ description: "off|minimal|low|medium|high|xhigh|max" }),
      working_dir: Type.Optional(Type.String({ description: "Working directory; defaults to the parent cwd" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (!THINKING_LEVELS.has(params.thinking)) throw new Error(`Invalid thinking level: ${params.thinking}`);
      {
        const v = validateRoute(params.model, params.thinking);
        if (!v.allowed) throw new Error(v.error);
      }
      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`working_dir is not a directory: ${cwd}`);
      const snapshot = await getManager().spawn({
        origin: "generic", title: params.name.trim() || "subagent", task: params.task, cwd,
        model: params.model, thinking: params.thinking, mutating: true,
        config: { name: "Agent", prompt: AGENT.prompt, timeoutMs: AGENT.timeoutMs, inheritResources: true },
        signal,
      });
      return { content: [{ type: "text", text: `Started ${snapshot.id} “${snapshot.title}” in ${cwd}.` }], details: { id: snapshot.id, status: snapshot.status } };
    },
  });

  pi.registerTool({
    name: "subagent_wait", label: "Wait for Subagents", description: "Wait for background subagents and return their results.",
    parameters: Type.Object({ ids: Type.Array(Type.String(), { maxItems: 64 }) }),
    async execute(_id, params, signal, onUpdate) {
      const ids = [...new Set(params.ids)];
      if (!ids.length) throw new Error("Provide at least one subagent id.");
      if (ids.some((id) => getManager().get(id)?.origin === "btw")) throw new Error("By-the-way sessions are only available through the TUI.");
      onUpdate?.({ content: [{ type: "text", text: `Waiting for ${ids.join(", ")}…` }], details: { pending: ids } });
      const snapshots = await getManager().wait(ids, signal);
      for (const id of ids) { getManager().consume(id); pendingResults.delete(id); }
      const combined = snapshots.map((snapshot) => `## ${snapshot.id} “${snapshot.title}” — ${snapshot.status}\n${snapshot.error ? `Error: ${snapshot.error}\n` : ""}${truncateSubagentOutput(snapshot.output || "(no output)", 200, 16 * 1024, "[output truncated]", snapshot.sessionFile).output}`).join("\n\n---\n\n");
      const text = truncateSubagentOutput(combined, 800, 64 * 1024, "[combined subagent output truncated]").output;
      return { content: [{ type: "text", text }], details: { results: snapshots.map(({ id, status }) => ({ id, status })) } };
    },
  });

  pi.registerTool({
    name: "subagent_cancel", label: "Cancel Subagents", description: "Cancel running background subagents.",
    parameters: Type.Object({ ids: Type.Array(Type.String()) }),
    async execute(_id, params) {
      if (params.ids.some((id) => getManager().get(id)?.origin === "btw")) throw new Error("By-the-way sessions are only available through the TUI.");
      const snapshots = await getManager().cancel([...new Set(params.ids)]);
      for (const snapshot of snapshots) pendingResults.delete(snapshot.id);
      return { content: [{ type: "text", text: snapshots.map((snapshot) => `${snapshot.id}: ${snapshot.status}`).join("\n") }], details: { results: snapshots.map(({ id, status }) => ({ id, status })) } };
    },
  });

  pi.registerTool({
    name: "subagent_check", label: "Check Subagent", description: "Check one subagent's status and recent output.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      const snapshot = getManager().get(params.id);
      if (!snapshot || snapshot.origin === "btw") throw new Error(`Unknown subagent id "${params.id}".`);
      const preview = (snapshot.liveText || snapshot.output || "(no output yet)").slice(-2048);
      return { content: [{ type: "text", text: `${snapshot.id} [${snapshot.status}] “${snapshot.title}”\n${preview}` }], details: { id: snapshot.id, status: snapshot.status } };
    },
  });

  pi.registerTool({
    name: "subagent_list", label: "List Subagents", description: "List tracked model-facing subagents.", parameters: Type.Object({}),
    async execute() {
      const entries = getManager().list().filter((entry) => entry.origin !== "btw");
      return { content: [{ type: "text", text: entries.length ? entries.map((entry) => `${entry.id} [${entry.status}] “${entry.title}” (${entry.model}:${entry.thinking}, ${entry.cwd})`).join("\n") : "No subagents." }], details: { subagents: entries.map(({ id, title, status, origin }) => ({ id, title, status, origin })) } };
    },
  });

  pi.registerMessageRenderer("subagent-result", (message, { expanded }, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return expanded ? new Markdown(content, 0, 0, getMarkdownTheme()) : new Text(content.split("\n").slice(0, 9).join("\n"), 0, 0);
  });
  pi.registerEntryRenderer("btw-result", (entry, { expanded }, theme) => {
    const data = entry.data as any;
    const text = `${theme.fg(data.status === "done" ? "success" : "error", "■")} ${theme.bold(`by the way · ${data.title}`)}\n${data.error ? `Error: ${data.error}\n` : ""}${data.answer ?? "(no answer)"}`;
    return expanded ? new Markdown(text, 0, 0, getMarkdownTheme()) : new Text(text.split("\n").slice(0, 9).join("\n"), 0, 0);
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, continue, and abort subagents",
    handler: async (args, ctx) => {
      const entries = getManager().list();
      if (ctx.mode !== "tui") {
        ctx.ui.notify(entries.length ? entries.map((entry) => `${entry.id} [${entry.status}] ${entry.title}`).join("\n") : "No subagents.", "info");
        return;
      }
      await showSubagents(ctx, getManager(), args.trim() || undefined);
      for (const entry of getManager().list()) if (entry.status !== "running") acknowledged.add(entry.id);
      updateStatus();
    },
  });

  pi.registerCommand("btw", {
    description: "Ask a one-off side question outside parent model context",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/btw is only available in TUI mode", "warning"); return; }
      const task = args.trim() || (await ctx.ui.input("By the way", "Ask a side question…"))?.trim();
      if (!task) return;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      if (!model) { ctx.ui.notify("No active model", "error"); return; }
      const snapshot = await getManager().spawn({
        origin: "btw", title: task.split(/\s+/).slice(0, 8).join(" "), task, cwd: ctx.cwd,
        model, thinking: pi.getThinkingLevel(), mutating: false,
        config: { name: "By the way", prompt: "Answer the user's one-off side question concisely. Do not modify files.", timeoutMs: 15 * 60_000, tools: "read,grep,find,ls", inheritResources: false },
      });
      await showTakeover(ctx, getManager(), snapshot.id);
    },
  });

  pi.registerCommand("subagent-preset", {
    description: "Switch the model preset used by scout, review, and commit",
    handler: async (args, ctx) => {
      const names = getSubagentPresetNames();
      if (names.length === 0) {
        ctx.ui.notify("No subagent presets configured", "warning");
        return;
      }

      const requested = args.trim();
      const name = requested || await ctx.ui.select(
        `Subagent preset (current: ${getActiveSubagentPresetName() ?? "none"})`,
        names,
      );
      if (!name) return;
      if (!names.includes(name)) {
        ctx.ui.notify(`Unknown subagent preset "${name}". Available: ${names.join(", ")}`, "error");
        return;
      }

      setSubagentPreset(name);
      ctx.ui.notify(`Subagent preset "${name}" activated`, "info");
    },
  });

}
