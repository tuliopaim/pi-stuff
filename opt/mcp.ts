import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createMcpExtension, getAgentDir, type LoadedMcpConfig, type McpServerConfig } from "@earendil-works/pi-coding-agent";

/** Normal OptChat only. Never merge trusted project or normal-profile MCP servers. */
export function loadOptchatMcpConfig(agentDir = getAgentDir()): LoadedMcpConfig {
  const source = join(agentDir, "mcp.json");
  try {
    const config = JSON.parse(readFileSync(source, "utf8"));
    const work = resolve(agentDir) === join(homedir(), ".pi-opt-work", "agent");
    const server = work ? config.mcpServers?.["work-db"] : undefined;
    return {
      servers: server ? [{ name: "work-db", config: server as McpServerConfig, source, scope: "global" }] : [],
      errors: [],
    };
  } catch {
    // Parser errors may include sensitive config values.
    return { servers: [], errors: ["Cannot read isolated OptChat MCP configuration"] };
  }
}

export default createMcpExtension({ loadConfig: () => loadOptchatMcpConfig() });
