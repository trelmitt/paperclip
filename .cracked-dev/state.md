# cracked-dev state

Repo: paperclipai/paperclip · default `master` · fork remote `fork` (trelmitt/paperclip) · isolated worktree.

## Done (this run)
- run-classifier safety axis — PR #11107 (branch `cracked-dev/run-classifier-safety`).
- scheduler tick reentrancy guard (this branch) — `createSingleFlight` util + wrap the heartbeat
  tick so an over-running tick can't overlap the next. VERIFY: single-flight 4/4, server
  typecheck. Self-audit: CLEAN.

## Ruled out / follow-up
- Persisting the run-liveness `actionability` axis on `heartbeat_runs` (migration) — deferred.
- Per-sweep single-flight for the heavy reap/reconcile chain to stop duplicate SWEEP dispatch
  (this cycle guards the tick dispatch cycle, not each background sweep) — follow-up.

## Repo conventions learned
- Isolated worktree needs `pnpm install` once; build `@paperclipai/shared` before server typecheck.
- PRs go via the `fork` remote (no upstream write). PR template requires the dedup-search
  checkbox with real linked PRs, enforced by a bot on the `review` check.

## Next candidates (ranked)
1. Company memory table + recall tool (L, foundational).
2. Evals in CI + run-liveness golden corpus (M).
3. Auto-debit finance_events -> per-venture P&L (M).
