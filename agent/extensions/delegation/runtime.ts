import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgents } from "./config.ts";
export { getActiveSubagentPresetName, getSubagentPresetNames, setSubagentPreset } from "./config.ts";

// Workflows still select explicit model/effort pairs. Their choices come from the same named agents.
export function getAgentRoutes() {
  return Object.entries(getAgents()).map(([id, agent]) => ({ id, model: agent.model, thinking: agent.thinking, guidance: agent.description }));
}
export function formatRouteGuidance() {
  return getAgentRoutes().map((r) => `${r.id}: ${r.model}:${r.thinking} - ${r.guidance}`).join("\n");
}
export function validateRoute(model: string, thinking: string, provider?: string): { allowed: boolean; error?: string } {
  if (provider) model = `${provider}/${model}`;
  if (getAgentRoutes().some((r) => r.model === model && r.thinking === thinking)) return { allowed: true };
  return { allowed: false, error: `${model}:${thinking} is not a configured agent model.\n${formatRouteGuidance()}` };
}
export function registerDynamicRouteGuidance(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    if (!pi.getActiveTools().some((name) => ["agent", "scout", "review", "commit", "workflow"].includes(name))) return;
    return { systemPrompt: `${event.systemPrompt}\n\n## Named subagents\n${formatRouteGuidance()}\nUse agent with no agent name for useful handoffs that do not fit a specialist. Delegate only self-contained work; do not overlap edits in the same working tree. Explicit user model picks go in route.` };
  });
}
