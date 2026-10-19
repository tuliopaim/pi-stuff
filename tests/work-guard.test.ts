import assert from "node:assert/strict";
import test from "node:test";
import workGuard from "../work/guard.ts";

test("work guard blocks other providers and endpoints, preserves direct Anthropic, and reapplies after replacement", async () => {
  let originalCalls = 0;
  let registrations = 0;
  const original = () => { originalCalls++; };
  const provider = (id: string) => ({ id, name: id, auth: { apiKey: { resolve: original } },
    stream: original, streamSimple: original, fetchDeferred: original, cancelDeferred: original,
    generateImages: original, classify: original, refreshModels: original });
  const anthropic = provider("anthropic");
  const providers = new Map(["anthropic", "openai", "image-only", "classifier-only"].map((id) => [id, id === "anthropic" ? anthropic : provider(id)]));
  const handlers: Record<string, Function> = {};
  let status = "";
  workGuard({ on: (name: string, handler: Function) => { handlers[name] = handler; } } as any);
  const ctx = { modelRegistry: {
    getAll: () => ["anthropic", "openai"].map((provider) => ({ provider })),
    getModelsOfType: (type: string) => [{ provider: type === "image" ? "image-only" : "classifier-only" }],
    getProvider: (id: string) => providers.get(id),
    registerProvider: (p: any) => { providers.set(p.id, p); registrations++; },
  }, ui: { setStatus: (_key: string, value: string) => { status = value; } } };
  handlers.session_start({}, ctx);
  assert.equal(providers.get("anthropic")!.auth, anthropic.auth);
  assert.match(status, /Anthropic only/);
  for (const id of ["openai", "image-only", "classifier-only"]) {
    const p = providers.get(id)! as any;
    for (const method of ["stream", "streamSimple", "fetchDeferred"]) {
      assert.throws(() => p[method](), /piw only permits/);
    }
    for (const method of ["cancelDeferred", "generateImages", "classify"]) {
      await assert.rejects(p[method](), /piw only permits/);
    }
    assert.equal(await p.auth.apiKey.check(), undefined);
    await assert.rejects(p.auth.apiKey.resolve(), /piw only permits/);
    assert.equal(p.refreshModels, undefined);
  }
  assert.equal(originalCalls, 0);
  handlers.before_agent_start({}, ctx);
  assert.equal(registrations, 4, "unchanged providers must not be re-registered");
  for (const event of ["model_select", "before_agent_start", "session_before_compact"]) {
    providers.set("openai", provider("openai"));
    handlers[event]({}, ctx);
    assert.throws(() => providers.get("openai")!.stream(), /piw only permits/);
  }
  const guardedAnthropic = providers.get("anthropic")! as any;
  for (const method of ["stream", "streamSimple"]) {
    for (const baseUrl of ["https://proxy.invalid", "https://api.anthropic.com.evil.invalid", "http://api.anthropic.com", "https://api.anthropic.com/other", "https://user@api.anthropic.com"]) {
      assert.throws(() => guardedAnthropic[method]({ api: "anthropic-messages", baseUrl }), /direct https/);
    }
    assert.throws(() => guardedAnthropic[method]({ api: "openai-completions", baseUrl: "https://api.anthropic.com" }), /direct https/);
    for (const baseUrl of ["https://api.anthropic.com", "https://api.anthropic.com/v1", "https://api.anthropic.com/v1/"]) {
      guardedAnthropic[method]({ api: "anthropic-messages", baseUrl });
    }
  }
  assert.equal(originalCalls, 6);
});
