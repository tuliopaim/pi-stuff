import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connectedSessionAdapter } from "../src/herdr-session.ts";

/** Load the maintained Herdr extension, unmodified, through the connected-session adapter. */
export default async function (pi: any) {
  const managed = await import(pathToFileURL(join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts")).href);
  const root = process.env["OPTCHAT_HOME"];
  if (!root) { managed.default(pi); return; }
  connectedSessionAdapter(managed.default, pi, join(root, "profiles", "main", "runs"));
}
