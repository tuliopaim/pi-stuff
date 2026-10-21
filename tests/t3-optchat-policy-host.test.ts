import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import t3OptChatPolicy, { OPTCHAT_BLOCK_MESSAGE } from "../agent/t3/t3-optchat-policy.ts";

const host = process.env.PI_TEST_HOST_DIR;

test("installed host runs the policy in real print mode and blocks child tools", { skip: !host }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-optchat-host-"));
  const cwd = join(directory, "cwd");
  const agentDir = join(directory, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);

  const {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
  } = await import(pathToFileURL(join(host!, "dist/index.js")).href);

  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [t3OptChatPolicy],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["bash"],
  });

  const original = process.env.T3_PI_RUNTIME_MODE;
  try {
    await session.bindExtensions({});
    assert.equal(session.extensionRunner.createContext().mode, "print");

    const call = {
      type: "tool_call",
      toolCallId: "test-call",
      toolName: "bash",
      input: { command: "echo must-not-run" },
    };

    delete process.env.T3_PI_RUNTIME_MODE;
    assert.deepEqual(
      await session.extensionRunner.emitToolCall(call),
      { block: true, reason: OPTCHAT_BLOCK_MESSAGE },
    );

    process.env.T3_PI_RUNTIME_MODE = "full-access";
    assert.equal(await session.extensionRunner.emitToolCall(call), undefined);
  } finally {
    if (original === undefined) delete process.env.T3_PI_RUNTIME_MODE;
    else process.env.T3_PI_RUNTIME_MODE = original;
    session.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
