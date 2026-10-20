import assert from "node:assert/strict";
import test from "node:test";
import askUser from "../agent/extensions/ask-user.ts";

function harness({ idle = false, mode = "tui", failure = false, protocol = true } = {}) {
  const events: unknown[] = [];
  const statuses: unknown[] = [];
  let tool: any;
  let component: any;
  let close: (value: unknown) => void = () => {};
  const pi = {
    on() {}, registerCommand() {},
    registerTool(value: unknown) { tool = value; },
    events: { emit(name: string, data: unknown) { events.push({ name, data }); } },
  };
  askUser(pi as any);
  const ctx = {
    mode, isIdle: () => idle,
    ui: {
      custom(factory: Function) {
        if (failure) throw new Error("dialog failed");
        return new Promise((resolve) => {
          close = resolve;
          component = factory({
            terminal: protocol ? { setProgramStatus: (status: unknown) => statuses.push(status) } : {},
            requestRender() {},
          }, { fg: (_color: string, text: string) => text }, {}, resolve);
        });
      },
    },
  };
  const run = (signal?: AbortSignal) => tool.execute("call", {
    question: "Continue?", options: [{ label: "Yes" }, { label: "No" }],
  }, signal, undefined, ctx);
  return { run, events, statuses, get component() { return component; }, close: () => close(null) };
}

const blocked = { name: "herdr:blocked", data: { active: true, label: "Continue?" } };
const unblocked = { name: "herdr:blocked", data: { active: false } };

test("ask_user reports blocked to Herdr and OSC, then working after an answer", async () => {
  const h = harness();
  const pending = h.run();
  assert.deepEqual(h.events, [blocked]);
  assert.deepEqual(h.statuses, [{ state: "blocked", kind: "question", app: "pi", message: "Continue?" }]);
  h.component.handleInput("1");
  const result = await pending;
  assert.equal(result.details.answer, "Yes");
  assert.deepEqual(h.events, [blocked, unblocked]);
  assert.deepEqual(h.statuses.at(-1), { state: "working", app: "pi" });
});

test("ask_user clears blocked on cancellation and returns idle for idle replay", async () => {
  const h = harness({ idle: true });
  const controller = new AbortController();
  const pending = h.run(controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.details.cancelled, true);
  assert.deepEqual(h.events, [blocked, unblocked]);
  assert.deepEqual(h.statuses.at(-1), { state: "idle", app: "pi" });
});

test("ask_user clears the Herdr blocker if custom UI creation fails", async () => {
  const h = harness({ failure: true });
  await assert.rejects(h.run(), /dialog failed/);
  assert.deepEqual(h.events, [blocked, unblocked]);
});

test("headless and already-aborted questions never publish blocked", async () => {
  const headless = harness({ mode: "rpc" });
  await headless.run();
  const aborted = harness();
  await aborted.run(AbortSignal.abort());
  for (const h of [headless, aborted]) {
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.statuses, []);
  }
});

test("older Pi terminals still report socket state and clear it on dismissal", async () => {
  const h = harness({ protocol: false });
  const pending = h.run();
  h.close();
  assert.equal((await pending).details.cancelled, true);
  assert.deepEqual(h.events, [blocked, unblocked]);
  assert.deepEqual(h.statuses, []);
});
