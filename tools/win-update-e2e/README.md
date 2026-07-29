# win-update-e2e — packaged NSIS update proof harness

**Windows only.** Given two Orca Windows installers (version N and N+1), this
harness performs a real silent update and proves, with machine-checkable
assertions, what happens to the terminal **daemon** and its **sessions** across
the update — and whether any console/terminal window flashes.

> **Companion harness:** proving the daemon survives a **crash** of the main
> process (GitHub #7742), rather than an update, lives in
> [`tools/win-crash-survival-e2e`](../win-crash-survival-e2e/README.md). It reuses
> the shared modules in this directory (app driver, daemon discovery, PowerShell
> runner, platform guard, table renderer).

It is the Phase 0 "proof harness" deliverable from
[`docs/windows-terminal-update-survival-plan.md`](../../docs/windows-terminal-update-survival-plan.md).
It exists specifically because the July 2026 attempt shipped four broken RCs
without ever installing the packaged artifact (see
[`docs/windows-terminal-update-survival-postmortem.md`](../../docs/windows-terminal-update-survival-postmortem.md),
"Why verification missed every one of these"). Its design refuses to repeat
those verification failures:

- **Window visibility is measured by window enumeration + owner/canary
  attribution — never by conhost command-line heuristics.** The post-mortem
  proved conhost flags invert with parent console state and `MainWindowHandle`
  is `0` for Windows-Terminal-hosted consoles. See `window-enum.ps1`.
- **Interactivity is proven by execution, not by result-shape.** Typed commands
  write sentinel **files**; the harness checks the files. A command that "runs
  and returns correct output" but flashes a window is still caught, because the
  window watch runs independently.
- **The daemon is identified by command-line marker, never by exe name.** With
  `ELECTRON_RUN_AS_NODE` the daemon image is `Orca.exe`; a relocated Phase 1
  host may be a differently-named copied binary. See `daemon-processes.mjs`.
- **Each run uses an isolated userData dir** so its daemon's socket/token path
  is unique and never collides with the many other daemons a dev box or CI
  runner can host.

## Usage

```
pnpm win-update-e2e --from <setup.exe> --to <setup.exe> --expect <profile>
# or download release assets via gh (one call each):
pnpm win-update-e2e --from-release v1.4.124-rc.9 --to-release v1.4.125-rc.1 --expect cold-restore
```

Or directly: `node tools/win-update-e2e/run.mjs --from ... --to ... --expect ...`

### Flags

| Flag                                          | Meaning                                                     |
| --------------------------------------------- | ----------------------------------------------------------- |
| `--from <path>` / `--to <path>`               | Local `orca-windows-setup.exe` for base (N) / update (N+1)  |
| `--from-release <tag>` / `--to-release <tag>` | Download the setup asset from a GitHub release tag via `gh` |
| `--expect cold-restore \| survival`           | Assertion profile (required)                                |
| `--install-dir <path>`                        | Isolated-install mode (see below) — install into `<path>`   |
| `--asset-pattern <glob>`                      | gh asset glob (default `*windows-setup.exe`)                |
| `--soak-seconds <n>`                          | Post-relaunch window-watch soak (default `180`)             |
| `--keep-install`                              | Skip teardown/uninstall for debugging (ignored in isolated) |

### Profiles

- **`cold-restore`** — **today's** behavior and the baseline that must keep
  passing against current `main`. The installer's path sweep kills the in-dir
  daemon, so: old daemon PID is **dead**, a **fresh** daemon exists, scrollback
  is cold-restored (best-effort), a new terminal is interactive, and **zero**
  unexpected console/terminal windows appear.
- **`survival`** — the Phase 1 target. Daemon PID **unchanged** across the
  update, marker process **still alive**, the pre-update session still
  interactive (typed input echoes, Ctrl+C interrupts), and **zero** unexpected
  windows.

## Safety

This harness installs, overwrites, and can uninstall a real app. Two guards
protect a developer's machine; a clean CI/VM is unaffected by either:

- **Pre-existing app process → hard refusal.** If an Orca _app_ process (not a
  daemon) is already running, the run aborts and prints the offending PIDs. The
  harness never kills a process it did not start.
- **Pre-existing install → refusal unless `--allow-existing-install`.** If an
  Orca install already exists under `%LOCALAPPDATA%\Programs`, the run refuses,
  because installing N then N+1 would silently overwrite that build and leave
  the `--to` version behind. Pass `--allow-existing-install` to proceed anyway.

Uninstall behavior at teardown follows ownership:

- **No pre-existing install** (harness fully owns it): teardown silently
  uninstalls, unless `--keep-install`.
- **`--allow-existing-install` was used** (an install existed first): teardown
  does **not** uninstall — removing a build the harness did not place would be
  wrong. It prints a prominent note that the machine now has the `--to` version
  and the prior build was not restored.

## Isolated install mode (developer machines)

On a clean CI/VM the harness installs into the default per-user location
(`%LOCALAPPDATA%\Programs\Orca`). A developer's box already has a real Orca there,
and the safety guards above would (correctly) refuse to run. **Isolated mode**
(`--install-dir <path>`) lets the harness run on that box without disturbing the
real install.

**The /D mechanism.** electron-builder's NSIS honors the standard NSIS `/D=<path>`
override for the install *directory* (`node_modules/app-builder-lib/templates/nsis/multiUser.nsh`).
`/D` is special: it must be the **last** argument and **cannot be quoted**, so the
path must be absolute and **spaces-free** (validated by `validateInstallDir`). The
installer's kill-sweep only matches processes under its own `$INSTDIR`, so a
separate directory never touches the real install's app or daemon processes.

**Why registry/shortcut backup-restore exists.** `/D` relocates *files only*.
Regardless of `/D`, the installer writes `InstallLocation` + the uninstall entry to
the **same per-user HKCU keys** as the real install
(`HKCU\Software\<APP_GUID>` and
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<key>`,
`node_modules/app-builder-lib/templates/nsis/include/installer.nsh`) and rewrites the
Start Menu / Desktop shortcuts. Left hijacked, the user's **next real update would
install into the test directory**. So isolated mode, before installing:

1. **Snapshots** the shared state (`registry-shortcut-backup.mjs`): `reg export`s
   each existing key to `.reg` files, copies the Orca `*.lnk` shortcuts, and records
   a manifest (which keys/shortcuts existed, the pre-run `InstallLocation`).
2. Runs the full install → update → assert proof against the isolated directory.
3. **Always restores** at teardown (a `try/finally` wraps everything after the
   snapshot): `reg import`s keys that pre-existed, `reg delete`s keys the test
   created, copies shortcuts back / deletes test-created ones, then **re-reads
   `InstallLocation` and verifies** it matches the snapshot. On mismatch it prints a
   loud block with the exact manual `reg import` command to recover. Isolated
   teardown **always** uninstalls the test install (the harness owns the directory)
   and removes the directory if empty — `--keep-install` is ignored.

**Residual risk.** The backup/restore covers `InstallLocation`, the uninstall entry,
and the Orca shortcuts — the state that steers a future update and the user-visible
launchers. It does **not** attempt to snapshot auto-update state files under the real
install's `userData` (the harness uses an isolated `userData` throughout, so it never
writes there), and it cannot restore state if the machine loses power mid-teardown
(re-run with a valid `--install-dir` to let restore complete, or run the printed
`reg import` by hand). The `.reg` backups live under the run's temp dir until a
successful teardown removes it.

**Example.**

```
pnpm win-update-e2e \
  --from-release v1.4.124-rc.9 --to-release v1.4.125-rc.1 \
  --expect cold-restore --install-dir C:\OrcaE2E
```

Read-only, touches nothing — print what isolated mode would snapshot on this machine:

```
node tools/win-update-e2e/registry-shortcut-backup.mjs
```

## What it does

1. **Preflight** — assert win32; warn if elevated; **refuse** to run if a
   pre-existing Orca _app_ process (not a daemon) is running that the harness
   did not start (it is printed and the run aborts — the harness never kills a
   user's processes); snapshot the baseline set of visible top-level windows.
2. **Install N** silently (`<setup.exe> /S`) and locate `Orca.exe`.
3. **Launch** the installed app (Playwright `_electron`, isolated userData),
   create ≥2 terminals, start a **marker** in one: a `powershell` loop that sets
   a unique window-title **canary**, records its PID, and heartbeats a file.
4. **Record** the daemon PID (scoped pid-file + live-process scan), marker PID,
   and session tab ids.
5. **Close** the app normally; verify the detached daemon is still alive.
6. **Start the window watch** — a background PowerShell loop polling visible
   top-level windows every 500ms, diffing against baseline, recording every new
   window (and title change) to a JSONL log through the update and soak.
7. **Install N+1** silently (the update).
8. **Relaunch** the app.
9. **Assert** per profile, then print a PASS/FAIL/INFO evidence table.
10. **Teardown** (unless `--keep-install`) — close app, kill only harness-created
    processes, silent-uninstall.

Exit code is `0` when every non-informational assertion passes, else `1`
(`2` for a CLI usage error).

## Standalone instrument self-tests (no installers needed)

Each probe module runs on its own so the harness's own instruments are testable:

```
# Opens a real transient console window and asserts the watch catches it:
node tools/win-update-e2e/window-watch.mjs --selftest

# Read-only: list daemon processes + PID files on this machine:
node tools/win-update-e2e/daemon-processes.mjs [--user-data <dir>] [--scope <substr>]

# Emit the current visible-window snapshot as JSON:
powershell -File tools/win-update-e2e/window-enum.ps1
```

## Files

| File                       | Responsibility                                                                |
| -------------------------- | ----------------------------------------------------------------------------- |
| `run.mjs`                  | Orchestrator + CLI entry                                                      |
| `cli-args.mjs`             | Argument parsing / validation                                                 |
| `preflight.mjs`            | win32/elevation checks, pre-existing-app refusal, baseline snapshot           |
| `installer-steps.mjs`      | Silent install/update/uninstall, exe discovery, gh download                   |
| `registry-shortcut-backup.mjs` | Isolated mode: snapshot/restore the shared HKCU keys + Orca shortcuts     |
| `app-driver.mjs`           | Playwright Electron launch + terminal driving (production-safe DOM selectors) |
| `interactivity-probes.mjs` | Sentinel-file echo / heartbeat / Ctrl+C probes                                |
| `daemon-processes.mjs`     | Daemon PID discovery (command-line marker + pid file), scoped                 |
| `window-enum.ps1`          | Shared visible-top-level-window enumerator (P/Invoke `EnumWindows`)           |
| `window-watch.ps1`         | Background baseline-diff watch loop → JSONL                                   |
| `window-watch.mjs`         | Node wrapper: start/stop watch, `--selftest`, baseline capture                |
| `assertions.mjs`           | Window-event classification + profile PASS/FAIL table                         |
| `platform-guard.mjs`       | `assertWin32`, elevation detection                                            |
| `powershell-runner.mjs`    | Windows PowerShell 5.1 spawn helpers                                          |

## Known limitations

- **Scrollback fidelity is best-effort.** A production build renders the
  terminal with WebGL, so xterm text is not reliably in the DOM and the e2e
  `SerializeAddon` is not exposed. When text cannot be read the check reports
  `INFO` (unknown), never a false `FAIL`.
- **Daemon file log** does not exist yet in packaged builds (the fork's stdio is
  suppressed). The "daemon log free of ERROR lines" assertion is `INFO` until
  Phase 0 daemon logging lands, then it reads `<userData>/logs/daemon.log`.
- The harness assumes the packaged main honors `ORCA_E2E_USER_DATA_DIR` to
  relocate userData; verify this against a real packaged build.
