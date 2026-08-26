import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentStatusText,
  transcriptEntriesForDisplay,
  workflowErrorForDisplay,
  wrapDashboardError,
} from "./dashboard.ts";
import {
  emptyUsage,
  type AgentRecord,
  type Theme,
  type WorkflowDetails,
} from "./model.ts";

const ERROR =
  "Agent received no assistant response event for deepseek-v4-flash within 45 seconds; the provider request may be stalled. Retry the workflow.";

const theme = new Proxy(
  {},
  {
    get() {
      return (_color: string, text: string) => text;
    },
  },
) as Theme;

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    index: 1,
    label: "History and intent",
    phase: "Reconnaissance",
    state: "error",
    model: "deepseek-v4-flash",
    startedAt: 1,
    finishedAt: 45_001,
    error: ERROR,
    preview: "",
    usage: emptyUsage(),
    transcript: [],
    ...overrides,
  };
}

test("dashboard error rows wrap the complete message", () => {
  const rows = wrapDashboardError(ERROR, 48, theme, "       ");
  assert.ok(rows.length > 1);
  assert.equal(
    rows.some((row) => row.includes("…")),
    false,
  );
  assert.match(rows.join(" "), /provider request may be\s+stalled/);
  assert.match(rows.join(" "), /Retry the workflow\./);
});

test("agent transcript includes its terminal error when the provider was silent", () => {
  const entries = transcriptEntriesForDisplay(agent());
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    role: "toolResult",
    name: "agent",
    text: ERROR,
    isError: true,
  });
});

test("running agent exposes its immediate retry state", () => {
  assert.match(
    agentStatusText(agent({ state: "running", retries: 1, error: undefined })),
    /retrying 1\/1/,
  );
});

test("first-response failure has a compact row summary", () => {
  assert.match(
    agentStatusText(agent({ errorKind: "first_response_timeout" })),
    /failed: no first response/,
  );
});

test("workflow error is hidden when it only repeats an agent error", () => {
  const failedAgent = agent();
  const details = {
    runId: "wf_fixture",
    background: false,
    status: "failed",
    startedAt: 1,
    phases: [],
    agents: [failedAgent],
    error: `Required agent failed: agent "History and intent": ${ERROR}`,
  } satisfies WorkflowDetails;
  assert.equal(workflowErrorForDisplay(details), undefined);

  details.error = "Artifact persistence failed";
  assert.equal(workflowErrorForDisplay(details), "Artifact persistence failed");
});
