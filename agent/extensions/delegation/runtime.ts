import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderDelegationCall, renderDelegationResult } from "./render.ts";
import { delegationDetails, truncateSubagentOutput, type SubagentManager } from "./manager.ts";

let sessionPreset: string | undefined;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

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

/** A subagent is enabled unless its active-preset configuration explicitly disables it. */
export function isSubagentEnabled(name: string): boolean {
  const presetName = getActiveSubagentPresetName();
  const config = presetName ? subagentSettings()?.presets?.[presetName]?.[name] : undefined;
  return !config || typeof config !== "object" || config.enabled !== false;
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
  if (override.skills !== undefined && (
    !Array.isArray(override.skills) || override.skills.some((skill: unknown) => typeof skill !== "string")
  )) {
    throw new Error(`Subagent preset "${presetName}" has invalid skills for "${name}"`);
  }

  return {
    ...defaults,
    model: override.model,
    thinking: override.thinking,
    ...(override.skills === undefined ? {} : { skills: override.skills }),
  };
}

export interface DelegationConfig {
  readonly name: string;
  readonly model: string;
  readonly thinking: string;
  readonly timeoutMs: number;
  readonly tools?: string;
  readonly skills?: readonly string[];
  readonly inheritResources?: boolean;
  readonly description: string;
  readonly snippet: string;
  readonly guidelines: readonly string[];
  readonly parameter: string;
  readonly prompt: string;
}

export interface DelegationPolicy extends DelegationConfig {
  readonly key: string;
  readonly mutating: boolean;
  readonly dynamicModel?: boolean;
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
  sessionFile?: string;
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

export function registerDelegatedTool(pi: ExtensionAPI, policy: DelegationPolicy, getManager: () => SubagentManager) {
  const resolveConfig = () => policy.dynamicModel ? policy : getDelegationConfig(policy.key, policy);
  const run = async (
    task: string,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: (details: DelegationDetails) => void,
    overrides?: Pick<DelegationConfig, "model" | "thinking">,
  ) => {
    const config = { ...resolveConfig(), ...overrides };
    const manager = getManager();
    let snapshot;
    try {
      snapshot = await manager.spawn({
        origin: policy.key as "scout" | "review" | "commit" | "agent",
        title: `${policy.name}: ${task}`,
        task,
        cwd,
        model: config.model,
        thinking: config.thinking,
        mutating: policy.mutating,
        config,
        consumed: true,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new DelegationAbortError();
      throw error;
    }
    const emit = () => onUpdate?.(delegationDetails(snapshot, config) as DelegationDetails);
    const unsubscribe = manager.subscribeTo(snapshot.id, emit);
    emit();
    try {
      await manager.wait([snapshot.id]);
    } finally {
      unsubscribe();
    }
    if (snapshot.status === "cancelled") throw new DelegationAbortError();
    if (snapshot.status !== "done") throw new Error(snapshot.error ?? `${policy.name} failed`);
    const details = delegationDetails(snapshot, config) as DelegationDetails;
    const output = details.output || policy.emptyOutput;
    const truncated = truncateSubagentOutput(output, policy.maxLines, policy.maxBytes, policy.truncationMessage, snapshot.sessionFile);
    details.output = truncated.output;
    details.truncated = truncated.truncated;
    return details;
  };

  pi.registerTool({
    name: policy.key,
    label: policy.name,
    description: `${policy.description} Hard timeout: ${policy.timeoutMs / 1000}s.`,
    promptSnippet: policy.snippet,
    promptGuidelines: [...policy.guidelines],
    parameters: policy.dynamicModel
      ? Type.Object({
          task: Type.String({ description: policy.parameter }),
          model: Type.String({ description: "Exact provider/model id chosen for this task" }),
          thinking: Type.String({ description: "Reasoning level: off, minimal, low, medium, high, xhigh, or max" }),
        })
      : Type.Object({ task: Type.String({ description: policy.parameter }) }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (policy.dynamicModel && !THINKING_LEVELS.has((params as any).thinking)) {
        throw new Error(`Invalid thinking level: ${(params as any).thinking}`);
      }
      const overrides = policy.dynamicModel
        ? { model: (params as any).model, thinking: (params as any).thinking }
        : undefined;
      const details = await run(params.task, ctx.cwd, signal, (details) => {
        onUpdate?.({
          content: [{ type: "text", text: details.output || details.activities.at(-1) || "(running…)" }],
          details,
        });
      }, overrides);
      return { content: [{ type: "text", text: details.output }], details };
    },

    renderCall(args, theme, context) {
      const cached = context.state.config as DelegationConfig | undefined;
      const config = policy.dynamicModel ? {
        ...(cached ?? resolveConfig()),
        ...(typeof (args as any).model === "string" ? { model: (args as any).model } : {}),
        ...(typeof (args as any).thinking === "string" ? { thinking: (args as any).thinking } : {}),
      } : cached ?? resolveConfig();
      context.state.config = config;
      return renderDelegationCall(config, args.task, context.expanded, theme);
    },

    renderResult(result, { expanded }, theme) {
      return renderDelegationResult(result.details as DelegationDetails | undefined, expanded, theme);
    },
  });

  return run;
}

