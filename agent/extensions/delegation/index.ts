import { join, resolve } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { formatSkillsForPrompt, getAgentDir, getMarkdownTheme, type AgentToolResult, type ExtensionAPI, type ExtensionContext, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createChildResources, resolveStandaloneChildProjectTrust } from "../shared/child-session.ts";
import { configPath, getActiveSubagentPresetName, getAgents, getSubagentPresetNames, resolveAgent, saveAgentModel, setSubagentPreset, THINKING_LEVELS, type AgentConfig } from "./config.ts";
import { AgentJobs, modelsFromRegistry, type Job, type JobResult } from "./durable.ts";
import { registerDynamicRouteGuidance } from "./runtime.ts";
import { showAgents } from "./dashboard.ts";
import { activeJob, elapsed, jobColor, jobSummary, pendingJob, shortPaths, statusCounts, terminalText } from "./presentation.ts";

const SHORTCUTS = {
  scout: { agent: "explore", description: "Delegate focused, read-only codebase reconnaissance to a cheaper model.", guidelines: ["Default to direct inspection. Use scout only for one narrow question that needs more than 2-3 files. Verify only evidence needed for edits. Do not use it for implementation or repeat completed exploration."] },
  review: { agent: "review", description: "Delegate focused, read-only code review to a high-reasoning model.", guidelines: ["Use review only when explicitly requested or when a high-risk change needs independent review. Supply exact scope and intended behavior. Verify findings before acting. Review once unless new code is added."] },
  commit: { agent: "commit", description: "Delegate completed-work analysis and intentional git commits to a specialized model.", guidelines: ["Use commit only when the user explicitly requests commits. Pass scope and splitting instructions. The child owns inspection, staging, and commits."] },
} as const;

export function formatResult(result: JobResult) {
  const { job } = result;
  const question = job.status === "waiting" ? `\n\nAnswer with agent({ action: "message", id: "${job.name ?? job.id}", task: "your answer" }). This resumes the same child.` : "";
  return `${job.name ?? job.agent} (${job.id}) [${job.status}]\n${jobSummary(job, result)}\n\n${result.output}${question}`;
}

type RenderContext = { expanded?: boolean; args?: { task?: string }; state?: { config?: AgentConfig; configKey?: string } };
type Theme = ExtensionContext["ui"]["theme"];
function renderCall(agent: string, args: { task?: string; route?: string; name?: string; background?: boolean; action?: string; id?: string }, theme: Theme, ctx?: RenderContext) {
  const key = JSON.stringify([agent, args.route]);
  let config = ctx?.state?.configKey === key ? ctx.state.config : undefined;
  if (!args.action || args.action === "run") {
    try { config ??= resolveAgent(agent, args.route); } catch { /* Configuration errors appear in the result. */ }
  } else config = undefined;
  if (ctx?.state) { ctx.state.config = config; ctx.state.configKey = key; }
  const label = args.action && args.action !== "run" ? `${args.action} ${args.id ?? "agents"}` : `${args.name ?? agent}${args.background ? " in background" : ""}`;
  const header = theme.fg("toolTitle", terminalText(label).replace(/\s+/g, " ")) + (config ? theme.fg("dim", ` · ${config.model}:${config.thinking}`) : "");
  if (!ctx?.expanded) return clipped([header, ...(args.task ? [theme.fg("muted", shortPaths(oneLine(args.task)))] : [])]);
  return new Text(header + (args.task ? `\n${terminalText(args.task)}` : "") + (config ? `\n\nAgent instructions:\n${terminalText(config.instructions)}` : ""), 0, 0);
}
const oneLine = (text: string) => terminalText(text).replace(/\s+/g, " ").trim();
// Collapsed cards cut lines at the terminal edge instead of wrapping them.
const clipped = (lines: string[]) => ({ invalidate() {}, render: (width: number) => lines.map((line) => truncateToWidth(line, width)) });
function renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, ctx?: RenderContext) {
  const details = result.details as Partial<JobResult> | undefined;
  const job = details?.job;
  const output = terminalText(details?.output ?? result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
  if (!job) return new Markdown(output, 0, 0, getMarkdownTheme());
  const body = new Container();
  const header = theme.fg(jobColor(job), `${job.name ?? job.agent} · ${job.status}`) + theme.fg("dim", ` · ${jobSummary(job, details)}`);
  if (!options.expanded && activeJob(job)) {
    const activity = output.split("\n").filter((line) => line.trim()).slice(-3).map((line) => theme.fg("dim", "› ") + theme.fg("muted", shortPaths(oneLine(line))));
    return clipped([header, ...activity, theme.fg("dim", "ctrl+o to expand")]);
  }
  body.addChild(clipped([header]));
  if (options.expanded) {
    const instructions = details?.instructions ?? ctx?.state?.config?.instructions;
    body.addChild(new Text(`\nTask:\n${terminalText(job.task ?? ctx?.args?.task ?? "")}\n\nAgent instructions:\n${terminalText(instructions ?? "See the durable conversation's saved instructions.")}\n`, 0, 0));
  }
  body.addChild(new Markdown(options.expanded || job.status === "waiting" ? output : output.split("\n").slice(-6).join("\n"), 0, 0, getMarkdownTheme()));
  if (job.status === "waiting") body.addChild(new Text(theme.fg("warning", `Answer with agent action message, id ${job.name ?? job.id}.`), 0, 0));
  return body;
}

export async function agentInstructions(config: AgentConfig, cwd: string, ctx: ExtensionContext, signal?: AbortSignal) {
  const setupSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000);
  const skills = config.skills;
  const { loader } = await awaitWithContext(createChildResources({
    cwd, projectTrusted: resolveStandaloneChildProjectTrust({ parentCwd: ctx.cwd, childCwd: cwd, parentTrusted: ctx.isProjectTrusted() }),
    noExtensions: true, noPromptTemplates: true,
    noSkills: skills !== undefined && !skills.includes("*"),
    ...(skills?.length && !skills.includes("*") ? { additionalSkillPaths: skills } : {}),
  }), withAbortSignal(setupSignal, BACKGROUND_CONTEXT));
  return [
    "You are a delegated coding assistant. Work only on the assigned task. You cannot ask the user directly or start subagents. If blocked, use ask_question to ask the parent one question. It parks your job until the parent answers and resumes this conversation. Do not call other tools after asking. Available tools: ask_question, " + config.tools.join(", "),
    ...loader.getAgentsFiles().agentsFiles.map((file) => `## Instructions from ${file.path}\n${file.content}`),
    formatSkillsForPrompt(loader.getSkills().skills),
    `Working directory: ${cwd}`,
    config.instructions,
  ].join("\n\n");
}

export default function delegation(pi: ExtensionAPI, openJobs = AgentJobs.open) {
  if (process.env.PI_DELEGATED === "1") return;
  registerDynamicRouteGuidance(pi);
  let jobs: AgentJobs | undefined;
  let context: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeInterrupt: (() => void) | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  const pendingReports = new Set<string>();
  const reportedUsage = new Map<string, Usage>();
  const collectUsage = (result: JobResult, ctx: ExtensionContext): Usage | undefined => {
    const id = result.job.id;
    // Session totals include all entries, even compacted or abandoned branches.
    // Only tool results count: automatic background and /commit cards do not.
    const saved = ctx.sessionManager.getEntries().findLast((entry: any) =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage && entry.message.details?.job?.id === id);
    const baseline: Usage | undefined = reportedUsage.get(id) ?? (saved as any)?.message.details.usage;
    if (baseline && result.usage.totalTokens < baseline.totalTokens) return undefined; // A concurrent collector may have a newer snapshot.
    const usage = { ...result.usage, cost: { ...result.usage.cost } };
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] -= baseline?.[key] ?? 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] -= baseline?.cost[key] ?? 0;
    reportedUsage.set(id, result.usage); // Reserve synchronously, including parallel waits before persistence.
    return usage.totalTokens || usage.cost.total ? usage : undefined;
  };
  const getJobs = () => { if (!jobs) throw new Error("Agent jobs are not ready"); return jobs; };

  const update = async () => {
    const current = jobs;
    const ctx = context;
    if (!current || !ctx) return;
    const entries = await current.list();
    if (current !== jobs) return;
    if (ctx.hasUI) {
      const theme = ctx.ui.theme;
      ctx.ui.setStatus("subagents", entries.some(pendingJob) ? `${theme.fg("muted", "subagents:")} ${statusCounts(entries.filter(pendingJob), theme)} ${theme.fg("dim", "/agents")}` : undefined);
    }
    if (flushing) return;
    flushing = true;
    try {
      for (const job of entries.filter((job) => !activeJob(job) && !job.delivered)) {
        const customType = job.status === "waiting" ? "agent-question" : "agent-result";
        const persisted = () => ctx.sessionManager.getBranch().some((entry: any) =>
          (entry.type === "custom_message" && entry.customType === customType && entry.details?.job?.requestId === job.requestId) ||
          (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.details?.job?.requestId === job.requestId && entry.message.details.job.status === job.status));
        if (!persisted() && job.background && !pendingReports.has(job.requestId)) {
          const result = await current.result(job.id);
          if (current !== jobs) return;
          if (result.job.requestId !== job.requestId || activeJob(result.job)) continue;
          pi.sendMessage({ customType, content: formatResult(result), details: result, display: true }, { deliverAs: "followUp", triggerTurn: true });
          pendingReports.add(job.requestId);
        }
        // Queued parent messages are not durable yet. A restart must be able to deliver them again.
        if (persisted()) { await current.acknowledge(job.id, job.requestId); pendingReports.delete(job.requestId); }
      }
    } finally { flushing = false; }
  };
  const scheduleUpdate = () => {
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      void update().catch((error) => context?.ui.notify(String(error), "error"));
    }, 100);
    updateTimer.unref();
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getActiveTools().some((name) => ["agent", "scout", "review", "commit"].includes(name))) return;
    reportedUsage.clear();
    context = ctx;
    setSubagentPreset(undefined);
    const saved = ctx.sessionManager.getBranch().findLast((entry: any) => entry.type === "custom" && entry.customType === "agent-preset") as { data?: { name?: string } } | undefined;
    if (saved?.data?.name) setSubagentPreset(saved.data.name);
    getAgents(); // Invalid configuration fails visibly, never falls back to an unintended provider.
    jobs = await openJobs({ models: modelsFromRegistry(ctx.modelRegistry, ctx.sessionManager.getSessionId()), ...(ctx.sessionManager.getSessionFile()
      ? { database: join(getAgentDir(), "subagents", `${ctx.sessionManager.getSessionId()}.sqlite`) }
      : { storage: new MemoryStorage() }) });
    unsubscribe = jobs.subscribe(scheduleUpdate);
    const current = jobs;
    unsubscribeInterrupt = pi.events.on("subagents:interrupt", () => {
      void current.list().then((entries) =>
        Promise.all(entries.filter(pendingJob).map((job) => current.cancel(job.id))),
      ).catch((error) => ctx.ui.notify(String(error), "error"));
    });
    await jobs.resume();
    await update();
  });
  pi.on("agent_settled", () => {
    pendingReports.clear(); // A cancelled parent run may have discarded its queued follow-ups.
    scheduleUpdate();
  });
  pi.on("message_end", scheduleUpdate);
  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribe?.(); unsubscribe = undefined;
    unsubscribeInterrupt?.(); unsubscribeInterrupt = undefined;
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = undefined;
    const closing = jobs; jobs = undefined; context = undefined;
    pendingReports.clear();
    reportedUsage.clear();
    ctx.ui.setStatus("subagents", undefined);
    ctx.ui.setWidget("subagents-monitor", undefined);
    await closing?.close();
  });

  const run = async (agent: string, task: string, ctx: ExtensionContext, route?: string, background = false, signal?: AbortSignal, onUpdate?: (result: any) => void, cwd = ctx.cwd, options?: { name?: string; title?: string }) => {
    const current = getJobs();
    const config = resolveAgent(agent, route);
    const slash = config.model.indexOf("/");
    if (!ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1))) throw new Error(`Unknown model "${config.model}"`);
    const instructions = await agentInstructions(config, cwd, ctx, signal);
    const job = await current.spawn(agent, { ...config, instructions }, task, cwd, background, signal, options);
    if (background) return { content: [{ type: "text" as const, text: `Started ${agent} job ${job.name ?? job.id} (${job.id}). Results and questions arrive automatically. Use agent action wait, status, message, or cancel with its name or id.` }], details: { job } };
    let stopped = false, feedbackTimer: ReturnType<typeof setTimeout> | undefined;
    const emit = () => {
      if (stopped || feedbackTimer || !onUpdate) return;
      feedbackTimer = setTimeout(() => {
        feedbackTimer = undefined;
        void current.result(job.id).then((info) => {
          if (!stopped) onUpdate({ content: [{ type: "text", text: current.preview(job.id) || info.output }], details: info });
        }).catch(() => {});
      }, 100);
    };
    const stop = current.subscribe(emit);
    onUpdate?.({ content: [{ type: "text", text: current.preview(job.id) || "Working" }], details: { job } });
    try {
      const result = await current.wait(job.id, signal);
      return { content: [{ type: "text" as const, text: formatResult(result) }], details: result, usage: result.usage, isError: result.job.status === "failed" || result.job.status === "cancelled" };
    } finally { stopped = true; stop(); if (feedbackTimer) clearTimeout(feedbackTimer); }
  };

  pi.registerTool({
    name: "agent", label: "Agent", exposure: "model-only",
    description: "Run a named subagent or manage its durable background job. Omit agent to use default for implementation and useful handoffs without a specialist. Results of background jobs arrive automatically, including after a restart.",
    promptSnippet: "Delegate a self-contained task; default handles work without a specialist",
    promptGuidelines: [
      "Use the fewest subagents that materially reduce context, uncertainty, or elapsed time. Direct work is fine; hand off self-contained work when useful even without an explicit delegation request.",
      "Omit agent for general-purpose handoffs. Use explore for reconnaissance, review for independent review, and plan for planning. Never use commit unless the user explicitly requests commits.",
      "Max four running jobs and one mutating child per working tree. Do not overlap parent edits with a mutating child. Use background only for work independent of the parent's next step.",
      "Children have built-in tools, project instructions, and skills, but no executable extensions or recursive delegation. They can ask the parent questions with ask_question and pause. Answer waiting jobs with agent action message using the job's name or id. Supply a complete task and validation requirements.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.Union(["run", "list", "status", "wait", "message", "cancel"].map((value) => Type.Literal(value)))),
      agent: Type.Optional(Type.String({ description: "Configured agent name; defaults to default" })),
      task: Type.Optional(Type.String({ description: "Self-contained task or message" })),
      id: Type.Optional(Type.String({ description: "Job name or UUID for status, wait, message, or cancel" })),
      name: Type.Optional(Type.String({ description: "Optional unique lowercase handle for this job", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" })),
      title: Type.Optional(Type.String({ description: "Short dashboard title", maxLength: 200 })),
      background: Type.Optional(Type.Boolean()),
      route: Type.Optional(Type.String({ description: "Explicit model override: agent name or provider/model[:thinking]" })),
      working_dir: Type.Optional(Type.String()),
    }),
    async execute(_call, args, signal, onUpdate, ctx) {
      const action = args.action ?? "run";
      if (action === "run") {
        const result = await run(args.agent ?? "default", args.task ?? "", ctx, args.route, args.background, signal, onUpdate, args.working_dir ? resolve(ctx.cwd, args.working_dir) : ctx.cwd, { name: args.name, title: args.title });
        return args.background ? result : { ...result, usage: collectUsage(result.details as JobResult, ctx) };
      }
      const current = getJobs();
      if (action === "list") {
        const configured = Object.entries(getAgents()).map(([name, config]) => `${name}: ${config.description} (${config.model}:${config.thinking})`);
        const entries = await current.list();
        return { content: [{ type: "text", text: [...configured, "", ...entries.map((job) => `${job.name ?? job.id} (${job.id}) ${job.agent} [${job.status}] ${(job.title ?? job.task).slice(0, 120)}${job.question ? `\n  Question: ${job.question.text}` : ""}`)].join("\n") }], details: { jobs: entries } };
      }
      if (!args.id) throw new Error(`${action} requires id`);
      if (action === "message") {
        const job = await current.message(args.id, args.task ?? "");
        return { content: [{ type: "text", text: `Message sent to ${job.id}` }], details: { job } };
      }
      if (action === "cancel") await current.cancel(args.id);
      const result = action === "wait" ? await current.wait(args.id, signal) : await current.result(args.id);
      return { content: [{ type: "text", text: formatResult(result) }], details: result, usage: action === "wait" ? collectUsage(result, ctx) : undefined, isError: result.job.status === "failed" };
    },
    renderCall: (args, theme, ctx) => renderCall(args.agent ?? "default", args, theme, ctx),
    renderResult,
  });
  for (const [name, shortcut] of Object.entries(SHORTCUTS)) pi.registerTool({
    name, label: name, exposure: "model-only", description: shortcut.description,
    promptGuidelines: [...shortcut.guidelines, "An explicit user model pick goes in route and overrides this agent's model."],
    parameters: Type.Object({ task: Type.String(), route: Type.Optional(Type.String({ description: "Agent name or provider/model[:thinking]" })) }),
    execute: async (_call, args, signal, onUpdate, ctx) => {
      const result = await run(shortcut.agent, args.task, ctx, args.route, false, signal, onUpdate);
      return { ...result, usage: collectUsage(result.details as JobResult, ctx) };
    },
    renderCall: (args, theme, ctx) => renderCall(shortcut.agent, args, theme, ctx),
    renderResult,
  });
  for (const name of ["agent-result", "agent-question"]) pi.registerMessageRenderer<JobResult>(name, (message, options, theme) => {
    const result = message.details;
    const box = new Box(1, 1, result ? (text) => theme.bg(result.job.status === "done" ? "toolSuccessBg" : pendingJob(result.job) ? "toolPendingBg" : "toolErrorBg", text) : undefined);
    const content = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    box.addChild(renderResult({ content: [{ type: "text", text: content }], details: result }, { expanded: options?.expanded ?? true, isPartial: false }, theme));
    return box;
  });

  const configureAgents = async (ctx: ExtensionContext) => {
    const agents = getAgents();
    const name = await ctx.ui.select("Configure agent", Object.entries(agents).map(([name, agent]) => `${name} · ${agent.model}:${agent.thinking}`));
    if (!name) return;
    const agent = name.split(" · ")[0];
    const available = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`)
      .filter((model) => getActiveSubagentPresetName() !== "copilot" || model.startsWith("github-copilot/"));
    const model = await ctx.ui.select(`Model for ${agent}`, available);
    if (!model) return;
    const slash = model.indexOf("/");
    const selectedModel = ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1));
    const thinking = await ctx.ui.select("Thinking level", selectedModel ? getSupportedThinkingLevels(selectedModel) : [...THINKING_LEVELS]);
    if (!thinking) return;
    saveAgentModel(agent, model, thinking as AgentConfig["thinking"]);
    ctx.ui.notify(`Saved ${agent} in ${configPath()}`, "info");
  };
  const selectPreset = async (args: string, ctx: ExtensionContext) => {
    const name = args.trim() || await ctx.ui.select(`Agent preset (${getActiveSubagentPresetName()})`, getSubagentPresetNames());
    if (name) { setSubagentPreset(name); pi.appendEntry("agent-preset", { name }); ctx.ui.notify(`Agent preset ${name}`, "info"); }
  };
  pi.registerCommand("subagent-preset", { description: "Switch named agents' model preset", handler: selectPreset });
  const manageAgents = {
    description: "Configure named agents or inspect, message, and cancel durable jobs",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (args.trim() === "configure") return configureAgents(ctx);
      if (args.trim().startsWith("preset")) return selectPreset(args.trim().slice(6), ctx);
      if (ctx.mode === "tui") {
        let initialId = args.trim() || undefined;
        while (true) {
          const action = await showAgents(ctx, jobs, initialId);
          initialId = undefined;
          if (!action) return;
          if (action === "configure") await configureAgents(ctx);
          else await selectPreset("", ctx);
        }
      }
      // RPC clients support native dialogs, not custom terminal screens.
      const entries = jobs ? await jobs.list() : [];
      const choices = ["Configure agents", "Switch preset", ...entries.map((job) => `${job.name ?? job.id} · ${job.agent} [${job.status}] ${(job.title ?? job.task).slice(0, 80)}`)];
      const selected = await ctx.ui.select("Agents", choices);
      if (!selected) return;
      if (selected === choices[0]) return configureAgents(ctx);
      if (selected === choices[1]) return selectPreset("", ctx);
      const id = selected.split(" · ")[0];
      const result = await getJobs().result(id);
      const messageAction = result.job.status === "waiting" ? "Answer question" : "Message";
      const action = await ctx.ui.select(`${result.job.name ?? result.job.agent} [${result.job.status}]`, ["View output", messageAction, "Cancel", "Close"]);
      if (action === "View output") await ctx.ui.editor("Agent output, edits are discarded", formatResult(result));
      if (action === "Cancel") await getJobs().cancel(id);
      if (action === messageAction) {
        const task = await ctx.ui.input(result.job.question?.text ?? "Message agent", "Answer, guidance, or follow-up");
        if (task?.trim()) await getJobs().message(id, task);
      }
    },
  };
  pi.registerCommand("agents", manageAgents);
  pi.registerCommand("commit", {
    description: "Create intentional commits with the commit agent",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Agent is busy", "warning"); return; }
      const task = args.trim() || "Analyze completed work and create the appropriate commits.";
      const startedAt = Date.now();
      let progress: { content: { text: string }[]; details: { job: Job } } | undefined;
      const showProgress = () => ctx.ui.setWidget("commit", (_tui, theme) => {
        const box = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
        box.addChild({
          invalidate() {},
          render(width) {
            return [
              theme.fg("toolTitle", theme.bold(`Commit · ${elapsed(startedAt)} · ${progress ? `${progress.details.job.model}:${progress.details.job.thinking}` : "Preparing agent"}`)),
              theme.fg("dim", terminalText(task).replace(/\s+/g, " ")),
              ...(progress ? terminalText(progress.content[0].text).split("\n").slice(-6) : ["Loading instructions and skills…"]).map((line) => theme.fg("toolOutput", line)),
              theme.fg("dim", "esc cancel"),
            ].map((line) => truncateToWidth(line, width));
          },
        });
        return box;
      });
      showProgress();
      const timer = setInterval(showProgress, 1000);
      const controller = new AbortController();
      const stop = ctx.ui.onTerminalInput?.((data) => {
        if (matchesKey(data, Key.escape)) { controller.abort(); return { consume: true }; }
      });
      try {
        const result = await run("commit", task, ctx, undefined, false, controller.signal,
          (update) => { progress = update; showProgress(); });
        pi.sendMessage({ customType: result.details.job.status === "waiting" ? "agent-question" : "agent-result", content: result.content, details: result.details, display: true });
      } catch (error) {
        const text = controller.signal.aborted ? "Commit agent cancelled" : `Commit agent failed: ${String(error)}`;
        let result: JobResult | undefined;
        if (progress?.details.job.id && jobs) {
          try { if (controller.signal.aborted) await jobs.cancel(progress.details.job.id); result = await jobs.result(progress.details.job.id); } catch { /* Setup may have failed before a job was stored. */ }
        }
        pi.sendMessage({ customType: "agent-result", content: result ? formatResult(result) : `${text}\n\nTask: ${task}`, details: result, display: true });
        ctx.ui.notify(text, controller.signal.aborted ? "info" : "error");
      }
      finally { clearInterval(timer); stop?.(); ctx.ui.setWidget("commit", undefined); }
    },
  });
}
