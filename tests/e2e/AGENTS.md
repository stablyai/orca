# AGENTS.md — E2E Tests

## Build the App With `--mode e2e` Before Running Tests

E2E tests read Zustand state via `window.__store`. That global is only assigned when the renderer is built with `VITE_EXPOSE_STORE=true`, which is set by `.env.e2e` and only applied when you pass `--mode e2e` to `electron-vite build`. A plain `pnpm build` or `pnpm build:electron-vite` produces an `out/` tree **without** the store exposed, so reusing it with `SKIP_BUILD=1` makes every spec hang on `waitForFunction(() => Boolean(window.__store))` and time out at 30s.

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
