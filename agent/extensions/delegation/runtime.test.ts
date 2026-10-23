import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgents, getActiveSubagentPresetName, resolveAgent, setSubagentPreset } from "./config.ts";
import { registerDynamicRouteGuidance } from "./runtime.ts";

test("registered guidance updates only its named section, including preset and tool changes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-agent-guidance-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  setSubagentPreset("personal");
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    setSubagentPreset(undefined);
    rmSync(directory, { recursive: true, force: true });
  });
  let handler: any;
  registerDynamicRouteGuidance({ on: (name: string, callback: any) => {
    assert.equal(name, "before_agent_start"); handler = callback;
  }, getActiveTools: () => ["agent"] } as any);
  const options = { sections: { unrelated: "Keep this" } as Record<string, string>, selectedTools: ["agent"], cwd: "/offline" };
  const event = { systemPrompt: "Original prompt", systemPromptOptions: options };
  assert.equal(handler(event), undefined, "must not return a full prompt override");
  assert.equal(event.systemPrompt, "Original prompt");
  assert.equal(options.sections.unrelated, "Keep this");
  assert.equal("forceSystemPrompt" in options, false);
  for (const [name, config] of Object.entries(getAgents())) {
    assert.ok(options.sections.named_subagents.includes(`${name}: ${config.model}:${config.thinking}`));
  }
  assert.match(options.sections.named_subagents, /useful handoffs that do not fit a specialist/);
  const before = options.sections.named_subagents;
  setSubagentPreset("anthropic-work");
  const route = resolveAgent("explore", "anthropic/claude-opus-5-5:high");
  assert.equal(handler(event), undefined);
  assert.notEqual(options.sections.named_subagents, before);
  assert.match(options.sections.named_subagents, /default: anthropic\/claude-sonnet-5-5:medium/);
  assert.equal(getActiveSubagentPresetName(), "anthropic-work");
  assert.deepEqual(resolveAgent("explore", "anthropic/claude-opus-5-5:high"), route);
  for (const selectedTools of [["read"], []]) {
    options.sections.named_subagents = "stale";
    options.selectedTools = selectedTools;
    assert.equal(handler(event), undefined);
    assert.deepEqual(options.sections, { unrelated: "Keep this" }, "remove stale guidance when no subagent tools are selected");
  }
});
