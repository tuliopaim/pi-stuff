import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function lastMessageMarkdown(entries: any[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "message" || !["assistant", "user"].includes(entry.message.role)) continue;

    const { content } = entry.message;
    const text = typeof content === "string"
      ? content
      : content.filter((block: { type: string }) => block.type === "text")
          .map((block: { type: string; text?: string }) => block.text)
          .join("\n\n");
    return text.trim() || undefined;
  }
}

export default function markdown(pi: ExtensionAPI) {
  pi.registerCommand("markdown", {
    description: "Save the last message to a Markdown file",
    handler: async (args, ctx) => {
      const content = lastMessageMarkdown(ctx.sessionManager.getBranch());
      if (!content) {
        ctx.ui.notify("No text message to save", "error");
        return;
      }

      const path = resolve(ctx.cwd, args.trim() || "last-message.md");
      try {
        await writeFile(path, `${content}\n`, "utf8");
        ctx.ui.notify(`Saved ${path}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not save Markdown: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
