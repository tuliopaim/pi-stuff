---
description: Set up a worktree and workspace with the GPT-6 Luna setup agent
argument-hint: "<task> [repo, base, app]"
---
Delegate this setup request to the named "setup-wt" agent using the agent tool:

$ARGUMENTS

Supply the current repository's absolute path and any relevant task, repository, branch, base, and app choices from the conversation. Setup alone does not authorize implementation. Do not create the worktree yourself. Handle any questions from the child, asking the user when needed, then relay its verified result and incomplete steps.
