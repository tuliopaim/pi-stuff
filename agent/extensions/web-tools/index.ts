import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebFetchTool } from "./webfetch.ts";
import { createWebSearchTool } from "./websearch.ts";

export default function webToolsExtension(pi: ExtensionAPI) {
	// The factories preserve their narrower renderer argument types for direct tests.
	// Pi validates tool inputs before invoking them, so widen only at registration.
	pi.registerTool(createWebFetchTool() as any);
	pi.registerTool(createWebSearchTool() as any);
}
