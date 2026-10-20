import type { Job, JobMetadata } from "./durable.ts";
import { homedir } from "node:os";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatCompactTokens, formatContextUtilization } from "../shared/context-utilization.ts";

// Strip terminal controls before displaying model output or tool arguments.
export function terminalText(text: string) {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "").replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function elapsed(startedAt: number, now = Date.now()) {
  if (!Number.isFinite(startedAt)) return "-";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function toolSummary(name: string, args: Record<string, unknown>) {
  const detail = ["path", "query", "pattern", "command"].map((key) => args[key]).find((value) => typeof value === "string");
  return terminalText(`${name}${detail ? `  ${detail}` : ""}`).replace(/\s+/g, " ").slice(0, 240);
}

export function jobTitle(job: Job) {
  return terminalText(`${job.name ?? job.agent} · ${job.title ?? job.task}`).replace(/\s+/g, " ");
}

export const activeJob = (job: Job) => job.status === "running" || job.status === "stalled";
export const pendingJob = (job: Job) => activeJob(job) || job.status === "waiting";
export const jobColor = (job: Job) => job.status === "done" ? "success" : pendingJob(job) ? "warning" : "error";

export function usageText(info: Partial<Pick<JobMetadata, "usage" | "contextUsage">> = {}) {
  const usage = info.usage;
  const context = formatContextUtilization(info.contextUsage ?? {});
  return [context && `${context} ctx`, usage && `↑${formatCompactTokens(usage.input ?? 0)} ↓${formatCompactTokens(usage.output ?? 0)}`,
    usage?.cacheRead && `R${formatCompactTokens(usage.cacheRead)}`, usage && `$${(usage.cost?.total ?? 0).toFixed(4)}`].filter(Boolean).join(" · ");
}

export function jobSummary(job: Job, info?: Partial<Pick<JobMetadata, "usage" | "contextUsage">>) {
  return [`${job.model}:${job.thinking}`, elapsed(job.startedAt, job.finishedAt ?? Date.now()), usageText(info)].filter(Boolean).join(" · ");
}

export function jobActivity(job: Job, preview = "") {
  if (job.question) return terminalText(`? ${job.question.text}`).replace(/\s+/g, " ");
  if (job.status === "stalled") return `Stalled · last activity ${elapsed(job.lastActivityAt ?? job.startedAt)} ago`;
  return terminalText(job.error || preview.split("\n").at(-1) || job.status).replace(/\s+/g, " ");
}

type Theme = { fg: (color: any, text: string) => string; bold?: (text: string) => string };
export const STATUS_ICONS: Record<string, string> = { running: "●", waiting: "?", stalled: "◌", done: "✓", failed: "✗", cancelled: "–" };
export const shortPaths = (text: string) => text.split(homedir()).join("~");

export function statusCounts(jobs: Job[], theme: Theme) {
  return ["running", "waiting", "stalled", "done", "failed", "cancelled"].flatMap((status) => {
    const matching = jobs.filter((job) => job.status === status);
    return matching.length ? [theme.fg(jobColor(matching[0]), `${STATUS_ICONS[status]} ${matching.length} ${status}`)] : [];
  }).join(theme.fg("dim", " · "));
}

export const statusLabel = (job: Job) => job.status === "done" ? "Completed" : job.status[0].toUpperCase() + job.status.slice(1);

// Puts `right` flush against the right edge, dropping it when the line is too narrow.
export function spread(left: string, right: string, width: number) {
  const available = width - visibleWidth(right) - 2;
  if (available < 8) return truncateToWidth(left, width);
  const text = truncateToWidth(left, available);
  return text + " ".repeat(width - visibleWidth(text) - visibleWidth(right)) + right;
}

export function framed(body: Component, theme: Theme, borderColor = "borderMuted"): Component {
  return {
    invalidate() { body.invalidate(); },
    render(width) {
      if (width < 6) return body.render(width).map((line) => truncateToWidth(line, width));
      const inner = width - 4;
      const border = (text: string) => theme.fg(borderColor, text);
      return [
        border(`╭${"─".repeat(width - 2)}╮`),
        ...body.render(inner).map((line) => {
          const text = truncateToWidth(line, inner);
          return border("│") + " " + text + " ".repeat(inner - visibleWidth(text) + 1) + border("│");
        }),
        border(`╰${"─".repeat(width - 2)}╯`),
      ];
    },
  };
}
