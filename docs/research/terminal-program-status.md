# Terminal program status, OSC 7501

Receive Pi's existing native status reports in Herdr. Do not add a second Pi emitter. OSC 7501 provides explicit state over the PTY and removes the need to infer that state from spinners or transcript text. It does not provide session discovery, task control, or authenticated process identity.

This note separates published protocol facts, local inspection, and proposed integration work. Inspection date: 2026-10-19. No integration code or settings were changed.

## Local findings

- Installed Pi 1.3.0 already implements OSC 7501 in `dist/modes/interactive/program-status-reporter.js` and `@earendil-works/pi-tui/dist/terminal.js`. It queries support and accepts `PI_PROGRAM_STATUS=1` as an override.
- Pi reports working during runs and compaction, blocked for native dialogs, and done, error, or idle after `agent_settled`.
- The local Herdr fork at `~/dev/personal/herdr`, commit `3658da53`, has no `7501` or `ProgramStatus` matches in `src` or `vendor`. The running `herdr-master` reports version 0.9.5.

Local source inspection also confirmed that Pi's `ctx.ui.custom` path does not automatically report blocked, unlike native selector/input/editor dialogs. The local `ask_user` uses that custom path, so an OSC receiver alone will not fix its question state. It needs explicit blocked reporting or native-dialog reuse. The standard Pi bridge currently reports working with `full_lifecycle_hook_authority`; no exact stale-state failure has been reproduced. The separate `piw` agent directory reports the Herdr Pi integration as not installed.

Read-only checks:

```sh
herdr agent explain "$HERDR_PANE_ID" --json
# state: working; screen_detection_skip_reason: full_lifecycle_hook_authority

herdr integration status
# pi: current (v9) (~/.pi/agent/extensions/herdr-agent-state.ts)

PI_CODING_AGENT_DIR="$HOME/.pi-work/agent" herdr integration status
# pi: not installed (~/.pi-work/agent/extensions/herdr-agent-state.ts)
```

The installed regular extension listens for `herdr:blocked`; `pi/agent/extensions/ask-user.ts` never emits that event. The work launcher `scripts/piw` changes `PI_CODING_AGENT_DIR`, and its shared extension directory does not contain the Herdr extension. These establish configuration and reporting gaps, not a reproduction of every reported stale state.

## Exact wire format

The current [specification, syntax](https://www.superlogical.com/rex/docs/build/program-status#syntax) defines:

```text
report: ESC ] 7501 ; key=value:key=value ST
query:  ESC ] 7501 ; ? ST
ESC = 0x1B
ST  = ESC followed by backslash, or BEL 0x07
```

For example, these are literal escaped bytes, with no newline required:

```text
\x1b]7501;state=working:app=pi\x1b\\
\x1b]7501;state=blocked:kind=question:app=pi:msg=Q29udGludWU/\x1b\\
```

The second message decodes to `Continue?`.

- Keys match `[a-z]+`; values match `[A-Za-z0-9_.,+/=-]*`. Pairs use colons, not semicolons. Trim whitespace around keys and values. Skip malformed pairs, ignore unknown keys, and use the last occurrence of duplicate keys.
- `state` is required. Missing or unknown state discards the report. Optional keys are `id`, `kind`, `progress`, `app`, `title`, and `msg`.
- `msg` and `title` use standard base64 of UTF-8, with optional padding. Decoded text must be a single line without U+0000–001F, U+007F, or U+0080–009F. Invalid base64 or forbidden decoded controls discard the whole report.
- `kind` applies only to blocked and accepts `permission`, `question`, or `auth`. `progress` applies only to working or blocked and accepts integer 0–100. Missing or invalid progress means indeterminate. `app` is a stable machine identifier, not a display label. Receivers must not infer semantics from `msg`. [Keys](https://www.superlogical.com/rex/docs/build/program-status#keys)

## State and record lifetime

| State | Meaning and lifetime |
| --- | --- |
| `idle` | Waiting for the next instruction. Remains until replaced or cleared; receiver may remove it on exit or shell prompt. |
| `working` | Running. Remove on replacement, clear, attached-process exit, or next shell prompt. |
| `blocked` | Cannot continue without user action. Same lifetime as working. |
| `done` | Finished, result ready and not yet seen. Survives process exit and shell prompt. |
| `error` | Failed and stopped. Same lifetime as done. |
| `clear` | Delete addressed record and descendants. Without `id`, delete all records. |

A report replaces the entire addressed record, not individual fields. Repeat `app`, `msg`, and other values that should remain. No heartbeat or periodic resend is required. On user cancellation or interruption, the program reports idle. A program that exits should send done or error immediately before exit. A shell prompt is specifically OSC 133 A. The terminal chooses when to stop displaying completed results, such as after the user returns and presses a key. [States](https://www.superlogical.com/rex/docs/build/program-status#states)

Records belong to each PTY-backed terminal, not the primary or alternate screen. Full reset RIS clears all records; soft reset DECSTR does not. Optional hierarchical IDs use segments `[A-Za-z0-9_.+-]{1,32}` separated by `/`. Missing ID addresses the root. Ancestors need not exist. Children inherit `app` from their nearest ancestor with an app. Hierarchy mandates clearing and app inheritance, but does not define state aggregation. Root working and child blocked can both be true. [Records and IDs](https://www.superlogical.com/rex/docs/build/program-status#records-and-ids)

## Support detection, not state queries

A supporting receiver must answer the query. A minimal valid response is:

```text
\x1b]7501;?\x1b\\
```

Revision 0.4 permits `?:states=idle,working,done,blocked,error:kinds=permission,question,auth`. Omitted lists mean exactly those fixed defaults; clear is excluded from the states list. Programs ignore unknown response pairs. No response within the program's chosen timeout means unsupported. The spec suggests sending primary device attributes `CSI c` immediately after the query to avoid waiting if that response arrives first. Detection is optional; programs may report without reading replies. There is **no API to query stored records**, and reports must never be echoed back. [Feature detection](https://www.superlogical.com/rex/docs/build/program-status#feature-detection), [security](https://www.superlogical.com/rex/docs/build/program-status#security)

Do not implement the old terminfo `Pst` proposal. It appears in the [initial gist](https://gist.github.com/mitchellh/7acae3abd8355c1c00287d67e96c913a), but revision 0.4 explicitly removes terminfo. [Revision history](https://www.superlogical.com/rex/docs/build/program-status#revision-history)

## Nesting and multiplexing limits

These are consequences of the documented model, not extra protocol features:

- IDs describe records, not processes. There is no PID, ownership token, automatic namespace allocation, or authentication. Two emitters using the root overwrite one another; either can clear every record. Cooperative nesting needs coordinated IDs or a proxy that rewrites them.
- Hierarchical IDs do not make arbitrary nested agents automatically discoverable. An outer Pi tool's captured child output may never reach the terminal parser. Only bytes delivered to the PTY receiver count.
- Multiplexers and nested terminals must preserve or consume OSC 7501 and route query replies to the correct inner PTY. The spec defines no tmux/screen passthrough mechanism or multiplexed pane-address envelope. Do not assume SSH/container transport solves an intervening terminal parser that swallows unknown OSCs.
- Lifecycle refers to the process attached to the PTY, not every descendant's exit. Without OSC 133 A or explicit replacement/clear, a descendant's working record can remain stale.

The protocol deliberately leaves grouping and presentation policy to the receiver. These limitations follow from [records](https://www.superlogical.com/rex/docs/build/program-status#records-and-ids), [lifetime](https://www.superlogical.com/rex/docs/build/program-status#states), and [security](https://www.superlogical.com/rex/docs/build/program-status#security).

## Maturity and implementation evidence

- The published spec's latest listed revision is **0.4, dated 2026-10-10**, following initial draft 0.1 on 2026-09-28. Treat it as a young, changing protocol, not a broadly deployed compatibility guarantee. Hashimoto's article is dated 2026-10-06 and still links to a now-removed terminfo section. [History](https://www.superlogical.com/rex/docs/build/program-status#revision-history), [article](https://mitchellh.com/writing/program-status-osc7501)
- Ghostty [PR #14560](https://github.com/ghostty-org/ghostty/pull/14560) merged on 2026-10-06 as `a4aacd918ba9e79929ff608034c60a4341773ef0`. It implements parsing and libghostty-vt reporting callbacks. The PR explicitly says the **Ghostty app ignores reports for now** and the embedder owns records and lifetime. This is not evidence that a released Ghostty app displays statuses.
- In that implementation, support is advertised only when the program-status effect is installed; its reply is the minimal `?`. Full reset emits clear. The [C callback contract](https://github.com/ghostty-org/ghostty/blob/a4aacd918ba9e79929ff608034c60a4341773ef0/include/ghostty/vt/terminal.h) says strings are valid only during the callback, so consumers must copy retained data. [Handler source](https://github.com/ghostty-org/ghostty/blob/a4aacd918ba9e79929ff608034c60a4341773ef0/src/terminal/stream_terminal.zig)
- Rex officially documents current session-picker indicators, unfocused-tab indicators, and Lua `terminal.program_status_changed` events. Push notifications and a unified inbox are described as future work. [Rex implementation claims](https://www.superlogical.com/rex/docs/build/program-status#in-rex)
- Hashimoto describes Terraform, Claude Code, Codex, and Homebrew integrations as **proofs of concept through plugins or forks**. That does not establish native support in official releases. His mention of Herdr illustrates heuristics and its socket API, not an OSC 7501 implementation claim. [Article](https://mitchellh.com/writing/program-status-osc7501)

## Proposed Herdr integration

1. Add a receiver at the fork's actual PTY/VT parser boundary. Prefer the upstream libghostty callback if its vendored library can supply it; otherwise use the existing OSC parsing machinery. A parser alone is insufficient: retain per-terminal records and connect them to Herdr's agent model.
2. Answer `OSC 7501;?` only when the receiver and state consumer are active. Pi's existing query should then enable its reporter without an override. `PI_PROGRAM_STATUS=1` only forces emission; it cannot make an unsupported Herdr consume reports.
3. Give explicit protocol records precedence over heuristic detection while valid, and restore heuristics after clear or lifecycle cleanup. Preserve raw done/error semantics before adapting to Herdr's view. Official Herdr docs define effective done as idle and unseen and list idle, working, blocked, done, and unknown, so error needs an explicit mapping or model extension. [Herdr agent views](https://herdr.dev/docs/socket-api/#agent-view-queries)
4. Initially support root Pi reports, but implement valid IDs and clearing correctly rather than silently folding children into root. Choose a visible-state policy, such as showing blocked children ahead of root working. That priority is an application decision, not a protocol rule.
5. Keep Herdr's socket integration for identity, native session references, resume commands, and richer metadata. OSC 7501 does not replace those. Herdr officially exposes `pane.report_agent` for semantic state and `pane.report_agent_session` for session-only reporting. [Socket API](https://herdr.dev/docs/socket-api/#agent-state-reporting)

For Pi lifecycle handling, official [extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) explicitly warn that `agent_end` is not final idle because retries, compaction, and queued messages may continue. `agent_settled` is the notification point after automatic continuation ends. This supports retaining the parent's verified native reporter rather than adding simplistic start/end hooks.

### Acceptance checks and pitfalls

Test real Pi startup negotiation without the override, run and compaction transitions, native permission/question dialogs and recovery, settled success/failure/cancel, shell return, full reset, alternate-screen changes, and pane close/replacement. Also test split escape sequences across PTY reads, BEL and ESC-backslash terminators, duplicate/unknown keys, whole-record replacement, hierarchical clear and inheritance, invalid base64/controls, oversized reports, and unsupported-query silence. Check that query replies never appear as user input or reach the wrong pane.

Enforce limits before applying any changes: 4096 bytes for the sequence, key length 16, msg 2732 encoded/2048 decoded, title 256 encoded/192 decoded, app 32, ID 128 total/32 per segment/8 levels. The documented record cap is 256 with at least 64 supported; evict least-recently-updated records when necessary. Treat text as untrusted plain text, disarm invisible formatting outside the grid, label the originating terminal, and rate-limit notifications. Do not put secrets into messages. [Limits](https://www.superlogical.com/rex/docs/build/program-status#limits), [security](https://www.superlogical.com/rex/docs/build/program-status#security)
