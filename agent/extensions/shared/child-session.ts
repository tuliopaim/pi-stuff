import * as path from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ChildResourceOptions {
  cwd: string;
  projectTrusted: boolean;
  appendSystemPrompt?: string[];
  agentDir?: string;
  noExtensions?: boolean;
  noSkills?: boolean;
  additionalSkillPaths?: string[];
  additionalExtensionPaths?: string[];
  contextFiles?: Array<{ path: string; content: string }>;
  noPromptTemplates?: boolean;
}

/** Load normal global/package resources and trust-gated project resources. */
export async function createChildResources(options: ChildResourceOptions) {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    ...(options.noExtensions ? { noExtensions: true } : {}),
    ...(options.noSkills ? { noSkills: true } : {}),
    ...(options.additionalSkillPaths ? { additionalSkillPaths: options.additionalSkillPaths } : {}),
    ...(options.additionalExtensionPaths ? { additionalExtensionPaths: options.additionalExtensionPaths } : {}),
    ...(options.noPromptTemplates ? { noPromptTemplates: true } : {}),
    ...(options.contextFiles ? {
      noContextFiles: true,
      agentsFilesOverride: () => ({ agentsFiles: options.contextFiles!.map((file) => ({ ...file })) }),
    } : {}),
    ...(options.appendSystemPrompt
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
  });
  await loader.reload();
  return { loader, settingsManager };
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function resolveStandaloneChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
  agentDir?: string;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(options.agentDir ?? getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}
