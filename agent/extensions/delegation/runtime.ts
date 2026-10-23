import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgents } from "./config.ts";
export { getActiveSubagentPresetName, getSubagentPresetNames, setSubagentPreset } from "./config.ts";

export function registerDynamicRouteGuidance(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const { sections, selectedTools } = event.systemPromptOptions;
    if (!selectedTools.some((name) => ["agent", "scout", "review", "commit"].includes(name))) {
      delete sections.named_subagents;
      return;
    }
    // Named sections append native transcript updates instead of replacing the cached prefix.
    sections.named_subagents = `${Object.entries(getAgents()).map(([name, agent]) => `${name}: ${agent.model}:${agent.thinking} - ${agent.description}`).join("\n")}\nUse agent with no agent name for useful handoffs that do not fit a specialist. Delegate only self-contained work; do not overlap edits in the same working tree. Explicit user model picks go in route.`;
  });
}
