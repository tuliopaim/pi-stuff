import type { TranscriptEntry } from "../workflows/model.ts";

export type SubagentOrigin = "scout" | "review" | "commit" | "agent" | "generic" | "btw";
export type SubagentStatus = "running" | "done" | "cancelled" | "failed" | "interrupted";

export interface SubagentUsage {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  contextWindow?: number;
}

export interface SubagentSnapshot {
  id: string;
  origin: SubagentOrigin;
  title: string;
  task: string;
  cwd: string;
  model: string;
  thinking: string;
  status: SubagentStatus;
  mutating: boolean;
  createdAt: number;
  settledAt?: number;
  restored?: boolean;
  sessionFile?: string;
  error?: string;
  output: string;
  liveText: string;
  liveThinking: string;
  activities: string[];
  queued: Array<{ text: string; kind: "steer" | "follow-up" }>;
  transcript: TranscriptEntry[];
  usage: SubagentUsage;
  consumed: boolean;
}

export function emptySubagentUsage(): SubagentUsage {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

