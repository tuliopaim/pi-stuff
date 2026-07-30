import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DELEGATION_TOOLS = new Set([
  "agent",
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
]);

export default function delegate(pi: ExtensionAPI) {
  let armed = false;
  const disable = () => pi.setActiveTools(pi.getActiveTools().filter((name) => !DELEGATION_TOOLS.has(name)));

  pi.on("session_start", disable);
  pi.on("agent_settled", () => {
    if (!armed) return;
    armed = false;
    disable();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !event.text.match(/^\/delegate(?:\s|$)/)) return;
    if (!ctx.isIdle()) {
      ctx.ui.notify("Agent is busy", "warning");
      return { action: "handled" };
    }
    const task = event.text.replace(/^\/delegate\s*/, "").trim()
      || (ctx.hasUI ? (await ctx.ui.input("Delegate", "Task…"))?.trim() : undefined);
    if (!task) return { action: "handled" };

    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...DELEGATION_TOOLS])]);
    armed = true;
    return {
      action: "transform",
      text: `Use delegation tools as appropriate to complete this task:\n\n${task}`,
    };
  });
}
