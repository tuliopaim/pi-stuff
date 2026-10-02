import type { Job, JobMetadata } from "./durable.ts";
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
