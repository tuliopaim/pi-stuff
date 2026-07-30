import assert from "node:assert/strict";
import test from "node:test";
import delegate from "../agent/extensions/delegate.ts";

test("/delegate enables delegation tools for one run", async () => {
  let active = ["read", "scout", "agent", "workflow"];
  const events = new Map<string, (...args: any[]) => any>();
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => { active = tools; },
    on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
  } as any;

  delegate(pi);
  events.get("session_start")!();
  assert.deepEqual(active, ["read", "scout"]);

  const result = await events.get("input")!(
    { text: "/delegate fix the bug", source: "interactive" },
    { isIdle: () => true, hasUI: false, ui: {} },
  );
  assert.match(result.text, /fix the bug/);
  assert.ok(active.includes("agent"));
  assert.ok(active.includes("subagent_spawn"));
  assert.ok(active.includes("workflow"));

  events.get("agent_settled")!();
  assert.deepEqual(active, ["read", "scout"]);
});
