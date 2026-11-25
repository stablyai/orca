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

## Layout Changes

- Terminal-topology refactors must preserve behavior or fix a named bug. The retired
  layout-oracle and parity programs provide no current automated regression gate.
- Inspect a profile with
  `node config/scripts/static-analysis/repository-layout/check-workspace-layout-rules.mjs <userDataDir>`.
