export interface AskUserQuestion {
  toolCallId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
}

interface SessionEntryLike {
  type?: string;
  customType?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function questionFromEntry(entry: SessionEntryLike): AskUserQuestion | undefined {
  if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) {
    return undefined;
  }

  for (let index = entry.message.content.length - 1; index >= 0; index--) {
    const block = entry.message.content[index] as {
      type?: string;
      id?: string;
      name?: string;
      arguments?: unknown;
    };
    if (block.type !== "toolCall" || block.name !== "ask_user" || typeof block.id !== "string") continue;

    const args = block.arguments as {
      question?: unknown;
      options?: unknown;
    } | undefined;
    if (typeof args?.question !== "string" || !Array.isArray(args.options)) continue;

    const options: AskUserQuestion["options"] = [];
    for (const option of args.options) {
      if (!option || typeof option !== "object" || typeof (option as { label?: unknown }).label !== "string") {
        return undefined;
      }
      const rawDescription = (option as { description?: unknown }).description;
      if (rawDescription !== undefined && typeof rawDescription !== "string") return undefined;
      const description = rawDescription as string | undefined;
      options.push({
        label: (option as { label: string }).label,
        ...(description === undefined ? {} : { description }),
      });
    }

    if (options.length < 2 || options.length > 5) return undefined;
    return { toolCallId: block.id, question: args.question, options };
  }

  return undefined;
}

export function findPendingAskUserQuestion(branch: readonly SessionEntryLike[]): AskUserQuestion | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== "message") continue;
    return questionFromEntry(entry);
  }
  return undefined;
}

export function findLatestAskUserQuestion(branch: readonly SessionEntryLike[]): AskUserQuestion | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const question = questionFromEntry(branch[index]!);
    if (question) return question;
  }
  return undefined;
}

export function buildResumedAnswerMessage(
  result: { answer: string; wasCustom: boolean; index?: number },
): string {
  if (result.wasCustom) return `Answer to the interrupted question: ${result.answer}`;
  return `Answer to the interrupted question: option ${result.index}: ${result.answer}`;
}
