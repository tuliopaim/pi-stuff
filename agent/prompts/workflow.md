---
description: Run a task through an explicit model-authored multi-agent workflow
argument-hint: "<task>"
---
Run this task with the `workflow` tool. The user explicitly requested a workflow; do not replace it with direct `agent` or `subagent_*` calls:

$ARGUMENTS

Workflow rules:

- Build the smallest workflow that satisfies the requested shape and dependencies.
- Existing issues, reviews, or approved plans are sufficient planning context; do not plan them again.
- Treat an explicit request to fix known findings as implementation approval unless a blocking decision remains.
- Use reconnaissance agents only for genuinely independent questions.
- Never chain planner, adversarial planner, and finalizer. Use at most one planning or review phase before implementation.
- Subagents share the working tree. Use at most one mutating agent and prefer one broad implementation owner for connected changes.
- At most four children run concurrently; additional requested calls must queue in the workflow.
- Give children only intended behavior, owned paths, and checks. Do not make every child reread every report.
- Keep results compact: summary, changed paths, checks, blockers.
- Add an integration or final-review phase only when independently changed contracts or consequential risk justify it.
- Do not automatically retry failures or launch a recovery workflow. Return control with the partial state and smallest next step.
- Do not create agents for baseline inventory, formatting, summaries, or commit grouping.

Use an explicit model and effort on every child call. Do not commit unless explicitly requested.
