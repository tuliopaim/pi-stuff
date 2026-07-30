import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getActiveSubagentPresetName,
  getAgentRoutes,
  getDelegationConfig,
  formatRouteGuidance,
  setSubagentPreset,
  validateRoute,
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

test("agent routes parse correctly from active preset", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-routes-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPreset = process.env.PI_SUBAGENT_PRESET;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SUBAGENT_PRESET;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      subagents: {
        preset: "test",
        presets: {
          test: {
            agent: {
              routes: [
                { model: "p/a", thinking: "medium", guidance: "recon" },
                { model: "p/b", thinking: "high", guidance: "impl" },
                { model: "p/c", thinking: "high", guidance: "review" },
              ],
            },
          },
        },
      },
    }));
    setSubagentPreset(undefined);

    const routes = getAgentRoutes();
    assert.equal(routes.length, 3);
    assert.equal(routes[0].model, "p/a");
    assert.equal(routes[0].thinking, "medium");
    assert.equal(routes[0].guidance, "recon");
    assert.equal(routes[2].model, "p/c");
    assert.equal(routes[2].thinking, "high");

    const guidance = formatRouteGuidance();
    assert.match(guidance, /p\/a:medium — recon/);
    assert.match(guidance, /p\/b:high — impl/);
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPreset === undefined) delete process.env.PI_SUBAGENT_PRESET;
    else process.env.PI_SUBAGENT_PRESET = previousPreset;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("allowed route validates successfully", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-route-allow-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      subagents: {
        preset: "x",
        presets: { x: { agent: { routes: [{ model: "p/a", thinking: "medium", guidance: "test" }] } } },
      },
    }));
    setSubagentPreset(undefined);

    const result = validateRoute("p/a", "medium");
    assert.equal(result.allowed, true);
    assert.equal(result.error, undefined);
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("disallowed route is rejected with available routes listed", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-route-deny-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      subagents: {
        preset: "x",
        presets: { x: { agent: { routes: [{ model: "p/a", thinking: "medium", guidance: "recon" }] } } },
      },
    }));
    setSubagentPreset(undefined);

    const result = validateRoute("p/b", "high");
    assert.equal(result.allowed, false);
    assert.ok(result.error);
    assert.match(result.error!, /not in the active preset routes/);
    assert.match(result.error!, /p\/a:medium — recon/);
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("presets without agent.routes are unrestricted", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-route-none-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      subagents: { preset: "x", presets: { x: { scout: { model: "p/s", thinking: "medium" } } } },
    }));
    setSubagentPreset(undefined);

    assert.equal(getAgentRoutes().length, 0);
    assert.equal(formatRouteGuidance(), "");
    const result = validateRoute("anything/goes", "high");
    assert.equal(result.allowed, true);
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("malformed route entry throws", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-route-bad-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      subagents: {
        preset: "x",
        presets: { x: { agent: { routes: [{ model: "p/a", thinking: "bogus", guidance: "bad" }] } } },
      },
    }));
    setSubagentPreset(undefined);

    assert.throws(() => getAgentRoutes(), /invalid thinking level/);
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("PI_SUBAGENT_PRESET=copilot selects copilot routes, /subagent-preset personal overrides", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-route-override-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPreset = process.env.PI_SUBAGENT_PRESET;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SUBAGENT_PRESET = "copilot";
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      subagents: {
        preset: "personal",
        presets: {
          personal: { agent: { routes: [{ model: "p/a", thinking: "medium", guidance: "personal" }] } },
          copilot: { agent: { routes: [{ model: "c/a", thinking: "high", guidance: "copilot" }] } },
        },
      },
    }));
    setSubagentPreset(undefined);

    // env var takes effect
    assert.equal(getActiveSubagentPresetName(), "copilot");
    const copilotRoutes = getAgentRoutes();
    assert.equal(copilotRoutes.length, 1);
    assert.equal(copilotRoutes[0].model, "c/a");

    // session override beats env
    setSubagentPreset("personal");
    assert.equal(getActiveSubagentPresetName(), "personal");
    const personalRoutes = getAgentRoutes();
    assert.equal(personalRoutes.length, 1);
    assert.equal(personalRoutes[0].model, "p/a");

    // allowed in personal, denied in copilot
    const v = validateRoute("p/a", "medium");
    assert.equal(v.allowed, true);
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousPreset === undefined) delete process.env.PI_SUBAGENT_PRESET;
    else process.env.PI_SUBAGENT_PRESET = previousPreset;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
