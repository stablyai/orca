# Repro harness: watcher.node main-process crash (issue #7547)

Manual, Windows-focused harness for the `@parcel/watcher` native crash class
(`0xc0000409` fail-fast / `0xc0000005` AV in `watcher.node`; same family as
macOS #5377 and Linux #6635). Not run in CI — it deliberately crashes
processes and hammers the filesystem.

All watched/churned directories live under `os.tmpdir()`, never the repo.

## Reproduce the bug (in-process watcher, pre-fix architecture)

```
node tools/repro-watcher-crash-7547/run.cjs delete-root 3 15000
```

Spawns `child.cjs`, which uses `@parcel/watcher` **in-process** the way
`filesystem-watcher.ts` did before the fix. Scenarios (arg 1):

- `delete-root` — subscribe to worktree-like dirs, churn files, delete the
  watched root mid-churn, unsubscribe (worktree deletion during agent writes).
  Crashes in seconds on Windows.
- `unsub-churn` — rapid subscribe/unsubscribe cycles against live churn.
  Also crashes: the trigger is `unsubscribe()` racing active event delivery
  (`CancelIo` from the wrong thread leaves a pending `ReadDirectoryChangesW`
  completion pointing at a freed `Subscription`).
- `worker-mix` — worker_threads sharing the process-global native `Watcher`.
- `del-nounsub` / `del-nochurn` / `del-1lane` — minimisation variants
  (deletion without unsubscribe does NOT crash; unsubscribe is the trigger).
- `overflow`, `mixed`.

A native crash surfaces as the child's exit code (`0xC0000409` = 3221226505,
`0xC0000005` = 3221225477) and the runner stops.

## Verify the fix (out-of-process watcher)

Build first so the forked entry exists, then run from the repo root:

```
npx electron-vite build
node tools/repro-watcher-crash-7547/fixed-child.cjs 15000
```

`fixed-child.cjs` esbuild-bundles the real `src/main/ipc/parcel-watcher-process.ts`
client and runs the same `delete-root` + `unsub-churn` load through the forked
`out/main/parcel-watcher-process-entry.js`. Expected output: contained watcher
process crashes (counted, recovered by respawn+resubscribe, surfaced through
`onInterruption`), a final health check that sees live events, and exit 0.

Exit codes: 0 pass · 5 watcher not functional at end · 6 in-process fallback
used (isolation not exercised) · 7 watchdog · 8 premature exit.
