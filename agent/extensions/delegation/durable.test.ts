import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentJobs, acquireDatabaseLock, modelsFromRegistry } from "./durable.ts";
import type { AgentConfig } from "./config.ts";

test("questions park durably, stop sibling mutations, and answers resume by name", async (t) => {
  const cwd = directory(t), database = join(cwd, "questions.sqlite");
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([
    fauxToolCall("bash", { command: "printf once >> completed.txt" }),
    fauxToolCall("ask_question", { question: "Which file?" }),
    fauxToolCall("write", { path: "unsafe.txt", content: "must not run" }),
  ], { stopReason: "toolUse" })]);
  const models = createModels(); models.setProvider(faux.provider);
  const first = await AgentJobs.open({ models, database });
  const job = await first.spawn("worker", { ...config, tools: ["bash", "write"] }, "ask first", cwd, false);
  const parked = await first.wait(job.id);
  assert.equal(parked.job.status, "waiting");
  assert.equal(parked.job.question?.text, "Which file?");
  assert.equal(parked.output, "Which file?");
  assert.equal((await first.harness.snapshot(LiveDoc, job.conversationId, BACKGROUND_CONTEXT))?.run, undefined);
  await first.refreshStatuses(Date.now() + 10 * 60_000);
  assert.equal((await first.get(job.id)).status, "waiting");
  const other = await first.spawn("other", { ...config, tools: ["write"] }, "other work", cwd, true);
  await first.cancel(other.id);
  assert.throws(() => readFileSync(join(cwd, "unsafe.txt")));
  await first.close();
  const second = await AgentJobs.open({ models, database }); t.after(() => second.close());
  await second.resume();
  assert.equal((await second.get(job.name!)).question?.text, "Which file?");
  faux.setResponses([fauxAssistantMessage("answer received")]);
  const resumed = await second.message(job.name!, "Use safe.txt");
  assert.equal(resumed.conversationId, job.conversationId);
  assert.equal((await second.wait(job.name!)).output, "answer received");
  assert.equal(readFileSync(join(cwd, "completed.txt"), "utf8"), "once");
  assert.throws(() => readFileSync(join(cwd, "unsafe.txt")));
  await second.close();
});

test("explicit handles are validated and names are atomically unique", async (t) => {
  const { jobs } = await setup(t, Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
  const cwd = directory(t);
  for (const name of ["Uppercase", "two words", "x\ncontrol", "-first", "a".repeat(65)]) {
    await assert.rejects(jobs.spawn("worker", config, "task", cwd, true, undefined, { name }), /name/);
  }
  await assert.rejects(jobs.spawn("worker", config, "task", cwd, true, undefined, { title: "x".repeat(201) }), /title/);
  const pair = await Promise.all([1, 2].map(() => jobs.spawn("worker", config, "task", cwd, true)));
  assert.deepEqual(pair.map((job) => job.name), ["worker-1", "worker-2"]);
  const explicit = await jobs.spawn("worker", config, "task", cwd, true, undefined, { name: "my-job", title: "Readable title" });
  assert.equal((await jobs.get("my-job")).id, explicit.id);
  assert.equal((await jobs.wait("my-job")).job.title, "Readable title");
  await assert.rejects(jobs.spawn("worker", config, "task", cwd, true, undefined, { name: "my-job" }), /already in use/);
});

test("cancelled questions are cleared and deliverable after acknowledgement", async (t) => {
  const { jobs } = await setup(t, [fauxAssistantMessage([fauxToolCall("ask_question", { question: "Help?" })], { stopReason: "toolUse" })]);
  const job = await jobs.spawn("worker", config, "ask", directory(t), true);
  await jobs.wait(job.id);
  await jobs.acknowledge(job.id, job.requestId);
  await jobs.cancel(job.name!);
  const result = await jobs.result(job.name!);
  assert.equal(result.job.status, "cancelled");
  assert.equal(result.job.question, undefined);
  assert.equal(result.job.delivered, false);
  assert.notEqual(result.job.requestId, job.requestId);
  await jobs.acknowledge(job.id, job.requestId);
  assert.equal((await jobs.get(job.id)).delivered, false);
  assert.equal(result.output, "Cancelled");
});

test("inactivity marks stalled without releasing mutation locks, then aborts work", async (t) => {
  const { jobs, faux } = await setup(t, [fauxAssistantMessage("long ".repeat(100))], true);
  const cwd = directory(t);
  const job = await jobs.spawn("writer", { ...config, tools: ["write"] }, "slow", cwd, true);
  await until(() => faux.state.callCount > 0);
  await jobs.refreshStatuses(Date.now() + 61_000);
  assert.equal((await jobs.get(job.id)).status, "stalled");
  await assert.rejects(jobs.spawn("writer", { ...config, tools: ["write"] }, "other", cwd, true), /mutating agent/);
  await jobs.refreshStatuses(Date.now() + 301_000);
  const result = await jobs.wait(job.id);
  assert.equal(result.job.status, "cancelled");
  assert.match(result.output, /without activity/);
});

test("each built-in tool has the shared three-minute timeout and aborts its process", async (t) => {
  const cwd = directory(t);
  const { jobs } = await setup(t, [
    fauxAssistantMessage([fauxToolCall("bash", { command: "printf started > started.txt; sleep 60; printf unsafe > unsafe.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("timeout handled"),
  ]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const job = await jobs.spawn("writer", { ...config, tools: ["bash"] }, "run", cwd, false);
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  while (true) {
    try { if (readFileSync(join(cwd, "started.txt"), "utf8") === "started") break; } catch {}
    if (process.hrtime.bigint() > deadline) throw new Error("Tool did not start");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  t.mock.timers.tick(180_000);
  t.mock.timers.reset();
  const result = await jobs.wait(job.id);
  assert.equal(result.job.status, "done");
  assert.match(JSON.stringify(await jobs.transcript(job.id)), /timed out after 3 minutes/);
  assert.throws(() => readFileSync(join(cwd, "unsafe.txt")));
});

test("transcript limits can load older history and metadata exposes durable usage and inbox", async (t) => {
  const { jobs } = await setup(t);
  const job = await jobs.spawn("worker", config, "first input", directory(t), false);
  await jobs.wait(job.id);
  const child = (await jobs.harness.conversation(job.conversationId, BACKGROUND_CONTEXT))!;
  for (let i = 0; i < 110; i++) {
    await child.submit({ type: "write", entry: { kind: "test.history", model: [{ role: "user", content: `entry ${i}`, timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
  }
  assert.equal((await jobs.transcript(job.name!)).length, 100);
  assert.ok((await jobs.transcript(job.name!, 200)).some((message) => message.role === "user" && message.content === "first input"));
  const metadata = await jobs.metadata(job.name!);
  assert.ok(metadata.usage.totalTokens > 0);
  assert.ok(metadata.contextUsage.contextWindow! > 0);
  assert.deepEqual(metadata.queued, []);
});

const config: AgentConfig = { model: "faux/faux-1", thinking: "off", description: "Test", instructions: "Answer the task", tools: [] };
function directory(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-durable-agents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function setup(t: test.TestContext, responses = [fauxAssistantMessage("hello")], slow = false) {
  const faux = fauxProvider(slow ? { tokensPerSecond: 10 } : {});
  faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  const jobs = await AgentJobs.open({ models, storage: new MemoryStorage() });
  t.after(() => jobs.close());
  return { jobs, models, faux };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Timed out waiting for check");
}

test("foreground runs return actual answers and offer only the parent question tool", async (t) => {
  const { jobs } = await setup(t);
  const job = await jobs.spawn("default", config, "Say hello", directory(t), false);
  const result = await jobs.wait(job.id);
  assert.equal(result.job.status, "done");
  assert.ok(result.job.finishedAt! >= result.job.startedAt);
  assert.equal(result.output, "hello");
  const child = await jobs.harness.conversation(job.conversationId, BACKGROUND_CONTEXT);
  assert.deepEqual((await child!.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name), ["ask_question"]);
  await jobs.acknowledge(job.id, job.requestId);
  assert.equal((await jobs.get(job.id)).delivered, true);
  assert.equal(jobs.preview(job.id), "");
});

test("Pi read-only tools work inside the durable child and receive the child cwd", async (t) => {
  const cwd = directory(t);
  writeFileSync(join(cwd, "hello.txt"), "file evidence");
  const { jobs } = await setup(t, [fauxAssistantMessage([fauxToolCall("read", { path: "hello.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("read done")]);
  const job = await jobs.spawn("explore", { ...config, tools: ["read", "grep", "find", "ls"] }, "Read hello.txt", cwd, false);
  const result = await jobs.wait(job.id);
  assert.equal(result.job.status, "done");
  const child = await jobs.harness.conversation(job.conversationId, BACKGROUND_CONTEXT);
  const history = await child!.context(BACKGROUND_CONTEXT);
  assert.match(JSON.stringify(history.messages), /file evidence/);
  assert.deepEqual((await child!.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name), ["ask_question", "read", "grep", "find", "ls"]);
});

test("live feedback includes tool arguments and the inspector retains the actual transcript", async (t) => {
  const { jobs } = await setup(t, [
    fauxAssistantMessage([fauxToolCall("bash", { command: "printf activity; sleep 0.2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Checked the work"),
  ]);
  const seen: string[] = [];
  const stop = jobs.subscribe(() => { for (const id of ids) seen.push(jobs.preview(id)); });
  const ids: string[] = [];
  t.after(stop);
  const job = await jobs.spawn("commit", { ...config, tools: ["bash"] }, "Check completed work", directory(t), false);
  ids.push(job.id);
  await jobs.wait(job.id);
  assert.match(seen.join("\n"), /bash\s+printf activity/);
  const transcript = await jobs.transcript(job.id);
  assert.equal(transcript[0].role, "user");
  assert.match(JSON.stringify(transcript), /activity/);
  assert.match(JSON.stringify(transcript.at(-1)), /Checked the work/);
});

test("default agents can edit through the durable tools", async (t) => {
  const cwd = directory(t);
  const { jobs } = await setup(t, [fauxAssistantMessage([fauxToolCall("write", { path: "result.txt", content: "changed" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const job = await jobs.spawn("default", { ...config, tools: ["write"] }, "Write result", cwd, false);
  assert.equal((await jobs.wait(job.id)).job.status, "done");
  assert.equal(readFileSync(join(cwd, "result.txt"), "utf8"), "changed");
});

test("nonzero shell exits remain error tool results in the durable transcript", async (t) => {
  const { jobs } = await setup(t, [fauxAssistantMessage([fauxToolCall("bash", { command: "exit 7" })], { stopReason: "toolUse" }), fauxAssistantMessage("the command failed")]);
  const job = await jobs.spawn("default", { ...config, tools: ["bash"] }, "Run a failing command", directory(t), false);
  await jobs.wait(job.id);
  const child = await jobs.harness.conversation(job.conversationId, BACKGROUND_CONTEXT);
  const history = await child!.context(BACKGROUND_CONTEXT);
  const result = history.messages.find((message) => message.role === "toolResult");
  assert.equal(result?.role === "toolResult" && result.isError, true);
});

test("provider failures are failed jobs, not successful empty answers", async (t) => {
  const { jobs } = await setup(t, [fauxAssistantMessage("", { stopReason: "error", errorMessage: "not authorized" })]);
  const job = await jobs.spawn("default", config, "fail", directory(t), false);
  const result = await jobs.wait(job.id);
  assert.equal(result.job.status, "failed");
  assert.match(result.output, /not authorized/);
});

test("observer failure aborts the child before releasing its mutation reservation", async (t) => {
  const { jobs } = await setup(t, [fauxAssistantMessage("long answer ".repeat(100))], true);
  const conversation = jobs.harness.conversation.bind(jobs.harness);
  jobs.harness.conversation = async (...args) => {
    const child = await conversation(...args);
    if (child) child.viewState = async () => { throw new Error("observer unavailable"); };
    return child;
  };
  const job = await jobs.spawn("default", { ...config, tools: ["write"] }, "slow writer", directory(t), false);
  const result = await jobs.wait(job.id);
  assert.equal(result.job.status, "failed");
  assert.match(result.output, /observer unavailable/);
  assert.equal((await jobs.harness.snapshot(LiveDoc, job.conversationId, BACKGROUND_CONTEXT))?.run, undefined);
});

test("unknown models and empty tasks are rejected before creating work", async (t) => {
  const { jobs } = await setup(t);
  await assert.rejects(jobs.spawn("default", { ...config, model: "faux/missing" }, "test", directory(t), false), /Unknown model/);
  await assert.rejects(jobs.spawn("default", config, " ", directory(t), false), /empty/);
  assert.deepEqual(await jobs.list(), []);
});

test("concurrent read-only fanout is capped; mutation locks cover symlinks and subdirectories", async (t) => {
  const cwd = directory(t);
  mkdirSync(join(cwd, ".git")); mkdirSync(join(cwd, "nested")); symlinkSync(cwd, join(cwd, "alias"));
  const { jobs } = await setup(t, Array.from({ length: 4 }, () => fauxAssistantMessage("long answer ".repeat(100))), true);
  const writer = await jobs.spawn("default", { ...config, tools: ["write"] }, "write", cwd, true);
  await assert.rejects(jobs.spawn("default", { ...config, tools: ["bash"] }, "write", join(cwd, "nested"), true), /mutating agent/);
  await assert.rejects(jobs.spawn("default", { ...config, tools: ["edit"] }, "write", join(cwd, "alias"), true), /mutating agent/);
  const reviewer = await jobs.spawn("review", { ...config, tools: ["bash"], mutating: false }, "inspect", cwd, true);
  assert.equal(reviewer.mutating, false);
  const readers = [reviewer, ...await Promise.all(Array.from({ length: 2 }, () => jobs.spawn("explore", config, "read", cwd, true)))];
  await assert.rejects(jobs.spawn("explore", config, "fifth", cwd, true), /four/);
  await Promise.all([writer, ...readers].map((job) => jobs.cancel(job.id)));
  assert.ok((await jobs.list()).every((job) => job.status === "cancelled"));
});

test("foreground cancellation cancels the job; cancelling a background wait leaves it alive", async (t) => {
  const { jobs } = await setup(t, [fauxAssistantMessage("long ".repeat(100)), fauxAssistantMessage("long ".repeat(100))], true);
  const cwd = directory(t);
  const foreground = await jobs.spawn("default", config, "foreground", cwd, false);
  const controller = new AbortController();
  const waiting = jobs.wait(foreground.id, controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  await until(async () => (await jobs.get(foreground.id)).status === "cancelled");
  const background = await jobs.spawn("default", config, "background", cwd, true);
  const other = new AbortController();
  const backgroundWait = jobs.wait(background.id, other.signal);
  other.abort();
  await assert.rejects(backgroundWait);
  assert.equal((await jobs.get(background.id)).status, "running");
  await jobs.cancel(background.id);
});

test("time limits cancel durable work and release concurrency reservations", async (t) => {
  const { jobs } = await setup(t, [fauxAssistantMessage("long ".repeat(100))], true);
  const job = await jobs.spawn("default", { ...config, timeoutMinutes: 0.0002 }, "slow", directory(t), false);
  const result = await jobs.wait(job.id);
  assert.equal(result.job.status, "cancelled");
  assert.match(result.output, /time limit/);
});

test("immediate guidance does not discard the original assignment", async (t) => {
  const { jobs } = await setup(t, Array.from({ length: 3 }, () => fauxAssistantMessage("done")));
  const lookup = jobs.harness.conversation.bind(jobs.harness);
  let release!: () => void, first = true;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  jobs.harness.conversation = async (...args) => { if (first) { first = false; await gate; } return lookup(...args); };
  const job = await jobs.spawn("worker", config, "original assignment", directory(t), true);
  const guidance = [jobs.message(job.id, "additional guidance"), jobs.message(job.id, "second guidance")];
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all(guidance);
  await jobs.wait(job.id);
  const text = JSON.stringify(await jobs.transcript(job.id));
  assert.match(text, /original assignment/);
  assert.match(text, /additional guidance/);
  assert.match(text, /second guidance/);
});

for (const background of [false, true]) test(`aborting an originally ${background ? "background" : "foreground"} wait after guidance preserves job ownership`, async (t) => {
  const { jobs } = await setup(t, [fauxAssistantMessage([fauxToolCall("write", { path: "result.txt", content: "changed" })], { stopReason: "toolUse" })]);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tool = (jobs as any).tools.find((tool: any) => tool.name === "write");
  let toolSignal!: AbortSignal;
  tool.execute = async (_args: unknown, _api: unknown, context: { abortSignal: AbortSignal }) => {
    toolSignal = context.abortSignal;
    started(); await gate;
    return { content: [{ type: "text", text: "finished" }] };
  };
  const cwd = directory(t);
  const job = await jobs.spawn("writer", { ...config, tools: ["write"] }, "write", cwd, background);
  await entered;
  const controller = new AbortController();
  const listener = t.mock.method(controller.signal, "addEventListener");
  const waiting = jobs.wait(job.name!, controller.signal);
  const rejected = assert.rejects(waiting);
  let cancelling: Promise<void> | undefined;
  try {
    await until(() => listener.mock.callCount() > 0);
    const guided = await jobs.message(job.name!, "queued guidance");
    assert.notEqual(guided.requestId, job.requestId);
    assert.equal(guided.background, true);
    await until(async () => (await jobs.metadata(job.id)).queued.length > 0);
    controller.abort();
    await rejected;
    if (background) {
      assert.equal(toolSignal.aborted, false);
      assert.equal((await jobs.get(job.id)).error, undefined);
      cancelling = jobs.cancel(job.id);
    }
    await until(() => toolSignal.aborted);
    assert.equal((await jobs.get(job.id)).error, "Cancelled");
    assert.ok(["running", "stalled"].includes((await jobs.get(job.id)).status));
    await assert.rejects(jobs.spawn("writer", { ...config, tools: ["write"] }, "second write", cwd, true), /mutating agent/);
    release();
    assert.equal((await jobs.wait(job.id)).job.status, "cancelled");
  } finally {
    controller.abort(); release();
    await rejected;
    await cancelling;
    await jobs.cancel(job.id);
  }
  assert.equal((await jobs.get(job.id)).status, "cancelled");
  const replacement = await jobs.spawn("writer", { ...config, tools: ["write"] }, "replacement", cwd, true);
  await jobs.cancel(replacement.id);
});

test("messages steer an active job and continuations keep the same conversation", async (t) => {
  const { jobs } = await setup(t, [fauxAssistantMessage("initial ".repeat(10)), fauxAssistantMessage("guided"), fauxAssistantMessage("continued")], true);
  const job = await jobs.spawn("default", config, "initial", directory(t), true);
  const guided = await jobs.message(job.id, "guidance");
  assert.notEqual(guided.requestId, job.requestId);
  await until(async () => (await jobs.metadata(job.id)).queued.some((item) => item.mode === "steer" && item.content === "guidance"));
  assert.equal((await jobs.wait(job.id)).output, "guided");
  const continuation = await jobs.message(job.id, "follow up");
  assert.equal(continuation.conversationId, job.conversationId);
  assert.equal((await jobs.wait(job.id)).output, "continued");
  await jobs.acknowledge(job.id, job.requestId);
  assert.equal((await jobs.get(job.id)).delivered, false, "old result cannot acknowledge a new continuation");
});

test("large output is bounded and gives the durable conversation location", async (t) => {
  const { jobs } = await setup(t, [fauxAssistantMessage("a".repeat(50_000))]);
  const job = await jobs.spawn("default", config, "long", directory(t), false);
  const result = await jobs.wait(job.id);
  assert.equal(result.truncated, true);
  assert.match(result.output, /Output truncated.*Full conversation/);
  assert.ok(Buffer.byteLength(result.output) < 33_000);
});

test("SQLite reopen resumes interrupted foreground jobs without duplicating input", async (t) => {
  const cwd = directory(t);
  const database = join(cwd, "jobs.sqlite");
  const faux = fauxProvider({ tokensPerSecond: 10 });
  faux.setResponses([fauxAssistantMessage("unfinished ".repeat(100))]);
  const models = createModels(); models.setProvider(faux.provider);
  const first = await AgentJobs.open({ models, database });
  const job = await first.spawn("default", config, "resume me", cwd, false);
  await until(() => faux.state.callCount > 0);
  await first.close(); await first.close();
  const second = await AgentJobs.open({ models, database });
  t.after(() => second.close());
  faux.setResponses([fauxAssistantMessage("recovered")]);
  await second.resume();
  assert.equal((await second.wait(job.id)).output, "recovered");
  assert.equal((await second.get(job.id)).background, true);
  const child = await second.harness.conversation(job.conversationId, BACKGROUND_CONTEXT);
  const history = await child!.context(BACKGROUND_CONTEXT);
  assert.equal(history.messages.filter((message) => message.role === "user").length, 1);
  await second.close();
});

test("database locks reject another writer and recover a dead owner", (t) => {
  const file = join(directory(t), "session.sqlite");
  const release = acquireDatabaseLock(file);
  assert.throws(() => acquireDatabaseLock(file), /already open/);
  release();
  const owner = new DatabaseSync(file);
  owner.exec("INSERT INTO dotfiles_agent_owner VALUES (1, 2147483647, 'dead-owner')");
  acquireDatabaseLock(file)();
  owner.exec("INSERT INTO dotfiles_agent_owner VALUES (1, 'invalid', 'invalid-owner')");
  assert.throws(() => acquireDatabaseLock(file), /Unreadable/);
  owner.close();
});

test("a SIGKILLed process resumes its SQLite job with one input and one answer", async (t) => {
  const cwd = directory(t);
  const database = join(cwd, "crash.sqlite");
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { createModels } from '@earendil-works/pi-ai/models';
    import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
    import { AgentJobs } from ${JSON.stringify(fileURLToPath(new URL("./durable.ts", import.meta.url)))};
    const faux = fauxProvider({ tokensPerSecond: 10 });
    faux.setResponses([fauxAssistantMessage('in progress '.repeat(1000))]);
    const models = createModels(); models.setProvider(faux.provider);
    const jobs = await AgentJobs.open({ models, database: ${JSON.stringify(database)} });
    const job = await jobs.spawn('default', ${JSON.stringify(config)}, 'survive a crash', ${JSON.stringify(cwd)}, true);
    while (!faux.state.callCount) await new Promise(resolve => setTimeout(resolve, 10));
    console.log('JOB:' + job.id);
  `], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await until(() => { if (child.exitCode !== null) throw new Error(stderr); return stdout.includes("JOB:"); });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const id = /JOB:([^\s]+)/.exec(stdout)![1];
  const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage("survived")]);
  const models = createModels(); models.setProvider(faux.provider);
  const restored = await AgentJobs.open({ models, database });
  t.after(() => restored.close());
  await restored.resume();
  const result = await restored.wait(id);
  assert.equal(result.output, "survived");
  assert.equal(result.job.status, "done");
  const conversation = await restored.harness.conversation(result.job.conversationId, BACKGROUND_CONTEXT);
  const history = await conversation!.context(BACKGROUND_CONTEXT);
  assert.equal(history.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(faux.state.callCount, 1);
  await restored.close();
});

test("model access uses the parent registry for auth and compaction", async () => {
  const { provider, getModel } = fauxProvider();
  let streamed = 0;
  const models = createModels(); models.setProvider(provider);
  const facade = modelsFromRegistry({
    find: () => getModel(),
    streamSimple: (...args: Parameters<typeof models.streamSimple>) => {
      assert.equal(args[2]?.sessionId, streamed === 0 ? "parent-session" : "explicit-session");
      if (streamed > 0) {
        assert.deepEqual(args[2]?.headers, { "x-test": "keep" });
        assert.equal(args[2]?.reasoning, "low");
      }
      streamed++;
      return models.streamSimple(...args);
    },
  } as any, "parent-session");
  assert.equal(facade.getModel("anything", "model"), getModel());
  await facade.completeSimple(getModel(), { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
  assert.equal(streamed, 1);
  const options = { sessionId: "explicit-session", headers: { "x-test": "keep" }, reasoning: "low" as const };
  await facade.streamSimple(getModel(), { messages: [] }, options).result();
  assert.deepEqual(options, { sessionId: "explicit-session", headers: { "x-test": "keep" }, reasoning: "low" });
  assert.equal(streamed, 2);
});

test("durable requests and follow-ups include the stable provider session ID", async (t) => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("1, 2, 3, 4, 5, 6, 7, 8, 9, 10"), fauxAssistantMessage("continued")]);
  const models = createModels(); models.setProvider(faux.provider);
  const facade = modelsFromRegistry({
    find: models.getModel.bind(models),
    streamSimple: (...args: Parameters<typeof models.streamSimple>) => {
      assert.equal(args[2]?.sessionId, "parent-session", "MissingSessionID: Request is missing x-opencode-session");
      return models.streamSimple(...args);
    },
  } as any, "parent-session");
  const jobs = await AgentJobs.open({ models: facade, storage: new MemoryStorage() });
  t.after(() => jobs.close());
  const job = await jobs.spawn("default", config, "Count from 1 to 10", directory(t), false);
  const result = await jobs.wait(job.id);
  assert.equal(result.job.status, "done", result.output);
  assert.equal(result.output, "1, 2, 3, 4, 5, 6, 7, 8, 9, 10");
  await jobs.message(job.id, "Continue");
  assert.equal((await jobs.wait(job.id)).output, "continued");
});
