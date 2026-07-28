---
description: Implement a substantial task with the smallest useful multi-agent workflow
argument-hint: "<task>"
---
Orchestrate this task with the `workflow` tool, using the smallest useful workflow:

$ARGUMENTS

Efficiency rules:

- Use the fewest agents that materially reduce context, uncertainty, or elapsed time: zero for clear local work, one for one self-contained workstream, and two to four only for independent fan-out or real phase dependencies.
- If one implementation agent can own it, use `agent` instead of `workflow`.
- Existing issues, reviews, or approved plans are sufficient planning context; do not plan them again.
- Treat an explicit request to fix known findings as implementation approval unless a blocking decision remains.
- Use one reconnaissance agent by default; use two only for independent questions that would otherwise make one assignment broad or duplicative.
- Never chain planner, adversarial planner, and finalizer. Use at most one planning or review agent before implementation.
- Subagents share the working tree. Use at most one mutating agent in the workflow and prefer one broad implementation owner for connected changes.
- Give children only intended behavior, owned paths, and checks. Do not make every child reread every report.
- Keep results compact: summary, changed paths, checks, blockers.
- Add a separate integration check only when independently changed contracts genuinely need it; do not create one by default.
- Add one final Sol review only for security, data-loss, migration, or similarly consequential work.
- Do not automatically retry failures or launch a recovery workflow. Return control with the partial state and smallest next step.
- Do not create agents for baseline inventory, formatting, summaries, or commit grouping.

Use explicit model and effort on every child call. Do not commit unless explicitly requested.
