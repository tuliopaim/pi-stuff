# Domain context

## Delegation

Delegation runs a self-contained task in a Pi Durable conversation. Named agents select a model, thinking level, instructions, tools, and skills. The default agent handles useful handoffs without a specialist. Scout, review, and commit are shortcuts for named agents.

## Subagent preset

A subagent preset overrides named agents' models and thinking levels for the current Pi session. Configuration lives in agents.json, without separate model lanes or role mappings.

## Agent job

An agent job is one durable child conversation and its current submission. Background jobs keep working after the parent turn and resume when the parent session reopens. Only one mutating job may run per working tree, with at most four jobs running per parent session.

Jobs have stable unique names as well as UUIDs. A child can use `ask_question` to park the job while the parent decides. Waiting jobs hold neither a running slot nor a mutation reservation after their tools stop. A parent answer continues the same child conversation. Pending questions persist across restarts, and parked time does not consume the active-time budget.
