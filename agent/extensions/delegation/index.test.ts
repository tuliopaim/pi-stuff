import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import registerDelegation from "./index.ts";
import { setSubagentPreset } from "./runtime.ts";

const output = Array.from({ length: 225 }, (_, index) => `line ${index} ${"x".repeat(120)}`).join("\n");

test("registers delegation adapters and executes tools through their policies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegation-extension-"));
  const executable = join(dir, "pi");
  const log = join(dir, "calls.jsonl");
  const previousPath = process.env.PATH;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: any[] = [];
  const statuses: any[] = [];

  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.DELEGATION_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } }));
console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "starting" } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(output)} }], stopReason: "stop", usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.01 } } } }));
console.log(JSON.stringify({ type: "agent_settled" }));
`);
  chmodSync(executable, 0o755);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    subagents: {
      preset: "test",
      presets: {
        test: {
          scout: { model: "test/scout", thinking: "low" },
          review: { model: "test/review", thinking: "medium" },
          commit: { model: "test/commit", thinking: "high" },
        },
      },
    },
  }));

  try {
    process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.DELEGATION_TEST_LOG = log;
    setSubagentPreset(undefined);

    registerDelegation({
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      on(name: string, handler: any) { events.set(name, handler); },
      sendMessage(message: any) { messages.push(message); },
    } as any);

    assert.deepEqual([...tools.keys()], ["scout", "review", "commit"]);
    assert.deepEqual([...commands.keys()], ["commit", "subagent-preset"]);
    assert.ok(events.has("session_start"));

    const updates: any[] = [];
    const results = new Map<string, any>();
    for (const name of tools.keys()) {
      results.set(name, await tools.get(name).execute(
        "call-id",
        { task: `run ${name}` },
        undefined,
        (update: any) => updates.push(update),
        { cwd: process.cwd() },
      ));
    }

    assert.ok(updates.length >= 6);
    assert.equal(updates.at(-1).details.status, "done");
    assert.deepEqual(updates.at(-1).details.activities, ["read src/index.ts"]);
    assert.equal(results.get("scout").details.model, "test/scout");
    assert.equal(results.get("scout").details.usage.turns, 1);
    assert.equal(results.get("scout").details.truncated, true);
    assert.match(results.get("scout").content[0].text, /Scout output truncated to 200 lines \/ 24KB/);
    assert.equal(results.get("review").details.model, "test/review");
    assert.equal(results.get("review").details.truncated, false);
    assert.equal(results.get("commit").details.model, "test/commit");
    assert.equal(results.get("commit").details.truncated, true);
    assert.match(results.get("commit").details.prompt, /# Commit Work/);

    await commands.get("commit").handler("command task", {
      cwd: process.cwd(),
      isIdle: () => true,
      ui: {
        notify() {},
        setStatus: (...args: any[]) => statuses.push(args),
      },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "commit-result");
    assert.equal(messages[0].display, true);
    assert.deepEqual(statuses.at(0), ["commit", "commit agent running"]);
    assert.deepEqual(statuses.at(-1), ["commit", undefined]);

    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((args) => args[args.indexOf("--model") + 1]), [
      "test/scout", "test/review", "test/commit", "test/commit",
    ]);
    assert.deepEqual(calls.map((args) => args[args.indexOf("--tools") + 1]), [
      "read,grep,find,ls",
      "read,grep,find,ls,bash",
      "read,grep,find,ls,bash",
      "read,grep,find,ls,bash",
    ]);
  } finally {
    setSubagentPreset(undefined);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    delete process.env.DELEGATION_TEST_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});
