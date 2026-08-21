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
  modelSelectionGuidelines,
  registerDynamicRouteGuidance,
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
          personal: {
            routes: [{ id: "recon", model: "personal/scout", thinking: "low", guidance: "reconnaissance" }],
            roles: { scout: "recon" },
            roleSkills: { scout: ["~/skills/recon"] },
          },
          copilot: {
            routes: [{ id: "recon", model: "github-copilot/scout", thinking: "medium", guidance: "reconnaissance" }],
            roles: { scout: "recon" },
          },
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
    assert.throws(() => getDelegationConfig("review", CONFIG), /no "review" role route/);
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
            routes: [
              { id: "recon", model: "p/a", thinking: "medium", guidance: "recon" },
              { id: "impl", model: "p/b", thinking: "high", guidance: "impl" },
              { id: "rev", model: "p/c", thinking: "high", guidance: "review" },
            ],
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

    const selection = modelSelectionGuidelines();
    assert.equal(selection.length, routes.length + 1);
    assert.match(selection[0], /active preset routes/);
    assert.ok(selection.slice(1).some((line) => /recon: p\/a:medium/.test(line)));
    assert.ok(selection.slice(1).some((line) => /rev: p\/c:high/.test(line)));

    let handler: ((event: any, ctx: any) => any) | undefined;
    const fakePi: any = {
      getActiveTools: () => ["workflow"],
      on: (_event: string, fn: any) => { handler = fn; },
    };
    registerDynamicRouteGuidance(fakePi);
    assert.ok(handler, "hook registered");
    const event = { type: "before_agent_start", prompt: "", systemPrompt: "BASE" };
    const patched = handler!(event, {});
    assert.match(patched.systemPrompt, /^BASE/);
    assert.match(patched.systemPrompt, /Delegated child model routes/);
    assert.match(patched.systemPrompt, /recon: p\/a:medium/);

    fakePi.getActiveTools = () => ["read", "bash"];
    assert.equal(handler!(event, {}), undefined);
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
        presets: { x: { routes: [{ id: "only", model: "p/a", thinking: "medium", guidance: "test" }] } },
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
        presets: { x: { routes: [{ id: "recon", model: "p/a", thinking: "medium", guidance: "recon" }] } },
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

test("offRoute allow accepts any model while keeping guidance injected", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-route-offroute-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      subagents: {
        preset: "x",
        presets: {
          x: {
            offRoute: "allow",
            routes: [{ id: "only", model: "p/a", thinking: "medium", guidance: "test" }],
          },
        },
      },
    }));
    setSubagentPreset(undefined);

    assert.notEqual(validateRoute("anything/goes", "max").allowed, false);
    // Guidance is still derived from routes.
    assert.match(modelSelectionGuidelines()[1], /only: p\/a:medium/);
  } finally {
    setSubagentPreset(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("shared.roleSkills applies when the preset does not override them", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-shared-skills-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      subagents: {
        shared: { roleSkills: { review: ["*"] } },
        preset: "x",
        presets: {
          x: {
            routes: [{ id: "deep", model: "p/r", thinking: "high", guidance: "review" }],
            roles: { review: "deep" },
          },
        },
      },
    }));
    setSubagentPreset(undefined);

    const config = getDelegationConfig("review", CONFIG);
    assert.equal(config.model, "p/r");
    assert.deepEqual(config.skills, ["*"]);
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
      subagents: { preset: "x", presets: { x: { roles: {} } } },
    }));
    setSubagentPreset(undefined);

    assert.equal(getAgentRoutes().length, 0);
    assert.equal(formatRouteGuidance(), "");
    assert.deepEqual(modelSelectionGuidelines(), []);
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
        presets: { x: { routes: [{ model: "p/a", thinking: "bogus", guidance: "bad" }] } },
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
          personal: { routes: [{ id: "a", model: "p/a", thinking: "medium", guidance: "personal" }] },
          copilot: { routes: [{ id: "a", model: "c/a", thinking: "high", guidance: "copilot" }] },
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
