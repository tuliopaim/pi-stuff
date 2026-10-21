import assert from "node:assert/strict";
import test from "node:test";
import askUser from "../agent/extensions/ask-user.ts";

interface AskParams {
  question: string;
  options: Array<{ label: string; description?: string }>;
}

const defaultParams: AskParams = {
  question: "Continue?",
  options: [{ label: "Yes", description: "Go ahead" }, { label: "No" }],
};

const askCall = {
  type: "message",
  message: {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-1",
      name: "ask_user",
      arguments: defaultParams,
    }],
  },
};

function harness({
  mode = "rpc",
  branch = [],
  select = () => undefined,
  input = () => undefined,
}: {
  mode?: string;
  branch?: unknown[];
  select?: (options: string[]) => string | undefined;
  input?: (title: string, placeholder?: string) => string | undefined;
} = {}) {
  let tool: any;
  let command: any;
  let sessionStart: any;
  const calls: Array<{
    method: string;
    title: string;
    options?: string[];
    placeholder?: string;
    signal?: AbortSignal;
  }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const sent: unknown[] = [];

  const pi = {
    on(event: string, handler: unknown) {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand(name: string, value: unknown) {
      if (name === "reask") command = value;
    },
    registerTool(value: unknown) {
      tool = value;
    },
    sendUserMessage(value: unknown) {
      sent.push(value);
    },
    events: { emit() {} },
  };
  askUser(pi as any);

  const ctx = {
    mode,
    isIdle: () => false,
    sessionManager: { getBranch: () => branch },
    ui: {
      select(title: string, options: string[], opts?: { signal?: AbortSignal }) {
        calls.push({ method: "select", title, options, signal: opts?.signal });
        return Promise.resolve(select(options));
      },
      input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }) {
        calls.push({ method: "input", title, placeholder, signal: opts?.signal });
        return Promise.resolve(input(title, placeholder));
      },
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      custom() {
        throw new Error("custom UI must not be used outside the TUI");
      },
    },
  };

  const run = (params: AskParams = defaultParams, signal?: AbortSignal) => tool.execute(
    "call",
    params,
    signal,
    undefined,
    ctx,
  );
  const reask = () => command.handler("", ctx);
  const start = () => sessionStart({}, ctx);

  return { run, reask, start, calls, notifications, sent };
}

test("RPC ask_user selects a provided option and shows its description", async () => {
  const h = harness({ select: (options) => options[1] });
  const result = await h.run();

  assert.deepEqual(h.calls, [{
    method: "select",
    title: "Continue?",
    options: ["1. Yes — Go ahead", "2. No", "3. Write my own answer…"],
    signal: undefined,
  }]);
  assert.deepEqual(result.details, {
    question: "Continue?",
    options: ["Yes", "No"],
    answer: "No",
    wasCustom: false,
    cancelled: false,
  });
  assert.equal(result.content[0].text, "User selected option 2: No");
});

test("RPC choices distinguish duplicate labels by index", async () => {
  const h = harness({ select: (options) => options[1] });
  const result = await h.run({
    question: "Which one?",
    options: [{ label: "Same", description: "First" }, { label: "Same" }],
  });

  assert.deepEqual(h.calls[0]!.options, [
    "1. Same — First",
    "2. Same",
    "3. Write my own answer…",
  ]);
  assert.equal(result.details.answer, "Same");
  assert.equal(result.details.wasCustom, false);
  assert.equal(result.content[0].text, "User selected option 2: Same");
});

test("RPC choices treat a free-form-looking label as a normal option", async () => {
  const h = harness({
    select: (options) => options[0],
    input: () => {
      throw new Error("free-form input must not open for a provided option");
    },
  });
  const result = await h.run({
    question: "Pick?",
    options: [{ label: "Write my own answer…" }, { label: "No" }],
  });

  assert.equal(result.details.answer, "Write my own answer…");
  assert.equal(result.details.wasCustom, false);
  assert.equal(result.content[0].text, "User selected option 1: Write my own answer…");
  assert.deepEqual(h.calls.map((call) => call.method), ["select"]);
});

test("RPC ask_user opens input for the explicit free-form choice", async () => {
  const h = harness({
    select: (options) => options[2],
    input: () => "  My answer  ",
  });
  const result = await h.run();

  assert.deepEqual(h.calls.map((call) => call.method), ["select", "input"]);
  assert.equal(h.calls[1]!.title, "Continue?");
  assert.equal(h.calls[1]!.placeholder, "Type your own answer");
  assert.equal(result.details.answer, "My answer");
  assert.equal(result.details.wasCustom, true);
  assert.equal(result.content[0].text, "User wrote their own answer: My answer");
});

test("RPC dismissal and empty free-form answers return no answer", async () => {
  const dismissed = harness({ select: () => undefined });
  const dismissedResult = await dismissed.run();
  assert.equal(dismissedResult.details.cancelled, true);
  assert.equal(dismissedResult.details.answer, null);
  assert.equal(dismissedResult.content[0].text.startsWith("User dismissed the question."), true);

  const empty = harness({ select: (options) => options[2], input: () => "   " });
  const emptyResult = await empty.run();
  assert.equal(emptyResult.details.cancelled, true);
  assert.deepEqual(empty.calls.map((call) => call.method), ["select", "input"]);
});

test("RPC ask_user respects and forwards the abort signal", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  const skipped = harness({
    select: () => {
      throw new Error("select must not open for an aborted question");
    },
  });
  const skippedResult = await skipped.run(defaultParams, preAborted.signal);
  assert.deepEqual(skipped.calls, []);
  assert.equal(skippedResult.details.cancelled, true);
  assert.equal(skippedResult.content[0].text, "Question cancelled.");

  const controller = new AbortController();
  const aborted = harness({
    select: () => {
      controller.abort();
      return undefined;
    },
  });
  const abortedResult = await aborted.run(defaultParams, controller.signal);
  assert.equal(aborted.calls[0]!.signal, controller.signal);
  assert.equal(abortedResult.details.cancelled, true);
  assert.deepEqual(aborted.calls.map((call) => call.method), ["select"]);
});

test("non-interactive modes keep the no-UI result", async () => {
  const h = harness({
    mode: "print",
    select: () => {
      throw new Error("select must not open without a UI");
    },
  });
  const result = await h.run();

  assert.deepEqual(h.calls, []);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.content[0].text, "No interactive UI is available. Ask the user in plain text instead.");
});

test("/reask uses the RPC presenter", async () => {
  const h = harness({ branch: [askCall], select: (options) => options[1] });
  await h.reask();

  assert.equal(h.calls[0]!.method, "select");
  assert.equal(h.calls[0]!.title, "Continue?");
  assert.deepEqual(h.sent, ["Answer to the interrupted question: option 2: No"]);
});

test("/reask warns instead of prompting when no interactive UI exists", async () => {
  const h = harness({ mode: "json", branch: [askCall] });
  await h.reask();

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.notifications, [{
    message: "The ask_user dialog needs an interactive UI.",
    type: "warning",
  }]);
});

test("session_start auto-resume stays TUI-only", async () => {
  const h = harness({
    branch: [askCall],
    select: () => {
      throw new Error("session_start must not open an RPC dialog");
    },
  });
  await h.start();

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent, []);
});
