import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import t3OptChatPolicy, {
  isSessionWithinRoot,
  isT3FullAccess,
  OPTCHAT_BLOCK_MESSAGE,
  OPTCHAT_FORK_MESSAGE,
  OPTCHAT_SWITCH_MESSAGE,
  shouldBlockToolCall,
} from "../agent/t3/t3-optchat-policy.ts";

function register({ mode = "rpc" }: { mode?: string } = {}) {
  const handlers: Record<string, Function> = {};
  const notifications: Array<{ message: string; type?: string }> = [];
  t3OptChatPolicy({
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
  } as any);
  const ctx = {
    mode,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };
  return { handlers, notifications, ctx };
}

function sessionFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "optchat-policy-"));
  const work = join(tmp, "work", "sessions");
  const personal = join(tmp, "personal", "sessions");
  mkdirSync(work, { recursive: true });
  mkdirSync(personal, { recursive: true });
  const workFile = join(work, "session.jsonl");
  const personalFile = join(personal, "session.jsonl");
  const outside = join(tmp, "outside.jsonl");
  const escape = join(work, "escape.jsonl");
  for (const file of [workFile, personalFile, outside]) writeFileSync(file, "{}\n");
  symlinkSync(outside, escape);
  return {
    tmp,
    work,
    workFile,
    personalFile,
    outside,
    escape,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

test("OptChat policy fails closed for non-RPC children and parent delegation without full access", () => {
  for (const mode of ["print", "json", "tui"]) {
    for (const tool of ["read", "bash", "spawn", "tell", "agent"]) {
      assert.equal(shouldBlockToolCall(mode, tool, false), true, `${mode}:${tool}`);
    }
  }
  for (const tool of ["spawn", "tell"]) {
    assert.equal(shouldBlockToolCall("rpc", tool, false), true, tool);
  }
  for (const tool of ["read", "bash"]) {
    assert.equal(shouldBlockToolCall("rpc", tool, false), false, tool);
  }
  for (const mode of ["rpc", "print", "json"]) {
    for (const tool of ["read", "spawn", "tell"]) {
      assert.equal(shouldBlockToolCall(mode, tool, true), false, `${mode}:${tool}`);
    }
  }
});

test("missing or non-full runtime mode is not full access", () => {
  assert.equal(isT3FullAccess({}), false);
  assert.equal(isT3FullAccess({ T3_PI_RUNTIME_MODE: "standard" }), false);
  assert.equal(isT3FullAccess({ T3_PI_RUNTIME_MODE: "full-access" }), true);
});

test("tool_call blocks with an actionable reason and allows tools in full access", async () => {
  const original = process.env.T3_PI_RUNTIME_MODE;
  delete process.env.T3_PI_RUNTIME_MODE;
  try {
    const child = register({ mode: "print" });
    assert.deepEqual(
      await child.handlers.tool_call({ toolName: "read" }, child.ctx),
      { block: true, reason: OPTCHAT_BLOCK_MESSAGE },
    );

    const parent = register({ mode: "rpc" });
    assert.deepEqual(
      await parent.handlers.tool_call({ toolName: "tell" }, parent.ctx),
      { block: true, reason: OPTCHAT_BLOCK_MESSAGE },
    );
    assert.equal(await parent.handlers.tool_call({ toolName: "bash" }, parent.ctx), undefined);

    process.env.T3_PI_RUNTIME_MODE = "full-access";
    const full = register({ mode: "print" });
    assert.equal(await full.handlers.tool_call({ toolName: "write" }, full.ctx), undefined);
  } finally {
    if (original === undefined) delete process.env.T3_PI_RUNTIME_MODE;
    else process.env.T3_PI_RUNTIME_MODE = original;
  }
});

test("session_before_fork cancels and explains", async () => {
  const h = register();
  assert.deepEqual(await h.handlers.session_before_fork({ entryId: "entry" }, h.ctx), { cancel: true });
  assert.deepEqual(h.notifications, [{ message: OPTCHAT_FORK_MESSAGE, type: "warning" }]);
});

test("resume allows the current root and blocks work/personal, traversal, and symlink escapes", async () => {
  const fixture = sessionFixture();
  const original = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = fixture.work;
  try {
    const h = register();
    assert.equal(
      await h.handlers.session_before_switch({ reason: "resume", targetSessionFile: fixture.workFile }, h.ctx),
      undefined,
    );
    assert.deepEqual(h.notifications, []);

    for (const target of [
      fixture.personalFile,
      join(fixture.work, "..", "..", "outside.jsonl"),
      fixture.escape,
      join(fixture.work, "missing.jsonl"),
      undefined,
    ]) {
      assert.deepEqual(
        await h.handlers.session_before_switch({ reason: "resume", targetSessionFile: target }, h.ctx),
        { cancel: true },
        String(target),
      );
    }
    assert.equal(h.notifications.length, 5);
    for (const notification of h.notifications) {
      assert.deepEqual(notification, { message: OPTCHAT_SWITCH_MESSAGE, type: "warning" });
    }

    assert.equal(
      await h.handlers.session_before_switch({ reason: "new", targetSessionFile: fixture.personalFile }, h.ctx),
      undefined,
    );
    assert.equal(h.notifications.length, 5);
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = original;
    fixture.cleanup();
  }
});

test("resume fails closed when the session root is missing or malformed", async () => {
  const original = process.env.PI_CODING_AGENT_SESSION_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    const h = register();
    assert.deepEqual(
      await h.handlers.session_before_switch({ reason: "resume", targetSessionFile: join(tmpdir(), "session.jsonl") }, h.ctx),
      { cancel: true },
    );
    assert.deepEqual(h.notifications, [{ message: OPTCHAT_SWITCH_MESSAGE, type: "warning" }]);
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = original;
  }

  assert.equal(isSessionWithinRoot(undefined, undefined), false);
  assert.equal(isSessionWithinRoot("session.jsonl", undefined), false);
  assert.equal(isSessionWithinRoot(undefined, tmpdir()), false);
  assert.equal(isSessionWithinRoot("\0", tmpdir()), false);
  assert.equal(isSessionWithinRoot(join(tmpdir(), "session.jsonl"), "\0"), false);
});
