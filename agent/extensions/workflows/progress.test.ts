import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkflowProgressPublisher, WORKFLOW_PROGRESS_INTERVAL_MS } from "./progress.ts";

test("workflow tool-card updates are capped at one redraw per second", () => {
  assert.equal(WORKFLOW_PROGRESS_INTERVAL_MS, 1_000);
});

test("workflow progress coalesces token-level update bursts", async () => {
  let publications = 0;
  const progress = createWorkflowProgressPublisher(() => publications++, 40);

  for (let index = 0; index < 20; index++) progress.request();
  await delay(10);
  assert.equal(publications, 1);

  for (let index = 0; index < 20; index++) progress.request();
  await delay(15);
  assert.equal(publications, 1);
  await delay(35);
  assert.equal(publications, 2);

  progress.dispose();
});

test("workflow progress flush publishes the final state immediately", () => {
  let publications = 0;
  const progress = createWorkflowProgressPublisher(() => publications++, 10_000);
  progress.request();
  progress.flush();
  assert.equal(publications, 1);
  progress.dispose();
});
