# My Pi setup

My [Pi](https://github.com/earendil-works/pi) configuration for coding: named subagents, multi-agent workflows, interactive questions, a status footer, reusable prompts and skills, and editor-assisted review.

## Subagents

Subagents use Pi 1.0's experimental [Pi Durable](https://earendil.com/posts/pi-durable/) package. Each job has its own conversation, model, instructions, tools, skills, and working directory. Durable handles transcripts, model retries, compaction, interrupted tool calls, and recovery.

| Agent | Purpose | Default model | Access |
|---|---|---|---|
| `explore` | Focused codebase reconnaissance | GPT-6 Luna | Read-only |
| `review` | Independent correctness and security review | GPT-6 Astra | Read-only |
| `plan` | Planning and design decisions | GPT-6 Astra | Read-only |
| `default` | Implementation and useful handoffs without a specialist | DeepSeek V4.1 Flash | Read, shell, edit, write |
| `commit` | Intentional commits, only when requested | GPT-6 Luna | Read and shell |
| `setup-wt` | Task worktree and workspace setup, no implementation | GPT-6 Luna | Read and shell |

The parent can use the `default` agent whenever a self-contained handoff is useful. You do not need to request delegation or choose a specialist first. The `scout`, `review`, and `commit` tools remain shortcuts to the corresponding named agents.

Use `/setup-wt <task> [repo, base, app]` to delegate to the setup agent. It follows the shared `setup-wt` skill and defaults to a Herdr workspace through `hsw`. The command is a prompt template, so the parent handles clarification questions.

### Configure agents

Run `/agents configure` to pick an agent, model, and supported thinking level. Changes apply to new jobs immediately and are saved in `~/.pi/agent/agents.json`.

The checked-in defaults are in [`agent/agents.json`](agent/agents.json). Personal configuration overrides only the fields you set. Add a custom agent or change instructions, tools, skills, or the total time limit by editing the same JSON file:

```json
{
  "agents": {
    "default": {
      "model": "openai-codex/gpt-6-sol",
      "thinking": "medium"
    },
    "research": {
      "model": "openai-codex/gpt-6-luna",
      "thinking": "high",
      "description": "Read-only research",
      "tools": ["read", "grep", "find", "ls"],
      "instructions": "Find evidence and cite exact files. Do not modify files.",
      "timeoutMinutes": 20
    }
  }
}
```

Custom agents inherit unspecified fields from `default`. Existing agents retain their own unspecified fields. Supported tools are `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`. Skills load normally unless you set `skills` to an explicit list of paths, `[]` for none, or `["*"]` for all.

Presets are optional model/thinking overrides keyed directly by agent name. There are no separate lanes or role maps:

```json
{
  "preset": "personal",
  "presets": {
    "personal": {},
    "budget": {
      "review": { "model": "openai-codex/gpt-6-luna", "thinking": "high" }
    }
  }
}
```

Switch with `/agents preset budget` or `/subagent-preset budget`. The selection is saved in the parent session. `PI_SUBAGENT_PRESET` sets the machine default; a session selection takes priority. Built-in presets are `personal`, `openai`, `opencode-go`, and `copilot`. The `copilot` preset permits only GitHub Copilot models, including explicit overrides and custom agents.

### Run and manage jobs

The model uses one tool:

```js
agent({ task: "Implement the scoped change and run its tests" }) // default agent
agent({ agent: "plan", task: "Plan the migration; do not implement" })
agent({ agent: "explore", task: "Trace the cache invalidation callers", background: true })
agent({ task: "Inspect API failures", name: "inspect-api", title: "API failure paths" })
agent({ action: "list" })
agent({ action: "status", id: "job-id" })
agent({ action: "wait", id: "job-id" })
agent({ action: "message", id: "job-id", task: "Check the error path too" })
agent({ action: "cancel", id: "job-id" })
```

An explicit `route` accepts an agent name or `provider/model[:thinking]`. It changes only the model and thinking level, never the selected agent's tools or instructions. Old lane names such as `recon` and `deep` still resolve for existing prompts.

Foreground calls wait for an answer or a question. Every child has `ask_question`: it records a question, stops its turn, and waits for the parent. The parent answers with `agent({ action: "message", id: "job-name", task: "answer" })`, which resumes the same conversation. Waiting releases the running-job slot and mutation reservation only after the child stops. Questions survive restarts.

Background calls return a job name and UUID and report results and questions to the parent automatically. Management actions accept either identifier. Names are unique lowercase handles; optional `name` and `title` fields make important jobs easier to find.

`/agents` opens the live dashboard, newest jobs first, with status, start/end times, duration, and timelines. Use `j/k` to select, Enter to inspect the transcript, `i` to send guidance or answer a question, and `x` to abort, including waiting jobs. The inspector shows usage, cost, context occupancy, conversation ID, and queued guidance. Press `o` to load another 100 history entries. `c` opens configuration and `p` switches presets. `/agents <job-name-or-id>` opens a job directly. RPC clients retain native dialogs. The editor widget shows recent background jobs, questions, stalled activity, and completion counts.

There can be four running jobs per parent session and one mutating child per working tree. Shell access counts as mutating. Do not edit the same working tree while a mutating child owns it. Independent mutating work belongs in separate worktrees. Foreground cancellation stops its job; cancelling a wait for a background job leaves that job running.

Jobs have a 30-minute active-time limit by default, including elapsed active time before a restart but excluding time parked for a parent answer. A minute without activity marks a job stalled; five minutes cancels it. Provider requests have a two-minute timeout, and each coding tool has an independent three-minute timeout. Mutation ownership remains held until tool execution actually stops. Output is capped at 300 lines or 32 KiB; reports include the database and conversation ID when truncated. Each conversation records its own token usage and cost. Context occupancy uses the last reported model usage, not a live tokenizer. Foreground tool results also report usage to the parent session.

### Restart behavior and limits

Each parent session owns `~/.pi/agent/subagents/<session-id>.sqlite`. A lock prevents two processes from opening the same database. Reopen the parent session to resume unfinished jobs, including interrupted foreground jobs. Settled, undelivered background results are also recovered. Messages continue the same child conversation; active messages steer it at the next turn boundary.

With `--no-session`, jobs use memory too. Restart recovery requires a saved parent session.

Read-only tools are replay-safe. Interrupted shell, edit, and write calls are not replayed automatically; the model sees the interruption and decides what to do. Shutdown closes storage without aborting durable jobs. A process must be running for jobs to make progress; this extension is not a daemon.

Children use Pi's built-in tools and trust-aware project instructions and skills. They can ask the parent questions, but cannot open user dialogs or message peers directly. They still do not load executable extensions, inherit the parent's conversation, or recursively delegate. Tool restrictions are not an operating-system sandbox.

This replaces the old `subagent_*` tool family, Markdown agent profiles, session modes, and `/btw`. Old JSON registries and child session files are left untouched, but are not imported into Durable. These compatibility features and executable extension inheritance remain unrestored. `/commit` shows its task immediately, then elapsed time, model, and recent tool activity while it runs. Escape cancels it. Success, failure, and cancellation leave a result in the conversation, including failures during setup. Delegation tool cards show model, time, activity, usage, and expandable task/instructions.

## Interactive questions

The `ask_user` tool asks one question with 2–5 likely answers and a free-form fallback. Arrow keys or number keys select an option; Escape goes back or dismisses it.

## Status footer

`agent/extensions/context-tokens-footer.ts` provides a two-line footer:

```text
~/dev/project                         provider/model · reasoning
34% 68k/200k · $0.42 · 71 tok/s       main · 3 files changed
```

It shows the working directory, selected model, context usage, session cost, generation speed, branch, changed-file count, and extension status messages.

## Multi-agent workflows

Named agents are always available. Workflows remain opt-in:

```text
/delegate Add organization-level API tokens
/workflow Scout this repository with several agents
```

`/delegate` lets the parent choose how to hand off work. `/workflow`, or an explicit request to run a workflow, enables the `workflow` tool for one run and requires a model-authored orchestration script. The workflow tool becomes inactive when that run settles; `agent`, `scout`, `review`, and `commit` stay available.

Workflows support `phase(title)`, `agent(prompt, options)`, `parallel([...])`, and `args`. They run sandboxed scripts, cap concurrency at four children and total calls at 32, and save artifacts under `~/.pi/agent/workflows/<runId>/`. `/workflows` opens their existing dashboard. Workflows still use the coding-agent SDK; this change ports the subagent module, not the separate workflow runner.

Each workflow child supplies an explicit model and reasoning effort. Allowed pairs come from the active named-agent configuration. Required child failures stop dependent phases. Schema-bound results are available for structured handoffs. Connected implementation stays with at most one mutating child, and nothing commits automatically.

## Plans, prompts, and skills

`/implement-plan <path>` reads a Markdown plan, asks for confirmation, and starts a fresh Pi session containing the plan and repository files. Without a path, it checks names such as `plans/PLAN.md` and `plan.md`.

Settings load prompts from `~/dotfiles/pi/agent/prompts` and extensions from `~/dotfiles/pi/agent/extensions`. Pi discovers shared skills through `~/.agents/skills`; see [skill ownership](../skills/README.md). Package-managed skills, including Ponytail, remain deliberate exceptions. The local `web-tools` extension provides public web search and retrieval.

## Files

```text
agent/
├── agents.json                   # named agents and optional model presets
├── settings.json                 # parent models, packages, skills, and resource paths
├── extensions/
│   ├── delegation/               # config, Durable jobs, tools, and native dialogs
│   ├── web-tools/                # public web search and fetch
│   ├── workflows/                # existing workflow runner and dashboard
│   ├── shared/                   # resource loading, trust, timeouts, and status
│   ├── ask-user.ts
│   ├── context-tokens-footer.ts
│   └── implement-plan.ts
└── prompts/
```

## Setup

This repository expects to live at `~/dotfiles`. Install extension dependencies on each machine, with Pi 1.0 and Node 22.22.2 or newer. Pi itself supports Node 22.19, which also passes this setup's checks, but one upstream dependency requests the newer patch release.

```sh
npm ci --prefix ~/dotfiles/pi/agent
```

The included settings already load the extensions. A local `pi install` does not install their npm dependencies. Home Manager or `symlinks.sh` links the settings, or link them manually:

```sh
mkdir -p ~/.pi/agent
ln -s ~/dotfiles/pi/agent/settings.json ~/.pi/agent/settings.json
```

After updating dependencies and deployment settings, run `/reload`. You do not need to link `agents.json`: the extension reads the checked-in defaults and any writable personal override automatically.

Pi 1.0's published shrinkwrap pins `brace-expansion` 5.0.9 in the host package. A full `npm audit` reports upstream denial-of-service advisories for it; this setup cannot replace that pinned copy through an npm override. The runtime-only dependency audit passes, but does not audit the globally installed Pi host.

## Checks

```sh
npm test --prefix ~/dotfiles/pi/agent
npm run test:agents --prefix ~/dotfiles/pi/agent
npm run typecheck:agents --prefix ~/dotfiles/pi/agent
npm run test:workflows --prefix ~/dotfiles/pi/agent
npm run typecheck:web-tools --prefix ~/dotfiles/pi/agent
```
