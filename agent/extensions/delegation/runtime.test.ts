import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getActiveSubagentPresetName,
  getDelegationConfig,
  setSubagentPreset,
  type DelegationConfig,
} from "./runtime.ts";

const CONFIG: DelegationConfig = {
  name: "Scout",
  model: "opencode-go/deepseek-v4-flash",
  thinking: "medium",
  timeoutMs: 5 * 60_000,
  tools: "read,grep,find,ls",
  description: "Scout",
  snippet: "Scout",
  guidelines: [],
  parameter: "Task",
  prompt: "Scout prompt",
};

test("subagent presets resolve from settings, environment, then session override", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-presets-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPreset = process.env.PI_SUBAGENT_PRESET;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SUBAGENT_PRESET;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      subagents: {
        preset: "personal",
        presets: {
          personal: { scout: { model: "personal/scout", thinking: "low", skills: ["~/skills/recon"] } },
          copilot: { scout: { model: "github-copilot/scout", thinking: "medium" } },
        },
      },
    }));

    setSubagentPreset(undefined);
    assert.equal(getActiveSubagentPresetName(), "personal");
    assert.equal(getDelegationConfig("scout", CONFIG).model, "personal/scout");
    assert.deepEqual(getDelegationConfig("scout", CONFIG).skills, ["~/skills/recon"]);

    process.env.PI_SUBAGENT_PRESET = "copilot";
    assert.equal(getDelegationConfig("scout", CONFIG).model, "github-copilot/scout");

    setSubagentPreset("personal");
    assert.equal(getDelegationConfig("scout", CONFIG).model, "personal/scout");
    assert.throws(() => getDelegationConfig("review", CONFIG), /no valid "review" configuration/);
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPreset === undefined) delete process.env.PI_SUBAGENT_PRESET;
    else process.env.PI_SUBAGENT_PRESET = previousPreset;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
