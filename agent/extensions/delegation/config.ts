import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeFileAtomic } from "../workflows/serialization.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export type AgentConfig = {
  model: string;
  thinking: typeof THINKING_LEVELS[number];
  description: string;
  instructions: string;
  tools: string[];
  skills?: string[];
  timeoutMinutes?: number;
};
type Config = { agents: Record<string, AgentConfig>; preset?: string; presets?: Record<string, Record<string, Partial<AgentConfig>>> };
let sessionPreset: string | undefined;

export const configPath = () => join(getAgentDir(), "agents.json");
const defaultsPath = fileURLToPath(new URL("../../agents.json", import.meta.url));

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfig(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!object(value) || Object.keys(value).some((key) => !["agents", "preset", "presets"].includes(key)) || (value.agents !== undefined && !object(value.agents)) ||
      (value.presets !== undefined && !object(value.presets)) ||
      (value.preset !== undefined && typeof value.preset !== "string")) throw new Error(`Invalid agent configuration: ${path}`);
  return value;
}

function mergedConfig(): Config {
  const defaults = readConfig(defaultsPath) as Config;
  const local = configPath() === defaultsPath ? {} : readConfig(configPath());
  const agents: Record<string, AgentConfig> = { ...defaults.agents, default: { ...defaults.agents.default, ...local.agents?.default } };
  for (const [name, config] of Object.entries(local.agents ?? {})) {
    if (!object(config) || Object.keys(config).some((key) => !["model", "thinking", "description", "instructions", "tools", "skills", "timeoutMinutes"].includes(key))) throw new Error(`Invalid agent "${name}"`);
    agents[name] = { ...(agents[name] ?? agents.default), ...config };
  }
  const presets = { ...defaults.presets };
  for (const [name, overrides] of Object.entries(local.presets ?? {})) {
    if (!object(overrides)) throw new Error(`Invalid agent preset "${name}"`);
    presets[name] = { ...presets[name], ...overrides };
  }
  return { agents, presets, preset: local.preset ?? defaults.preset };
}

export function getActiveSubagentPresetName() {
  return sessionPreset ?? (process.env.PI_SUBAGENT_PRESET?.trim() || undefined) ?? mergedConfig().preset;
}
export function getSubagentPresetNames() { return Object.keys(mergedConfig().presets ?? {}); }
export function setSubagentPreset(name: string | undefined) {
  if (name !== undefined && !getSubagentPresetNames().includes(name)) throw new Error(`Unknown agent preset "${name}"`);
  sessionPreset = name;
}

export function getAgents(): Record<string, AgentConfig> {
  const config = mergedConfig();
  const preset = getActiveSubagentPresetName();
  if (preset && !Object.hasOwn(config.presets ?? {}, preset)) throw new Error(`Unknown agent preset "${preset}"`);
  const agents: Record<string, AgentConfig> = Object.create(null);
  if (preset) for (const name of Object.keys(config.presets?.[preset] ?? {})) {
    if (!Object.hasOwn(config.agents, name)) throw new Error(`Preset "${preset}" refers to unknown agent "${name}"`);
  }
  for (const [name, base] of Object.entries(config.agents)) {
    const override = preset ? config.presets?.[preset]?.[name] : undefined;
    if (override !== undefined && (!object(override) || Object.keys(override).some((key) => !["model", "thinking"].includes(key)))) throw new Error(`Invalid preset override for "${name}"`);
    const agent = { ...base, ...override };
    if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof agent.model !== "string" || !/^[^/\s]+\/\S+$/.test(agent.model) ||
        !THINKING_LEVELS.includes(agent.thinking) || typeof agent.description !== "string" || typeof agent.instructions !== "string" ||
        !Array.isArray(agent.tools) || agent.tools.some((tool) => !TOOL_NAMES.includes(tool as any)) ||
        (agent.skills !== undefined && (!Array.isArray(agent.skills) || agent.skills.some((skill) => typeof skill !== "string"))) ||
        (agent.timeoutMinutes !== undefined && (!Number.isFinite(agent.timeoutMinutes) || agent.timeoutMinutes <= 0 || agent.timeoutMinutes > 120))) {
      throw new Error(`Invalid configuration for agent "${name}" in ${configPath()}`);
    }
    agents[name] = agent;
    if (preset === "copilot" && !agent.model.startsWith("github-copilot/")) throw new Error(`The copilot preset only permits github-copilot models; check agent "${name}".`);
  }
  return agents;
}

export function resolveAgent(name = "default", route?: string): AgentConfig {
  const agents = getAgents();
  if (!Object.hasOwn(agents, name)) throw new Error(`Unknown agent "${name}". Available: ${Object.keys(agents).join(", ")}`);
  if (!route) return agents[name];
  const aliases: Record<string, string> = { recon: "explore", deep: "review", mechanical: "commit", implement: "default", integrate: "default", hard: "default", fast: "explore" };
  const selected = agents[route] ?? agents[aliases[route]];
  if (selected) return { ...agents[name], model: selected.model, thinking: selected.thinking };
  const match = /^([^/\s]+\/\S+?)(?::(off|minimal|low|medium|high|xhigh|max))?$/.exec(route);
  if (!match) throw new Error(`Unknown agent or model "${route}". Use an agent name or provider/model[:thinking].`);
  // A workplace preset must never silently send code to another provider.
  if (getActiveSubagentPresetName() === "copilot" && !match[1].startsWith("github-copilot/")) throw new Error("The copilot preset only permits github-copilot models.");
  return { ...agents[name], model: match[1], thinking: (match[2] as AgentConfig["thinking"]) ?? agents[name].thinking };
}

export function saveAgentModel(name: string, model: string, thinking: AgentConfig["thinking"]) {
  resolveAgent(name);
  if (!/^[^/\s]+\/\S+$/.test(model) || !THINKING_LEVELS.includes(thinking)) throw new Error("Invalid model or thinking level");
  if (getActiveSubagentPresetName() === "copilot" && !model.startsWith("github-copilot/")) throw new Error("The copilot preset only permits github-copilot models.");
  const local = readConfig(configPath());
  const preset = getActiveSubagentPresetName();
  if (preset) {
    local.presets ??= {};
    local.presets[preset] ??= {};
    local.presets[preset][name] = { ...local.presets[preset][name], model, thinking };
  } else {
    local.agents ??= {};
    local.agents[name] = { ...local.agents[name], model, thinking };
  }
  writeFileAtomic(configPath(), JSON.stringify(local, null, 2) + "\n");
}
