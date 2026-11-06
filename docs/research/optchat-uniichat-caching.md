# OptChat and UniiChat caching review

Research date: 2026-10-23 UTC. Read-only investigation of upstream source, GitHub issue/PR bodies and full comment endpoints, Anthropic documentation, the installed Pi 1.4.0 provider, and our vendored extension. No model calls, runtime changes, commits, or pushes were made for this report. Private prompt contents are not included.

## Findings

The likely discussion the user remembers is [OptChat #202, the UniiChat compaction and caching review](https://github.com/jonaslsaa/pi-optchat/issues/202). OptChat maintainer `jonaslsaa` opened it after Victor Taelin released [UniiChat](https://github.com/VictorTaelin/UniiChat). It is a review of differences, not a declaration that OptChat caching is broken or that UniiChat guarantees hits after an idle gap.

**The substantive caching fixes from that review are already in our 0.8.9 base.** Updating to 0.9.0 alone would not add the missing fix for this incident. The umbrella issue remains open with unchecked boxes, but the linked implementations were merged before 0.8.9. The newer release changes connected-window interruption, instruction-file refresh, and git-lock recovery, not the cache-layout or compaction algorithms examined here.

Our local patch addresses a separate problem: upstream's explicit Anthropic marks default to five minutes even when the launcher sets long retention. We now put one-hour TTLs on main/connected requests and use five minutes for delegated work, compaction, and imports. The reported miss did write a one-hour entry. That verifies the write policy, not that the request reused the previous entry.

The 11-minute miss remains unexplained at the exact-prefix level. OptChat rebuilding context at a new run is a credible explanation, but the token-count drop alone does not prove which prefix changed. Capture first-divergence evidence before changing prompt construction or cache marks again.

## Repositories and revisions

Clones used:

- `/Users/tuliopaim/dev/personal/pi-optchat`, upstream `https://github.com/jonaslsaa/pi-optchat`, HEAD `6e8ee41d169ee0e00e00e77a66fa7385bb2a9333` (0.9.0).
- `/Users/tuliopaim/dev/personal/UniiChat`, canonical upstream linked directly from #202, HEAD `0500bf6a8ea4bf0ce047488562022b1b6532cc30`. At fetch time this repository had one commit. This is also the UniiChat revision reviewed in #202.
- Our copy: `/Users/tuliopaim/dotfiles/pi/vendor/pi-optchat`, npm 0.8.9 plus local cache-policy/accounting and Herdr integration patches, recorded at pi-stuff commit `26ea2d5cf22127bea9fbf2b1fc0f2837e1de827f`.

Upstream points checked:

| Point | Commit | Relevance |
| --- | --- | --- |
| 0.8.6 | `aae1caf7715830051d327f819fc776792211167a` | OptChat side of #202's original comparison |
| 0.8.7 | `8fc8807b6fc234b62090d139029d47792d368bc3` | Includes restart persistence and cache replay |
| 0.8.8 | `512eb7b59754631cbb831ca6e9a53ecec0d42ae3` | Intermediate release |
| 0.8.9 | `6a9bf7e182a9da0c2a58083b7c562d270f04db9d` | Our base; release commit dated 2026-10-20 |
| 0.9.0 / current HEAD | `6e8ee41d169ee0e00e00e77a66fa7385bb2a9333` | Release commit dated 2026-10-22 |

Commit links: [0.8.9](https://github.com/jonaslsaa/pi-optchat/commit/6a9bf7e182a9da0c2a58083b7c562d270f04db9d), [0.9.0](https://github.com/jonaslsaa/pi-optchat/commit/6e8ee41d169ee0e00e00e77a66fa7385bb2a9333), [comparison](https://github.com/jonaslsaa/pi-optchat/compare/v0.8.9...v0.9.0). Annotated tag `v0.9.0` resolves to the HEAD commit above; the tag object's own SHA is not the source commit.

## What the maintainer discussion actually says

[#202](https://github.com/jonaslsaa/pi-optchat/issues/202) was created 2026-10-19T17:59:42Z, updated 2026-10-20T14:03:42Z, and remained **open** when fetched. Its full comments endpoint returned no comments. Its introduction says Victor open-sourced UniiChat and asked ports to compare compaction and caching with the actual code. The maintainer's headline is: "the core matches."

This followed an earlier, recipe-based review, [#101](https://github.com/jonaslsaa/pi-optchat/issues/101), created 2026-10-08T11:50:59Z and now closed. Its revised-gist reference is [Victor's 2026-10-08 revision](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/3c190e06f34aba0c69f49042c526093269604935). The issues describe a real earlier design problem: repeatedly merging the view after every message changes cached prefixes. They do not establish that today's miss is the same bug.

[#96](https://github.com/jonaslsaa/pi-optchat/pull/96) adopted the revised merge order, a 128,000-to-64,000-byte sawtooth view, persisted view state, and four-line view blocks. It also deliberately added two extra view marks. Its exploratory live tests reported roughly 97% reads after four-minute pauses and zero after six-minute pauses on the then-five-minute policy. Those results were about that workload and TTL; they are not evidence that the later one-hour patch fails.

### Linked issues and what shipped

Dates below are UTC. Issue bodies and complete comment endpoints were fetched for #187, #194–198, #206, #207, and #214–216; those comment endpoints returned no comments. PR merge metadata and tagged history, not #202's checklist, determine release inclusion.

| Discussion | State and dates when fetched | Implementation / release result |
| --- | --- | --- |
| [#187](https://github.com/jonaslsaa/pi-optchat/pull/187) | Created Oct 16; merged Oct 17 22:29:33 | `25ba0b8`: place request-end mark on a block, avoiding conflicting top-level 5m and block 1h marks. Already before 0.8.6. This prevents an HTTP 400, not prefix churn. |
| [#194](https://github.com/jonaslsaa/pi-optchat/issues/194) | Created Oct 19; closed Oct 20 15:09:04 | Proposed whole-batch changes, independent compaction sawtooth, and scheduling changes. Resolved by #216; only scheduling adopted after measurement. |
| [#195](https://github.com/jonaslsaa/pi-optchat/issues/195) | Created Oct 19; closed Oct 20 14:05:40 | #206 persists the compaction view. In 0.8.7 and our 0.8.9. |
| [#196](https://github.com/jonaslsaa/pi-optchat/issues/196) | Created Oct 19; closed Oct 20 15:09:27 | #215 gates sibling first requests. In 0.8.9. |
| [#197](https://github.com/jonaslsaa/pi-optchat/issues/197) | Created Oct 19; closed Oct 20 15:09:52 | #214 removes the compaction-task end mark. In 0.8.9. |
| [#198](https://github.com/jonaslsaa/pi-optchat/issues/198) | Created Oct 19; closed Oct 20 13:54:09 | #207 adds fake-Anthropic replay. In 0.8.7 and our 0.8.9. |
| [#206](https://github.com/jonaslsaa/pi-optchat/pull/206) | Created Oct 19; merged Oct 20 14:05:37 | `9570d32`: save both views and batch state; validate tiling; old-file fallback. |
| [#207](https://github.com/jonaslsaa/pi-optchat/pull/207) | Created Oct 19; merged Oct 20 13:54:08 | `e53af72`: replay real memory/context/provider serialization with fake cache availability and breakpoint lookback. |
| [#214](https://github.com/jonaslsaa/pi-optchat/pull/214) | Created Oct 20; merged Oct 20 15:09:50 | `8d2005e`: compactor uses `end: false`. Maintainer's 12-input live A/B kept cache reads equal and reduced warm-call total cost 6.8%; including cold primers, 1.3%. Small study, not a universal saving estimate. |
| [#215](https://github.com/jonaslsaa/pi-optchat/pull/215) | Created Oct 20; merged Oct 20 15:09:25 | `b9c129d`: sibling gate plus separate task block. Maintainer's three-Haiku-sibling live check reduced writes 112,572 to 38,114 and cost $0.141 to $0.055. Batch-specific, not all-session single flight. |
| [#216](https://github.com/jonaslsaa/pi-optchat/pull/216) | Created Oct 20; merged Oct 20 15:09:01 | `16ef478`: build in chat/context order, merge first on ties. Fake-cache backlog reads improved about 56–62% to 98%. Whole-batch and independent-compaction changes were explicitly **not** adopted: they added no measured benefit after ordering was fixed. |

This last distinction matters. It would be incorrect to say OptChat now exactly copies UniiChat's whole-batch rule or fully independent compaction view. It deliberately retains those differences.

## How the two implementations protect cached prefixes

### Stable growth, then deliberate rewrites

Both keep a compact memory view that mostly grows at its end and occasionally merges older adjacent summaries. A merge replaces earlier text, so the new view cannot reuse all entries written for the old view. Cache retention keeps the old entry available; it does not make the new text identical.

UniiChat gives chat and compaction views separate batch state, applies its own whole-batch rules, and persists both as `view`/`seen`: [Memory.ts L75–98](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L75-L98), [L200–242](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L200-L242), [L835–858](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L835-L858). Its default chat high mark is 128,000 bytes, not 128k tokens: [L143–151](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L143-L151).

OptChat 0.8.9 has the same broad sawtooth design, but permits incremental merges while catching up and forces a compaction-view fit on chat merges. The scheduler change reduces the situations where this matters. It saves both views and their merge state, with a validated fallback for old/damaged saved state: [memory.ts L58–90](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/memory.ts#L58-L90), [L140–164](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/memory.ts#L140-L164), [L191–227](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/memory.ts#L191-L227), [L250–258](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/memory.ts#L250-L258), [L282–290](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/memory.ts#L282-L290).

Persisting the view prevents an unnecessary rebuild on reload. It does not freeze the live view forever, preserve every earlier prompt, or stop ordinary compaction batches from changing text.

### Breakpoints and long tool turns

Anthropic caches the prefix in order `tools → system → messages`. A later mark includes the earlier tools and system even if those earlier sections have no independent mark. A breakpoint searches at most 20 positions for earlier cache entries; it cannot recover arbitrary unchanged content unless an earlier request actually wrote an entry there. See [official prompt structure](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#structuring-your-prompt) and [breakpoint mechanics](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#how-automatic-prefix-checking-works). Current docs also say consecutive tool-use/result runs can count as one position on the Claude API; the old replay is an approximation, not the service implementation.

UniiChat makes four-line memory blocks, marking the last whole one, while separately marking the system and turn/reply boundaries: [Memory.ts L1005–1017](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L1005-L1017), [Anthropic.ts L57–83](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Anthropic.ts#L57-L83).

OptChat uses up to three view marks, at offsets 0/20/40 whole blocks back, and one request/turn-end mark. It removes Pi's redundant system/tool/message marks to stay within four. This is a deliberate difference: a long tool run can add enough *new view blocks on the next turn* that a single last-view mark cannot reach the old entry. The separate task block lets sibling agents share the view regardless of task text: [cache.ts L8–22 and L33–71](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/cache.ts#L8-L71).

Tradeoff: OptChat has no independent system/tools cache entry to fall back to if every reachable view prefix changes. That can make a view rebuild more expensive than one with a separate early breakpoint. This is a code-derived possibility, **not proof** of this incident. Adding an early breakpoint requires giving up an existing mark or redesigning mark selection; blindly adding a fifth is invalid.

### Turns and runs are not just process restarts

OptChat resets `run`, `keep`, and `view` at `startRun`, called by `before_agent_start` for a submitted prompt. It then waits for summaries and captures a fresh memory view. Context is rebuilt from that view, an optional previous completed exchange, and the current run. A long run can also refresh the view mid-turn when its configured budget is exceeded: [0.8.9 index.ts L371–390](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/index.ts#L371-L390), [L435–464](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/index.ts#L435-L464), [transcript.ts L162–178](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/transcript.ts#L162-L178), [L191–215](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/transcript.ts#L191-L215).

A run boundary therefore need not mean the Pi process restarted or `/reload` ran. Moving a large verbatim run into summarized memory explains how a smaller request can arise. To establish cache causality, compare the resulting wire prefixes, not just the run marker or total size.

UniiChat also builds calls from a current view plus whole recent messages rather than keeping an eternally append-only full transcript: [Memory.whole L458–470](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts#L458-L470), [Server.ts L523–558](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L523-L558). Switching implementations would not eliminate the fundamental memory-rewrite/cache-write tradeoff.

### Parallel work, compaction, and TTL

UniiChat uses shared per-prefix single flight, waiting until a writer begins answering before letting matching followers proceed. Its warm cache bookkeeping refreshes on use: [AskAI.ts L215–278](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/AskAI.ts#L215-L278). Its Anthropic block marks omit `ttl` (default five minutes); its gate uses 300,000 ms for Claude: [Anthropic.ts L33–37](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Anthropic.ts#L33-L37), [AskAI.ts L142–146](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/AskAI.ts#L142-L146).

OptChat gates compactions by shared/shorter prefixes and sibling first requests within a batch. It is not a general gate across unrelated conversations. The compactor's four-minute warm heuristic is internal coordination, not the provider TTL and not an instruction to evict an entry. Its task stays unmarked because different summaries have different tasks: [compactor.ts L16–43 and L60–84](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/compactor.ts#L16-L84), [agents.ts L237–258](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/src/agents.ts#L237-L258).

Although UniiChat shares the chat system with compactions, compactions have no tools and can use another model. Identical system wording alone does not establish a shared cache prefix: tools precede system, and caches are model-specific. OptChat deliberately uses a separate compactor prompt/model; #202 explicitly retains that decision. Sources: [UniiChat Server.ts L335–340](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Server.ts#L335-L340), [OptChat #202](https://github.com/jonaslsaa/pi-optchat/issues/202), [Anthropic cache diagnostics reason types](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics#cache-miss-reason-types).

## What the tests establish, and what they do not

UniiChat's fake Anthropic models five-minute expiry with a fake clock, read refresh, a 20-block lookback, four-mark limit, and entries available only after the writer starts. Its seeded turns have at most six tool steps and assert at least 95% reads of counted input, excluding the compaction task: [cache.test.ts L1–31](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/cache.test.ts#L1-L31), [L91–122](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/cache.test.ts#L91-L122), [L225–256](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/cache.test.ts#L225-L256).

OptChat's port exercises real memory, context building, and Pi's Anthropic serialization, including 50–60 tool steps and a cold compaction backlog. It catches missing marks, a missing compactor gate, and poor scheduling. However:

- The source explicitly says, "The 5-minute TTL is left out." It has no timed 11-minute or one-hour reuse test.
- The 95% threshold is **of reusable characters**, meaning the longest prefix any prior request sent, not 95% of billed prompt tokens. Newly rewritten views may lower the actual billed-token hit rate without failing it. Its own comment reports a post-long-turn case at 97.9% of reusable but only 37.3% of sent characters.
- Its restart case explicitly clears the fake cache, then checks reuse among subsequent compactions. It does not test preservation of a warm entry across restart.
- Sibling behavior has separate tests; it is not replayed here. The introductory comment about "no gate" is stale after #215, so implementation and dedicated tests take precedence.
- Fake counters are character-based approximations, not actual tokenization or production billing. These results do not certify every provider/model or Pi-version combination.

Sources: [0.8.9 cache-replay.test.ts L1–7](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/test/cache-replay.test.ts#L1-L7), [L24–61](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/test/cache-replay.test.ts#L24-L61), [L125–146](https://github.com/jonaslsaa/pi-optchat/blob/6a9bf7e182a9da0c2a58083b7c562d270f04db9d/test/cache-replay.test.ts#L125-L146), [#215 tests](https://github.com/jonaslsaa/pi-optchat/pull/215).

This research read those tests and history; it did not rerun the upstream suites or make a live cache A/B. Local payload-policy tests establish requested TTL and accounting, not actual hits after idle time.

## Our patch and the observed miss

The [versioned local policy](https://github.com/tuliopaim/pi-stuff/blob/26ea2d5cf22127bea9fbf2b1fc0f2837e1de827f/vendor/pi-optchat/src/cache.ts#L24-L42) selects main/connected retention from the conversation default, while delegated/compactor/import default short. Workload-specific overrides can change each. Global `none` disables caching. [Block construction](https://github.com/tuliopaim/pi-stuff/blob/26ea2d5cf22127bea9fbf2b1fc0f2837e1de827f/vendor/pi-optchat/src/cache.ts#L58-L93) sets `ttl: "1h"` for long and drops conflicting/redundant marks. [Compactor provider options](https://github.com/tuliopaim/pi-stuff/blob/26ea2d5cf22127bea9fbf2b1fc0f2837e1de827f/vendor/pi-optchat/src/compactor.ts#L64-L80) follow the same policy. [Usage provenance](https://github.com/tuliopaim/pi-stuff/blob/26ea2d5cf22127bea9fbf2b1fc0f2837e1de827f/vendor/pi-optchat/src/usage.ts#L37-L90) records policy on observed requests without retroactively assigning it to old history.

The patch does **not** change sawtooth merging, turn reconstruction, previous-exchange selection, model/tool/system stability, the 20-position lookup, or Anthropic's cache matching. Our `memory.ts` and `transcript.ts` match upstream 0.8.9 byte-for-byte. The one-hour policy is our patch, not a newly discovered upstream setting.

### Confirmed local evidence

Session `01a16a48-4711-72d1-8ff7-a72e7ebfc8a4`, 2026-10-23 UTC:

| Time | Evidence |
| --- | --- |
| 20:03:54 | Earlier request read 102,475 cached tokens. |
| 20:14:39 | Assistant request aborted; run ended. This is a run boundary, not evidence of a process restart. |
| 20:14:44.706 | New run request read 0, wrote 46,324, and reported `cacheWrite1h: 46324`; metadata was `main`, `long`, `workload-v1`. |
| Following request | Read the 46,324 tokens written above. |

The miss's stored usage is input 4, output 776, cache read 0, cache write 46,324. Stored `usage.cost.cacheWrite` is **$0.370592** and total **$0.386128**. These are Pi-calculated estimates stored alongside provider-reported token usage, not a dollar invoice returned by Anthropic. This research rechecked the matching local ledger row without including prompt text.

The request shrank from roughly 103k prompt tokens to 46k across the boundary. There is no raw request capture or per-block fingerprint for the two requests. Saving memory near the boundary does not prove a sawtooth merge took place. The original cache-write age for every relevant breakpoint was not reconstructed either; a recent read count is not by itself a complete map of all TTLs and entries.

### Inferences, ranked for investigation

1. A rebuilt view, previous-exchange choice, or run-history substitution changed an early message prefix. Context construction makes this plausible, but no exact changed block was captured.
2. Tools, system instructions, thinking/effort, or another prompt-affecting setting changed. Because tools/system precede messages, these can explain a full miss even when much of the view text is unchanged.
3. A prior matching entry existed but the new marks could not reach it after enough view growth or a layout change. This needs prior and current breakpoint positions, not token totals.
4. Cache availability/scope/actual earlier-entry TTL differed from what we expect. The new one-hour write alone does not reveal the old entry's lifetime or workspace. Investigate this if fingerprints match and breakpoints should reach a known live entry.

The phrase "cache miss after 11m idle" is a useful symptom, not proof of five-minute expiry. Equally, `cacheWrite1h > 0` is not proof that a prefix survived an idle gap. Both earlier conclusions would overstate the evidence.

## Better next investigation

### Use Anthropic's first-party diagnostics where supported

The current [cache diagnostics documentation](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics) describes exactly the missing comparison. These are documentation claims, not features tested live in this investigation.

- [Basic usage](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics#basic-usage): "Include the `diagnostics` object on every turn" and "the API stores a fingerprint only for requests that include it." First send `diagnostics: {"previous_message_id": null}`, then reference the prior response's `id`. Both requests must opt in; adding it now cannot retroactively diagnose this miss.
- The same section says: "The `cache-diagnosis-2026-04-07` beta header is no longer required." The page metadata marks the Claude API feature `ga`. We use direct Anthropic, but actual account/model/SDK acceptance still needs a small opt-in test.
- [Streaming](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics#streaming): "`diagnostics` appears on the `message_start` event."
- [Response format](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics#response-format) distinguishes response `diagnostics: null` (unrequested, first turn, or no divergence) from `{"cache_miss_reason": null}` (comparison pending) and a populated reason. For example: `{"diagnostics":{"cache_miss_reason":{"type":"system_changed","cache_missed_input_tokens":41850}}}`. Do not treat a missing/null value as proof of a match unless opt-in and prior-reference preconditions are known.
- [Reason types](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics#cache-miss-reason-types) include `model_changed`, `system_changed`, `tools_changed`, `messages_changed`, `previous_message_not_found`, and `unavailable`. Only the first divergence is reported. The estimated missed-token count is not a billing number.
- [Data retention](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics#data-retention): "Anthropic does not store the raw text of your prompts or Claude's outputs for this feature." Fingerprints consist of "cryptographic hashes and token-count estimates," scoped to organization/workspace. This is the feature's retention statement, not a claim about all API data handling.
- [Limitations](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics#limitations): fingerprints expire after an unspecified short period; same-workspace comparisons are required; diagnostics is best-effort and may be pending/unavailable. An 11-minute gap might outlive diagnostic retention even while a one-hour cache entry remains live. Local fingerprints remain useful for that case.
- [Reading alongside usage](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics#reading-diagnostics-alongside-usage): diagnostics answers whether the request changed; cache-read usage answers whether the cache actually hit. Neither substitutes for the other.

### Installed Pi 1.4.0 can expose the needed evidence

Read-only source check under `~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/` found the hooks below. Package metadata points to `earendil-works/pi`; tag `v1.4.0` resolves to commit `4a080252f06caf63a525d7873c5d94d3c23887e0`. The installed source-map embedded contents for the Anthropic provider, extension types, SDK wiring, and cost calculation match the files at that pinned commit byte-for-byte.

| Installed file | Finding |
| --- | --- |
| `pi-ai/dist/api/anthropic-messages.js:477–499` | Invokes `onProviderStreamEvent(event, model)` before normalization; saves `output.responseId = event.message.id`; saves token and 1h-write details. It does not copy Anthropic's `message.diagnostics` into the normalized assistant message. Pinned source: [anthropic-messages.ts L696–721](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/api/anthropic-messages.ts#L696-L721). |
| `pi-coding-agent/dist/core/extensions/types.d.ts:692–719` | Exposes `before_provider_request`, `after_provider_response` with headers, and `provider_stream_event` with raw `data`. Pinned source: [types.ts L900–930](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/extensions/types.ts#L900-L930). |
| `pi-coding-agent/dist/core/sdk.js:240–252,275` | Wires the stream observer to extension events. Pinned source: [sdk.ts L388–400](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/sdk.ts#L388-L400), [L424–426](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/sdk.ts#L424-L426). |

The provider has a separate Pi diagnostic list for errors/fallbacks; that is not Anthropic's cache-diagnostics response object. An extension can likely add the outgoing opt-in in the payload hook, track the prior provider response ID per conversation, and observe `message_start.message.diagnostics` via `provider_stream_event`, without changing the provider adapter. Main conversations, child Pi sessions, and direct compactor `streamSimple` calls need their own correctly scoped wiring; compactor calls can use the low-level observer option. Do not share one previous-response ID across concurrent compactions or unrelated agents.

This is source-confirmed API availability, **not an integration test**. Verify hook ordering, abort/retry/fallback behavior, raw event shape, and persistence before relying on it. In particular, diagnostic injection and local fingerprints must observe the final payload after all extensions have mutated it.

### Add bounded, content-free local evidence

For each outgoing request record correlation IDs, process/extension revision, workload/policy, model/effort, workspace identifier as a local opaque hash, run boundary, and last-use gap. Record cryptographic fingerprints of ordered tools, system blocks, and each message/block, plus cumulative prefix hashes, byte lengths, block types/roles, and cache-mark positions/TTLs. Include view revision/part IDs, whether a batch or mid-turn refresh occurred, and the previous-exchange selection ID. Record no raw prompt/tool-result text, credentials, authorization headers, or private filesystem contents.

Join the response ID, provider request ID, cache counters, `cacheWrite1h`, and diagnostic result onto that request record. Use a bounded local log with explicit opt-in and retention; hashes can still reveal repeated sensitive values and are not a substitute for access control.

This gives a falsifiable answer: same tools/system but first divergence at an early view block supports view churn; changed tools supports tool layout; identical reachable known-live prefixes with zero reads calls for a provider/scope investigation. A count-only ledger cannot answer those questions retrospectively.

## Regression and cost measurements

Keep the current per-workload split while collecting evidence. Do not turn on one-hour caching for every role just to improve the headline hit ratio, or disable compaction just to preserve a long prefix.

Add deterministic fake-clock cases around the final serialized payload:

- Stable prefix after 4, 6, 11, and 61 minutes: short should expire after its TTL; long should still hit at 11 and expire after 61 without intervening reads. Test read refresh separately.
- The same warm-prefix case across `/reload`, process reopen, normal next-user-turn, abort/resume, and connected-window continuation. Do not clear the fake cache at each boundary.
- A deliberate sawtooth merge, rebuilt/invalid saved view, changed previous exchange, and mid-turn refresh: expect a classified changed prefix and measure the surviving prefix, rather than demand an impossible full hit.
- Long tool turns, more than 60 added view blocks, tool-order changes, instruction edits, thinking/effort changes, and image changes; assert legal marks and report reachable versus total stable prefix separately.
- Cold sibling batches: one primer for identical prefixes; independent leaders for different model/effort/cwd. Verify aborted leaders release waiters.
- Verify the one-off compaction task remains unmarked under both TTL policies.

After deterministic tests, run a small, approved live trial with a fixed synthetic prefix and minimal output. Warm a one-hour prefix, leave it unchanged for 11 minutes, then check provider reads and diagnostics. Run a changed-view control separately. Simulating time tests our logic, but only this live unchanged-prefix check establishes reuse after a real idle gap.

For Grafana, retain weighted hit rate `sum(read) / sum(input + read + write)` and input cost per million prompt tokens. Add buckets for idle gap and request/run boundary, workload, model/effort, actual write TTL detail, and first-divergence reason. Track absolute write tokens/cost per completed human turn and per summary, not just percentage hits. Keep unknown historical policy distinct. Compare matched workloads; role and context-size changes confound day-over-day totals.

### Prices and historical estimates

[Anthropic's current pricing section](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing), fetched 2026-10-23, says "Cache write tokens with a 5-minute TTL are 1.25 times" base input and one-hour writes are "2 times" base input. The table lists Opus 5.5 at $4/MTok input, $5 short writes, $8 long writes, and $0.20 reads. Its footnote says Opus 5.5 and Sonnet 5.5 reads are **0.05x** base; "All other models use the standard 0.1x multiplier." The earlier generic explanation that reads always cost 0.1x is therefore not model-accurate for the current Opus 5.5 table. Use the selected model's current rate, including tiers, rather than hardcoding that multiplier.

The exact miss estimate remains $0.370592 in writes: `46,324 × $8 / 1,000,000`. Read pricing does not change this all-write event. Pi's installed `pi-ai/dist/models.js:672–691` computes `usage.cost` from model rates; it separates `cacheWrite1h` and prices those tokens at twice base input. Pinned matching source: [models.ts L1236–1255](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/models.ts#L1236-L1255). AI Usage preserves these recorded estimates rather than repricing history: [pi-spend.ts](https://github.com/tuliopaim/ai-usage/blob/9c00f0e32dd1ffe9a6a97822869957409919eaba/src/pi-spend.ts#L305-L328). Consequently, do not silently rewrite old cost records using today's documentation. Auditing read-rate accuracy is a separate check of the model catalog actually used at the request time.

For an unchanged prefix written once then reused once after more than five but less than sixty minutes, long writes can pay off: in base-input units, long costs `2 + r` versus two short cold writes at `1.25 + 1.25 = 2.5`, where `r` is that model's read multiplier. If the second request arrives within five minutes, short costs `1.25 + r`, and long's extra 0.75 buys no extra hit. If the prefix is rewritten each time, long writes only increase the expense. This is why main/connected at one hour and bursty delegated/compaction work at five minutes is reasonable, but still needs measured costs rather than a hit-rate promise.

## Recommended outcome

Do not pursue an upstream update as the cache-miss fix: our base already includes the relevant UniiChat-review changes. Rebase to newer upstream separately if its other fixes are wanted, preserving local policy and Herdr behavior.

The next useful change is opt-in first-divergence diagnostics plus fake-clock regression coverage, followed by a real unchanged-prefix 11-minute check. Only then decide whether to change view batching, preserve more of a previous run, or trade one view breakpoint for a separate tools/system breakpoint. The evidence presently supports "one-hour writes are active; the cause of this miss is not established," not "the TTL patch is broken" or "OptChat compaction definitely caused it."

## Follow-up: offline idle replay and incident memory snapshots

A deeper local investigation added two read-only/offline tools:

```sh
agent/node_modules/.bin/tsx --test tests/optchat-cache-idle.test.ts
python3 tests/optchat-cache-snapshot.py
```

The seven tests call the vendored 0.9.0 `cachePayload` implementation. One also uses the real `Memory` scheduler, rendering and compaction with a deterministic local compressor. The simulated cache models explicit prefix writes, a controllable clock, read refresh and a 20-position lookup. It is not Anthropic's implementation: it omits minimum token thresholds, tokenization, images, tool-run position grouping and server-side eviction. All data is synthetic; no requests or paid model calls occur.

Results:

- An identical one-hour payload hits after 11 simulated minutes. A five-minute payload expires over that interval.
- A one-hour read refreshes expiry; leaving the entry unread for more than an hour expires it.
- Changing only the current task retains view-prefix reuse.
- Changing the system text, or the first memory-view block, causes a full miss even while the old entries remain live.
- Real memory compaction under a reduced test budget changes the first rendered line and causes a full simulated miss. Its immediate follow-up hits. This reproduces the incident's pattern, not its exact historical wire payload.
- A sufficiently large append-only view increase can also move the existing marks beyond lookup coverage. The synthetic plain-text case hits with 236 appended lines but misses with 260. This does not establish a universal tool-step limit.
- An experimental layout that replaces the oldest view mark with a system mark stays within four marks and preserves system/tools reuse across a rewritten view. It does not preserve the rewritten memory and sacrifices some long-view-growth coverage. It is a test experiment only, not enabled in the launcher or extension.

### New historical evidence

The snapshot script reads the work profile's memory Git history locally and prints counts, part identifiers and SHA-256 fingerprints only. It does not print conversation text, write memory files, replay the scheduler, or reconstruct complete provider payloads.

| Evidence | Before | After |
| --- | --- | --- |
| Memory commit | `41c61db` | `d346744` |
| Commit time UTC | 2026-10-23 19:57:37 | 2026-10-23 20:14:39 |
| Entries | 819 | 885 |
| Saved view coverage | 774 | 869 |
| Saved parts plus trailing entries | 343 lines | 203 lines |
| First memory part | `0+16` | `0+32` |
| First-line SHA-256 | `775e040fc1603de8a30836532f1330c88cc1a02e1cd71435bcc878ef6849f6c9` | `116c359a231cd9503ae375c1331adee5b10a9a9df33b9f4720f221cf8fe87b75` |

The compared memory views have **zero unchanged leading lines**. Commit `d346744` was saved five seconds before the 20:14:44 UTC full miss. The session's preceding run began at 19:59:38 UTC and ended at 20:14:39; the next began at 20:14:44. The incident's 46,324-token write was reported as one-hour retention, followed by immediate cache reuse.

This is substantially stronger evidence for early memory-prefix churn than the previously observed token-count reduction. It is not conclusive wire-level attribution. Saved state is not necessarily the exact frozen view sent on the last request of a run; mid-turn refresh and other system/tools changes remain possible. The script reconstructs persisted parts plus trailing entries without re-running view fitting. Request fingerprints were not captured historically.

Working conclusion: one-hour retention is active. An early memory rewrite is the leading explanation for this incident, and the current lack of a system/tools fallback can amplify the rewrite cost. Longer TTL cannot make a rewritten prefix match an older cache entry. Do not describe this as demonstrated five-minute expiry or as definitively proven provider failure.

Recommended next design experiment is to compare mark allocations across both compaction and long-turn workloads before changing production. A system fallback can reduce the cold-write portion, but a naive replacement may worsen lookup coverage for long turns. Keep main/connected at one hour and delegated/compactor/import at five minutes while evaluating that tradeoff. No live instrumentation or runtime change was made in this follow-up.
