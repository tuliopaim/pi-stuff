import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const T3_FULL_ACCESS = "full-access";
export const OPTCHAT_BLOCK_MESSAGE =
  "OptChat delegation requires T3 Full access; individual subagent approvals are not supported.";
export const OPTCHAT_FORK_MESSAGE =
  "Fork and rollback are not supported for OptChat memory; start a new thread.";
export const OPTCHAT_SWITCH_MESSAGE =
  "Session switching outside this OptChat profile is not supported; start a new thread.";

const OPTCHAT_DELEGATION_TOOLS = new Set(["spawn", "tell"]);

export function isT3FullAccess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.T3_PI_RUNTIME_MODE === T3_FULL_ACCESS;
}

export function shouldBlockToolCall(
  mode: string | undefined,
  toolName: string,
  fullAccess = isT3FullAccess(),
): boolean {
  if (fullAccess) return false;
  // Only the T3 RPC parent has the CLI approval bridge. Every child/non-RPC mode fails closed.
  if (mode !== "rpc") return true;
  // The RPC parent keeps its normal T3 approvals, except for delegation itself.
  return OPTCHAT_DELEGATION_TOOLS.has(toolName);
}

export function isSessionWithinRoot(
  targetSessionFile: string | undefined,
  sessionRoot: string | undefined,
): boolean {
  if (typeof targetSessionFile !== "string" || typeof sessionRoot !== "string") return false;
  if (!targetSessionFile.trim() || !sessionRoot.trim()) return false;

  try {
    const root = realpathSync(resolve(sessionRoot));
    const target = realpathSync(resolve(targetSessionFile));
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return target === root || target.startsWith(prefix);
  } catch {
    // Missing, malformed, or unresolvable paths must not pass the isolation check.
    return false;
  }
}

export default function t3OptChatPolicy(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!shouldBlockToolCall(ctx.mode, event.toolName)) return;
    return { block: true, reason: OPTCHAT_BLOCK_MESSAGE };
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    ctx.ui.notify(OPTCHAT_FORK_MESSAGE, "warning");
    return { cancel: true };
  });

  pi.on("session_before_switch", async (event, ctx) => {
    if (event.reason !== "resume") return;
    if (isSessionWithinRoot(event.targetSessionFile, process.env.PI_CODING_AGENT_SESSION_DIR)) return;
    ctx.ui.notify(OPTCHAT_SWITCH_MESSAGE, "warning");
    return { cancel: true };
  });
}
