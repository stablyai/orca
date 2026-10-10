# AGENTS.md — E2E Tests

## Build the App With `--mode e2e` Before Running Tests

E2E tests read Zustand state via `window.__store`. That global is only assigned when the preload bundle is built in `e2e` mode, which is applied when you pass `--mode e2e` to `electron-vite build`. A plain `pnpm build` or `pnpm build:electron-vite` produces an `out/` tree **without** the store exposed, so reusing it with `SKIP_BUILD=1` makes every spec hang on `waitForFunction(() => Boolean(window.__store))` and time out at 30s.

- Default path: `pnpm run test:e2e` — `globalSetup` runs `electron-vite build --mode e2e` for you.
- Fast iteration: `pnpm exec electron-vite build --mode e2e` once, then `SKIP_BUILD=1 pnpm run test:e2e …`.
- If **every** E2E test times out at the `window.__store` line, do **not** assume the harness is broken. The `out/` build is almost certainly stale or was produced without `--mode e2e`. Rebuild with `--mode e2e` and retry before changing test code.

## Prefer a Store-Slice Unit Test When the Logic Is Pure

An E2E spec that calls `store.getState().someAction(...)` inside `page.evaluate` is a unit test paying the cost of an Electron launch (~1.5s) for no extra coverage. Before adding one, check `src/renderer/src/store/slices/*.test.ts` — most store-level behavior (tab moves, splits, reorders, merges, no-op guards) is already covered there with `createTestAppStore()`.

Reach for E2E only when the test needs something a unit test genuinely cannot reach:

- Real dnd-kit / pointer events, focus, keyboard shortcuts, or drag-and-drop UI cues.
- IPC round-trips through the main process (repos, filesystem, PTY, Git).
- Persistence: app restart, userData dir, session rehydration.
- Multi-window or multi-worktree interactions that depend on Electron lifecycle.

If the test could be rewritten to import the slice and drive it directly without losing fidelity, do that instead.

## E2E Assertions Must Target the DOM, Not the Store

`window.__store` is fine for _setup_ (seeding a repo, pre-filling a draft, stubbing hydration timing) but the thing a spec finally `expect()`s on must be user-observable — `getByRole`, `toBeVisible`, `toHaveText`, `toContainText`. A spec that both writes to the store and reads it back is asserting that Zustand's setter works, not that Orca works.

Why this matters: the `'create-worktree'` modal key lived on in the `activeModal` union long after `AddWorktreeDialog.tsx` was deleted in #710, so `store.openModal('create-worktree')` + `store.activeModal === 'create-worktree'` round-trips succeeded against a modal that rendered nothing. That tautology is what let #1186 (React error #31 in `StartFromField`) ship — the store-layer test passed while the composer actively crashed for real users.

Concretely:

- Use the store to reach a state; use the DOM to prove the state is correct.
- If a render-layer regression would leave the store clean but the UI broken, a store-only test will not catch it. Mount the affected subtree and assert on what the user sees.
- Headless (`ORCA_E2E_HEADLESS=1`) does not exempt you from this rule — Playwright drives the real DOM via CDP regardless of window visibility. The rare cases that need focus or pointer capture use `ORCA_E2E_HEADFUL=1` via `project.metadata.orcaHeadful`.

## Terminal Layout Parity Check

Terminal-topology refactor PRs must be inert or fix a named bug. `terminal-layout-parity.spec.ts` runs fixed journeys in the real app (create tab, split right then down, close pane, close tab, reorder panes, drag a pane out to a new tab across two restarts, CLI split, split plus new tab across restart, non-git folder workspace), captures the renderer's terminal topology and the saved `workspaceSession` from `profile-state.db`, and `terminal-layout-parity-snapshot.ts` relabels volatile values (UUIDs and PTY suffixes by first appearance in ordered structure, times, pids, temp paths) so two runs of one commit compare equal.

- `pnpm run test:e2e:terminal-layout-parity` compares the working tree with its merge-base on `origin/main`; `-- --base <ref> --head <ref>` compares two commits (each built once in a detached worktree under `.tmp/terminal-layout-parity`); `--base X --head X` is the determinism check. `-- -g close-pane` runs only matching scenarios. A checkout is stamped only after its build finishes; the working tree builds in Playwright's global setup. CI needs `fetch-depth: 0`.
- The head's spec drives both builds (cwd picks which `out/` the helpers launch), so a journey cannot depend on a test hook main lacks.
- A fix declares itself in `terminal-layout-parity-declared-differences.ts` (scenario, bug id, report path prefixes). Undeclared differences fail, and so does a declaration that matches nothing.
- Journeys wait for every pane's PTY to bind and for main's `terminal.list` to match the renderer before quitting; without that pacing, `activeLeafId` and the saved host-authority fields race on main. A path main still does not reproduce goes in `TERMINAL_LAYOUT_PARITY_UNSTABLE_ON_MAIN` with its evidence; it is reported, not failed.
- Follow-ups: setup-script split, SSH Docker relay split plus restart, second client or mobile edit.

## Workspace Layout Oracle

`workspace-layout-oracle.spec.ts` (window attached) and `workspace-layout-oracle-headless.spec.ts` (orcad and Electron `orca serve`, no window) drive layout journeys through the commands users, the CLI and paired clients send, and after every step decide pass/fail with no reviewer:

- **rules**: the runtime's layout (main's session over the read-only `session:get` IPC; a headless runtime's saved profile) against `workspace-layout-rules.ts`: a terminal in two panes, a pane in two tabs, a tab outside exactly one group, tab rows and tab bar disagreeing, two tab orders, an id changing for the same pane, tab or group. A sampler also runs the rules every 100 ms between steps; breaches that heal before a step settles are recorded as `(transient)`. (The unit model test checks every write exactly, via `store.onWorkspaceSessionWritten`.)
- **roundTrip**: each partition, through the layout module's Loader then Serializer, must reach a fixed point: a second load changes nothing (`workspace-layout-round-trip-check.ts`). This is an idempotence check; its list of change kinds a first load may make is broad. The same check runs in the app on every Store write in dev and e2e, logged as `[workspace-layout] round-trip check:`, with each new kind of first-load change logged as `[workspace-layout] first-load changes:`.
- **view**: what the window draws, read from the DOM (`[data-tab-group-strip-id]`, `[data-terminal-tab-id] .pane[data-leaf-id][data-pty-id]`), against the runtime. Exited or slept bindings are compared as unbound.
- **client**: `session.tabs.list` and `terminal.list` against the runtime, including custom titles and running terminals with no pane.
- **expected**: panes per tab the step must produce, which panes it removes, and that every other pane still shows the terminal it showed before (a command applied to the wrong pane, or lost). An empty layout cannot pass.
- **restart**: the layout after a relaunch, a cold relaunch with the PTY daemon killed, or the in-app daemon restart, against before.
- **marker**: an `echo` written to each visible pane's terminal must appear in that pane's xterm accessibility tree (frozen or crossed panes).
- **remount**: xterm instances are counted per pane in the window; one created again outside a relaunch, reload or daemon restart fails.

`workspace-layout-oracle-latency.spec.ts` records command-to-drawn-update p50/p95 for split, close pane, new tab, rename, tab reorder and close tab, idle and while another tab floods output. It never fails on a number.

A step waits up to `ORCA_LAYOUT_ORACLE_SETTLE_MS` (12 s) for every view to agree before recording. Findings main still has are listed in `workspace-layout-oracle-known-on-main.ts` with their bug; anything else fails. `ORCA_LAYOUT_ORACLE_RECORD=1` records without failing, `ORCA_LAYOUT_ORACLE_REPEAT=<n>` repeats each scenario, and each run writes a JSON report (with the evidence each side held) to `ORCA_LAYOUT_ORACLE_REPORT_DIR`. `node config/scripts/check-workspace-layout-rules.mjs <userDataDir>` runs the rules over any profile, including a running dev app's.
