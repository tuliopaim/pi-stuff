import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatCompactTokens, formatContextUtilization } from "../shared/context-utilization.ts";
import type { SubagentSnapshot, SubagentUsage } from "./domain.ts";

type Theme = ExtensionContext["ui"]["theme"];

export function sanitizeTerminalText(text: string) {
  return text
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

function elapsed(snapshot: SubagentSnapshot, now = Date.now()) {
  const startedAt = Number.isFinite(snapshot.createdAt) ? snapshot.createdAt : now;
  const seconds = Math.max(0, Math.round(((snapshot.settledAt ?? now) - startedAt) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

function usageParts(usage: SubagentUsage) {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`${formatCompactTokens(usage.input)} in`);
  if (usage.output) parts.push(`${formatCompactTokens(usage.output)} out`);
  if (usage.cacheRead) parts.push(`R${formatCompactTokens(usage.cacheRead)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts;
}

export function formatSubagentUsage(snapshot: SubagentSnapshot, now = Date.now()) {
  const usage = snapshot.usage ?? {
    turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0,
  };
  const context = formatContextUtilization({
    tokens: usage.contextTokens,
    contextWindow: usage.contextWindow,
  });
  return [
    `${snapshot.model ?? "unknown"}:${snapshot.thinking ?? "?"}`,
    elapsed(snapshot, now),
    ...(context ? [`${context} ctx`] : []),
    ...usageParts(usage),
  ].join(" · ");
}

function currentActivity(snapshot: SubagentSnapshot) {
  const activity = snapshot.activities?.at(-1);
  if (activity) return `→ ${sanitizeTerminalText(activity)}`;
  const live = sanitizeTerminalText(snapshot.liveText ?? "").split("\n").filter(Boolean).at(-1)?.trim();
  if (live) return `↳ ${live}`;
  if (snapshot.liveThinking) return "… thinking";
  if (snapshot.status === "running") return "… starting";
  if (snapshot.error) return `✗ ${sanitizeTerminalText(snapshot.error)}`;
  return snapshot.status;
}

function aggregate(entries: readonly SubagentSnapshot[]) {
  const usage: SubagentUsage = {
    turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0,
  };
  for (const entry of entries) {
    if (!entry.usage) continue;
    usage.turns += entry.usage.turns;
    usage.input += entry.usage.input;
    usage.output += entry.usage.output;
    usage.cacheRead += entry.usage.cacheRead;
    usage.cacheWrite += entry.usage.cacheWrite;
    usage.cost += entry.usage.cost;
  }
  return usage;
}

function prioritized(entries: readonly SubagentSnapshot[]) {
  return [...entries].sort((a, b) => {
    if ((a.status === "running") !== (b.status === "running")) return a.status === "running" ? -1 : 1;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
}

export function renderSubagentMonitor(
  entries: readonly SubagentSnapshot[],
  width: number,
  theme: Theme,
  now = Date.now(),
) {
  const running = entries.filter((entry) => entry.status === "running").length;
  const done = entries.filter((entry) => entry.status === "done").length;
  const failed = entries.length - running - done;
  const counts = [
    running ? `${running} running` : "",
    done ? `${done} done` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean);
  const totals = usageParts(aggregate(entries));
  const header = `${theme.fg("accent", theme.bold("SUBAGENTS"))} ${theme.fg("dim", [...counts, ...totals].join(" · "))}`;
  const lines = [truncateToWidth(header, width)];
  const shown = prioritized(entries).slice(0, 4);
  for (const entry of shown) {
    const color = entry.status === "done" ? "success" : entry.status === "running" ? "warning" : "error";
    lines.push(truncateToWidth(
      `${theme.fg(color, "■")} ${theme.bold(sanitizeTerminalText(entry.title))} ${theme.fg("dim", `· ${entry.origin} · ${entry.id}`)}`,
      width,
    ));
    lines.push(truncateToWidth(theme.fg("dim", `  ${formatSubagentUsage(entry, now)}`), width));
    lines.push(truncateToWidth(theme.fg(entry.status === "running" ? "muted" : color, `  ${currentActivity(entry)}`), width));
  }
  if (entries.length > shown.length) lines.push(theme.fg("dim", `… ${entries.length - shown.length} more · /subagents to inspect`));
  else lines.push(theme.fg("dim", "/subagents to inspect, steer, or cancel"));
  return lines.map((line) => truncateToWidth(line, width));
}

export function formatWaitingSubagents(entries: readonly SubagentSnapshot[], now = Date.now()) {
  return entries.map((entry) => [
    `${entry.status === "running" ? "■" : entry.status === "done" ? "✓" : "✗"} ${entry.title} · ${entry.id}`,
    `  ${formatSubagentUsage(entry, now)}`,
    `  ${currentActivity(entry)}`,
  ].join("\n")).join("\n");
}
