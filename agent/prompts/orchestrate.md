---
description: Implement a substantial task with the smallest useful multi-agent workflow
argument-hint: "<task>"
---
Orchestrate this task with the `workflow` tool, using the smallest useful workflow:

$ARGUMENTS

Efficiency rules:

- If one implementation agent can own it, use `agent` instead of `workflow`.
- Existing issues, reviews, or approved plans are sufficient planning context; do not plan them again.
- Treat an explicit request to fix known findings as implementation approval unless a blocking decision remains.
- Use at most two parallel reconnaissance agents, only when the parent lacks the relevant seams.
- Never chain planner, adversarial planner, and finalizer. Use at most one planning or review agent before implementation.
- Use at most three mutating agents. Prefer one broad owner over sequential specialists that must reread the same files.
- Give children only intended behavior, owned paths, and checks. Do not make every child reread every report.
- Keep results compact: summary, changed paths, checks, blockers.
- Add an integration agent only when multiple mutating agents changed connected contracts.
- Add one final Sol review only for security, data-loss, migration, or similarly consequential work.
- Do not automatically retry failures or launch a recovery workflow. Return control with the partial state and smallest next step.
- Do not create agents for baseline inventory, formatting, summaries, or commit grouping.

Use explicit model and effort on every child call. Do not commit unless explicitly requested.
