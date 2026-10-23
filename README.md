# My Pi setup

My [Pi](https://github.com/earendil-works/pi) configuration for coding: named subagents, interactive questions, a status footer, reusable prompts and skills, and editor-assisted review.

Plannotator reviews can publish private Tailscale links for use from a phone alongside Herdr Web UI. See [phone reviews](docs/phone-reviews.md) for setup and commands.

## Subagents

Subagents use Pi 1.0's experimental [Pi Durable](https://earendil.com/posts/pi-durable/) package. Each job has its own conversation, model, instructions, tools, skills, and working directory. Durable handles transcripts, model retries, compaction, interrupted tool calls, and recovery.

| Agent | Purpose | Default model | Access |
|---|---|---|---|
| `explore` | Focused codebase reconnaissance | GPT-6 Luna | Read-only |
| `review` | Independent correctness and security review | GPT-6 Astra | Inspect (bash, non-mutating) |
| `plan` | Planning and design decisions | GPT-6 Astra | Inspect (bash, non-mutating) |
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
      "model": "openai/gpt-6-sol",
      "thinking": "medium"
    },
    "research": {
      "model": "openai/gpt-6-luna",
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
      "review": { "model": "openai/gpt-6-luna", "thinking": "high" }
    }
  }
}
```

Switch with `/agents preset budget` or `/subagent-preset budget`. The selection is saved in the parent session. `PI_SUBAGENT_PRESET` sets the machine default; a session selection takes priority. Built-in presets are `personal`, `openai`, `opencode-go`, `copilot`, and `anthropic-work`. The `copilot` preset permits only GitHub Copilot models; `anthropic-work` permits only direct Anthropic models. These restrictions cover explicit overrides, custom agents, and saved model choices.

`anthropic-work` uses Haiku 5.5 with low thinking for exploration and commits, Sonnet 5.5 with medium thinking for implementation and low thinking for worktree setup, and Opus 5.5 with high thinking for review and planning. Activate it with `/agents preset anthropic-work`. It changes child models only, not the parent session's model.

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

`/agents` opens the live dashboard, newest jobs first, with status, start/end times, duration, and timelines. Use `j/k` to select, Enter to inspect the transcript, `i` to send guidance or answer a question, and `x` to abort, including waiting jobs. The inspector shows usage, cost, context occupancy, conversation ID, and queued guidance. Press `o` to load another 100 history entries. `c` opens configuration and `p` switches presets. `/agents <job-name-or-id>` opens a job directly. RPC clients retain native dialogs. Active background jobs show a compact "Started agent" receipt in the transcript and live progress only in the pinned bottom monitor. Expand the receipt to inspect details. Foreground jobs and waits keep a live transcript card. Questions and terminal results restore the full card in the original entry rather than add blocks. The underlying tool calls and results stay in the model's transcript. Cards rebuild from the visible transcript after reloads or compaction. Recovered background jobs without a transcript card appear above the editor. `/commit` uses the same renderer with an Escape-to-cancel control.

There can be four running jobs per parent session and one mutating child per working tree. Shell access counts as mutating unless the agent sets `"mutating": false`, as `review` and `plan` do. Do not edit the same working tree while a mutating child owns it. Independent mutating work belongs in separate worktrees. Foreground cancellation stops its job; cancelling a wait for a background job leaves that job running. User cancellations update the card without restarting the parent. Questions, failures, and timeouts still wake it.

Jobs have a 30-minute active-time limit by default, including elapsed active time before a restart but excluding time parked for a parent answer. A minute without activity marks a job stalled; five minutes cancels it. Provider requests have a two-minute timeout, and each coding tool has an independent three-minute timeout. Mutation ownership remains held until tool execution actually stops. Output is capped at 300 lines or 32 KiB; reports include the database and conversation ID when truncated. Each conversation records its own token usage and cost. Context occupancy uses the last reported model usage, not a live tokenizer. Foreground tool results also report usage to the parent session.

### Restart behavior and limits

Named-agent guidance uses Pi's structured `named_subagents` prompt section. Preset and tool changes append native transcript updates rather than replacing the leading system prompt. This requires Pi 1.4.

Each parent session owns `~/.pi/agent/subagents/<session-id>.sqlite`. A lock prevents two processes from opening the same database. Reopen the parent session to resume unfinished jobs, including interrupted foreground jobs. Settled, undelivered background results are also recovered. Messages continue the same child conversation; active messages steer it at the next turn boundary.

With `--no-session`, jobs use memory too. Restart recovery requires a saved parent session.

Read-only tools are replay-safe. Interrupted shell, edit, and write calls are not replayed automatically; the model sees the interruption and decides what to do. Shutdown closes storage without aborting durable jobs. A process must be running for jobs to make progress; this extension is not a daemon.

Children use Pi's built-in tools and trust-aware project instructions and skills. They can ask the parent questions, but cannot open user dialogs or message peers directly. They still do not load executable extensions, inherit the parent's conversation, or recursively delegate. Tool restrictions are not an operating-system sandbox.

This replaces the old `subagent_*` tool family, Markdown agent profiles, session modes, and `/btw`. Old JSON registries and child session files are left untouched, but are not imported into Durable. These compatibility features and executable extension inheritance remain unrestored. `/commit` shows its task immediately, then elapsed time, model, and recent tool activity while it runs. Escape cancels it. Success, failure, and cancellation leave a result in the conversation, including failures during setup. Delegation tool cards show model, time, activity, usage, and expandable task/instructions.

## Work profile

Run `piw` for company Anthropic work. The launcher at `~/dotfiles/scripts/piw`
creates `~/.pi-work/agent` on first use from [`work/`](work/), then preserves
local settings and credentials. It starts Opus with high thinking and locks
named agents to the existing `anthropic-work` preset. Use
`piw --model anthropic/claude-sonnet-5-5` to start on Sonnet instead.

The profile reuses the shared extensions, prompts, and package declarations.
Sessions, provider credentials, and subagent state stay separate from normal
Pi. Memory backend selection is machine-local and reversible through
`~/dotfiles/scripts/agent-memory`. Personal Pi, cc and ccp share personal memory;
piw and ccw share a separate work service, data directory and token. Both groups
currently use local ai-memory, with no OptMem history import. Only the synthetic
`~/dotfiles/.ai-memory-personal-test` and `.ai-memory-work-test` directories opt
into capture, in their matching workspace and project `dotfiles-memory-test`.
Actual work and EMS repositories stay unmarked. Each profile's native MCP entry
is `ai-memory`; pass the marker's explicit workspace and project. See
[usage and rollback](../docs/agent-memory.md). The checked-in work seed has no
persistent memory backend until setup. OptMem remains installed but inactive;
only an explicit backend selection restores it. Shared non-memory rules remain
live references, not static copies in profile instructions.
Existing machine-wide EMS/Jira skills remain available as before;
`work-services` and `health-scout` load only in this work profile and Claude work.

Herdr's integration is installed per profile, not through the shared extensions.
After creating the work profile, install it separately:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi-work/agent" herdr integration install pi
```

Start a new `piw` session or run `/reload` in an existing one afterward. The
integration supplies native session identity and restore support. OSC 7501
status reporting is built into Pi 1.3 and requires a supporting Herdr build.

PostgreSQL uses the existing `~/.claude-work/bin/postgres-mcp` launcher and
Keychain-backed read-only profiles. Tools load through search; modification,
CSV import, and connection-editing tools are hidden. Grafana continues to use
`~/.claude-work/bin/gcx` and its existing Keychain login. No database password
or Grafana token is copied.

The Anthropic credential resolves the Keychain item `pi-anthropic-work`, account
`anthropic`. To enroll or replace it, run this in your terminal and enter the
key at the private prompt, never in chat or a command argument:

```sh
security add-generic-password -U -a anthropic -s pi-anthropic-work -w
piw auth check --provider anthropic --json
piw mcp list
```

The explicit work guard loads even with `--no-extensions`. It disables
non-Anthropic provider authentication and execution, including ambient cloud
credentials, and rejects Anthropic endpoint/API overrides that do not use the
direct Anthropic Messages API. It reapplies on startup, model changes, new turns,
and compaction. This prevents accidental provider switching; it is not a sandbox against trusted
extensions that deliberately replace providers or make their own HTTP requests.
Web search still sends search terms to its configured search provider.

Exit `piw` and open normal `pi` to do personal work. Do not carry a work
conversation into another provider. The launcher does not change normal Pi's
settings, and it never copies personal provider logins into the work profile.

## Interactive questions

The `ask_user` tool asks one question with 2–5 likely answers and a free-form fallback. Arrow keys or number keys select an option; Escape goes back or dismisses it.

## Status footer

`agent/extensions/context-tokens-footer.ts` provides a two-line footer:

```text
~/dev/project                         provider/model · reasoning
34% 68k/200k · $0.42 · 71 tok/s       main · 3 files changed
```

It shows the working directory, selected model, context usage, session cost, generation speed, branch, changed-file count, and extension status messages.

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
│   ├── shared/                   # resource loading, trust, timeouts, and status
│   ├── ask-user.ts
│   ├── context-tokens-footer.ts
│   └── implement-plan.ts
└── prompts/
```

## Setup

This repository expects to live at `~/dotfiles`. Install extension dependencies on each machine, with Pi 1.4 and Node 22.22.2 or newer. Pi itself supports Node 22.19, which also passes this setup's checks, but one upstream dependency requests the newer patch release.

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
npm run typecheck:web-tools --prefix ~/dotfiles/pi/agent
python3 ~/dotfiles/scripts/tests/piw.test.py
```

The host-runtime regressions, including the offline subagent prefix and discovery checks, need Pi 1.4. Set
`PI_TEST_HOST_DIR` to the installed `@earendil-works/pi-coding-agent` package
before running `npm test`, or run it directly:

```sh
PI_TEST_HOST_DIR=/path/to/pi-coding-agent \
  node --test --experimental-strip-types ~/dotfiles/pi/tests/work-guard-host.test.ts
```

## OptChat cache retention

`pi-opt` and `pi-optw` load the local OptChat 0.8.9 source snapshot in
`vendor/pi-optchat`. Anthropic cache retention defaults to one hour for main
and connected conversations, five minutes for delegated agents, summarization,
and history import. Hits refresh expiry. Longer retention helps pauses, not
continuous tool calls, and one-hour writes cost more.

Controls are independent per workload:

```sh
pi-optw                             # conversation long, background short
PI_CACHE_RETENTION=short pi-optw    # conversation short, background short
PI_CACHE_RETENTION=none pi-optw     # master off, even with workload overrides
OPTCHAT_CACHE_CONNECTED=short pi-optw
OPTCHAT_CACHE_DELEGATED=long pi-optw
OPTCHAT_CACHE_COMPACTOR=long pi-optw
```

`OPTCHAT_CACHE_MAIN`, `OPTCHAT_CACHE_CONNECTED`, `OPTCHAT_CACHE_DELEGATED`,
`OPTCHAT_CACHE_COMPACTOR`, and `OPTCHAT_CACHE_IMPORT` accept `long`, `short`,
or `none`. Restart the owner session to reload code or environment settings.
Connected windows run their requests in the owner process and use its policy.
The same controls work for `pi-opt` on Anthropic. OpenAI is unaffected by
these custom Anthropic markers.

New Anthropic usage ledger records include `workload`, `requestedRetention`,
and `cachePolicy: "workload-v1"`. Historical/recovered usage without an observed
request stays untagged. Usage retains Pi's provider-reported `cacheWrite1h`
when available. No prompts or credentials are added to telemetry.

AI Usage exports a policy comparison table for Grafana. Compare the same model
and workload across comparable windows using weighted cache-hit rate, input
cost per million prompt tokens, write volume, and sample size. Pi's cost
estimates account for the reported one-hour write premium, but are not invoices.
Do not infer achieved TTL from requested retention or declare savings from hit
rate alone. See `vendor/pi-optchat/LOCAL-CHANGES.md` for provenance.

Regression checks:

```sh
python3 ../scripts/tests/pi-opt.test.py
agent/node_modules/.bin/tsx --test tests/optchat-cache-*.test.ts
```
