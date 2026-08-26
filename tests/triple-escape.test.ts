import assert from "node:assert/strict";
import test from "node:test";
import { ConsecutivePressGate } from "../agent/extensions/triple-escape.ts";

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
