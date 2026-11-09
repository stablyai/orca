# OMP relay-host immediate-close probe (#9530)

This opt-in probe uses a real installed OMP binary and native PTYs behind production
`PtyHandler` spawn/data/shutdown handlers. The dispatcher is an in-process test
transport; no SSH connection or rendered client is exercised. OMP source is read-only.

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_OMP_PROBE_BINARY=/absolute/path/to/omp \
  ORCA_OMP_PROBE_SHELL=/bin/bash \
  node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts \
  tests/tools/omp-relay-close-lifecycle.test.mjs
```

The test defaults to zsh on macOS and bash on Linux. Windows is skipped. It needs
existing native node-pty dependencies; do not install or rebuild as part of the probe.
HOME, user profile, XDG roots and OMP/PI agent roots are disposable, profiles cleared,
and zsh inheritance fenced to the disposable root. No model request is made. The
probe runs `! /bin/sleep 120`, records exact shell/OMP/tool process rows, requests
immediate close, and observes those PIDs independently of the relay inventory.
Matching PID/start-time/group identities bound leftover cleanup. Reports and capped
terminal transcripts stay in `.bench-fixtures/omp-relay-close-*`.

## Measured on macOS with OMP 18.1.18

At source base `93c370246388`, bash mode leaves sleep PID 43156, PGID 43156, alive
and reparented to PID 1 after root PID 42902 and OMP PID 42949 exit. The zsh control
exits cleanly: OMP uses a headless PTY for zsh/fish user-shell tools, while bash
uses its embedded-shell subprocess path. Thus an external command alone does not
determine the process lifetime; the configured user shell matters.

With the correction, the same bash probe leaves none of its captured PIDs present.
This is detached-tool leakage, not proof of the original foreground-OMP-survives
report. The local-provider/daemon correction is PR #20642; this probe and correction
cover the separate direct-relay backend.

## Reliability contract

- Invariant: `terminal-session.explicit-close-retirement`. Explicit immediate close
  captures still-parented detached descendants before root termination, preserves
  the exact host owner through physical exit, and cannot attach/adopt that owner
  while the close is pending. A concurrent close joins the same operation.
- Failure source/oracle: actual OMP external sleep survives the bash-mode relay
  close before the fix; independently queried owned PIDs are absent afterward.
  Unit tests also cover pending attachment/adoption/create replay, natural exit
  during capture, signal failure/retry, retained claims during initial promotion,
  and close completing while attachment awaits a source checkpoint.
- Gate: the existing experimental explicit-close gate's descendant/backend tests,
  relay lifecycle suites and this opt-in real-PTY probe. Live SSH transport and
  rendered client flows remain explicit validation gaps.
- Budget: one existing bounded process-table capture (one-second timeout, 32-MiB
  cap), plus one bounded identity recheck after the two-second grace when there
  are descendants. Same-turn captures coalesce; no recurring polling is added.
- Authority: the execution host does all process inspection/signaling. Pending-close
  refusal carries no proven-exited marker; it is not evidence of process death.
  No new RPC fields/opcodes or required capabilities. Older clients receive an
  ordinary failed attach while close is pending, not a successful doomed attachment.
- Scope: every immediate POSIX relay close, including still-parented intentionally
  detached jobs. Graceful close, disconnect grace, keep-alive and fatal-exit/dispose
  policies are unchanged. Windows retains its immediate force-kill path and now
  rejects attachment during the physical-exit wait. Folder workspaces and worktrees
  use the same PTY identity, without repository metadata checks.
- Gaps: macOS runtime evidence only; Linux/Windows/WSL runtime, live SSH/mobile and
  mixed-version clients are not exercised. Children reparented before capture and
  same-second identity ambiguity retain the incumbent cleanup limitations.

Mock-PTY suites isolate the sweep: their fake PIDs often equal the test runner's PID
and must never reach the real host process table or descendant signals.
