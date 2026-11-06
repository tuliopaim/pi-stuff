# Local OptChat cache policy and accounting patch

Source: npm `pi-optchat@0.10.0`, https://github.com/jonaslsaa/pi-optchat.
Upstream commit: `2714a3f4167ba41ea1868b51d715e680ac5f095d`.
Updated by a three-way merge of the local snapshot against pristine npm 0.9.0
and npm 0.10.0, not by replacing locally patched files.
Tarball SHA-1: `98fc83c75cbd392d62c4cec802a0036e4bb32688`.
Upstream license and third-party notices are retained. This snapshot contains
no credentials, transcripts, or npm dependencies.

Changed upstream files: `src/cache.ts`, `src/compactor.ts`, `src/index.ts`,
`src/agents.ts`, `src/usage.ts`, `src/handoff.ts`, `src/checkpoint.ts`, `src/connected-window.ts`,
and `src/window-bridge.ts`.
The Herdr transcript adapter is preserved in `src/herdr-session.ts` and
`herdr/extension.ts`, consolidated from the installed local Herdr overlay.
It publishes only validated connected-run transcript paths through the managed
Herdr integration. The launcher no longer selects an unversioned OptChat copy
that could silently bypass the cache policy.

- Main and connected conversations follow `PI_CACHE_RETENTION`, default long
  in the launcher. Delegated agents, compactor and history import default short.
- Independent `OPTCHAT_CACHE_{MAIN,CONNECTED,DELEGATED,COMPACTOR,IMPORT}` controls
  accept long, short, none. `PI_CACHE_RETENTION=none` always disables caching.
- Each custom block uses its workload TTL. Compactor provider options use the
  same workload policy. Automatic and redundant block marks are removed.
- New Anthropic responses record workload, requested retention and policy
  version. Request-entry boundaries avoid attributing new policy to old usage.
  Recovery preserves existing records and leaves unobserved policy unknown.
- Existing roles and stable IDs remain compatible with upstream accounting.
  Connected/delegated is additional metadata, not inferred from model names.

Launchers validate controls and load this source, not disposable npm cache files.
Restart owner processes after changes. One-hour writes cost more. Provider usage
already retains cacheWrite1h where available; requested TTL is not proof of a hit.

Connected-window interrupts respect the focused editor's optional
`shouldInterrupt(): boolean` gate. The local triple-Esc editor exposes this method
because OptChat's terminal listener runs before editor input. Every intercepted
Esc is consumed, so presses are not counted twice. Ordinary editors keep upstream
single-Esc behavior; autocomplete and overlays still bypass remote interruption.
Regression coverage: `tests/optchat-connected-escape.test.ts` uses the real listener,
real editor, and a local socket owner without model calls.

Upstream 0.10.0 asks connected windows to write their own handoff in their
existing session, or reopens that session after recovery. Both paths retain the
connected request hook and usage policy, including overrides and master off.
This is an additional model turn, not a guaranteed cache hit. The compactor
fallback explicitly uses compactor retention instead of inheriting the conversation
default from the provider. Shutdown defers handoffs until restart.
Upstream also persists the profile's main model and thinking choice; explicit CLI
model/provider/thinking selections retain upstream precedence.

For an upstream update, three-way merge against the pristine source version and run
cache policy, accounting, keyboard and launcher tests. The compactor's four-minute primer
heuristic is unchanged; it is conservative and does not shorten provider TTL.

Child settings retain separate global and project scopes in an in-memory storage
copy. Flattening effective settings let a trusted project's `extensions: []`
erase isolated-profile extensions, including shared tools, MCP policy and the
work guard. Pi's resource loader now resolves both scopes normally, without
changing project trust or persisting child overrides. Regression coverage in
`tests/optchat-policy-host.test.ts` opens real children against Pi 1.4 with an
empty project extension list and checks tools, work-only fixture MCP and the guard.
