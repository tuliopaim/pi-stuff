import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { renderDelegationMessage } from "./render.ts";
import {
  createDelegationDetails,
  DelegationAbortError,
  getActiveSubagentPresetName,
  getDelegationConfig,
  getSubagentPresetNames,
  registerDelegatedTool,
  setSubagentPreset,
  type DelegationDetails,
  type DelegationPolicy,
} from "./runtime.ts";

const workflow = readFileSync(
  resolve(homedir(), "dotfiles/skills/commit-work/SKILL.md"),
  "utf8",
);

const SCOUT: DelegationPolicy = {
  key: "scout",
  name: "Scout",
  model: "opencode-go/deepseek-v4-flash",
  thinking: "medium",
  timeoutMs: 5 * 60_000,
  tools: "read,grep,find,ls",
  description: "Delegate focused, read-only codebase reconnaissance to a cheaper model.",
  snippet: "Delegate focused codebase reconnaissance to a cheaper read-only model",
  guidelines: [
    "Use scout before broad exploration when locating the answer likely requires more than 2-3 files.",
    "Do not use scout for work answerable with one or two direct reads, after equivalent reconnaissance is already done, for implementation, or for decisions requiring your own judgment.",
    "Give scout one narrow, self-contained question and use it at most once per task unless the user explicitly requests broader investigation.",
    "After scout returns, read only its recommended targets and verify only claims that affect edits or important decisions.",
  ],
  parameter: "One narrow, self-contained reconnaissance question, including the evidence the parent needs",
  prompt: `You are a read-only codebase scout. Your job is to reduce the parent agent's context usage. Investigate one delegated question; do not implement, edit files, run builds, or run tests.

Return only this compact handoff:
## Answer
Direct answer in at most 3 bullets.

## Relevant flow
- symbol — path:line
- → caller or consumer — path:line
- → test, when relevant — path:line

## Parent should read
- At most 3 exact files or line ranges required for the next decision.

## Unknowns
- Only uncertainties that could change the implementation, or "None".

Rules:
- Stop when the delegated question is answered.
- Include at most 8 evidence references and 500 words.
- Prefer exact symbols, paths, and line numbers over prose.
- Trace definitions and callers when relevant.
- Do not include large code excerpts or general architecture commentary unless requested.`,
  maxLines: 200,
  maxBytes: 24 * 1024,
  emptyOutput: "(scout returned no output)",
  truncationMessage: "[Scout output truncated to 200 lines / 24KB]",
};

const REVIEW: DelegationPolicy = {
  key: "review",
  name: "Review",
  model: "openai-codex/gpt-5.6-sol",
  thinking: "high",
  timeoutMs: 15 * 60_000,
  tools: "read,grep,find,ls,bash",
  description: "Delegate focused, read-only code review to a high-reasoning model.",
  snippet: "Delegate focused code review to a high-reasoning model",
  guidelines: [
    "Use review only when the user explicitly requests it, or after a high-risk change where an independent fresh-context review is materially useful; do not invoke it automatically.",
    "Give review the exact scope: working tree, commit/range, or named files, plus intended behavior.",
    "Use review at most once per change unless new code is added after the review.",
    "Treat review findings as leads; verify each finding yourself before changing code or reporting it as fact.",
  ],
  parameter: "Review scope and intended behavior, including commit/range or files when known",
  prompt: `You are a read-only code reviewer. Review the delegated change or scope; do not edit files.

Return only this compact handoff:
## Findings
For each real issue, ordered by severity:
### [P0-P3] Short title
- Evidence: path:line
- Impact: what breaks and under which conditions
- Fix: smallest correct change

If there are no findings, write "No findings."

## Validation gaps
- Important behavior you could not verify, or "None".

## Verdict
One sentence stating whether the change is safe to merge.

Rules:
- Prioritize correctness, security, data loss, regressions, and missing validation.
- Review the actual diff and trace affected callers when relevant.
- Do not report style preferences, speculative concerns, or pre-existing issues unrelated to the change.
- Use shell only for read-only inspection such as git diff/status/show/log and rg/find.
- Do not run builds or tests unless the delegated task explicitly asks.
- Prefer exact file paths and line numbers over prose.
- Stay under 1,200 words.`,
  maxLines: 250,
  maxBytes: 32 * 1024,
  emptyOutput: "(review returned no output)",
  truncationMessage: "[Review output truncated to 250 lines / 32KB]",
};

const COMMIT: DelegationPolicy = {
  key: "commit",
  name: "Commit",
  model: "opencode-go/deepseek-v4-flash",
  thinking: "medium",
  timeoutMs: 15 * 60_000,
  tools: "read,grep,find,ls,bash",
  description: "Delegate completed-work analysis and intentional git commits to a specialized model.",
  snippet: "Delegate git commit creation to an isolated specialized child",
  guidelines: [
    "Use commit only when the user explicitly asks to commit completed work.",
    "Pass any requested scope or commit-splitting instructions in the task.",
    "Do not inspect, stage, or commit in the parent; the isolated commit agent owns the complete workflow.",
  ],
  parameter: "Optional commit scope, ticket context, or commit-splitting instructions",
  prompt: `You are an isolated git commit agent. Follow the injected commit-work workflow exactly. Inspect all changes before staging, keep unrelated work uncommitted, never expose secrets, never amend or force push, and report each created commit's SHA and message.\n\n${workflow}`,
  maxLines: 200,
  maxBytes: 24 * 1024,
  emptyOutput: "(commit agent returned no output)",
  truncationMessage: "[Commit output truncated to 200 lines / 24KB]",
};

export default function (pi: ExtensionAPI) {
  registerDelegatedTool(pi, SCOUT);
  registerDelegatedTool(pi, REVIEW);
  const runCommit = registerDelegatedTool(pi, COMMIT);

  pi.registerMessageRenderer<DelegationDetails>("commit-result", (message, { expanded }, theme) =>
    message.details ? renderDelegationMessage("Commit", message.details, expanded, theme) : undefined,
  );

  pi.registerCommand("commit", {
    description: "Create intentional commits with the isolated commit agent",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy", "warning");
        return;
      }
      const task = args.trim() || "Analyze all completed work and create the appropriate commit or commits.";
      const controller = new AbortController();
      let latest: DelegationDetails | undefined;

      const showWidget = (details: DelegationDetails) => {
        latest = details;
        ctx.ui.setWidget("commit", (_tui, theme) => renderDelegationMessage("Commit", details, false, theme));
      };
      // The command path gets no harness-supplied signal, so escape is wired up by hand.
      const stopListening = ctx.ui.onTerminalInput?.((data) => {
        if (!matchesKey(data, Key.escape)) return undefined;
        controller.abort();
        return { consume: true };
      });

      try {
        const details = await runCommit(task, ctx.cwd, controller.signal, showWidget);
        pi.sendMessage({ customType: "commit-result", content: details.output, display: true, details });
      } catch (error) {
        const cancelled = error instanceof DelegationAbortError;
        const message = error instanceof Error ? error.message : String(error);
        const details: DelegationDetails = {
          ...(latest ?? createDelegationDetails(getDelegationConfig(COMMIT.key, COMMIT), task)),
          status: cancelled ? "cancelled" : "failed",
          error: message,
        };
        pi.sendMessage({
          customType: "commit-result",
          content: details.output || `Commit agent ${cancelled ? "cancelled" : "failed"}: ${message}`,
          display: true,
          details,
        });
        if (!cancelled) ctx.ui.notify(message, "error");
      } finally {
        stopListening?.();
        ctx.ui.setWidget("commit", undefined);
      }
    },
  });

  pi.registerCommand("subagent-preset", {
    description: "Switch the model preset used by scout, review, and commit",
    handler: async (args, ctx) => {
      const names = getSubagentPresetNames();
      if (names.length === 0) {
        ctx.ui.notify("No subagent presets configured", "warning");
        return;
      }

      const requested = args.trim();
      const name = requested || await ctx.ui.select(
        `Subagent preset (current: ${getActiveSubagentPresetName() ?? "none"})`,
        names,
      );
      if (!name) return;
      if (!names.includes(name)) {
        ctx.ui.notify(`Unknown subagent preset "${name}". Available: ${names.join(", ")}`, "error");
        return;
      }

      setSubagentPreset(name);
      ctx.ui.notify(`Subagent preset "${name}" activated`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const active = getActiveSubagentPresetName();
    if (active && !getSubagentPresetNames().includes(active)) {
      ctx.ui.notify(`Unknown subagent preset "${active}"`, "warning");
    }
  });
}
