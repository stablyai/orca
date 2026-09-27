# Cross-machine recovery rendered evidence

From the repo root, run
`ORCA_BACKGROUND_LAUNCH=1 mise exec node@24 pnpm@12.0.0 -- node tests/tools/cross-machine-recovery-rendered/run.mjs`.
Add `SKIP_BUILD=1` to reuse the current `electron-vite build --mode e2e` output.
Every Orca window stays hidden and unfocused; screenshots come from the renderer over the Chrome DevTools Protocol.

The script runs two Playwright specs with `ORCA_RECOVERY_RENDERED_DIR` pointed at a fresh
`.bench-fixtures/cross-machine-recovery-rendered-*` directory (gitignored):

- `tests/e2e/cross-machine-recovery-rendered.spec.ts` opens Recover Sessions from the Cmd-J
  palette against a fake cc-sync provider that lists one item per state, asserts that state, and
  captures `picker-complete.png`, `picker-partial.png`, `picker-paused.png`,
  `picker-collision.png` and `picker-divergence.png`. It skips when the variable is unset.
- `tests/e2e/cross-machine-recovery-two-profile.spec.ts` exports a workspace from one profile,
  imports it into a second one, and captures `two-profile-1-before-import.png` through
  `two-profile-4-after-resume-and-shell.png`, including the Recovered session placeholders.

`report.json` lists the captured and missing screenshots. The script exits non-zero when a spec
fails or a screenshot is missing.

The provider is a fixture script and `claude` is a fake CLI, so this proves rendering and the
Orca-side contract, not cc-sync transport or a real Claude resume.
