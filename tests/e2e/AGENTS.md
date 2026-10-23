# E2E Tests

## Build and Run

- `ORCA_BACKGROUND_LAUNCH=1 pnpm run test:e2e` builds with `--mode e2e`, which exposes
  `window.__store`.
- For iteration, build with `pnpm exec electron-vite build --mode e2e`, then run
  `ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm run test:e2e …` only while that build is current.
  A plain build omits `window.__store`; if tests time out waiting for it, rebuild in E2E
  mode before changing the harness.

## Choose the Test Boundary

- Test pure store logic in `src/renderer/src/store/slices/*.test.ts` with
  `createTestAppStore()`. Use E2E for real UI events, IPC, persistence/restarts, or
  Electron lifecycle interactions.
- Use `window.__store` for setup; assert user-visible behavior through the DOM
  (`getByRole`, `toBeVisible`, `toHaveText`). Writing state and reading it back cannot
  catch broken rendering. This applies to hidden CDP-driven renderers too.

## Layout Regression Gates

- Terminal-topology refactors must preserve behavior or fix a named bug. Run
  `ORCA_BACKGROUND_LAUNCH=1 pnpm run test:e2e:terminal-layout-parity` to compare the working
  tree with its merge-base on `origin/main`. See the
  [runner](../../config/scripts/run-terminal-layout-parity.mjs) for commit comparisons
  and scenario filters. The head's journeys must work against both builds.
- Declare intended fixes in [declared differences](terminal-layout-parity-declared-differences.ts)
  with scenario, bug ID, and report path prefixes; undeclared or unmatched declarations fail.
  Preserve PTY-binding and main/renderer agreement waits before quitting. Unstable-on-main
  exclusions need evidence in `TERMINAL_LAYOUT_PARITY_UNSTABLE_ON_MAIN`.
- Use the [window](workspace-layout-oracle.spec.ts) and
  [headless](workspace-layout-oracle-headless.spec.ts) layout oracles for live/saved layout,
  DOM/client agreement, command effects, restarts, terminal output, and remount checks.
  [Latency](workspace-layout-oracle-latency.spec.ts) measurements are informational.
- New [known-on-main](workspace-layout-oracle-known-on-main.ts) entries must cite a reproducing
  run on `main` in the PR; rerun intermittent findings until reproduced. Use
  `ORCA_LAYOUT_ORACLE_REPEAT=<n>` for repeats and `ORCA_LAYOUT_ORACLE_REPORT_DIR` for JSON
  reports. `ORCA_LAYOUT_ORACLE_RECORD=1` records without failing; do not use it as a passing gate.
- Inspect any profile with
  `node config/scripts/check-workspace-layout-rules.mjs <userDataDir>`.
