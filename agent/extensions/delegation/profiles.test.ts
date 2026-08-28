import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSubagentProfiles, resolveProfileSkillPaths } from "./profiles.ts";

test("profile discovery applies trusted project overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-profiles-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "researcher.md"), `---\nname: researcher\ndescription: global\nroute: recon\ntools: websearch, webfetch\ntimeout: 10m\n---\nGlobal prompt`);
  writeFileSync(join(cwd, ".pi", "agents", "researcher.md"), `---\nname: researcher\ndescription: project\nmodel: test/model\nthinking: low\nmutating: false\n---\nProject prompt`);
  try {
    const untrusted = discoverSubagentProfiles({ agentDir, cwd, projectTrusted: false });
    assert.equal(untrusted.profiles[0].description, "global");
    const trusted = discoverSubagentProfiles({ agentDir, cwd, projectTrusted: true });
    assert.equal(trusted.profiles.length, 1);
    assert.equal(trusted.profiles[0].description, "project");
    assert.equal(trusted.profiles[0].prompt, "Project prompt");
    assert.equal(trusted.profiles[0].mutating, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("profile discovery reports malformed profiles", () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-profiles-bad-"));
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", "bad.md"), `---\nname: bad\nmodel: test/model\n---\nPrompt`);
  try {
    const result = discoverSubagentProfiles({ agentDir: root, cwd: root, projectTrusted: false });
    assert.equal(result.profiles.length, 0);
    assert.match(result.errors[0].error, /model.*thinking/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("profile skill names resolve to discovered skill files", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-profile-skills-"));
  const skillFile = join(root, "skills", "research", "SKILL.md");
  mkdirSync(join(root, "skills", "research"), { recursive: true });
  writeFileSync(skillFile, `---\nname: research\ndescription: Research docs\n---\n# Research`);
  try {
    const paths = await resolveProfileSkillPaths({ skills: ["research"], name: "researcher" } as any, {
      agentDir: root, cwd: root, projectTrusted: false,
    });
    assert.deepEqual(paths, [skillFile]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
