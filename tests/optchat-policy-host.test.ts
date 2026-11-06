import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";

const host = process.env.PI_TEST_HOST_DIR;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("normal OptChat profiles discover shared tools and activate codemode in main and child SDK sessions", { skip: !host }, async () => {
  const sdk = await import(pathToFileURL(join(host!, "dist/index.js")).href);
  const { createJiti } = await import(pathToFileURL(join(host!, "dist/core/extensions/jiti-loader.js")).href);
  const jiti = createJiti(import.meta.url, { moduleCache: false,
    alias: { "@earendil-works/pi-coding-agent": join(host!, "dist/index.js"),
      "@earendil-works/pi-ai": join(host!, "../pi-ai/dist/compat.js"),
      "typebox": join(repo, "pi/agent/node_modules/typebox/build/index.mjs") } });
  const { Children } = await jiti.import(join(repo, "pi/vendor/pi-optchat/src/agents.ts"));
  const { AuthStorage } = await import(pathToFileURL(join(host!, "dist/core/auth-storage.js")).href);
  const directory = mkdtempSync(join(tmpdir(), "optchat-policy-"));
  const original = { ...process.env };
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("Offline test forbids network"); };
  try {
    const home = join(directory, "home");
    mkdirSync(home);
    const shared = join(home, "dotfiles/pi/agent/extensions");
    mkdirSync(shared, { recursive: true });
    for (const name of readdirSync(join(repo, "pi/agent/extensions"))) {
      symlinkSync(join(repo, "pi/agent/extensions", name), join(shared, name));
    }
    for (const name of ["vendor", "work", "opt"]) symlinkSync(join(repo, "pi", name), join(home, "dotfiles/pi", name));
    writeFileSync(join(shared, "future-shared-tool.ts"), `export default pi => pi.registerTool({
      name: 'policy_probe', label: 'Policy probe', description: 'Default shared discovery probe',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'offline' }], details: {} })
    });`);
    const source = join(home, ".pi-work/agent");
    mkdirSync(source, { recursive: true });
    const serverScript = join(directory, "mcp-fixture.cjs");
    writeFileSync(serverScript, `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'offline-fixture', version: '1' } }
    : request.method === 'tools/list'
      ? { tools: [{ name: 'probe', description: 'Offline probe', inputSchema: { type: 'object', properties: {} } }] } : {};
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
});`);
    writeFileSync(join(source, "mcp.json"), JSON.stringify({ mcpServers: {
      "work-db": { command: process.execPath, args: [serverScript], exposure: "deferred" },
      "ai-memory": { command: "never-run-memory" },
    } }));
    // Use already-installed packages as local resources. No package install or provider calls.
    const cache = [join(homedir(), ".pi/agent/npm/node_modules/@plannotator/pi-extension"),
      join(homedir(), ".pi-opt/agent/npm/node_modules/pi-context-bar")];
    // Policy tests assert the pins. This offline host check uses cached UI packages,
    // which can be older than the requested versions.
    process.env.HOME = home;
    process.env.OPTCHAT_INSPECT_KEY = "f10";
    process.env.PLANNOTATOR_AGENT_TOOL = "1";
    const cwd = join(directory, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: {
      "ai-memory": { command: "must-not-start" }, "project-extra": { command: "must-not-start" },
      "work-db": { command: "must-not-replace-approved-server" },
    } }));
    // --no-approve trusts project settings, but an empty project list must not
    // erase global declarations in children.
    writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ extensions: [] }));
    for (const mode of ["personal", "work"]) {
      const agentDir = join(home, mode === "work" ? ".pi-opt-work/agent" : ".pi-opt/agent");
      mkdirSync(agentDir, { recursive: true });
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.OPTCHAT_HOME = join(agentDir, "memory");
      execFileSync("python3", [join(repo, "scripts/pi-opt-config.py"), mode, mode === "work" ? "anthropic" : "openai", "fixture", "medium"]);
      const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
      settings.packages = cache;
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
      const runtime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(),
        modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "catalog.json"), refreshOnCreate: false });
      for (const child of [false, true]) {
        let settingsManager = sdk.SettingsManager.create(cwd, agentDir);
        let loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
          noContextFiles: true, noSkills: true, noPromptTemplates: true,
          extensionFactories: [
            { name: "codemode", factory: sdk.createCodemodeExtension(), builtin: true, replaceable: true },
            { name: "tool-search", factory: sdk.createToolSearchExtension(), builtin: true, replaceable: true },
            { name: "mcp", factory: sdk.createMcpExtension(), builtin: true, replaceable: true },
          ],
        });
        let childSession;
        if (child) {
          const children = new Children({ directory: join(agentDir, "child-profile") }, new sdk.ModelRegistry(runtime),
            () => ({}), () => "", async () => {}, () => {}, undefined, {
              builtins: () => ["codemode", "tool-search", "mcp"],
              createSession: async (options: any) => {
                loader = options.resourceLoader;
                settingsManager = options.settingsManager;
                return sdk.createAgentSession({ ...options, agentDir, modelRuntime: runtime });
              },
            });
          childSession = await children.open({ id: "offline-child", directory: cwd, depth: 1, connected: false,
            model: new sdk.ModelRegistry(runtime).find("anthropic", "claude-haiku-5-5"),
            sessionManager: sdk.SessionManager.inMemory(cwd) });
        } else await loader.reload();
        if (child) {
          assert.equal(settingsManager.getCacheWarmingMode(), "off");
          assert.equal(settingsManager.getCompactionEnabled(), true);
          assert.deepEqual(settingsManager.getGlobalSettings().extensions, settings.extensions);
          assert.deepEqual(settingsManager.getProjectSettings().extensions, []);
        }
        const loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        const paths = loaded.extensions.map((e: any) => e.resolvedPath);
        for (const suffix of ["web-tools/index.ts", "ask-user.ts", "markdown.ts", "plannotator-phone/index.ts", "selection-comments-prototype.ts", "triple-escape.ts", "opt/mcp.ts"]) {
          assert.ok(paths.some((p: string) => p.endsWith(suffix)), `${mode}/${child}: missing ${suffix}`);
        }
        assert.ok(!paths.some((p: string) => /delegation\/|context-tokens-footer|implement-plan|ai-memory|optmem/i.test(p)));
        assert.equal(paths.some((p: string) => p.endsWith("work/guard.ts")), mode === "work");
        if (!child) assert.ok(paths.findIndex((p: string) => p.endsWith("triple-escape.ts")) < paths.findIndex((p: string) => p.endsWith("vendor/pi-optchat/src/index.ts")));
        const session = childSession ?? (await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader,
          modelRuntime: runtime, sessionManager: sdk.SessionManager.inMemory(cwd) })).session;
        try {
          await session.bindExtensions({});
          assert.ok(session.getActiveToolNames().includes("codemode"));
          assert.ok(session.getActiveToolNames().includes("tool_search"));
          assert.ok(session.getActiveToolNames().includes("ask_user"));
          assert.ok(session.getActiveToolNames().includes("policy_probe"), "New shared extensions load without a launcher edit");
          if (mode === "work") {
            for (let attempt = 0; attempt < 100 && !session.getAllTools().some((t: any) => t.name.startsWith("mcp__")); attempt++) {
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          }
          assert.deepEqual(session.getAllTools().filter((t: any) => t.name.startsWith("mcp__")).map((t: any) => t.name),
            mode === "work" ? ["mcp__work_postgres__probe"] : []);
          if (mode === "work") {
            const guardedRegistry = session.extensionRunner.createContext().modelRegistry;
            const model = guardedRegistry.find("openai", "gpt-6-luna");
            const response = await guardedRegistry.streamSimple(model, { messages: [] }, { apiKey: "fixture" }).result();
            assert.match(response.errorMessage, /only permits direct Anthropic/);
          }
        } finally {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
        }
      }
      if (mode === "work") {
        // --no-extensions drops settings extensions, not explicit CLI extensions.
        const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
        const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
          additionalExtensionPaths: [join(repo, "pi/work/guard.ts")],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        assert.ok(loader.getExtensions().extensions.some((e: any) => e.resolvedPath.endsWith("work/guard.ts")));
        const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader,
          modelRuntime: runtime, sessionManager: sdk.SessionManager.inMemory(cwd) });
        try {
          await session.bindExtensions({});
          const registry = session.extensionRunner.createContext().modelRegistry;
          const response = await registry.streamSimple(registry.find("openai", "gpt-6-luna"),
            { messages: [] }, { apiKey: "fixture" }).result();
          assert.match(response.errorMessage, /only permits direct Anthropic/);
        } finally {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session.dispose();
        }
      }
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(directory, { recursive: true, force: true });
  }
});
