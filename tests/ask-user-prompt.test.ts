import assert from "node:assert/strict";
import test from "node:test";
import { buildAskUserResultMessage } from "../agent/extensions/shared/ask-user-prompt.ts";
import {
  buildResumedAnswerMessage,
  findLatestAskUserQuestion,
  findPendingAskUserQuestion,
} from "../agent/extensions/shared/ask-user-session.ts";

test("ask_user preserves selected and custom answers for the parent model", () => {
  assert.equal(
    buildAskUserResultMessage({ kind: "selected", answer: "Keep it", index: 2 }),
    "User selected option 2: Keep it",
  );
  assert.equal(
    buildAskUserResultMessage({ kind: "custom", answer: "Something else" }),
    "User wrote their own answer: Something else",
  );
});

const askCall = {
  type: "message",
  message: {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-1",
      name: "ask_user",
      arguments: {
        question: "Pick one?",
        options: [
          { label: "First", description: "The first choice" },
          { label: "Second" },
        ],
      },
    }],
  },
};

test("finds an interrupted ask_user call at the end of the active branch", () => {
  assert.deepEqual(findPendingAskUserQuestion([
    askCall,
    { type: "custom", customType: "other-extension" },
  ]), {
    toolCallId: "call-1",
    question: "Pick one?",
    options: [
      { label: "First", description: "The first choice" },
      { label: "Second" },
    ],
  });
});

test("does not auto-replay an ask_user call after conversation continued", () => {
  assert.equal(findPendingAskUserQuestion([
    askCall,
    { type: "message", message: { role: "user", content: "Continue" } },
  ]), undefined);
  assert.equal(findLatestAskUserQuestion([
    askCall,
    { type: "message", message: { role: "user", content: "Continue" } },
  ])?.toolCallId, "call-1");
});

test("formats replayed selections and custom answers as user messages", () => {
  assert.equal(
    buildResumedAnswerMessage({ answer: "Second", wasCustom: false, index: 2 }),
    "Answer to the interrupted question: option 2: Second",
  );
  assert.equal(
    buildResumedAnswerMessage({ answer: "My answer", wasCustom: true }),
    "Answer to the interrupted question: My answer",
  );
});
