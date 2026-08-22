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
  const preset = activePreset();
  if (!preset) return true;
  // The foreground agent tool picks models dynamically, so it opts in explicitly.
  if (name === "agent") return preset.enableAgentTool === true;
  const role = preset.roles?.[name];
  return typeof role === "string" && role.length > 0;
}

export function setSubagentPreset(name: string | undefined) {
  sessionPreset = name;
}

/** The active preset object from settings, honoring env/session overrides. */
function activePreset(): Record<string, any> | undefined {
  const presetName = getActiveSubagentPresetName();
  return presetName ? subagentSettings()?.presets?.[presetName] : undefined;
}

/** Fixed-role subagents resolve their model through their preset's roles map. */
export function getDelegationConfig(name: string, defaults: DelegationConfig): DelegationConfig {
  const preset = activePreset();
  if (!preset) return defaults;

  const roleId = preset.roles?.[name];
  const route = typeof roleId === "string"
    ? getAgentRoutes().find((r) => r.id === roleId)
    : undefined;
  if (!route) {
    throw new Error(
      `Subagent preset "${getActiveSubagentPresetName()}" has no "${name}" role route${
        roleId !== undefined ? ` matching id "${roleId}"` : ""
      }`,
    );
  }

  const skills = preset.roleSkills?.[name]
    ?? subagentSettings()?.shared?.roleSkills?.[name];
  if (skills !== undefined && (
    !Array.isArray(skills) || skills.some((skill: unknown) => typeof skill !== "string")
  )) {
    throw new Error(`Subagent preset "${getActiveSubagentPresetName()}" has invalid skills for "${name}"`);
  }

  return {
    ...defaults,
    model: route.model,
    thinking: route.thinking,
    ...(skills === undefined ? {} : { skills }),
  };
}

/**
 * A single allowed child-model lane. `id` names the lane so roles can pin to
 * it and prompts can refer to it ("use the recon lane").
 */
export interface AgentRoute {
  readonly id?: string;
  readonly model: string;
  readonly thinking: string;
  readonly guidance: string;
}

/** Route validation result. */
export interface RouteValidation {
  allowed: boolean;
  error?: string;
}

export function getAgentRoutes(): AgentRoute[] {
  const preset = activePreset();
  if (!preset) return [];

  const routes = preset.routes;
  if (!Array.isArray(routes) || routes.length === 0) return [];

  const seenIds = new Set<string>();
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (typeof r.model !== "string" || typeof r.thinking !== "string" || typeof r.guidance !== "string") {
      throw new Error(
        `Subagent preset "${getActiveSubagentPresetName()}" routes[${i}] is invalid: need model, thinking, and guidance strings`
      );
    }
    if (!THINKING_LEVELS.has(r.thinking)) {
      throw new Error(
        `Subagent preset "${getActiveSubagentPresetName()}" routes[${i}] has invalid thinking level "${r.thinking}"`
      );
    }
    if (r.id !== undefined) {
      if (typeof r.id !== "string" || r.id.length === 0) {
        throw new Error(`Subagent preset "${getActiveSubagentPresetName()}" routes[${i}].id must be a non-empty string`);
      }
      if (seenIds.has(r.id)) {
        throw new Error(`Subagent preset "${getActiveSubagentPresetName()}" has duplicate route id "${r.id}"`);
      }
      seenIds.add(r.id);
    }
  }

  return routes as AgentRoute[];
}

/**
 * Renders one route as a menu line. Ids act as stable lane names the model can
 * reason about ("spawn three recon children").
 */
function renderRoute(r: AgentRoute): string {
  return `${r.id ? `${r.id}: ` : ""}${r.model}:${r.thinking} — ${r.guidance}`;
}

export function validateRoute(model: string, thinking: string): RouteValidation {
  const routes = getAgentRoutes();
  if (routes.length === 0) return { allowed: true }; // no routes configured = unrestricted
  if (activePreset()?.offRoute === "allow") return { allowed: true }; // guidance-only mode

  const match = routes.find((r) => r.model === model && r.thinking === thinking);
  if (match) return { allowed: true };

  const formatted = routes.map((r) => `  ${renderRoute(r)}`).join("\n");
  return {
    allowed: false,
    error: `"${model}:${thinking}" is not in the active preset routes.\nAvailable routes:\n${formatted}`,
  };
}

/**
 * Shared child-model selection guidance derived from the active preset's
 * agent routes. Empty when no routes are configured (unrestricted).
 */
export function modelSelectionGuidelines(): string[] {
  const routes = getAgentRoutes();
  if (routes.length === 0) return [];
  return [
    "When choosing a model and thinking level for a delegated child, pick from the active preset routes:",
    ...routes.map(renderRoute),
    "If the user names a specific model or lane for delegated children, pass that route explicitly on every delegation call for that task; an explicit user pick overrides each tool's preset role.",
  ];
}

/** Tools whose model selection must reflect the live preset rather than startup state. */
const DYNAMIC_MODEL_TOOLS = new Set(["agent", "subagent_spawn", "workflow"]);

/**
 * Injects the active preset's child-model routes into the system prompt of
 * every turn where a dynamic-model delegation tool is armed. Registration-time
 * tool metadata cannot track mid-session `/subagent-preset` switches; this
 * per-turn patch can, because event.systemPrompt is rebuilt fresh each turn.
 */
export function registerDynamicRouteGuidance(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const armed = pi
      .getActiveTools()
      .some((name) => DYNAMIC_MODEL_TOOLS.has(name));
    if (!armed) return undefined;
    const lines = modelSelectionGuidelines();
    if (lines.length === 0) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Delegated child model routes (active subagent preset)\n${lines.join("\n")}`,
    };
  });
}

export function formatRouteGuidance(): string {
  const routes = getAgentRoutes();
  if (routes.length === 0) return "";
  return routes.map(renderRoute).join("\n");
}

/**
 * Resolves one route reference to a configured route. A reference matches a
 * route id first, then an exact provider/model string, so prose like "use
 * opencode-go/ox-alpha-free" lands on the same lane as its id.
 */
export function resolveRouteRef(ref: string): AgentRoute {
  const routes = getAgentRoutes();
  const route = routes.find((r) => r.id === ref) ?? routes.find((r) => r.model === ref);
  if (!route) {
    throw new Error(
      `Unknown route "${ref}".\nAvailable routes:\n${formatRouteGuidance() || "(no subagent preset routes are configured)"}`
    );
  }
  return route;
}

/** Extracts an optional non-empty string parameter as trimmed text. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Per-call model overrides for a delegated tool call. An explicit `route`
 * wins over everything else (the user's pick); dynamic-model tools otherwise
 * require their raw model/thinking pair.
 */
export function callOverrides(policy: DelegationPolicy, params: any): Pick<DelegationConfig, "model" | "thinking"> {
  const routeRef = optionalString(params?.route);
  if (routeRef) {
    const route = resolveRouteRef(routeRef);
    return { model: route.model, thinking: route.thinking };
  }
  if (!policy.dynamicModel) return {};
  if (!optionalString(params?.model) || !optionalString(params?.thinking)) {
    throw new Error("Provide either `route` or both `model` and `thinking`.");
  }
  if (!THINKING_LEVELS.has(params.thinking)) {
    throw new Error(`Invalid thinking level: ${params.thinking}`);
  }
  const v = validateRoute(params.model, params.thinking);
  if (!v.allowed) throw new Error(v.error);
  return { model: params.model, thinking: params.thinking };
}

export interface DelegationConfig {
  readonly name: string;
  /** Fallback model, used only when no subagent preset is active. An active preset resolves models through its routes. */
  readonly model: string;
  /** Fallback thinking level, used only when no subagent preset is active. */
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
  const ROUTE_PARAM = Type.Optional(Type.String({
    description: "Route id or provider/model from the active preset's routes; overrides this tool's preset role for this call",
  }));
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
    promptGuidelines: [
      ...policy.guidelines,
      "When the user names a specific model or lane for this delegation, pass it in `route` (route id or provider/model); an explicit user pick overrides the preset role.",
    ],
    parameters: policy.dynamicModel
      ? Type.Object({
          task: Type.String({ description: policy.parameter }),
          model: Type.Optional(Type.String({ description: "Exact provider/model id (required unless `route` is given)" })),
          thinking: Type.Optional(Type.String({ description: "Reasoning level: off, minimal, low, medium, high, xhigh, or max (required unless `route` is given)" })),
          route: ROUTE_PARAM,
        })
      : Type.Object({
          task: Type.String({ description: policy.parameter }),
          route: ROUTE_PARAM,
        }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const overrides = callOverrides(policy, params);
      const details = await run(params.task, ctx.cwd, signal, (details) => {
        onUpdate?.({
          content: [{ type: "text", text: details.output || details.activities.at(-1) || "(running…)" }],
          details,
        });
      }, overrides);
      return { content: [{ type: "text", text: details.output }], details };
    },

    renderCall(args, theme, context) {
      let base = (context.state.config as DelegationConfig | undefined) ?? resolveConfig();
      const routeRef = optionalString((args as any)?.route);
      if (routeRef) {
        try {
          const route = resolveRouteRef(routeRef);
          base = { ...base, model: route.model, thinking: route.thinking };
        } catch {
          // Keep the resolved default; renderCall must not throw on bad input.
        }
      }
      const config = policy.dynamicModel ? {
        ...base,
        ...(typeof (args as any).model === "string" ? { model: (args as any).model } : {}),
        ...(typeof (args as any).thinking === "string" ? { thinking: (args as any).thinking } : {}),
      } : base;
      context.state.config = config;
      return renderDelegationCall(config, args.task, context.expanded, theme);
    },

    renderResult(result, { expanded }, theme) {
      return renderDelegationResult(result.details as DelegationDetails | undefined, expanded, theme);
    },
  });

  return run;
}

