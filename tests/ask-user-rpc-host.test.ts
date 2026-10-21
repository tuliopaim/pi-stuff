import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const host = process.env.PI_TEST_HOST_DIR;
const PREFIX = "ASK_USER_HOST:";
const ASK_USER_PATH = [
  resolve(process.cwd(), "extensions", "ask-user.ts"),
  resolve(process.cwd(), "agent", "extensions", "ask-user.ts"),
  resolve(process.cwd(), "..", "agent", "extensions", "ask-user.ts"),
].find((path) => existsSync(path));
const ASK_USER = pathToFileURL(ASK_USER_PATH!).href;

function rpcClient(child: ChildProcess) {
  let buffer = "";
  let stderr = "";
  let exited = false;
  const records: any[] = [];
  const waiters: Array<{
    predicate: (record: any) => boolean;
    resolve: (record: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const drain = () => {
    for (let index = 0; index < waiters.length; index++) {
      const waiter = waiters[index]!;
      const found = records.findIndex(waiter.predicate);
      if (found < 0) continue;
      const [record] = records.splice(found, 1);
      clearTimeout(waiter.timer);
      waiters.splice(index, 1);
      index--;
      waiter.resolve(record);
    }
  };

  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      records.push(JSON.parse(line));
      drain();
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  child.once("exit", (code, signal) => {
    exited = true;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`pi exited (code=${code}, signal=${signal}) before the expected record. stderr: ${stderr}`));
    }
  });

  return {
    stderr: () => stderr,
    send(record: unknown) {
      child.stdin!.write(`${JSON.stringify(record)}\n`);
    },
    waitFor(predicate: (record: any) => boolean, label: string, timeout = 10_000) {
      const existing = records.findIndex(predicate);
      if (existing >= 0) return Promise.resolve(records.splice(existing, 1)[0]);
      if (exited) return Promise.reject(new Error(`pi already exited while waiting for ${label}. stderr: ${stderr}`));
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${label}. stderr: ${stderr}`));
        }, timeout);
        timer.unref();
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin!.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test("real RPC ask_user round trip selects, writes a custom answer, and dismisses", { skip: !host }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ask-user-rpc-"));
  const home = join(directory, "home");
  const cwd = join(directory, "cwd");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(home, ".pi", "agent", "auth.json"), "{}\n");
  const fixture = join(directory, "ask-user-fixture.ts");
  writeFileSync(fixture, `
import askUser from ${JSON.stringify(ASK_USER)};

export default function (pi) {
  let askUserTool;
  const proxy = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") return (tool) => { askUserTool = tool; };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  askUser(proxy);
  pi.registerCommand("test-question", {
    description: "Run ask_user through real RPC without a model",
    handler: async (_args, ctx) => {
      const result = await askUserTool.execute(
        "test-call",
        { question: "Pick one?", options: [{ label: "Yes", description: "Go ahead" }, { label: "No" }] },
        undefined,
        undefined,
        ctx,
      );
      ctx.ui.notify(${JSON.stringify(PREFIX)} + JSON.stringify(result.details), "info");
    },
  });
}
`);

  const child = spawn(process.execPath, [
    join(host!, "dist", "bundle", "cli.js"),
    "--mode", "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--extension", fixture,
  ], {
    cwd,
    env: { ...process.env, HOME: home, PI_OFFLINE: "1", T3_PI_RUNTIME_MODE: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = rpcClient(child);

  const startQuestion = async (label: string) => {
    const id = `prompt-${label}`;
    const response = rpc.waitFor(
      (record) => record.type === "response" && record.id === id,
      `${label} prompt response`,
    );
    response.catch(() => {});
    rpc.send({ id, type: "prompt", message: "/test-question" });
    const select = await rpc.waitFor(
      (record) => record.type === "extension_ui_request" && record.method === "select",
      `${label} select request`,
    );
    return { select, response };
  };

  const finishQuestion = async (label: string) => {
    const notify = await rpc.waitFor(
      (record) => record.type === "extension_ui_request" && record.method === "notify"
        && typeof record.message === "string" && record.message.startsWith(PREFIX),
      `${label} result notification`,
    );
    return JSON.parse(notify.message.slice(PREFIX.length));
  };

  try {
    rpc.send({ id: "commands", type: "get_commands" });
    const commands = await rpc.waitFor((record) => record.type === "response" && record.id === "commands", "command list");
    assert.equal(commands.success, true);
    assert.ok(
      commands.data?.commands?.some((command: any) => command.name === "test-question" && command.source === "extension"),
      "test-question extension command is missing; refusing to prompt and risk a paid run",
    );

    const selectedPrompt = await startQuestion("selected");
    assert.deepEqual(selectedPrompt.select.options, [
      "1. Yes — Go ahead",
      "2. No",
      "3. Write my own answer…",
    ]);
    rpc.send({ type: "extension_ui_response", id: selectedPrompt.select.id, value: selectedPrompt.select.options[1] });
    const selected = await finishQuestion("selected");
    const selectedResponse = await selectedPrompt.response;
    assert.equal(selectedResponse.success, true, JSON.stringify(selectedResponse));
    assert.equal(selectedResponse.data?.disposition, "handled");
    assert.equal(selected.answer, "No");
    assert.equal(selected.wasCustom, false);
    assert.equal(selected.cancelled, false);

    const customPrompt = await startQuestion("custom");
    rpc.send({ type: "extension_ui_response", id: customPrompt.select.id, value: customPrompt.select.options[2] });
    const inputRequest = await rpc.waitFor(
      (record) => record.type === "extension_ui_request" && record.method === "input",
      "custom answer input request",
    );
    assert.equal(inputRequest.title, "Pick one?");
    rpc.send({ type: "extension_ui_response", id: inputRequest.id, value: "A custom answer" });
    const custom = await finishQuestion("custom");
    const customResponse = await customPrompt.response;
    assert.equal(customResponse.data?.disposition, "handled");
    assert.equal(custom.answer, "A custom answer");
    assert.equal(custom.wasCustom, true);
    assert.equal(custom.cancelled, false);

    const cancelledPrompt = await startQuestion("cancelled");
    rpc.send({ type: "extension_ui_response", id: cancelledPrompt.select.id, cancelled: true });
    const cancelled = await finishQuestion("cancelled");
    const cancelledResponse = await cancelledPrompt.response;
    assert.equal(cancelledResponse.data?.disposition, "handled");
    assert.equal(cancelled.answer, null);
    assert.equal(cancelled.cancelled, true);

    rpc.send({ id: "stats", type: "get_session_stats" });
    const stats = await rpc.waitFor((record) => record.type === "response" && record.id === "stats", "session stats");
    assert.equal(stats.success, true);
    assert.equal(stats.data?.assistantMessages, 0);
    assert.equal(stats.data?.cost ?? 0, 0);
  } finally {
    await stop(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
