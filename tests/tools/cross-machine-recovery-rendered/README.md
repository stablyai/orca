# Capture cross-machine recovery evidence

Check recovery picker states, workspace import between two local Orca profiles, and the
Recovered session placeholder in narrow panes.
With repository dependencies installed, run from the repository root:

```sh
ORCA_BACKGROUND_LAUNCH=1 mise exec node@24 pnpm@12.0.0 -- node tests/tools/cross-machine-recovery-rendered/run.mjs
```

By default, the run builds the Electron app with `--mode e2e` and the CLI. Add
`SKIP_BUILD=1` to reuse current CLI output and an app build made with `--mode e2e`.
Missing outputs still build. Orca windows stay hidden and unfocused.
Screenshots come from the renderer over the Chrome DevTools Protocol.

The runner sets `ORCA_RECOVERY_RENDERED_DIR` to a fresh, gitignored
`.bench-fixtures/cross-machine-recovery-rendered-*` directory and runs three Playwright specs:

- [Picker states](../../e2e/cross-machine-recovery-rendered.spec.ts) opens Recover Sessions
  from the jump palette, checks one fixture item per state, and captures `picker-complete.png`,
  `picker-partial.png`, `picker-paused.png`, `picker-collision.png`, and `picker-divergence.png`.
  This spec skips when `ORCA_RECOVERY_RENDERED_DIR` is unset.
- [Two-profile import](../../e2e/cross-machine-recovery-two-profile.spec.ts) exports a workspace
  from one profile and imports it into another. It captures `two-profile-1-before-import.png`,
  `two-profile-2-imported-layout.png`, `two-profile-3-structured-placeholder.png`, and
  `two-profile-4-after-resume-and-shell.png`, including the Recovered session placeholders.
- [Narrow-pane placeholder](../../e2e/recovered-session-placeholder-narrow-pane.spec.ts) narrows a
  split terminal pane from 480 px down to the 50 px divider clamp and checks that the
  placeholder's text stays inside the pane with no word broken across lines. At 50 px it captures
  the collapsed menu trigger as `placeholder-50px-compact.png` and its open menu as
  `placeholder-50px-menu.png`.

Open the output directory printed at the end of the run to inspect the eleven screenshots,
`report.json`, and one `.identity-guard.json` per screenshot. The report records the Playwright
exit status, captured and missing screenshots, and the guard's result. The runner
exits nonzero if Playwright fails or any expected screenshot is missing. It also exits nonzero
if the guard detects this machine's username, hostname, or home path, if its read of the renderer
came back blank or missed a rendered terminal, or if a screenshot has no guard record.

The guard checks every capture so screenshots can be shared. Pane shells start with a neutral prompt:
zsh or bash read a fixture shell config in the disposable home, and on Windows the profile pins
`cmd.exe`, which reads a bare `PROMPT`. Fixture paths echoed by the terminal live under the OS
temp directory, or under an `orca-e2e` directory at the drive root when that temp directory sits
inside the home directory, as Windows `%TEMP%` does. Before and after each capture, the guard
checks visible text, form field values, and every terminal buffer for the machine's identity: its
username, full or short hostname, or home path. It also requires non-blank page text and a buffer
for every rendered terminal. If any check fails, it refuses the capture and writes no PNG.
Playwright's own failure screenshots are off for these specs; a failing test captures
`test-failed-<n>.png` through the same guard instead.

The specs use a fake cc-sync provider and a fake `claude` CLI. They check Orca rendering and
recovery behavior; cc-sync transport and real Claude resume are outside this check.
