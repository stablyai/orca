# STA-5698 relay epoch gate diagnosis, fix, and revalidation

## Verdict

Both required openclaw end-to-end scenarios pass after the fix.

- **Relay replaced / known-different epoch:** PASS. Orca declined the persisted agent resume, launched the stub exactly once without `--resume`, displayed `--- previous session unavailable, started fresh ---`, and left a working shell.
- **Relay alive / same epoch:** PASS. Orca relaunched the agent with `--resume sta5698-session-diag-task01` and displayed `--- session restored ---`.

## Proven root cause

The epoch read did not time out and was not cached as `undefined`. The relay recovery path positively determined that the old PTY was absent, then removed the stable owner from ownership state before the renderer requested its cold agent resume. `spawnForStablePane` did execute, but its `owner` argument was `null`; the previous implementation only called `deriveStablePaneFreshSpawnOptions` when an owner remained, so the epoch gate never requested `relay.status` and the resume passed through unchanged.

Temporary instrumentation captured the following sequence before any production change:

1. The old relay PTY was reported absent during reconnect and its stable owner was cleared.
2. The renderer initiated `startFreshColdRestoreAgentResume`.
3. The request reached `spawnForStablePane` with no owner PTY ID.
4. The fresh spawn retained the resume identity and launched Claude with `--resume`.

The instrumentation also called the deployed relay's raw `relay.status` method. Its reply contained:

```json
{ "ptyIdMintEpoch": "e865b114-0e7c-4ff1-93a9-3a13952800b4" }
```

This establishes that the deployed relay published the field and that the gate was skipped before any timeout/cache behavior could matter.

## Ranked hypotheses

- **H1 eliminated:** `requestHostRpc('relay.status')` was called zero times in the failing path. The read did not fail or time out, so the existing positive/negative promise cache was not causal.
- **H2 eliminated:** the raw deployed `relay.status` reply included `ptyIdMintEpoch` as shown above.
- **H3 refined, not causal:** the renderer did initiate `startFreshColdRestoreAgentResume`, but that request still passed through `spawnForStablePane`; this was not a bypass spawn site.
- **H4 eliminated:** the owner did not carry the replacement relay's epoch. It had already been removed, so the comparison was skipped rather than comparing new against new.

## Fix

Relay recovery now records the old, epoch-bearing owner by SSH connection and pane key immediately before clearing an absent PTY. The IPC and runtime spawn paths pass the pane key into `spawnForStablePane`, which consumes the retired owner when the live owner is gone and the fresh spawn has explicit persisted resume identity (`resumeProviderSession` or `agentSessionEnsure`).

The existing comparison semantics remain intact:

- known-different epochs strip resume options and mark `agentResumeUnavailable`;
- same epochs preserve the resume;
- unknown status, timeout, malformed IDs, non-SSH owners, and ordinary new agent launches behave as before.

The retired owner is one-shot and connection-scoped, so it cannot cross the SSH execution boundary or affect a later unrelated spawn.

## Regression proof

The new regression test was run against the pre-fix implementation and failed as expected:

```text
expected requestHostRpc to be called once, received zero calls
1 failed, 8 passed
```

That failure directly reproduced the missing gate after relay recovery had retired the owner. Coverage now includes:

- different epoch after a retired owner: resume declined;
- same epoch after a retired owner: resume preserved;
- ordinary new agent launch: retired owner does not convert it into a resume decision;
- SSH reconnect retirement: the absent remote PTY records the correct connection/pane-scoped owner before cleanup.

Final targeted result: 2 files passed, 46 tests passed.

## Electron environment

- App identity: `Orca: brennanb2025/sta5698-integration-e2e`
- `devRepoRoot`: `/Users/brennanbenson/orca/workspaces/orca/sta5698-electron-e2e`
- Named Playwright session: `sta5698-diag-task01-final`
- Isolated CDP endpoint: `127.0.0.1:9334`
- Isolated renderer: `127.0.0.1:5176`
- Isolated user-data path: `/tmp/orca-sta5698-diag-task01.klaEPi`
- SSH target: config-backed `openclaw`, displayed as `openclaw-sta5698-diag-task01`
- Remote namespace: `/home/brennan/sta5698-diag-task01-20260829T0018Z`
- Provider session identity explicitly seeded through the real store: `sta5698-session-diag-task01`

`window.api.app.getIdentity()` was checked before validation and matched the worktree above.

## Test 1 — relay replaced, resume must be declined

**PASS**

- Exact old relay PID sent `SIGKILL`: `3031516`.
- PTY mint epoch changed from `17abb0ae-969d-47c7-b59e-2a00ac800b0c` to `c31268f9-6763-4b06-8b35-976f924440ce`.
- Stub launch count: exactly 1.
- The only stub launch had `--dangerously-skip-permissions` and no `--resume`.
- Visible banner: `--- previous session unavailable, started fresh ---`.
- Working-shell sentinel: `STA5698_TEST1_SHELL_OK`.

Evidence:

- [Fresh-session banner](./test1-relay-replaced-pass.png)
- [Working shell sentinel](./test1-working-shell-pass.png)
- [Stub launch log](./test1-stub-launches.log)

## Test 2 — relay alive, same epoch must resume

**PASS**

- Relay PID remained `3035314` throughout the scenario.
- Mint epoch remained `c31268f9-6763-4b06-8b35-976f924440ce`.
- Exact pane shell PID sent `SIGKILL`: `3046028`, after verifying `/bin/bash --rcfile /home/brennan/.orca-relay/shell-ready/bash/rcfile`.
- The dedicated pane-recovery remount seam was invoked after the automatic health remount did not trigger.
- The replacement PTY kept the same epoch and advanced to suffix `:4`.
- Stub launch count increased from 1 to 2.
- The second launch was `--dangerously-skip-permissions --resume sta5698-session-diag-task01`.
- Visible banner: `--- session restored ---`.

Evidence:

- [Restored-session UI and exact resume invocation](./test2-same-relay-resume-pass.png)
- [Stub launch log](./test2-stub-launches.log)

## Required checks

All final checks passed after formatting the final implementation:

```text
pnpm tc
pnpm test src/main/ipc/pty/                          # 3 files, 23 tests passed
pnpm test src/main/ssh/ssh-relay-session.test.ts \
  src/main/ipc/pty/pane/stable-owner-relay-epoch.test.ts  # 2 files, 46 tests passed
npx oxlint <all 7 changed TypeScript files>
pnpm oxfmt <all 7 changed TypeScript files>
git diff --check
rg 'STA5698_DIAG' src/main src/renderer             # no matches
```

## Cleanup

The test agent tab was stopped and closed through the isolated Electron UI using Playwright CDP. The named Playwright session was closed, the recorded Electron session was interrupted, ports 9334 and 5176 were verified free, exact relay PID `3035314` was verified and terminated, the exact remote namespace was removed, and the isolated local profile was moved to Trash. No broad process kill or desktop-control automation was used.
