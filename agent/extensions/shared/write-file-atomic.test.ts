import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeFileAtomic } from "./write-file-atomic.ts";

test("atomic writes leave complete readable content", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-atomic-test-"));
  try {
    const file = join(directory, "artifact.json");
    writeFileAtomic(file, '{"value":1}');
    writeFileAtomic(file, '{"value":2}');
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { value: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
