import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("phone reviews activate over RPC only when privately enabled", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-phone-rpc-"));
  const configDir = join(home, ".config", "pi");
  const originalHome = process.env.HOME;
  const originalRemote = process.env.PLANNOTATOR_REMOTE;
  process.env.HOME = home;
  let plannotatorPhone: any;
  try {
    plannotatorPhone = (await import("../agent/extensions/plannotator-phone/index.ts")).default;
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }

  const handlers: Record<string, Function> = {};
  let command: any;
  const notifications: string[] = [];
  plannotatorPhone({
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
    registerCommand(_name: string, value: unknown) {
      command = value;
    },
    sendMessage() {},
  } as any);

  const ctx = (mode: string) => ({
    mode,
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  });

  try {
    await handlers.session_start({}, ctx("rpc"));
    await command.handler("", ctx("rpc"));
    assert.match(notifications.at(-1)!, /phone links are disabled/);
    assert.equal((globalThis as any).__plannotatorPhone_v1, undefined);

    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "plannotator-phone.json"), JSON.stringify({ enabled: true }));

    await handlers.session_start({}, ctx("rpc"));
    assert.ok((globalThis as any).__plannotatorPhone_v1);
    assert.equal(process.env.PLANNOTATOR_REMOTE, "0");
    await command.handler("", ctx("rpc"));
    assert.match(notifications.at(-1)!, /review tracking is unavailable/);

    for (const mode of ["sdk", "json", "print"]) {
      await handlers.session_start({}, ctx(mode));
      await command.handler("", ctx(mode));
      assert.match(notifications.at(-1)!, /phone links are disabled/, mode);
    }
  } finally {
    await handlers.session_shutdown({ reason: "quit" });
    delete (globalThis as any).__plannotatorPhone_v1;
    delete (globalThis as any).__plannotatorPiReviewRegistry_v1;
    if (originalRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = originalRemote;
    rmSync(home, { recursive: true, force: true });
  }
});
