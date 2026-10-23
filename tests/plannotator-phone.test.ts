import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Socket } from "node:net";
import { ReviewLinks, type Registry, type Review, type Route } from "../agent/extensions/plannotator-phone/manager.ts";
import { createReviewProxy, localReviewUrl } from "../agent/extensions/plannotator-phone/proxy.ts";
import { serveConfigs, stopServeProcess } from "../agent/extensions/plannotator-phone/tailnet.ts";

async function backend(handler: http.RequestListener) {
  const server = http.createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port, url: `http://localhost:${port}`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); }) };
}
const identity = { hostname: "test.tail.example", login: "owner@example.test" };

test("the owner can read and submit feedback; upstream sees its own loopback origin", async () => {
  let received: unknown;
  const source = await backend(async (req, res) => {
    const body: Buffer[] = []; for await (const chunk of req) body.push(Buffer.from(chunk));
    received = { host: req.headers.host, origin: req.headers.origin, identity: req.headers["tailscale-user-login"], body: Buffer.concat(body).toString() };
    res.setHeader("Content-Type", "application/json"); res.end('{"approved":false,"feedback":"Revise step 2"}');
  });
  const proxy = await createReviewProxy(source.url, identity);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/deny`, {
      method: "POST", headers: { "tailscale-user-login": identity.login, Origin: new URL(proxy.url).origin }, body: "review feedback",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { approved: false, feedback: "Revise step 2" });
    assert.deepEqual(received, { host: `localhost:${source.port}`, origin: source.url, identity: undefined, body: "review feedback" });
  } finally { await proxy.close(); await source.close(); }
});

test("missing identity, another login, and a foreign origin never reach the review", async () => {
  let count = 0;
  const source = await backend((_req, res) => { count++; res.end("private plan"); });
  const proxy = await createReviewProxy(source.url, identity);
  try {
    for (const headers of [{}, { "tailscale-user-login": "guest@example.test" }, { "tailscale-user-login": identity.login, Origin: "https://unrelated.test" }]) {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/api/plan`, { headers });
      assert.equal(response.status, 403); await response.text();
    }
    assert.equal(count, 0);
  } finally { await proxy.close(); await source.close(); }
});

test("the owner can stream a response before the source finishes", async () => {
  let finish: (() => void) | undefined;
  const source = await backend((_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.write("data: first\n\n"); finish = () => res.end("data: last\n\n"); });
  const proxy = await createReviewProxy(source.url, identity);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/events`, { headers: { "tailscale-user-login": identity.login } });
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    finish!();
    assert.match(new TextDecoder().decode((await reader.read()).value), /last/);
    await reader.cancel();
  } finally { await proxy.close(); await source.close(); }
});

test("WebSocket upgrades keep the owning connection and loopback Host", async () => {
  const source = await backend((_req, res) => res.end());
  source.server.on("upgrade", (req, socket) => {
    assert.equal(req.headers.host, `localhost:${source.port}`);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nready");
    socket.on("data", (data) => socket.write(data));
  });
  const proxy = await createReviewProxy(source.url, identity);
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: proxy.port, headers: { Connection: "Upgrade", Upgrade: "websocket", "tailscale-user-login": identity.login, Origin: new URL(proxy.url).origin } });
      request.on("error", reject);
      request.on("upgrade", (_res, socket, head) => {
        assert.equal(head.toString(), "ready");
        socket.once("data", (data) => { resolve(data.toString()); socket.destroy(); });
        socket.write("round trip");
      });
      request.end();
    });
    assert.equal(result, "round trip");
  } finally { await proxy.close(); await source.close(); }
});

test("only explicit localhost review ports are accepted", () => {
  assert.equal(localReviewUrl("http://localhost:19432/?review=one").port, "19432");
  for (const value of ["http://example.com:19432/", "https://localhost:19432/", "http://localhost/", "http://localhost:22/", "http://user:password@localhost:19432/"]) assert.throws(() => localReviewUrl(value));
});

test("Serve conflicts include foreground routes, and malformed status fails closed", () => {
  assert.equal(serveConfigs(null).length, 0);
  const configs = serveConfigs({ TCP: { "7317": {} }, Foreground: { one: { TCP: { "19432": {} } } } });
  assert.ok(configs.some((config) => config.TCP?.["19432"]));
  assert.throws(() => serveConfigs("invalid")); assert.throws(() => serveConfigs({ TCP: [] }));
});

function registry(): Registry {
  const open = new Set<Review>();
  return { add: (entry) => { const review = entry as Review; open.add(review); return review; }, remove: (review) => { open.delete(review); }, openAll: () => [...open] };
}
const review = (id: string, owner = "parent-one"): Review => ({ id, owner, url: "http://localhost:19432/", subject: "Plan" });

test("reload attaches once and closing one review preserves another", async () => {
  const closed: string[] = [], messages: string[] = [];
  let sequence = 0;
  const links = new ReviewLinks(async () => { const url = `https://test:${++sequence}/`; return { url, close: async () => { closed.push(url); } }; });
  const source = registry();
  links.reportWith({ owner: "parent-one", token: {}, ready: (_r, url) => messages.push(url), error: assert.fail });
  links.attach(source); const first = source.add(review("one")), second = source.add(review("two"));
  links.attach(source); await links.list("parent-one");
  assert.equal(sequence, 2); assert.equal(messages.length, 2);
  source.remove(first); await links.remove(first);
  // The remove hook may still be finishing its asynchronous route teardown.
  await links.list("parent-one");
  assert.deepEqual((await links.list("parent-one")).map((r) => r.id), ["two"]);
  assert.ok(closed.includes("https://test:1/"));
  source.remove(second); await links.stop();
});

test("a review closed while publishing cannot leave a late route or notify another session", async () => {
  let resolve!: (route: Route) => void;
  let closed = 0, messages = 0;
  const links = new ReviewLinks(() => new Promise((done) => { resolve = done; }));
  const source = registry(), token = {};
  links.reportWith({ owner: "parent-one", token, ready: () => messages++, error: assert.fail });
  links.attach(source); const first = source.add(review("same-id"));
  const removed = links.remove(first); source.remove(first);
  links.clearReporter(token);
  links.reportWith({ owner: "parent-two", token: {}, ready: () => messages++, error: assert.fail });
  resolve({ url: "https://test:1234/", close: async () => { closed++; } });
  await removed;
  assert.equal(closed, 1); assert.equal(messages, 0);
  assert.deepEqual(await links.list("parent-two"), []); await links.stop();
});

test("a retired reporter cannot receive another session's link", async () => {
  let resolve!: (route: Route) => void;
  let messages = 0;
  const links = new ReviewLinks(() => new Promise((done) => { resolve = done; }));
  const source = registry(), token = {};
  links.reportWith({ owner: "parent-one", token, ready: () => messages++, error: assert.fail }); links.attach(source);
  source.add(review("one")); links.clearReporter(token);
  links.reportWith({ owner: "parent-two", token: {}, ready: () => messages++, error: assert.fail });
  resolve({ url: "https://test:1234/", close: async () => {} });
  assert.equal((await links.list("parent-one")).length, 1); assert.equal(messages, 0);
  await links.stop();
});

test("a failed publish can be retried without losing the native review", async () => {
  let attempts = 0;
  const links = new ReviewLinks(async () => { if (++attempts === 1) throw new Error("Tailscale offline"); return { url: "https://test:1234/", close: async () => {} }; });
  const source = registry(); links.attach(source); source.add(review("one"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal((await links.list("parent-one"))[0]?.url, "https://test:1234/");
  assert.equal(source.openAll().length, 1); await links.stop();
});

test("a failed notification cannot reject publishing or interrupt the native registry", async () => {
  const links = new ReviewLinks(async () => { throw new Error("Tailscale offline"); });
  const source = registry();
  links.reportWith({ owner: "parent-one", token: {}, ready: assert.fail, error: () => { throw new Error("UI unavailable"); } });
  links.attach(source); const first = source.add(review("one"));
  assert.equal((await links.list("parent-one"))[0]?.error, "Tailscale offline");
  source.remove(first); await links.stop();
  assert.equal(source.openAll().length, 0);
});

test("shutdown awaits a native remove already cleaning up, and isolates cleanup failures", async () => {
  let finish!: () => void;
  const closed: string[] = [];
  let sequence = 0;
  const links = new ReviewLinks(async () => {
    const id = String(++sequence);
    return { url: `https://test:${id}/`, close: async () => {
      if (id === "1") await new Promise<void>((resolve) => { finish = resolve; });
      closed.push(id); if (id === "1") throw new Error("Route cleanup failed");
    } };
  });
  const source = registry();
  links.reportWith({ owner: "parent-one", token: {}, ready: () => {}, error: () => { throw new Error("UI unavailable"); } });
  links.attach(source); const first = source.add(review("one")); source.add(review("two"));
  await links.list("parent-one");
  source.remove(first); await Promise.resolve();
  let stopped = false;
  const stopping = links.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false); assert.ok(closed.includes("2"));
  finish(); await stopping;
  assert.ok(closed.includes("1"));
});

test("Serve cleanup kills a lingering CLI even after its shell launcher exits", { skip: process.platform === "win32", timeout: 5_000 }, async () => {
  const worker = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);";
  const launcher = `const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: ['ignore', 'inherit', 'ignore'] });
    process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", launcher], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close");
  try {
    await once(child.stdout!, "data");
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    assert.equal(child.exitCode, 0);
    await stopServeProcess(child, 100);
    await closed;
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    child.stdout?.destroy();
  }
});
