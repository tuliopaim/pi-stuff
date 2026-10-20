import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createReviewProxy } from "./proxy.ts";

const execute = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function signalServe(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    // macOS commonly installs a shell wrapper without exec. Stop its CLI child too.
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
function serveAlive(child: ChildProcess) {
  if (process.platform === "win32" || !child.pid) return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

export async function stopServeProcess(child: ChildProcess, graceMs = 2_000) {
  // The launcher may already have exited while its CLI child still owns the route.
  if (!serveAlive(child)) return;
  signalServe(child, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (serveAlive(child) && Date.now() < deadline) await sleep(50);
  if (serveAlive(child)) signalServe(child, "SIGKILL");
}
type Config = { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; Foreground?: Record<string, Config> };

export function serveConfigs(value: unknown): Config[] {
  if (value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Tailscale returned an invalid Serve configuration.");
  const config = value as Config;
  if (config.TCP != null && (typeof config.TCP !== "object" || Array.isArray(config.TCP))) throw new Error("Invalid Tailscale TCP configuration.");
  if (config.Foreground != null && (typeof config.Foreground !== "object" || Array.isArray(config.Foreground))) throw new Error("Invalid Tailscale foreground configuration.");
  return [config, ...Object.values(config.Foreground ?? {}).flatMap(serveConfigs)];
}

export class TailnetPublisher {
  private readonly children = new Set<ChildProcess>();
  private identity?: { hostname: string; login: string };
  readonly binary: string;
  constructor(binary: string) { this.binary = binary; }

  private async json(args: string[]) {
    const { stdout } = await execute(this.binary, args, { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  }

  async publish(reviewUrl: string) {
    if (!this.identity) {
      const status = await this.json(["status", "--json"]);
      const hostname = status.Self?.DNSName?.replace(/\.+$/, "");
      const login = status.User?.[String(status.Self?.UserID)]?.LoginName;
      if (status.BackendState !== "Running" || !hostname || !/^[a-z0-9.-]+$/i.test(hostname) || !login) {
        throw new Error("Tailscale must be running on a machine owned by your login.");
      }
      this.identity = { hostname, login };
    }
    const identity = this.identity;
    for (let attempt = 0; attempt < 8; attempt++) {
      const proxy = await createReviewProxy(reviewUrl, identity);
      let child: ChildProcess | undefined;
      let closed = false;
      const close = async () => {
        if (closed) return; closed = true;
        try {
          if (child) {
            try { await stopServeProcess(child); } finally { this.children.delete(child); }
            // Let the daemon release the foreground route before its loopback port is reused.
            const deadline = Date.now() + 3_000;
            while (Date.now() < deadline) {
              try {
                const configs = serveConfigs(await this.json(["serve", "status", "--json"]));
                if (!configs.some((config) => config.TCP?.[String(proxy.port)] !== undefined)) break;
              } catch { break; }
              await sleep(50);
            }
          }
        } finally { await proxy.close(); }
      };
      try {
        const configs = serveConfigs(await this.json(["serve", "status", "--json"]));
        if (configs.some((config) => config.TCP?.[String(proxy.port)] !== undefined)) { await close(); continue; }
        const target = `http://127.0.0.1:${proxy.port}`;
        child = spawn(this.binary, ["serve", `--https=${proxy.port}`, target], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
        this.children.add(child);
        let failure: Error | undefined;
        child.once("error", (error) => { failure = error; });
        // Drain output without retaining review data or identity headers.
        child.stdout?.resume(); child.stderr?.resume();
        const deadline = Date.now() + 10_000;
        for (;;) {
          if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error("Tailscale Serve could not publish this review.");
          const active = serveConfigs(await this.json(["serve", "status", "--json"]));
          if (active.some((config) => config.TCP?.[String(proxy.port)] !== undefined
            && config.Web?.[`${identity.hostname}:${proxy.port}`]?.Handlers?.["/"]?.Proxy === target)) break;
          if (Date.now() > deadline) throw new Error("Tailscale Serve did not publish the review in time.");
          await sleep(100);
        }
        return { url: proxy.url, close };
      } catch (error) { await close(); throw error; }
    }
    throw new Error("Could not find an unused Tailscale review port.");
  }

  stopChildren() {
    for (const child of this.children) {
      if (serveAlive(child)) signalServe(child, "SIGTERM");
    }
  }
}
