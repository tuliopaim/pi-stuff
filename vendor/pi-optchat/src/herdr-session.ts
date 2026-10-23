import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Only the owner's explicit path in this connected profile is trusted; never search by cwd. */
export function trustedTranscript(value: unknown, runs: string): string | null {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || !value.endsWith(".jsonl")) return null;
  try {
    const root = realpathSync(runs);
    let file: string;
    try { file = realpathSync(value); } catch {
      // Pi can announce its next file before writing it; broken symlinks are not unwritten files.
      try { lstatSync(value); return null; } catch (error: any) { if (error.code !== "ENOENT") return null; }
      file = join(realpathSync(dirname(value)), basename(value));
    }
    const inside = relative(root, file);
    return inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? file : null;
  } catch { return null; }
}

// This adapter deliberately shares the managed integration's sequence counter and state reporter.
// A second independent herdr:pi reporter would invalidate its sequence numbers and freeze status.
export function connectedSessionAdapter(install: (pi: any) => unknown, pi: any, runs: string) {
  let context: any;
  let reference: string | null = null;
  let start: ((event: any, ctx: any) => unknown) | undefined;
  const withReference = (ctx: any) => !ctx || !reference ? ctx : new Proxy(ctx, {
    get(target, key) {
      if (key !== "sessionManager") return Reflect.get(target, key);
      return new Proxy(target.sessionManager, {
        get(manager, property) {
          if (property === "getSessionFile") return () => reference;
          const value = Reflect.get(manager, property);
          return typeof value === "function" ? value.bind(manager) : value;
        },
      });
    },
  });
  const wrapped = new Proxy(pi, {
    get(target, key) {
      if (key !== "on") return Reflect.get(target, key);
      return (event: string, handler: (event: any, ctx: any) => unknown) => {
        if (event === "session_start") start = handler;
        return pi.on(event, (data: any, ctx: any) => {
          if (event === "session_start") { reference = null; context = ctx; }
          return handler(data, withReference(ctx));
        });
      };
    },
  });
  install(wrapped);
  // The connected-window event is emitted only after its owner's validated started frame.
  // Keep the final transcript on completion/disconnect; the next real session_start resets it.
  pi.events.on("optchat:transcript", async (data: unknown) => {
    if (!context || context.mode !== "tui" || !start || !data || typeof data !== "object") return;
    const path = trustedTranscript((data as { path?: unknown }).path, resolve(runs));
    if (!path) return;
    reference = path;
    await start({ reason: "resume" }, withReference(context));
  });
}
