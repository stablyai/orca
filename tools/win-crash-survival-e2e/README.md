# win-crash-survival-e2e — packaged crash-survival proof harness

**Windows only.** Proves that a **crash of Orca's main process** does not orphan
open terminal PTYs — the regression behind
[GitHub #7742](https://github.com/stablyai/orca/issues/7742) —
with machine-checkable assertions against an **already-installed, packaged**
`Orca.exe`.

## Why this exists

On Windows, when Orca's main/renderer process crashed, open terminal PTYs were
orphaned and PowerShell hard-crashed with a `0xE9` "No process is on the other
end of the pipe" `FailFast`. Root cause: the terminal **daemon** (which hosts the
ConPTYs) died together with the main process, severing the console pipe.

The fix re-architected the daemon into a standalone, relocated
`orca-terminal-daemon.exe` (see
[`src/main/daemon/daemon-host-relocation.ts`](../../src/main/daemon/daemon-host-relocation.ts))
that is spawned **detached** and **survives main-process death**.

There is already a harness proving the daemon survives a Windows **update**
([`tools/win-update-e2e`](../win-update-e2e/README.md)). This harness proves the
daemon survives a **crash** of the main process, so that guarantee can't silently
regress. It **reuses win-update-e2e's shared modules** (app driver, daemon
discovery, onboarding seed, PowerShell runner, platform guard, table renderer)
and adds only the crash step + its assertions.

## What it does

1. **Launch** the installed `Orca.exe` under an isolated `userData` dir
   (`ORCA_E2E_USER_DATA_DIR`), seeded with a fresh profile (onboarding dismissed
   plus one throwaway git repo), then open a plain terminal tab (the seeded
   workspace opens an agent tab, not a bare shell).
2. **Stamp the interactive shell** — typing DIRECTLY into it (not a nested
   `powershell`), set a per-shell env sentinel `ORCA_CRASH_SENTINEL=<canary>` and
   record the shell's own `$PID`. The command finishes fast, leaving the shell
   idle at a live PSReadLine prompt — the exact state that FailFasts with `0xE9`
   on a broken build.
3. **Record** the daemon PID and the real Electron **main** PID (resolved via
   `app.evaluate(() => process.pid)` — the launched instance's own main, not the
   launcher stub `app.process()` returns, and not a machine-wide scan).
4. **Crash** — `taskkill /F /PID <real-main-pid>` with **no `/T`** and **no
   graceful close**. This kills ONLY the real main of the instance this harness
   launched, never a scanned or image-named process, and never the process tree —
   a real crash does not tree-kill the detached daemon. Then **prove the crash
   landed** (poll the main PID until dead).
5. **Assert survival**: the daemon PID and the same interactive shell PID are
   still alive after the crash soak.
6. **Relaunch** (same `userData`, no reseed) and assert the daemon PID is
   **unchanged** (the new main **adopts** the surviving daemon instead of forking
   a new one) and that the reattached UI is bound to the **same survivor shell** —
   a bounded, readiness-aware command on the exact restored tab reads back both
   `ORCA_CRASH_SENTINEL` and the shell's `$PID`, which a freshly re-spawned shell
   would not carry.
7. **Scan the full crash-to-input window** and require the Windows **Application
   event log** to contain **zero** pwsh `FailFast` / `0xE9` events (matched by
   crash-reporter provider+id, not fragile Message text). Scanning after the
   reattach keystroke catches shells that fail only on their next console read.
8. **Teardown** — close the relaunched app, then kill this run's scoped daemon
   **tree** (re-discovered fresh via `findDaemonProcesses(userData)`, which the
   surviving shell is a descendant of) and remove the temp profile. It never kills
   a PID captured earlier in the run (a recycled PID could hit an innocent
   process), never installs/uninstalls, and never touches any other Orca on the box.

Exit code is `0` when every non-informational assertion passes, else `1` (`2` for
a CLI usage error).

## Usage

```powershell
pnpm win-crash-survival-e2e --expect survival
# or explicitly point at an installed exe:
node tools/win-crash-survival-e2e/run.mjs --expect survival --exe-path "C:\Users\<you>\AppData\Local\Programs\orca\Orca.exe"
```

### Flags

| Flag                 | Meaning                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `--expect <profile>` | Assertion profile (required): `survival` or `orphaned` (see below)                             |
| `--exe-path <path>`  | Installed `Orca.exe` to drive (default: per-user install under `%LOCALAPPDATA%\Programs\Orca`) |
| `--soak-seconds <n>` | Post-crash observation window before relaunch (default `8`)                                    |
| `--keep-profile`     | Skip temp-profile cleanup (debugging)                                                          |

### Profiles

- **`survival`** — the fixed behavior and the baseline that must keep passing:
  the main crash actually lands, yet the daemon + the same interactive shell PID
  survive, zero pwsh `FailFast` events fire, a relaunch **adopts** the same daemon
  PID, and the reattached UI reads back the survivor shell's env sentinel.
- **`orphaned`** — the directional inverse describing the **old broken #7742**
  behavior. Daemon death is the **primary** signal (deterministic); pwsh
  `FailFast` / `0xE9` is **secondary** — faithful only because the shell is left
  idle at a live PSReadLine prompt (which queries the severed console). On a fixed
  build this profile is **expected to fail**, proving the survival assertions are
  not vacuous. It is **not exercised in CI** (`workflow_dispatch` is unavailable on
  a non-default branch) and the `0xE9` only reproduces on a genuinely broken build.

## Safety

- **Never installs, updates, or uninstalls anything** — it only launches an
  existing exe against an isolated `userData` dir.
- The crash kills **only** the real Electron main of the instance this harness
  launched — resolved via `app.evaluate(() => process.pid)` (not the launcher stub
  `app.process()` returns) — `/F` with **no `/T`**. It never `taskkill`s by image
  name or a scanned pid, so a developer's live Orca (a different `userData`, out of
  scope) is untouched.
- **Teardown never kills a PID captured earlier in the run** (a recycled PID could
  hit an innocent process): daemon cleanup re-discovers this run's daemon fresh via
  a `userData`-scoped `findDaemonProcesses`, and the surviving shell is torn down
  as a descendant of that daemon tree.
- Daemon discovery is **scoped** to this run's `userData` path, so it never
  matches the many other daemons a dev box or CI runner can host.
- Windows-only (`assertWin32`); it no-ops with a clear error off win32.
