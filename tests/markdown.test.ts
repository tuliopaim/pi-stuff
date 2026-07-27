import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import markdown from "../agent/extensions/markdown.ts";

test("/markdown saves the last conversational message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-markdown-"));
  let command: any;
  const notifications: string[] = [];

  markdown({ registerCommand: (_name: string, value: any) => { command = value; } } as any);

  try {
    await command.handler("answer.md", {
      cwd,
      sessionManager: { getBranch: () => [
        { type: "message", message: { role: "user", content: "Question" } },
        { type: "message", message: { role: "assistant", content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "# Answer" },
          { type: "text", text: "Details" },
        ] } },
      ] },
      ui: { notify: (message: string) => notifications.push(message) },
    });

    assert.equal(await readFile(join(cwd, "answer.md"), "utf8"), "# Answer\n\nDetails\n");
    assert.match(notifications[0], /Saved .*answer\.md$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
