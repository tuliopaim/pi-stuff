import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPath, getAgents, resolveAgent, saveAgentModel, setSubagentPreset } from "./config.ts";
import { validateRoute } from "./runtime.ts";

function setup(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "pi-agents-config-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldPreset = process.env.PI_SUBAGENT_PRESET;
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.PI_SUBAGENT_PRESET;
  setSubagentPreset(undefined);
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldPreset === undefined) delete process.env.PI_SUBAGENT_PRESET; else process.env.PI_SUBAGENT_PRESET = oldPreset;
    setSubagentPreset(undefined);
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("named agents have a general-purpose default and safe specialist tool sets", (t) => {
  setup(t);
  const agents = getAgents();
  assert.deepEqual(Object.keys(agents), ["explore", "review", "plan", "default", "setup-wt", "commit"]);
  assert.equal(resolveAgent().model, agents.default.model);
  assert.deepEqual(agents.explore.tools, ["read", "grep", "find", "ls"]);
  for (const name of ["review", "plan"]) {
    assert.deepEqual(agents[name].tools, ["read", "grep", "find", "ls", "bash"]);
    assert.equal(agents[name].mutating, false);
  }
  assert.ok(agents.default.tools.includes("edit"));
  assert.equal(validateRoute(agents.default.model, agents.default.thinking).allowed, true);
});

test("worktree setup uses Luna and shell tools without implementation tools", (t) => {
  setup(t);
  const agent = resolveAgent("setup-wt");
  assert.equal(agent.model, "openai-codex/gpt-6-luna");
  assert.equal(agent.thinking, "medium");
  assert.deepEqual(agent.tools, ["read", "grep", "find", "ls", "bash"]);
  assert.match(agent.instructions, /setup-wt\/SKILL\.md/);
});

test("partial custom agents inherit default behavior and overrides keep specialist tools", (t) => {
  const directory = setup(t);
  writeFileSync(join(directory, "agents.json"), JSON.stringify({ agents: {
    research: { model: "custom/research", description: "Research" },
    explore: { model: "custom/cheap" },
  } }));
  const agents = getAgents();
  assert.equal(agents.research.instructions, agents.default.instructions);
  assert.equal(agents.explore.model, "custom/cheap");
  assert.ok(!agents.explore.tools.includes("bash"));
  assert.equal(resolveAgent("review", "research").model, "custom/research");
  assert.deepEqual(resolveAgent("review", "research").tools, agents.review.tools);
});

test("custom-agent inheritance is independent of JSON property order", (t) => {
  const directory = setup(t);
  const custom = { model: "custom/model" };
  const defaults = { instructions: "Personal default", tools: ["read"] };
  for (const agents of [{ custom, default: defaults }, { default: defaults, custom }]) {
    writeFileSync(join(directory, "agents.json"), JSON.stringify({ agents }));
    assert.equal(getAgents().custom.instructions, "Personal default");
    assert.deepEqual(getAgents().custom.tools, ["read"]);
  }
});

test("workflow route validation supports separate provider and model fields", (t) => {
  setup(t);
  const agent = getAgents().default;
  const slash = agent.model.indexOf("/");
  assert.equal(validateRoute(agent.model.slice(slash + 1), agent.thinking, agent.model.slice(0, slash)).allowed, true);
  assert.equal(validateRoute(agent.model.slice(slash + 1), agent.thinking, "wrong-provider").allowed, false);
});

test("explicit model picks and old lane aliases only replace the model and thinking", (t) => {
  setup(t);
  assert.equal(resolveAgent("explore", "deep").model, getAgents().review.model);
  const picked = resolveAgent("explore", "openrouter/vendor/model:low");
  assert.equal(picked.model, "openrouter/vendor/model");
  assert.equal(picked.thinking, "low");
  assert.ok(!picked.tools.includes("write"));
  assert.throws(() => resolveAgent("missing"), /Unknown agent/);
  assert.throws(() => resolveAgent("default", "no-such-lane"), /Unknown agent or model/);
});

test("presets honor environment then session overrides; copilot cannot leak to another provider", (t) => {
  setup(t);
  process.env.PI_SUBAGENT_PRESET = "copilot";
  assert.ok(Object.values(getAgents()).every((agent) => agent.model.startsWith("github-copilot/")));
  assert.throws(() => resolveAgent("default", "openai/model"), /only permits/);
  setSubagentPreset("openai");
  assert.equal(resolveAgent().model, "openai-codex/gpt-6.1-sol");
  assert.throws(() => setSubagentPreset("missing"), /Unknown agent preset/);
});

test("native model configuration persists in the active preset without replacing other settings", (t) => {
  const directory = setup(t);
  writeFileSync(join(directory, "agents.json"), JSON.stringify({ agents: { explore: { instructions: "Keep this" } } }));
  saveAgentModel("explore", "custom/new", "low");
  assert.equal(resolveAgent("explore").model, "custom/new");
  assert.equal(resolveAgent("explore").instructions, "Keep this");
  const saved = JSON.parse(readFileSync(configPath(), "utf8"));
  assert.deepEqual(saved.presets.personal.explore, { model: "custom/new", thinking: "low" });
});

test("malformed configuration and unknown presets fail closed", (t) => {
  const directory = setup(t);
  const file = join(directory, "agents.json");
  for (const content of ["{", '{"agents":null}', '{"agents":{"explore":{"thinking":"typo"}}}', '{"agents":{"default":{"tools":["agent"]}}}', '{"agents":{"default":{"timeoutMinutes":-1}}}', '{"agents":{"review":{"mutating":"no"}}}']) {
    writeFileSync(file, content);
    assert.throws(getAgents);
  }
  writeFileSync(file, "{}");
  process.env.PI_SUBAGENT_PRESET = "unknown";
  assert.throws(getAgents, /Unknown agent preset/);
});
