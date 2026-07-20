# My Pi setup

An opinionated [Pi](https://github.com/badlogic/pi-mono) configuration for day-to-day coding: focused subagents, multi-agent workflows, interactive questions, a useful status footer, reusable prompts and skills, and editor-assisted review.

Inspired by [Ben Davis's Pi setup](https://github.com/davis7dotsh/my-pi-setup), then adapted around my own models, dotfiles, and review workflow.

## What it adds

- **Focused subagents** for codebase reconnaissance, independent review, and intentional commits
- **Multi-agent workflows** for larger tasks that benefit from parallel or phased work
- **Interactive questions** with multiple-choice and free-form answers
- **A two-line footer** showing model, context usage, cost, generation speed, branch, and changed files
- **Fresh-context plan execution** with `/implement-plan`
- **Reusable prompts and skills**, including `/orchestrate`
- **Web research tools** through `pi-web-access`
- **Simplicity-focused coding guidance** through `ponytail`

## Subagents

Most delegated work does not need a workflow. Three tools run focused jobs in isolated child processes:

| Tool | Purpose | Access |
|---|---|---|
| `scout` | Trace code, locate relevant files, and answer a narrow reconnaissance question | Read-only |
| `review` | Review a change from a fresh context and report correctness, security, or regression risks | Read-only |
| `commit` | Inspect completed work, stage only the intended files, and create one or more commits | Git write access |

Each tool has its own model, reasoning level, timeout, prompt, and output limit, while sharing the same subprocess lifecycle and activity UI. Child agents cannot recursively delegate.

Model choices live in `agent/settings.json`. Switch the active set for the current session with:

```text
/subagent-preset
/subagent-preset opencode-go
/subagent-preset openai
```

The `/commit` command is a convenient front end for the same isolated commit agent. It only runs when explicitly requested. It reuses the tool-call presentation: a padded box that is gray while running and turns green on success or red on failure, streamed live above the editor and then recorded in the transcript. Press `Esc` while it runs to cancel; the cancelled run is kept in the transcript rather than discarded.

## Interactive questions

The `ask_user` tool lets the model pause and ask one question with 2–5 likely answers. The widget supports:

- arrow keys or number keys to select an option
- an optional description below each answer
- **Write my own answer…** for free-form input
- `Esc` to go back or dismiss

This avoids ambiguous prose exchanges when the real decision can be presented clearly as a small set of choices.

## Bottom widget

`agent/extensions/context-tokens-footer.ts` replaces Pi's footer with a compact two-line dashboard:

```text
~/dev/project                         provider/model · reasoning
34% 68k/200k · $0.42 · 71 tok/s       main · 3 files changed
```

It updates during generation and shows:

- current directory and selected model
- context tokens and percentage used
- accumulated session cost
- output tokens per second
- Git branch and changed-file count
- status messages published by extensions, such as running subagents or workflows

## Multi-agent workflows

The `workflow` tool is for substantial tasks that need parallel research, phased implementation, or independent synthesis. It runs a task-specific JavaScript orchestration script with four primitives:

- `phase(title)` — updates the visible phase
- `agent(prompt, options)` — starts one isolated agent
- `parallel([...])` — runs independent agents concurrently
- `args` — receives input supplied to the workflow

Workflows are sandboxed, capped at four concurrent agents and 32 agent calls, and persist artifacts under `~/.pi/agent/workflows/<runId>/`. They can run in the foreground or background. `/workflows` opens the dashboard for active and completed runs.

Every child selects its model and reasoning effort explicitly. The intended routing is:

- `opencode-go/deepseek-v4-flash` for reconnaissance and routine checks
- `opencode-go/kimi-k2.7-code` for implementation and integration
- `openai-codex/gpt-5.6-sol` for planning or consequential final review

Required child failures stop dependent phases rather than silently feeding them incomplete results. Schema-bound results are available when later phases need structured data.

### `/orchestrate`: plan, approve, implement

For a substantial implementation:

```text
/orchestrate Add organization-level API tokens
```

The first workflow researches the codebase, builds a plan, reviews it, and stops before editing. Refine the plan in the parent conversation, then continue explicitly:

```text
Approved, continue.
```

A second workflow implements and verifies the approved plan. The split is intentional: the conversation is the human review checkpoint, and nothing commits automatically.

Use `/skill:orchestrated-task <task>` as the direct alternative. For other large jobs, ask Pi to “use a workflow” and it will generate one for that task.

## Plans, prompts, and skills

### Fresh-context plan execution

`/implement-plan <path>` reads a Markdown plan, asks for confirmation, and starts a fresh Pi session containing only the plan and repository files. If no path is supplied, it checks common names such as `plans/PLAN.md` and `plan.md`.

```text
/implement-plan plans/PLAN.md
```

### Shared prompts and skills

`agent/settings.json` loads:

- prompts from `~/dotfiles/pi/agent/prompts`
- personal skills from `~/dotfiles/skills`
- all local extensions from `~/dotfiles/pi/agent/extensions`

The included prompt templates expose commands such as `/orchestrate`. Installed packages add `pi-web-access` for web search/content retrieval and `ponytail` for deliberately minimal, YAGNI-oriented implementation.

## Shared extension structure

The implementation is split by responsibility instead of placing everything in one extension:

```text
agent/
├── settings.json                 # models, packages, skills, prompts, extensions
├── extensions/
│   ├── delegation/               # scout, review, commit, and model presets
│   ├── workflows/                # sandbox, runner, dashboard, and artifacts
│   ├── shared/                   # child sessions, trust, timeouts, context, status
│   ├── ask-user.ts               # interactive question tool
│   ├── context-tokens-footer.ts  # bottom dashboard
│   └── implement-plan.ts         # fresh-context plan command
└── prompts/                      # reusable slash-command prompts
```

The shared child-session layer gives workflow children the normal global/package resources while preventing recursive delegation and respecting Pi's project trust decisions. Shared helpers also keep context reporting, activity text, and tool-call deadlines consistent.

## Setup

This repository expects to live at `~/dotfiles`, because the Pi settings reference paths under that directory.

Install the local extension dependencies:

```sh
npm install --prefix ~/dotfiles/pi/agent
```

Link the settings file manually:

```sh
mkdir -p ~/.pi/agent
ln -s ~/dotfiles/pi/agent/settings.json ~/.pi/agent/settings.json
```

Alternatively, the repository's Home Manager configuration or `symlinks.sh` creates that link. Apply Home Manager after configuration changes, then run `/reload` in Pi.

## Checks

Run all extension and prompt tests:

```sh
npm test --prefix ~/dotfiles/pi/agent
```

Run only workflow tests:

```sh
npm run --prefix ~/dotfiles/pi/agent test:workflows
```
