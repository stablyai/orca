# Keep Automated Runs Out of the Foreground

Tests and agent-driven app launches share the developer's machine. They may use it; they must never
take the foreground — no window raised over the editor, no focus stolen, no Dock tile churn.

`src/main/window/foreground-activation-policy.ts` enforces this in the main process. It is on
whenever `ORCA_E2E_HEADLESS=1`, `ORCA_E2E_HEADFUL=1`, or `ORCA_BACKGROUND_LAUNCH=1`:

- headless / explicit background → the window never reaches the screen (Playwright drives it via CDP)
- headful without explicit background → `showInactive()`, no `app.focus({ steal: true })`, no
  `moveTop()`/always-on-top reinforcement
- macOS headless / explicit background → `accessory` activation policy, so no Dock tile and no menu-bar takeover

Rules when adding tests or scripts:

- Launch through `tests/e2e/helpers/orca-app.ts` (or `orca-restart.ts`) — they already set the env.
- A raw `electron.launch()` outside those helpers must pass `ORCA_BACKGROUND_LAUNCH: '1'`.
- Do not reveal windows in explicit background or headless runs. Only an explicitly headful run
  may call `showInactive()`; never call `show()` or `bringToFront()` in automated background checks.
- Tag a spec `@headful` only when it needs real pixels; it still runs in the background.
- Native-focus tests belong on an isolated display or CI. Do not set `ORCA_E2E_FOREGROUND=1`
  on the user’s desktop; it cannot override explicit background mode.

## Isolated terminal performance presentation

The Terminal Perf workflow has one explicit exception to the no-reveal rule: after windowless
startup, `terminal-perf-presentation.ts` presents the benchmark window without focus on its
isolated Xvfb display. Chromium otherwise throttles undrawn frames to one per second and makes
typing measurements invalid. This exception requires all of:

- `ORCA_E2E_TERMINAL_PERF_XVFB=1`, set inside `xvfb-run` by that workflow;
- Linux, `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`, and a nonempty `DISPLAY`;
- the page fixture to finish loading before presentation, and confirmed native window visibility.

Keep `ORCA_BACKGROUND_LAUNCH=1`: the application must still suppress automatic reveals and focus.
`isWindowlessLaunch` describes that automatic launch policy, not the window's current visibility.
This exception belongs only to this benchmark fixture; do not generalize it to local or self-hosted
runs, paired-client helpers, native-focus tests, or production window policy. Background terminal
panes remain hidden. Evidence: `docs/reference/terminal-perf-latency-investigation.md`.

## Isolated native IBus presentation

The native IBus fixtures start with `ORCA_BACKGROUND_LAUNCH=1`, then present only their owned
page's window on the runner's fresh Xvfb display. A window mapped with X11 alone remains hidden
to Electron and cannot receive native keyboard events.

`terminal-native-ibus-window.ts` requires Linux, hosted GitHub Actions, a numeric `DISPLAY`,
`ORCA_E2E_NATIVE_IBUS_HANGUL=1`, and `ORCA_E2E_NATIVE_IBUS_XVFB=1` before presentation. The native
runner sets the last marker inside its isolated display session. These guards run again inside
Electron before `showInactive()`. Native focus stays confined to that display; this fixture does
not relax automatic launch policy or permit presentation on the user's desktop.
