import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function createAskQuestionTool(onQuestion: (question: string) => void) {
  return defineTool({
    name: "ask_question",
    label: "Ask Orchestrator",
    description: "Ask the parent orchestrator one question, then stop and wait for its answer.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: "One clear freeform question" }),
    }),
    async execute(_id, params) {
      const question = params.question.trim();
      if (!question) throw new Error("Question must not be empty.");
      onQuestion(question);
      return {
        content: [{ type: "text", text: "Question sent. Stop now and wait for the orchestrator's answer." }],
        details: {},
        terminate: true,
      };
    },
  });
}
