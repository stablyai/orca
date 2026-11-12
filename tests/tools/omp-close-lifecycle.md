# OMP owned-PTY close probe (#9530)

This opt-in probe launches an actual installed OMP binary in disposable local PTYs
and calls Orca's production `shutdownLocalPty` and `killAllLocalPtys` functions,
or daemon `Session`, native subprocess handle, and `TerminalSessionTeardown`.
It sets the same agent-session ownership flag that `activateLocalPtySession` sets
for `launchAgent` / recognized startup commands, then repeats without that flag
to represent OMP typed into a shell. This isolates termination policy; it does not
exercise Agent button delivery or terminal-tab/handle routing.

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_OMP_PROBE_BINARY=/absolute/path/to/omp \
  node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts \
  tests/tools/omp-close-lifecycle.test.mjs
```

The probe defaults to zsh on macOS and bash on other POSIX hosts. Set
`ORCA_OMP_PROBE_SHELL` to the absolute path of either shell to override. Windows
is skipped. It requires the existing node-pty native dependency for the current
Node runtime. The normal unit suite skips the test unless a binary is supplied.

Each case waits five seconds for OMP startup, captures the owned process tree,
requests explicit close or local quit cleanup, and verifies those exact process
IDs are absent using host `ps` after a six-second observation window. It records
raw terminal output and before/after process rows in `.bench-fixtures/omp-close-*`.
The fixture contains no prompt or model request. It disables the first-run setup
wizard, startup splash and update checks in a temporary config; OMP's normal tools
and extensions remain enabled. HOME, ZDOTDIR, XDG_CONFIG_HOME and OMP's agent home
are disposable. Cleanup signals only owned identities with matching process start
time and group, then removes the temporary home.

## Observed on 2026-09-14

At Orca base `93c370246388`, macOS arm64, installed `omp/18.1.18`:

- Explicit local close with the agent flag: shell and foreground OMP exited.
- Explicit local close without the flag: shell and foreground OMP exited.
- Local quit cleanup with or without the flag: shell and foreground OMP exited.
- Explicit close used the existing five-second force deadline for the shell.
  Quit removes native exit tracking immediately, so the probe uses independent
  host process evidence; an empty provider map is not its exit oracle.

The same four outcomes were observed in an initial first-run setup-splash pass.
The normal-idle transcript displayed the OMP prompt and reported no LSP servers.
No stale foreground OMP was reproduced in these local termination-policy cases.

## Detached external tool reproduction and correction

Set `ORCA_OMP_PROBE_EXTERNAL_TOOL=1` to run `! /bin/sleep 120` in OMP before
explicit immediate close. Add `ORCA_OMP_PROBE_BACKEND=daemon` to exercise the daemon
backend. Each mode tests both recognized and typed launches; these modes do not
run the local-quit cases. The probe makes no model requests. Both OMP/PI profiles
are cleared, and XDG data/cache/state roots are isolated alongside configuration.

On macOS, installed Orca `1.4.202-hourly.202609132311` and OMP `18.1.18`, an actual
non-focus CLI-created terminal reproduced the detached-child leak: shell PID
71632 and OMP PID 71667 exited after CLI close, but sleep PID 72125 (PGID 72125)
remained after the grace window, reparented to PID 1. The owned survivor was
cleaned using its captured PID/start-time/group identity. This is a detached-tool
leak, not a reproduction of the reported foreground OMP surviving for days.

With the correction, all four actual OMP/external-sleep cases (recognized/typed,
local/daemon) left none of the captured shell, OMP or sleep PIDs present. This
runs production backend code with real PTYs; it does not run a rebuilt installed
app through the CLI. Reports/transcripts remain local under `.bench-fixtures/`.

### Termination contract

Immediate close now uses the existing descendant sweep for all local-provider
and daemon shells, including agents typed after startup. This also terminates
still-parented, intentionally detached jobs that previously survived POSIX close.
The sweep captures descendants before root exit, checks current root ownership,
and retains the existing identity-guarded delayed escalation. It adds a bounded
process-table capture (one-second timeout) and, when descendants exist, the
existing single two-second delayed recheck; there is no recurring polling.
Daemon termination is claimed before awaiting capture, preventing reattachment.
Physical root exit still gates session reaping. Snapshot failure falls back to
root termination; children already reparented before capture are not covered.

The execution host runs this policy. Paired runtimes using these backends receive
the fix when their host updates; no wire fields or client-side remote PID signals
are added. Direct SSH relay PTYs use separate `src/relay/pty-handler.ts` termination
and are not fixed or runtime-validated by this change. Graceful plain-shell
shutdown, disconnect and daemon/remote keep-alive policy are unchanged. The code
uses no repository metadata and applies to folder workspaces as well as worktrees.
Windows retains its existing guarded job/tree termination; this probe skips it.

## Limits and next evidence

Do not close #9530 from this probe. The original report did not identify Orca/OMP
versions or the exact close action. A tab can disappear without this termination
entry point running, which this probe does not cover. It also does not exercise
full app quit lifecycle, background/floating/mobile handle resolution, a busy
model turn, initialized eval workers or LSPs, Windows/WSL/Linux execution, or live SSH ownership. Daemon/remote keep-alive is intentional and remains unchanged.

A failing reproduction needs the original surface/close action, provider mode,
owning runtime, and process identities before and after. Signal-resistant fixture
processes alone do not establish that current OMP has the reported leak.
