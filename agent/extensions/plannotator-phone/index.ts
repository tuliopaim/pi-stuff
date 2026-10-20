import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ReviewLinks, type Registry } from "./manager.ts";
import { TailnetPublisher } from "./tailnet.ts";

type State = { links: ReviewLinks; publisher: TailnetPublisher; timer?: ReturnType<typeof setInterval>; previousRemote?: string };
const shared = globalThis as typeof globalThis & {
  __plannotatorPhone_v1?: State;
  __plannotatorPiReviewRegistry_v1?: Registry;
};
const configPath = join(homedir(), ".config", "pi", "plannotator-phone.json");

export default function plannotatorPhone(pi: ExtensionAPI) {
  const token = {};
  let active = false;
  const discover = () => {
    const state = shared.__plannotatorPhone_v1, registry = shared.__plannotatorPiReviewRegistry_v1;
    if (state && registry && typeof registry.add === "function" && typeof registry.remove === "function" && typeof registry.openAll === "function") {
      state.links.attach(registry);
      clearInterval(state.timer); state.timer = undefined;
      return true;
    }
    return false;
  };
  pi.on("session_start", async (_event, ctx) => {
    active = false;
    let config: { enabled?: boolean; tailscale?: string } = {};
    try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { /* Opt in per machine. */ }
    if (config.enabled !== true || ctx.mode !== "tui") {
      const state = shared.__plannotatorPhone_v1;
      if (state) {
        clearInterval(state.timer); await state.links.stop();
        if (process.env.PLANNOTATOR_REMOTE === "0") {
          if (state.previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
          else process.env.PLANNOTATOR_REMOTE = state.previousRemote;
        }
      }
      return;
    }
    active = true;
    if (!shared.__plannotatorPhone_v1) {
      const publisher = new TailnetPublisher(config.tailscale || "tailscale");
      shared.__plannotatorPhone_v1 = { publisher, links: new ReviewLinks((url) => publisher.publish(url)), previousRemote: process.env.PLANNOTATOR_REMOTE };
      process.once("exit", () => publisher.stopChildren());
    }
    const state = shared.__plannotatorPhone_v1;
    // Native reviews stay loopback-only, including Pi sessions started through SSH.
    process.env.PLANNOTATOR_REMOTE = "0";
    state.links.reportWith({
      owner: ctx.sessionManager.getSessionId(), token,
      ready: (review, url) => pi.sendMessage({
        customType: "plannotator-phone", content: `Plannotator: ${review.subject}\n\n[Open review on your phone](${url})`, display: true,
        details: { reviewId: review.id, url },
      }, { triggerTurn: false }),
      error: (message) => ctx.ui.notify(`Plannotator phone: ${message}`, "warning"),
    });
    clearInterval(state.timer); discover();
    if (!shared.__plannotatorPiReviewRegistry_v1) {
      const deadline = Date.now() + 10_000;
      state.timer = setInterval(() => { discover(); if (Date.now() > deadline) clearInterval(state.timer); }, 250);
      state.timer.unref();
    }
  });
  pi.on("session_shutdown", async (event) => {
    const state = shared.__plannotatorPhone_v1;
    if (!state) return;
    state.links.clearReporter(token);
    if (event.reason === "quit") { clearInterval(state.timer); await state.links.stop(); }
  });
  pi.on("context", (event) => ({ messages: event.messages.filter((message) => !(message.role === "custom" && message.customType === "plannotator-phone")) }));
  pi.registerCommand("phone-reviews", {
    description: "Show private phone links for this Pi session's open Plannotator reviews",
    handler: async (_args, ctx) => {
      if (!active || !shared.__plannotatorPhone_v1) { ctx.ui.notify("Plannotator phone links are disabled on this machine.", "warning"); return; }
      if (!discover()) { ctx.ui.notify("Plannotator review tracking is unavailable. Load the Plannotator extension and reload Pi.", "warning"); return; }
      const reviews = await shared.__plannotatorPhone_v1.links.list(ctx.sessionManager.getSessionId());
      pi.sendMessage({ customType: "plannotator-phone", display: true,
        content: reviews.length ? reviews.map((review) => `${review.subject}\n${review.url ? `[Open review](${review.url})` : review.error || "Publishing link…"}`).join("\n\n") : "No open Plannotator reviews in this session.",
      }, { triggerTurn: false });
    },
  });
}
