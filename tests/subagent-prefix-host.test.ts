import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { registerDynamicRouteGuidance } from "../agent/extensions/delegation/runtime.ts";
import { setSubagentPreset } from "../agent/extensions/delegation/config.ts";

const host = process.env.PI_TEST_HOST_DIR;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleAt = (path: string) => import(pathToFileURL(path).href);

test("Pi 1.4 native guidance and tool updates preserve the serialized historical prefix after resume", { skip: !host }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-prefix-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const oldFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("Network prohibited"); };
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    setSubagentPreset(undefined);
    rmSync(directory, { recursive: true, force: true });
  });
  const { AgentSession, SessionManager } = await moduleAt(join(host!, "dist/index.js"));
  const { ExtensionRunner } = await moduleAt(join(host!, "dist/core/extensions/runner.js"));
  const { buildSystemPromptSections } = await moduleAt(join(host!, "dist/core/system-prompt.js"));
  const { convertToLlm } = await moduleAt(join(host!, "dist/core/messages.js"));
  const ai = join(host!, "../pi-ai/dist");
  const { stream } = await moduleAt(join(ai, "api/anthropic-messages.js"));
  const { ANTHROPIC_MODELS } = await moduleAt(join(ai, "providers/anthropic.models.js"));
  const { getCurrentSystemMessage } = await moduleAt(join(ai, "utils/transcript.js"));
  let callback: any;
  registerDynamicRouteGuidance({ on: (_event: string, handler: any) => { callback = handler; }, getActiveTools: () => ["agent"] } as any);
  const runner = {
    extensions: [{ path: "delegation/runtime.ts", handlers: new Map([["before_agent_start", [callback]]]) }],
    createContext: () => ({}), assertActive() {}, emitError: (error: unknown) => assert.fail(JSON.stringify(error)),
  };
  const options = () => ({ cwd: "/offline", selectedTools: ["agent"], sections: { unrelated: "Keep this" } });
  const guidance = async () => {
    const result = await ExtensionRunner.prototype.emitBeforeAgentStart.call(runner, { messageType: "user", prompt: "offline" }, options());
    assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
    assert.match(result.systemPromptOptions.sections.named_subagents, /default:/);
    assert.equal(result.systemPromptOptions.sections.unrelated, "Keep this");
    return result.systemPromptOptions;
  };
  const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
  setSubagentPreset("personal");
  const firstOptions = await guidance();
  const manager = SessionManager.inMemory("/offline");
  manager.appendMessage({ role: "system", content: "", sections: buildSystemPromptSections(firstOptions), toolsAdded: [tool("agent")], timestamp: 1 });
  manager.appendMessage({ role: "user", content: "first", timestamp: 2 });
  const before = manager.buildSessionContext().messages;
  // A fresh manager reconstructs the saved branch, as --continue does.
  const resumed = SessionManager.inMemory("/offline", undefined, JSON.parse(JSON.stringify(manager.getEntries())));
  resumed.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", thinkingLevel: "high", providerThinkingLevel: "high",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 3 });
  setSubagentPreset("anthropic-work");
  const nextOptions = await guidance();
  nextOptions.selectedTools.push("read");
  const messages = resumed.buildSessionContext().messages;
  const fake: any = { agent: { state: { messages } }, _hiddenDeclarations: new Set(), _applyToolLoadout: (names: string[]) => names.map(tool), _runSystemPromptOptions: nextOptions };
  const patch = AgentSession.prototype._preparePromptAndToolLoadout.call(fake, nextOptions, messages);
  assert.ok(patch.sections.named_subagents);
  assert.equal(patch.sections.unrelated, undefined);
  resumed.appendMessage({ ...patch, toolsAdded: [tool("read")] });
  resumed.appendMessage({ role: "user", content: "next", timestamp: 3 });
  const after = resumed.buildSessionContext().messages;
  assert.match(getCurrentSystemMessage(after).sections.named_subagents, /anthropic\/claude-sonnet-5-5/);
  AgentSession.prototype._installAgentForcedPromptProjection.call(fake);
  assert.deepEqual(await fake.agent.transformContext(after), after, "must not collapse native system updates");
  const stripCache = (value: any): any => Array.isArray(value) ? value.map(stripCache) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, item]) => [key, key === "content" && typeof item === "string" ? [{ type: "text", text: item }] : stripCache(item)])) : value;
  async function capture(transcript: any[], oauth: boolean) {
    let payload: any;
    await stream(ANTHROPIC_MODELS["claude-opus-5-5"], { messages: convertToLlm(transcript) }, {
      apiKey: oauth ? "sk-ant-oat01-OFFLINE" : "sk-ant-api03-OFFLINE", env: { PI_CACHE_RETENTION: "long" },
      fetch: globalThis.fetch, onPayload: (body: unknown) => { payload = structuredClone(body); throw new Error("Captured offline"); },
    }).result();
    assert.ok(payload);
    return stripCache(payload);
  }
  for (const oauth of [false, true]) {
    const a = await capture(before, oauth), b = await capture(await fake.agent.transformContext(after), oauth);
    assert.deepEqual(b.system, a.system);
    assert.deepEqual(b.tools, a.tools);
    assert.deepEqual(b.messages.slice(0, a.messages.length), a.messages);
    assert.ok(JSON.stringify(b.messages.slice(a.messages.length)).includes("named_subagents"));
    assert.ok(JSON.stringify(b.messages.slice(a.messages.length)).includes("claude-sonnet-5-5"));
  }
  assert.equal(fetches, 0);
});

test("installed discovery loads subagents but no workflow tools, commands, gate, or prompt", { skip: !host }, async () => {
  const { DefaultResourceLoader, SettingsManager } = await moduleAt(join(host!, "dist/index.js"));
  const directory = mkdtempSync(join(tmpdir(), "pi-no-workflows-"));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network prohibited"); };
  try {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory,
      settingsManager: SettingsManager.inMemory({ extensions: [join(repo, "agent/extensions")], prompts: [join(repo, "agent/prompts")] }),
      noSkills: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const tools = loaded.extensions.flatMap((ext: any) => [...ext.tools.keys()]);
    const commands = loaded.extensions.flatMap((ext: any) => [...ext.commands.keys()]);
    for (const name of ["agent", "scout", "review", "commit"]) assert.ok(tools.includes(name), name);
    assert.ok(commands.includes("agents"));
    assert.ok(commands.includes("subagent-preset"));
    assert.equal(tools.includes("workflow"), false);
    for (const name of ["workflow", "workflows", "delegate"]) {
      assert.equal(commands.includes(name), false);
      assert.equal(loader.getPrompts().prompts.some((prompt: any) => prompt.name === name), false);
    }
    assert.equal(loaded.extensions.some((ext: any) => /workflows|delegation-gate/.test(ext.path)), false);
  } finally {
    globalThis.fetch = oldFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
