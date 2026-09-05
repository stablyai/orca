# Keep Automated Runs Out of the Foreground

Tests and agent-driven app launches share the developer's machine. They may use it; they must never
take the foreground — no window raised over the editor, no focus stolen, no Dock tile churn.

`src/main/window/foreground-activation-policy.ts` enforces this in the main process. It is on
whenever `ORCA_E2E_HEADLESS=1`, `ORCA_E2E_HEADFUL=1`, or `ORCA_BACKGROUND_LAUNCH=1`:

- headless → the window never reaches the screen (Playwright drives it via CDP)
- headful / background → `showInactive()`, no `app.focus({ steal: true })`, no
  `moveTop()`/always-on-top reinforcement
- macOS headless → `accessory` activation policy, so no Dock tile and no menu-bar takeover

Rules when adding tests or scripts:

- Launch through `tests/e2e/helpers/orca-app.ts` (or `orca-restart.ts`) — they already set the env.
- A raw `electron.launch()` outside those helpers must pass `ORCA_BACKGROUND_LAUNCH: '1'`.
- Call `showInactive()`, never `show()`, when an `app.evaluate()` block reveals a window.
- Tag a spec `@headful` only when it needs real pixels; it still runs in the background.
- `ORCA_E2E_FOREGROUND=1` is the only opt-out, for runs whose subject _is_ native focus (IME and
  other OS-level key injection). Add a comment saying why.
