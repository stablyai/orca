# Capture cross-machine recovery evidence

Check recovery picker states and workspace import between two local Orca profiles.
With repository dependencies installed, run from the repository root:

```sh
ORCA_BACKGROUND_LAUNCH=1 mise exec node@24 pnpm@12.0.0 -- node tests/tools/cross-machine-recovery-rendered/run.mjs
```

By default, the run builds the Electron app with `--mode e2e` and the CLI. Add
`SKIP_BUILD=1` to reuse current CLI output and an app build made with `--mode e2e`.
Missing outputs still build. Orca windows stay hidden and unfocused.
Screenshots come from the renderer over the Chrome DevTools Protocol.

The runner sets `ORCA_RECOVERY_RENDERED_DIR` to a fresh, gitignored
`.bench-fixtures/cross-machine-recovery-rendered-*` directory and runs two Playwright specs:

- [Picker states](../../e2e/cross-machine-recovery-rendered.spec.ts) opens Recover Sessions
  from the jump palette, checks one fixture item per state, and captures `picker-complete.png`,
  `picker-partial.png`, `picker-paused.png`, `picker-collision.png`, and `picker-divergence.png`.
  This spec skips when `ORCA_RECOVERY_RENDERED_DIR` is unset.
- [Two-profile import](../../e2e/cross-machine-recovery-two-profile.spec.ts) exports a workspace
  from one profile and imports it into another. It captures `two-profile-1-before-import.png`,
  `two-profile-2-imported-layout.png`, `two-profile-3-structured-placeholder.png`, and
  `two-profile-4-after-resume-and-shell.png`, including the Recovered session placeholders.

Open the output directory printed at the end of the run to inspect the nine screenshots and
`report.json`. The report records the Playwright exit status and lists captured and missing
screenshots. The runner exits nonzero if Playwright fails or any expected screenshot is missing.

The specs use a fake cc-sync provider and a fake `claude` CLI. They check Orca rendering and
recovery behavior; cc-sync transport and real Claude resume are outside this check.
