import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderDelegationCall, renderDelegationResult } from "./render.ts";

let sessionPreset: string | undefined;

function subagentSettings(): any {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))?.subagents;
  } catch {
    return undefined;
  }
}

export function getSubagentPresetNames(): string[] {
  const presets = subagentSettings()?.presets;
  return presets && typeof presets === "object" ? Object.keys(presets) : [];
}

export function getActiveSubagentPresetName(): string | undefined {
  const configured = subagentSettings()?.preset;
  return sessionPreset
    ?? (process.env.PI_SUBAGENT_PRESET?.trim() || undefined)
    ?? (typeof configured === "string" ? configured : undefined);
}

export function setSubagentPreset(name: string | undefined) {
  sessionPreset = name;
}

export function getDelegationConfig(name: string, defaults: DelegationConfig): DelegationConfig {
  const presetName = getActiveSubagentPresetName();
  if (!presetName) return defaults;

  const override = subagentSettings()?.presets?.[presetName]?.[name];
  if (!override || typeof override.model !== "string" || typeof override.thinking !== "string") {
    throw new Error(`Subagent preset "${presetName}" has no valid "${name}" configuration`);
  }

  return { ...defaults, model: override.model, thinking: override.thinking };
}

export interface DelegationConfig {
  readonly name: string;
  readonly model: string;
  readonly thinking: string;
  readonly timeoutMs: number;
  readonly tools: string;
  readonly skills?: readonly string[];
  readonly description: string;
  readonly snippet: string;
  readonly guidelines: readonly string[];
  readonly parameter: string;
  readonly prompt: string;
}

export interface DelegationPolicy extends DelegationConfig {
  readonly key: string;
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly emptyOutput: string;
  readonly truncationMessage: string;
}

export type DelegationStatus = "running" | "done" | "cancelled" | "failed";

/** Thrown when a delegated run is stopped through its AbortSignal rather than failing on its own. */
export class DelegationAbortError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "DelegationAbortError";
  }
}

export interface DelegationDetails {
  task: string;
  model: string;
  thinking: string;
  prompt: string;
  status: DelegationStatus;
  /** Set when the run ended in "cancelled" or "failed"; shown next to the status label. */
  error?: string;
  activities: string[];
  output: string;
  elapsedMs: number;
  usage: {
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
  };
  truncated?: boolean;
  lastStopReason?: string;
}

function textFromMessage(message: any) {
  return Array.isArray(message?.content)
    ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
    : "";
}

function formatTool(toolName: string, args: Record<string, unknown>) {
  const path = String(args.path ?? args.file_path ?? ".");
  switch (toolName) {
    case "read": return `read ${path}${args.offset ? `:${args.offset}` : ""}`;
    case "grep": return `grep /${String(args.pattern ?? "")}/ in ${path}`;
    case "find": return `find ${String(args.pattern ?? "*")} in ${path}`;
    case "ls": return `ls ${path}`;
    case "bash": {
      const command = String(args.command ?? "");
      return `$ ${command.length > 100 ? `${command.slice(0, 100)}…` : command}`;
    }
    default: return `${toolName} ${JSON.stringify(args)}`;
  }
}

export function createDelegationDetails(config: DelegationConfig, task: string): DelegationDetails {
  return {
    task,
    model: config.model,
    thinking: config.thinking,
    prompt: config.prompt,
    status: "running",
    activities: [],
    output: "",
    elapsedMs: 0,
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
  };
}

/** Apply one event from `pi --mode json`; returns whether the visible state changed. */
export function applyDelegationEvent(details: DelegationDetails, event: any) {
  if (event.type === "message_start" && event.message?.role === "assistant") {
    details.output = "";
    return true;
  }

  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      details.output += update.delta;
      return true;
    }
  }

  if (event.type === "tool_execution_start") {
    details.activities.push(formatTool(event.toolName, event.args ?? {}));
    if (details.activities.length > 100) details.activities.shift();
    return true;
  }

  if (event.type === "tool_execution_end" && event.isError) {
    details.activities.push(`✗ ${event.toolName}`);
    if (details.activities.length > 100) details.activities.shift();
    return true;
  }

  if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = textFromMessage(event.message);
    if (text) details.output = text;
    if (event.message.stopReason) details.lastStopReason = event.message.stopReason;
    const usage = event.message.usage;
    if (usage) {
      details.usage.turns++;
      details.usage.input += usage.input ?? 0;
      details.usage.output += usage.output ?? 0;
      details.usage.cacheRead += usage.cacheRead ?? 0;
      details.usage.cacheWrite += usage.cacheWrite ?? 0;
      details.usage.cost += usage.cost?.total ?? 0;
      details.usage.contextTokens = usage.totalTokens ?? details.usage.contextTokens;
    }
    return true;
  }

  if (event.type === "agent_end" && !event.willRetry) {
    return true;
  }

  if (event.type === "agent_settled") {
    details.status = "done";
    return true;
  }

  return false;
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
    captureStdout?: boolean;
  },
) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopped: "timeout" | "aborted" | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32" && proc.pid) {
          spawnSync("taskkill", ["/PID", String(proc.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else if (proc.pid) process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch {
        proc.kill(signal);
      }
    };
    const stop = (reason: "timeout" | "aborted") => {
      if (stopped) return;
      stopped = reason;
      killTree("SIGTERM");
      forceKillTimer = setTimeout(() => killTree("SIGKILL"), 5_000);
    };
    const onAbort = () => stop("aborted");
    const timeout = setTimeout(() => stop("timeout"), options.timeoutMs);

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      if (options.captureStdout !== false) stdout += chunk;
      options.onStdout?.(chunk);
    });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (error) => reject(error));
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (stopped) killTree("SIGKILL");
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (stopped === "timeout") reject(new Error(`Timed out after ${options.timeoutMs / 60_000} minutes`));
      else if (stopped === "aborted") reject(new DelegationAbortError());
      else resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function runDelegatedPi(
  config: DelegationConfig,
  task: string,
  cwd: string,
  signal?: AbortSignal,
  onUpdate?: (details: DelegationDetails) => void,
) {
  const details = createDelegationDetails(config, task);
  const startedAt = Date.now();
  let buffer = "";
  let lastUpdate = 0;

  const emit = (force = false) => {
    details.elapsedMs = Date.now() - startedAt;
    if (force || Date.now() - lastUpdate >= 100) {
      lastUpdate = Date.now();
      onUpdate?.({ ...details, activities: [...details.activities], usage: { ...details.usage } });
    }
  };
  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      if (applyDelegationEvent(details, JSON.parse(line))) emit();
    } catch {
      // Ignore non-JSON stdout; stderr and exit status still report child failures.
    }
  };

  emit(true);
  const result = await runProcess(
    "pi",
    [
      "--mode", "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      ...(config.skills ?? []).flatMap((skill) => ["--skill", skill]),
      "--no-prompt-templates",
      "--model", config.model,
      "--thinking", config.thinking,
      "--tools", config.tools,
      "--append-system-prompt", config.prompt,
      `${config.name} task: ${task}`,
    ],
    {
      cwd,
      timeoutMs: config.timeoutMs,
      signal,
      captureStdout: false,
      onStdout(chunk) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      },
    },
  );

  processLine(buffer);
  details.status = "done";
  emit(true);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Delegated task exited with code ${result.code}`);
  if (details.lastStopReason && details.lastStopReason !== "stop" && details.lastStopReason !== "toolUse") {
    throw new Error(`Delegated task ended with stopReason: ${details.lastStopReason}`);
  }
  return details;
}

export function registerDelegatedTool(pi: ExtensionAPI, policy: DelegationPolicy) {
  const resolveConfig = () => getDelegationConfig(policy.key, policy);
  const run = async (
    task: string,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: (details: DelegationDetails) => void,
  ) => {
    const details = await runDelegatedPi(resolveConfig(), task, cwd, signal, onUpdate);
    const output = details.output || policy.emptyOutput;
    const truncated = truncateHead(output, { maxLines: policy.maxLines, maxBytes: policy.maxBytes });
    details.output = truncated.truncated
      ? `${truncated.content}\n\n${policy.truncationMessage}`
      : truncated.content;
    details.truncated = truncated.truncated;
    return details;
  };

  pi.registerTool({
    name: policy.key,
    label: policy.name,
    description: `${policy.description} Hard timeout: ${policy.timeoutMs / 1000}s.`,
    promptSnippet: policy.snippet,
    promptGuidelines: [...policy.guidelines],
    parameters: Type.Object({ task: Type.String({ description: policy.parameter }) }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const details = await run(params.task, ctx.cwd, signal, (details) => {
        onUpdate?.({
          content: [{ type: "text", text: details.output || details.activities.at(-1) || "(running…)" }],
          details,
        });
      });
      return { content: [{ type: "text", text: details.output }], details };
    },

    renderCall(args, theme, context) {
      const config = (context.state.config as DelegationConfig | undefined) ?? resolveConfig();
      context.state.config = config;
      return renderDelegationCall(config, args.task, context.expanded, theme);
    },

    renderResult(result, { expanded }, theme) {
      return renderDelegationResult(result.details as DelegationDetails | undefined, expanded, theme);
    },
  });

  return run;
}

