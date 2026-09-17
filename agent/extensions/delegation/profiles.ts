import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, DefaultResourceLoader, parseFrontmatter, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SubagentSessionMode } from "./domain.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SESSION_MODES = new Set<SubagentSessionMode>(["standalone", "lineage-only", "fork"]);
const MAX_TIMEOUT_MS = 30 * 60_000;

export interface SubagentProfile {
  name: string;
  description: string;
  prompt: string;
  path: string;
  source: "global" | "project";
  route?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  skills?: string[];
  mutating: boolean;
  timeoutMs: number;
  inheritResources: boolean;
  sessionMode: SubagentSessionMode;
  cwd: string;
}

export interface ProfileDiscovery {
  profiles: SubagentProfile[];
  errors: Array<{ path: string; error: string }>;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function list(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a comma-separated string.`);
  return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 64);
}

function duration(value: unknown) {
  if (value === undefined) return 30 * 60_000;
  if (typeof value !== "string") throw new Error("timeout must use 30s, 10m, or 1h syntax.");
  const match = /^(\d+)(s|m|h)$/.exec(value.trim());
  if (!match) throw new Error("timeout must use 30s, 10m, or 1h syntax.");
  const multiplier = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 60 * 60_000;
  const milliseconds = Number(match[1]) * multiplier;
  if (milliseconds < 1_000 || milliseconds > MAX_TIMEOUT_MS) throw new Error("timeout must be between 1s and 30m.");
  return milliseconds;
}

function parseProfile(file: string, source: SubagentProfile["source"], parentCwd: string): SubagentProfile {
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
  const name = text(frontmatter.name);
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("name is required and must be a lowercase handle.");
  const model = text(frontmatter.model);
  const thinking = text(frontmatter.thinking);
  if (Boolean(model) !== Boolean(thinking)) throw new Error("model and thinking must be set together.");
  if (thinking && !THINKING_LEVELS.has(thinking)) throw new Error(`Invalid thinking level: ${thinking}.`);
  const route = text(frontmatter.route);
  if (route && model) throw new Error("route cannot be combined with model and thinking.");
  const sessionMode = (text(frontmatter["session-mode"]) ?? "standalone") as SubagentSessionMode;
  if (!SESSION_MODES.has(sessionMode)) throw new Error(`Invalid session-mode: ${sessionMode}.`);
  const prompt = body.trim();
  if (!prompt) throw new Error("Profile Markdown body must not be empty.");
  for (const field of ["mutating", "inherit-resources"] as const) {
    if (frontmatter[field] !== undefined && typeof frontmatter[field] !== "boolean") throw new Error(`${field} must be true or false.`);
  }
  const configuredCwd = text(frontmatter.cwd);
  return {
    name,
    description: text(frontmatter.description) ?? "",
    prompt: prompt.slice(0, 16 * 1024),
    path: file,
    source,
    route,
    model,
    thinking,
    tools: list(frontmatter.tools, "tools")?.join(","),
    skills: list(frontmatter.skills, "skills"),
    mutating: frontmatter.mutating === undefined ? true : frontmatter.mutating === true,
    timeoutMs: duration(frontmatter.timeout),
    inheritResources: frontmatter["inherit-resources"] === true,
    sessionMode,
    cwd: configuredCwd ? path.resolve(parentCwd, configuredCwd) : parentCwd,
  };
}

function markdownFiles(directory: string) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(directory, entry.name)).sort();
  } catch { return []; }
}

export function discoverSubagentProfiles(options: { agentDir: string; cwd: string; projectTrusted: boolean }): ProfileDiscovery {
  const profiles = new Map<string, SubagentProfile>();
  const errors: ProfileDiscovery["errors"] = [];
  const sources: Array<{ directory: string; source: SubagentProfile["source"] }> = [
    { directory: path.join(options.agentDir, "agents"), source: "global" },
    ...(options.projectTrusted ? [{ directory: path.join(options.cwd, CONFIG_DIR_NAME, "agents"), source: "project" as const }] : []),
  ];
  for (const source of sources) {
    for (const file of markdownFiles(source.directory)) {
      try {
        const profile = parseProfile(file, source.source, options.cwd);
        const existing = profiles.get(profile.name);
        if (existing?.source === profile.source) {
          errors.push({ path: file, error: `Duplicate profile name "${profile.name}" in ${profile.source} profiles.` });
          continue;
        }
        profiles.set(profile.name, profile);
      } catch (error) {
        errors.push({ path: file, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export async function resolveProfileSkillPaths(profile: SubagentProfile, options: { agentDir: string; cwd: string; projectTrusted: boolean }) {
  if (!profile.skills?.length) return undefined;
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: options.projectTrusted });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd, agentDir: options.agentDir, settingsManager,
    noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const available = loader.getSkills().skills;
  const paths = profile.skills.map((name) => {
    const skill = available.find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Unknown skill "${name}" in profile "${profile.name}".`);
    return skill.filePath;
  });
  return [...new Set(paths)];
}
