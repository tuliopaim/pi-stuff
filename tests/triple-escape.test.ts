import assert from "node:assert/strict";
import test from "node:test";
import tripleEscape, { ConsecutivePressGate } from "../agent/extensions/triple-escape.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mountNavigation } from "../vendor/pi-optchat/src/navigation.ts";

test("OptChat preserves the triple-Esc editor and only the third Escape interrupts", () => {
  initTheme("dark");
  let factory: any;
  let start: any;
  let childInterrupts = 0;
  const ctx = { mode: "tui", ui: {
    setEditorComponent: (next: any) => { factory = next; },
    getEditorComponent: () => factory,
    setWidget() {},
  } };
  tripleEscape({
    on: (_event: string, handler: any) => { start = handler; },
    events: { emit: () => { childInterrupts++; } },
  } as any);
  start({}, ctx);
  const installed = factory;
  const unmount = mountNavigation(ctx as any,
    { subscribe: () => () => {} } as any,
    { onChange: () => () => {}, progress: () => ({ total: 0 }) } as any,
    "f10", () => {});
  assert.equal(factory, installed, "OptChat must not replace the triple-Esc editor");
  const editor = factory({ requestRender() {} }, {}, {
    matches: (data: string, action: string) => data === "\x1b" && action === "app.interrupt",
  });
  let parentInterrupts = 0;
  editor.onEscape = () => { parentInterrupts++; };
  editor.handleInput("\x1b");
  editor.handleInput("\x1b");
  assert.equal(parentInterrupts, 0);
  assert.equal(childInterrupts, 0);
  editor.handleInput("\x1b");
  assert.equal(parentInterrupts, 1);
  assert.equal(childInterrupts, 1);
  unmount();
  assert.equal(factory, installed);
});

test("the third consecutive press opens the gate", () => {
  const gate = new ConsecutivePressGate(3, 1_000);

  assert.equal(gate.press(1_000), false);
  assert.equal(gate.press(1_100), false);
  assert.equal(gate.press(1_200), true);
  assert.equal(gate.press(1_300), false);
});

test("presses outside the interval start a new sequence", () => {
  const gate = new ConsecutivePressGate(3, 1_000);

  assert.equal(gate.press(1_000), false);
  assert.equal(gate.press(2_001), false);
  assert.equal(gate.press(2_100), false);
  assert.equal(gate.press(2_200), true);
});

test("reset discards an incomplete sequence", () => {
  const gate = new ConsecutivePressGate(3, 1_000);

  assert.equal(gate.press(1_000), false);
  assert.equal(gate.press(1_100), false);
  gate.reset();
  assert.equal(gate.press(1_200), false);
});
