import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import workGuard from "../work/guard.ts";

// The repo's extension fixtures use Pi 1.0; this guard needs the Pi 1.3 provider API.
const host = process.env.PI_TEST_HOST_DIR;
test("Pi 1.3 runtime blocks provider, models.json, and resolved-credential endpoint overrides before fetch", { skip: !host }, async () => {
  const { ModelRuntime, ModelRegistry } = await import(pathToFileURL(join(host!, "dist/index.js")).href);
  const { AuthStorage } = await import(pathToFileURL(join(host!, "dist/core/auth-storage.js")).href);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("Test intercepted an unexpected network request"); };
  const directory = mkdtempSync(join(tmpdir(), "piw-host-"));
  try {
    for (const scenario of ["openai", "endpoint", "api", "credential-endpoint"]) {
      const path = join(directory, `${scenario}.json`);
      const config = scenario === "endpoint" ? { baseUrl: "https://non-anthropic.invalid" }
        : scenario === "api" ? { models: [{ id: "bad-api", api: "openai-completions", baseUrl: "https://non-anthropic.invalid" }] } : undefined;
      writeFileSync(path, JSON.stringify({ providers: config ? { anthropic: config } : {} }));
      const runtime = await ModelRuntime.create({
        credentials: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "dummy" }, openai: { type: "api_key", key: "dummy" } }),
        modelsPath: path, modelsStorePath: join(directory, "catalog.json"), refreshOnCreate: false,
      });
      if (scenario === "credential-endpoint") {
        const provider = runtime.getProvider("anthropic");
        runtime.registerNativeProvider({ ...provider, auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "dummy", baseUrl: "https://non-anthropic.invalid" }, source: "test" }) } } });
      }
      const handlers: Record<string, Function> = {};
      workGuard({ on: (event: string, fn: Function) => { handlers[event] = fn; } } as any);
      const registry = new ModelRegistry(runtime);
      handlers.session_start({}, { modelRegistry: registry, ui: { setStatus() {} } });
      const provider = scenario === "openai" ? "openai" : "anthropic";
      const model = registry.find(provider, scenario === "api" ? "bad-api" : scenario === "openai" ? "gpt-6-luna" : "claude-haiku-5-5");
      assert.ok(model, `${scenario}: missing fixture model`);
      for (const method of ["stream", "streamSimple"] as const) {
        const result = await registry[method](model, { messages: [{ role: "user", content: "test", timestamp: Date.now() }] }, { apiKey: "dummy" }).result();
        assert.equal(result.stopReason, "error", scenario);
        assert.match(result.errorMessage, /piw (only permits|requires the direct)/, scenario);
      }
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
