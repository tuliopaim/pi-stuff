import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Key, Markdown, Text, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { showSubagents, showTakeover } from "./dashboard.ts";
import { SubagentManager, truncateSubagentOutput } from "./manager.ts";
import { isPendingSubagentStatus, type SubagentSnapshot } from "./domain.ts";
import { formatSubagentUsage, formatWaitingSubagents, renderSubagentMonitor } from "./presentation.ts";
import { discoverSubagentProfiles, resolveProfileSkillPaths } from "./profiles.ts";
import { renderDelegationMessage } from "./render.ts";
import {
  createDelegationDetails,
  DelegationAbortError,
  getActiveSubagentPresetName,
  getDelegationConfig,
  getSubagentPresetNames,
  isSubagentEnabled,
  optionalString,
  registerDelegatedTool,
  registerDynamicRouteGuidance,
  resolveRouteRef,
  setSubagentPreset,
  validateRoute,
  type DelegationDetails,
  type DelegationPolicy,
} from "./runtime.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SESSION_MODES = ["standalone", "lineage-only", "fork"] as const;

// The model/thinking fields on the policies below are fallbacks used only when
// no subagent preset is active. Whenever a preset is active, getDelegationConfig
// resolves every child through that preset's roles, and an explicit `route`
// argument on a call overrides both. See README "Subagents".
const SCOUT: DelegationPolicy = {
  key: "scout",
  name: "Scout",
  model: "opencode-go/deepseek-v4-flash",
  thinking: "medium",
  mutating: false,
  timeoutMs: 30 * 60_000,
  tools: "read,grep,find,ls",
  description: "Delegate focused, read-only codebase reconnaissance to a cheaper model.",
  snippet: "Delegate focused codebase reconnaissance to a cheaper read-only model",
  guidelines: [
    "Default to direct inspection. Use scout only for a narrow reconnaissance question that would otherwise require exploring more than 2-3 files.",
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
  timeoutMs: 30 * 60_000,
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
  timeoutMs: 30 * 60_000,
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
  createManager: (ctx: ExtensionContext, parentSessionId: string, onSettled: (snapshot: SubagentSnapshot) => void, onQuestion: (snapshot: SubagentSnapshot) => void) => SubagentManager
    = (ctx, parentSessionId, onSettled, onQuestion) => new SubagentManager(ctx, parentSessionId, onSettled, { onQuestion }),
) {
  if (process.env.PI_DELEGATED === "1") return;
  registerDynamicRouteGuidance(pi);

  let manager: SubagentManager | undefined;
  let context: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let monitorClock: ReturnType<typeof setInterval> | undefined;
  const acknowledged = new Set<string>();
  const announcedQuestions = new Set<string>();
  const pendingResults = new Map<string, SubagentSnapshot>();
  const getManager = () => {
    if (!manager) throw new Error("Subagent manager is not ready yet.");
    return manager;
  };
  const updateStatus = () => {
    if (!context?.hasUI || !manager) return;
    const entries = manager.list();
    const running = entries.filter((entry) => isPendingSubagentStatus(entry.status)).length;
    const done = entries.filter((entry) => entry.status === "done" && !acknowledged.has(entry.id)).length;
    const failed = entries.filter((entry) => !isPendingSubagentStatus(entry.status) && entry.status !== "done" && !acknowledged.has(entry.id)).length;
    context.ui.setStatus("subagents", running || done || failed
      ? formatActivityStatus(context.ui.theme, "subagents", { running, done, failed })
      : undefined);
    // Foreground one-off agents already own a tool card. The persistent monitor
    // is only for subagent_spawn jobs that otherwise have no live home.
    const monitored = entries.filter((entry) =>
      entry.origin === "generic" && (isPendingSubagentStatus(entry.status) || !entry.consumed));
    context.ui.setWidget?.("subagents-monitor", monitored.length
      ? (_tui, theme) => ({
          render: (width) => renderSubagentMonitor(monitored, width, theme),
          invalidate() {},
        })
      : undefined);
    const shouldTick = monitored.some((entry) => entry.status === "running" || entry.status === "stalled");
    if (shouldTick && !monitorClock) {
      monitorClock = setInterval(updateStatus, 1_000);
      monitorClock.unref?.();
    } else if (!shouldTick && monitorClock) {
      clearInterval(monitorClock);
      monitorClock = undefined;
    }
  };
  const scheduleUpdate = () => {
    if (updateTimer) return;
    updateStatus();
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      updateStatus();
    }, 100);
    updateTimer.unref?.();
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
    } else if (!snapshot.consumed) {
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
          content: `Subagent ${snapshot.name} (${snapshot.id}) “${snapshot.title}” ${snapshot.status}.\n${formatSubagentUsage(snapshot)}\n\n${snapshot.error ? `Error: ${snapshot.error}\n\n` : ""}${bounded.output}`,
          details: { id: snapshot.id, name: snapshot.name, title: snapshot.title, status: snapshot.status },
        }, { deliverAs: "followUp", triggerTurn: true });
        manager?.consume(snapshot.id);
        pendingResults.delete(snapshot.id);
      } catch {}
    }
  };
  const announceQuestion = (snapshot: SubagentSnapshot) => {
    if (!snapshot.question || snapshot.origin === "btw") return;
    const key = `${snapshot.id}:${snapshot.question.askedAt}`;
    if (announcedQuestions.has(key)) return;
    pi.sendMessage({
      customType: "subagent-question", display: true,
      content: `Subagent ${snapshot.name} (${snapshot.id}) is waiting for your answer.\n\n${snapshot.question.text}\n\nReply with: subagent_message({ name: "${snapshot.name}", message: "..." })`,
      details: { id: snapshot.id, name: snapshot.name, question: snapshot.question.text },
    }, { deliverAs: "steer", triggerTurn: true });
    announcedQuestions.add(key);
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    manager = createManager(ctx, ctx.sessionManager.getSessionId(), settled, announceQuestion);
    for (const entry of manager.list()) {
      if (!isPendingSubagentStatus(entry.status)) acknowledged.add(entry.id);
      if (entry.origin === "generic" && !isPendingSubagentStatus(entry.status) && !entry.consumed) pendingResults.set(entry.id, entry);
      if (entry.status === "waiting") announceQuestion(entry);
    }
    unsubscribe = manager.subscribe(scheduleUpdate);
    updateStatus();
    if (pendingResults.size) queueMicrotask(flushResults);
    const active = getActiveSubagentPresetName();
    if (active && !getSubagentPresetNames().includes(active)) ctx.ui.notify(`Unknown subagent preset "${active}"`, "warning");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribe?.(); unsubscribe = undefined;
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = undefined;
    if (monitorClock) clearInterval(monitorClock);
    monitorClock = undefined;
    ctx.ui.setStatus("subagents", undefined);
    ctx.ui.setWidget?.("subagents-monitor", undefined);
    pendingResults.clear();
    announcedQuestions.clear();
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
      "Choose each child's model and thinking level from the active subagent preset routes.",
      "When the user names a specific model or lane, pass it in `route` (route id or provider/model); an explicit user pick overrides preset roles.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Self-contained task" }),
      name: Type.Optional(Type.String({ description: "Short display name; defaults to the profile or subagent" })),
      agent: Type.Optional(Type.String({ description: "Declarative agent profile name from subagent_profiles" })),
      model: Type.Optional(Type.String({ description: "Exact provider/model id (required unless `route` is given)" })),
      thinking: Type.Optional(Type.String({ description: "off|minimal|low|medium|high|xhigh|max (required unless `route` is given)" })),
      route: Type.Optional(Type.String({ description: "Route id or provider/model from the active preset; overrides `model`/`thinking`" })),
      working_dir: Type.Optional(Type.String({ description: "Working directory; defaults to the parent cwd" })),
      session_mode: Type.Optional(StringEnum(SESSION_MODES, { description: "standalone, lineage-only, or fork; fork copies parent conversation context" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const discovery = discoverSubagentProfiles({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
      const profileName = optionalString(params.agent);
      const profile = profileName ? discovery.profiles.find((candidate) => candidate.name === profileName) : undefined;
      if (profileName && !profile) {
        const diagnostics = discovery.errors.map((item) => `${item.path}: ${item.error}`).join("\n");
        throw new Error(`Unknown subagent profile "${profileName}".${diagnostics ? `\nProfile errors:\n${diagnostics}` : ""}`);
      }
      let model: string;
      let thinking: string;
      const routeRef = optionalString(params.route);
      if (routeRef) {
        const route = resolveRouteRef(routeRef);
        model = route.model;
        thinking = route.thinking;
      } else if (optionalString(params.model) || optionalString(params.thinking)) {
        if (!optionalString(params.model) || !optionalString(params.thinking)) throw new Error("Provide both `model` and `thinking`.");
        if (!THINKING_LEVELS.has(params.thinking)) throw new Error(`Invalid thinking level: ${params.thinking}`);
        const v = validateRoute(params.model, params.thinking);
        if (!v.allowed) throw new Error(v.error);
        model = params.model;
        thinking = params.thinking;
      } else if (profile?.route) {
        const route = resolveRouteRef(profile.route);
        model = route.model;
        thinking = route.thinking;
      } else if (profile?.model && profile.thinking) {
        const v = validateRoute(profile.model, profile.thinking);
        if (!v.allowed) throw new Error(v.error);
        model = profile.model;
        thinking = profile.thinking;
      } else {
        throw new Error("Provide `agent`, `route`, or both `model` and `thinking`.");
      }
      const cwd = params.working_dir ? path.resolve(ctx.cwd, params.working_dir) : profile?.cwd ?? ctx.cwd;
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`working_dir is not a directory: ${cwd}`);
      const name = optionalString(params.name) ?? profile?.name ?? "subagent";
      const sessionMode = params.session_mode ?? profile?.sessionMode ?? "standalone";
      const profileSkillPaths = profile ? await resolveProfileSkillPaths(profile, {
        agentDir: getAgentDir(), cwd, projectTrusted: ctx.isProjectTrusted(),
      }) : undefined;
      const snapshot = await getManager().spawn({
        origin: "generic", name, title: name, task: params.task, cwd,
        model, thinking, sessionMode, parentSessionFile: ctx.sessionManager.getSessionFile(), mutating: profile?.mutating ?? true,
        config: profile ? {
          name: profile.name, prompt: profile.prompt, timeoutMs: profile.timeoutMs, tools: profile.tools,
          skills: profileSkillPaths, inheritResources: profile.inheritResources,
        } : { name: "Agent", prompt: AGENT.prompt, timeoutMs: AGENT.timeoutMs, inheritResources: true },
        signal,
      });
      return { content: [{ type: "text", text: `Started ${snapshot.name} (${snapshot.id}) “${snapshot.title}” in ${cwd}.` }], details: { id: snapshot.id, name: snapshot.name, status: snapshot.status, sessionMode: snapshot.sessionMode } };
    },
    renderCall(args, theme) {
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "subagent";
      let text = `${theme.fg("toolTitle", theme.bold("spawn subagent "))}${theme.fg("accent", name)}`;
      if (args.model) text += `\n${theme.fg("dim", `${args.model}:${args.thinking ?? "?"}`)}`;
      else if (typeof args.route === "string") text += `\n${theme.fg("dim", `route: ${args.route}`)}`;
      if (args.task) text += `\n${theme.fg("muted", args.task)}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_profiles", label: "List Subagent Profiles",
    description: "List available declarative background-agent profiles and any profile errors.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const discovery = discoverSubagentProfiles({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
      const profiles = discovery.profiles.map((profile) =>
        `${profile.name} [${profile.source}] ${profile.description || "(no description)"} · ${profile.route ? `route ${profile.route}` : profile.model ? `${profile.model}:${profile.thinking}` : "model required at spawn"} · ${profile.mutating ? "mutating" : "read-only"} · ${profile.sessionMode}`);
      const errors = discovery.errors.map((item) => `ERROR ${item.path}: ${item.error}`);
      return { content: [{ type: "text", text: [...profiles, ...errors].join("\n") || "No subagent profiles." }], details: discovery };
    },
  });

  pi.registerTool({
    name: "subagent_message", label: "Message Subagent",
    description: "Send guidance to a tracked subagent by its stable name, answer a waiting question, or continue a settled child session.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, description: "Exact stable subagent name" }),
      message: Type.String({ minLength: 1, description: "Guidance, answer, or continuation prompt" }),
    }),
    async execute(_id, params) {
      const manager = getManager();
      const snapshot = manager.resolve(params.name);
      if (!snapshot || snapshot.name !== params.name || snapshot.origin === "btw") {
        const names = manager.list().filter((entry) => entry.origin !== "btw").map((entry) => entry.name);
        throw new Error(`Unknown subagent name "${params.name}".${names.length ? ` Known names: ${names.join(", ")}.` : ""}`);
      }
      if (!params.message.trim()) throw new Error("Message must not be empty.");
      await manager.send(snapshot.id, params.message);
      return {
        content: [{ type: "text", text: `Message sent to ${snapshot.name} (${snapshot.id}).` }],
        details: { id: snapshot.id, name: snapshot.name, status: snapshot.status, sessionMode: snapshot.sessionMode },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait", label: "Wait for Subagents", description: "Wait for background subagents and return their results.",
    parameters: Type.Object({ ids: Type.Array(Type.String(), { maxItems: 64 }) }),
    async execute(_id, params, signal, onUpdate) {
      const ids = [...new Set(params.ids)];
      if (!ids.length) throw new Error("Provide at least one subagent id.");
      if (ids.some((id) => getManager().resolve(id)?.origin === "btw")) throw new Error("By-the-way sessions are only available through the TUI.");
      const emit = () => {
        const entries = ids.map((id) => getManager().resolve(id)).filter((entry): entry is SubagentSnapshot => Boolean(entry));
        onUpdate?.({ content: [{ type: "text", text: formatWaitingSubagents(entries) }], details: { pending: ids } });
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribeWait = onUpdate ? getManager().subscribe(() => {
        if (!timer) timer = setTimeout(() => { timer = undefined; emit(); }, 150);
      }) : undefined;
      emit();
      let snapshots: SubagentSnapshot[];
      try {
        snapshots = await getManager().wait(ids, signal);
      } finally {
        unsubscribeWait?.();
        if (timer) clearTimeout(timer);
      }
      for (const snapshot of snapshots) { getManager().consume(snapshot.id); pendingResults.delete(snapshot.id); }
      const combined = snapshots.map((snapshot) => `## ${snapshot.name} (${snapshot.id}) “${snapshot.title}” — ${snapshot.status}\n${formatSubagentUsage(snapshot)}\n${snapshot.error ? `Error: ${snapshot.error}\n` : ""}${truncateSubagentOutput(snapshot.output || "(no output)", 200, 16 * 1024, "[output truncated]", snapshot.sessionFile).output}`).join("\n\n---\n\n");
      const text = truncateSubagentOutput(combined, 800, 64 * 1024, "[combined subagent output truncated]").output;
      return { content: [{ type: "text", text }], details: { results: snapshots.map(({ id, status }) => ({ id, status })) } };
    },
  });

  pi.registerTool({
    name: "subagent_cancel", label: "Cancel Subagents", description: "Cancel running background subagents.",
    parameters: Type.Object({ ids: Type.Array(Type.String()) }),
    async execute(_id, params) {
      if (params.ids.some((id) => getManager().resolve(id)?.origin === "btw")) throw new Error("By-the-way sessions are only available through the TUI.");
      const snapshots = await getManager().cancel([...new Set(params.ids)]);
      for (const snapshot of snapshots) pendingResults.delete(snapshot.id);
      return { content: [{ type: "text", text: snapshots.map((snapshot) => `${snapshot.id}: ${snapshot.status}`).join("\n") }], details: { results: snapshots.map(({ id, status }) => ({ id, status })) } };
    },
  });

  pi.registerTool({
    name: "subagent_check", label: "Check Subagent", description: "Check one subagent's status and recent output.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      const snapshot = getManager().resolve(params.id);
      if (!snapshot || snapshot.origin === "btw") throw new Error(`Unknown subagent id "${params.id}".`);
      const preview = (snapshot.liveText || snapshot.output || "(no output yet)").slice(-2048);
      return { content: [{ type: "text", text: `${snapshot.name} (${snapshot.id}) [${snapshot.status}] “${snapshot.title}”\n${formatSubagentUsage(snapshot)}\n${preview}` }], details: { id: snapshot.id, name: snapshot.name, status: snapshot.status, sessionMode: snapshot.sessionMode } };
    },
  });

  pi.registerTool({
    name: "subagent_list", label: "List Subagents", description: "List tracked model-facing subagents.", parameters: Type.Object({}),
    async execute() {
      const entries = getManager().list().filter((entry) => entry.origin !== "btw");
      return { content: [{ type: "text", text: entries.length ? entries.map((entry) => `${entry.name} (${entry.id}) [${entry.status}] “${entry.title}” (${entry.model}:${entry.thinking}, ${entry.sessionMode}, ${entry.cwd})`).join("\n") : "No subagents." }], details: { subagents: entries.map(({ id, name, title, status, origin, sessionMode }) => ({ id, name, title, status, origin, sessionMode })) } };
    },
  });

  pi.registerMessageRenderer("subagent-result", (message) => {
    const content = typeof message.content === "string" ? message.content : "";
    const box = new Box(1, 0);
    box.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
    return box;
  });
  pi.registerMessageRenderer("subagent-question", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("warning", content), 0, 0));
    return box;
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
      for (const entry of getManager().list()) if (!isPendingSubagentStatus(entry.status)) acknowledged.add(entry.id);
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
        origin: "btw", name: "btw", title: task.split(/\s+/).slice(0, 8).join(" "), task, cwd: ctx.cwd,
        model, thinking: pi.getThinkingLevel(), sessionMode: "standalone", mutating: false,
        config: { name: "By the way", prompt: "Answer the user's one-off side question concisely. Do not modify files.", timeoutMs: 30 * 60_000, tools: "read,grep,find,ls", inheritResources: false },
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
