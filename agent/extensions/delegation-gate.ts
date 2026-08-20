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

function explicitlyRequestsWorkflow(text: string) {
  const request = /\b(?:invoke|run|use|start|launch|execute)\s+(?:an?\s+)?(?:multi-agent\s+)?workflow\b/i.exec(text);
  if (!request) return false;
  const before = text.slice(0, request.index);
  const clauseStart = Math.max(before.lastIndexOf("."), before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf("\n"));
  const clause = before.slice(clauseStart + 1);
  return !/\b(?:do not|don't|never|avoid)\b/i.test(clause);
}

/** Owns the one-run activation policy for every dormant delegation tool. */
export default function delegationGate(pi: ExtensionAPI) {
  let armed = false;
  const disable = () => pi.setActiveTools(pi.getActiveTools().filter((name) => !DELEGATION_TOOLS.has(name)));
  const enable = () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...DELEGATION_TOOLS])]);
    armed = true;
  };

  pi.on("session_start", disable);
  pi.on("agent_settled", () => {
    if (!armed) return;
    armed = false;
    disable();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return;
    const isDelegate = /^\/delegate(?:\s|$)/.test(event.text);
    const isWorkflow = /^\/workflow(?:\s|$)/.test(event.text);
    const naturalWorkflow = explicitlyRequestsWorkflow(event.text);
    if (!isDelegate && !isWorkflow && !naturalWorkflow) return;
    if (!ctx.isIdle()) {
      ctx.ui.notify("Agent is busy", "warning");
      return { action: "handled" };
    }
    if (naturalWorkflow && !isDelegate && !isWorkflow) {
      enable();
      // Preserve the user's explicit request while making the named tool available.
      return;
    }
    if (isWorkflow) {
      enable();
      // Let Pi expand the workflow prompt template after its tool is available.
      return { action: "continue" };
    }

    const task = event.text.replace(/^\/delegate\s*/, "").trim()
      || (ctx.hasUI ? (await ctx.ui.input("Delegate", "Task…"))?.trim() : undefined);
    if (!task) return { action: "handled" };

    enable();
    return {
      action: "transform",
      text: `Use delegation tools as appropriate to complete this task:\n\n${task}`,
    };
  });
}
