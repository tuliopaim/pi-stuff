# Local OptChat cache policy and accounting patch

Source: npm `pi-optchat@0.8.9`, https://github.com/jonaslsaa/pi-optchat.
Upstream license and third-party notices are retained. This snapshot contains
no credentials, transcripts, or npm dependencies.

Changed upstream files: `src/cache.ts`, `src/compactor.ts`, `src/index.ts`,
`src/agents.ts`, `src/usage.ts`, `src/connected-window.ts`, and `src/window-bridge.ts`.
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

For an upstream update, replace the snapshot, reapply these changes, and run
cache policy, accounting and launcher tests. The compactor's four-minute primer
heuristic is unchanged; it is conservative and does not shorten provider TTL.
