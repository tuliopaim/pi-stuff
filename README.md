# My Pi setup

An opinionated [Pi](https://github.com/badlogic/pi-mono) configuration for day-to-day coding: focused subagents, multi-agent workflows, interactive questions, a useful status footer, reusable prompts and skills, and editor-assisted review.

Inspired by [Ben Davis's Pi setup](https://github.com/davis7dotsh/my-pi-setup), then adapted around my own models, dotfiles, and review workflow.

## What it adds

- **Focused subagents** for codebase reconnaissance, independent review, and intentional commits
- **Multi-agent workflows** for larger tasks that benefit from parallel or phased work
- **Interactive questions** with multiple-choice and free-form answers
- **A two-line footer** showing model, context usage, cost, generation speed, branch, and changed files
- **Fresh-context plan execution** with `/implement-plan`
- **Reusable prompts and skills**, including `/workflow`
- **Browser-free web research tools** through the local `web-tools` extension

## Subagents

Most delegated work does not need a workflow. Three tools run focused jobs in isolated child processes:

| Tool | Purpose | Access |
|---|---|---|
| `scout` | Trace code, locate relevant files, and answer a narrow reconnaissance question | Read-only |
| `review` | Review a change from a fresh context and report correctness, security, or regression risks | Read-only |
| `commit` | Inspect completed work, stage only the intended files, and create one or more commits | Git write access |

Each tool has its own timeout, prompt, and output limit, while sharing the same subprocess lifecycle and activity UI. Child agents cannot recursively delegate.

Models are not hardwired per tool. They resolve through one precedence ladder:

1. **Explicit pick** — if you name a model or lane in your prompt ("use ox-alpha-free high"), the agent passes a `route` argument on every delegation call for that task. It overrides everything below.
2. **Preset roles** — otherwise each tool uses its role mapping from the active preset (`scout → recon`, `review → deep`, …).
3. **Built-in fallbacks** — only when no preset is active at all.

A `route` accepts either a lane id (`ox`) or an exact provider/model string (`opencode-go/ox-alpha-free`), so prose maps onto lanes without string gymnastics. The resolved model is visible on every call and result card.

Model choices live in `agent/settings.json`. Switch the active set for the current session with:

```text
/subagent-preset
/subagent-preset opencode-go
/subagent-preset openai
/subagent-preset copilot
```

### Agent routes

Each preset defines an `agent.routes` list — named lanes that are the single
vocabulary for child model selection. A route is an `id`, a `model`, a
`thinking` level, and short `guidance` describing when to use it:

```json
{ "id": "ox", "model": "opencode-go/ox-alpha-free", "thinking": "high", "guidance": "long multi-step implementations, cross-module refactors, hard debugging" }
```

The same list drives three things:

- **Roles** — `scout`, `review`, and `commit` pin their default lane by route id.
- **Dynamic tools** — `agent`, `subagent_spawn`, and workflow `agent()` calls must use a configured model/thinking pair (unless the preset sets `offRoute: "allow"`).
- **Explicit picks** — a `route` argument on any delegation call references a lane by id or provider/model string.

When a preset has routes configured, anything outside the list is rejected
before spawning a child. Presets without routes retain the unrestricted default.
See the available routes for the current session by calling any dynamic subagent
tool with a disallowed model/thinking pair — the error message lists the permitted
routes.

### Prompting for specific models

Say it like a human; the agent translates your words into a `route` argument:

```text
/delegate review the last commit, see if we changed anything we didn't have to
```
→ scout lands on `recon`, review on `deep`. Nothing to say.

```text
/delegate review the last commit ... use ox-alpha-free high for everything
```
→ every child this task resolves through the `ox` lane.

```text
/delegate check two things in parallel: (1) did the migration drop any MapEnum
calls beyond the known list, (2) does anything still reference Pomelo?
Put (1) on recon but do (2) on ox — it needs broad context.
```
→ one scout per question, each with its own lane, visible per call.

For larger jobs see [Multi-agent workflows](#multi-agent-workflows): `/workflow`
for phased or parallel orchestration, `subagent_spawn` for long-running work in
separate working trees. Lanes are picked per child either from the routes'
guidance text ("planner on deep, implementation owner on ox") or from an
explicit pick in your prompt.

### Mac mini default

The Mac mini ships with `PI_SUBAGENT_PRESET=copilot` in its Nix host configuration
(`nix/macos/hosts/macmini.nix`). This routes all subagent traffic through GitHub
Copilot models for workplace isolation. The session-level `/subagent-preset`
command still takes priority over the environment variable.

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

Generic agents and workflows are dormant by default. Enable them for one task with:

```text
/delegate Add organization-level API tokens
```

`/delegate` is the umbrella command: Pi chooses whether the task needs one agent,
several persistent subagents, or a workflow. To explicitly require a model-authored
workflow, use:

```text
/workflow Scout this repository with five Luna agents
```

An explicit natural-language request such as “run a workflow for this task” has
the same activation behavior as `/workflow`.

The `agent`, `subagent_*`, and `workflow` tools are removed again when that run settles. The focused `scout`, `review`, and `commit` tools remain available normally.

The `workflow` tool is for substantial tasks that need parallel research, phased implementation, or independent synthesis. It runs a task-specific JavaScript orchestration script with four primitives:

- `phase(title)` — updates the visible phase
- `agent(prompt, options)` — starts one isolated agent
- `parallel([...])` — runs independent agents concurrently
- `args` — receives input supplied to the workflow

Workflows are sandboxed, capped at four concurrent agents and 32 agent calls, and persist artifacts under `~/.pi/agent/workflows/<runId>/`. They can run in the foreground or background. `/workflows` opens the dashboard for active and completed runs.

Every child selects its model and reasoning effort explicitly. The active
subagent preset defines which model/thinking combinations are allowed; see the
`agent.routes` in `agent/settings.json` for each preset's routing rules.
Requests outside the configured routes are rejected before spawning.

For example, the `personal` preset routes:
- `opencode-go/deepseek-v4-flash:medium` for reconnaissance
- `opencode-go/kimi-k2.7-code:high` for implementation
- `openai-codex/gpt-5.6-sol:medium` or `:high` for difficult or consequential work

Required child failures stop dependent phases rather than silently feeding them incomplete results. Schema-bound results are available when later phases need structured data.

### `/workflow`: explicit multi-agent orchestration

For a substantial implementation:

```text
/workflow Add organization-level API tokens
```

Pi always invokes the `workflow` tool for this command. It keeps the workflow lean,
skips redundant planning when existing context defines the work, and uses at most one
mutating child because children share the working tree. Nothing commits automatically.

For other large jobs, ask Pi to “use a workflow” and it will generate one for that task.

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

The included prompt templates expose commands such as `/workflow`. The local `web-tools` extension provides browser-free public web search and content retrieval.

## Shared extension structure

The implementation is split by responsibility instead of placing everything in one extension:

```text
agent/
├── settings.json                 # models, packages, skills, prompts, extensions
├── extensions/
│   ├── delegation/               # scout, review, commit, and model presets
│   ├── web-tools/                 # browser-free public web search and fetch
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

**Install the extension dependencies before starting Pi on every new machine:**

```sh
npm ci --prefix ~/dotfiles/pi/agent
```

Do not use `pi install ~/dotfiles/pi/agent/extensions` for this. Local-path installs only register the extension directory; they do not install its npm dependencies. The included settings already load that directory.

If Pi reports `Cannot find module 'html-to-text'` (or another web-tools dependency), rerun the `npm ci` command above.

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

Run the web-tools checks:

```sh
npm run --prefix ~/dotfiles/pi/agent test:web-tools
npm run --prefix ~/dotfiles/pi/agent typecheck:web-tools
```
