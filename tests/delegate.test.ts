import assert from "node:assert/strict";
import test from "node:test";
import delegationGate from "../agent/extensions/delegation-gate.ts";

test("/delegate enables agents without workflows for one run", async () => {
  let active = ["read", "scout", "agent", "workflow"];
  const events = new Map<string, (...args: any[]) => any>();
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => { active = tools; },
    on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
  } as any;

  delegationGate(pi);
  events.get("session_start")!();
  assert.deepEqual(active, ["read", "scout"]);

  const result = await events.get("input")!(
    { text: "/delegate fix the bug", source: "interactive" },
    { isIdle: () => true, hasUI: false, ui: {} },
  );
  assert.match(result.text, /fix the bug/);
  assert.ok(active.includes("agent"));
  assert.ok(active.includes("subagent_spawn"));
  assert.ok(!active.includes("workflow"));

  events.get("agent_settled")!();
  assert.deepEqual(active, ["read", "scout"]);
});

test("/workflow enables workflow tools before prompt expansion", async () => {
  let active = ["read", "scout", "agent", "workflow"];
  const events = new Map<string, (...args: any[]) => any>();
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => { active = tools; },
    on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
  } as any;

  delegationGate(pi);
  events.get("session_start")!();

  const result = await events.get("input")!(
    { text: "/workflow add a source", source: "interactive" },
    { isIdle: () => true, hasUI: false, ui: {} },
  );

  assert.deepEqual(result, { action: "continue" });
  assert.ok(active.includes("agent"));
  assert.ok(active.includes("workflow"));

  events.get("agent_settled")!();
  assert.deepEqual(active, ["read", "scout"]);
});

test("an explicit plain-language workflow request enables workflow tools", async () => {
  let active = ["read", "scout", "agent", "workflow"];
  const events = new Map<string, (...args: any[]) => any>();
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => { active = tools; },
    on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
  } as any;

  delegationGate(pi);
  events.get("session_start")!();
  assert.ok(!active.includes("workflow"));

  const result = await events.get("input")!(
    { text: "invoke a workflow of 5 5.6-luna agents to scout this repo", source: "interactive" },
    { isIdle: () => true, hasUI: false, ui: {} },
  );

  assert.equal(result, undefined);
  assert.ok(active.includes("agent"));
  assert.ok(active.includes("workflow"));
});

test("negative workflow wording does not arm delegation", async () => {
  let active = ["read", "scout", "agent", "workflow"];
  const events = new Map<string, (...args: any[]) => any>();
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => { active = tools; },
    on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
  } as any;

  delegationGate(pi);
  events.get("session_start")!();
  const result = await events.get("input")!(
    { text: "I do not want you to run a workflow for this", source: "interactive" },
    { isIdle: () => true, hasUI: false, ui: {} },
  );

  assert.equal(result, undefined);
  assert.deepEqual(active, ["read", "scout"]);
});
