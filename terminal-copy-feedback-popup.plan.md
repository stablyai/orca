# Terminal Copy Feedback Popup ("copied to clipboard")

Mimic herdr's copy popup: a small green-bordered box anchored to the bottom-center of the
terminal pane that says `● copied to clipboard` for 2 seconds after a copy.

Reference: herdr `src/ui/status.rs` (`render_copy_feedback_buffer`), `src/client/shell/state.rs`
(`show_copy_feedback`, 2s deadline), `src/config/model.rs` (`ClipboardToastConfig`, default
`BottomCenter`).

## Approved decisions

| Decision | Choice |
|---|---|
| Duration | 2 seconds (herdr's actual value) |
| Scope | Copy-on-select **and** Cmd/Ctrl+C shortcut copies |
| Green | The pane's terminal theme ANSI green (how herdr does it) — fallback `--color-status-success` |
| Settings | None new; popup follows the existing "Copy on Select" toggle where applicable |
| Drag behavior | One popup per drag, shown after mouse release — never during drag |

## Drag-select problem and fix

xterm fires `onSelectionChange` on every character boundary during a drag, and the
copy-on-select path copies on each event (silent, existing behavior — unchanged). A naive
popup would re-arm continuously during the drag.

Fix: debounce the popup trigger. Each copy-on-select success re-arms a 200ms per-pane timer;
the popup shows only when no new selection change arrives within that window (= drag ended).
Cmd+C fires once, so it shows immediately. Copies during the drag stay silent and immediate,
exactly as today; only the popup waits.

## Architecture

```
copy succeeds (copy-on-select, debounced 200ms)
copy succeeds (Cmd+C, immediate)
  → terminal-copy-flash-store.notify(paneId, mode)
      → per-pane timer state
  → TerminalCopyFeedbackPopup (portaled into pane.container) reads store via useSyncExternalStore
      → renders box for 2000ms, then hides
```

- No app-store changes; a module-level pub/sub store keeps this pane-local and testable.
- Overlay pattern mirrors `SessionRestoredBannerPortals` / `TerminalPaneRuntimePortals`
  (React portal into `pane.container`).
- Store prunes entries for closed panes to avoid timer leaks.

## Visual spec (herdr box → Orca tokens)

herdr: 1-row box, `Borders::ALL` in theme green, panel bg, `●` dot in green + bold message,
bottom-center, width = message + padding.

Orca equivalent:

- Wrapper: `pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center` (same
  strip as the SSH reconnect banner; must not collide — it is transient, so overlap is acceptable).
- Box: 1px border in the pane theme's `green`, `bg-card/95` + documented elevation shadow,
  `rounded-sm` (styleguide radius scale), `px-3 py-1`.
- Content: `●` in theme green + bold `font-mono text-xs` message `copied to clipboard`
  (lowercase, herdr's literal text), text color inherits card foreground.
- `aria-hidden` — decorative; copy-on-select can fire often and must not spam screen readers.
- No animation for v1 (herdr has none).

Styleguide note: STYLEGUIDE.md routes transient confirmations to sonner toasts. This popup is a
deliberate, user-requested deviation: it is anchored to the terminal pane like herdr/tmux
feedback, not a global notification. Documented here as the design record.

## Trigger sites (both route through existing copy helpers)

1. Copy-on-select: `src/renderer/src/components/terminal-pane/terminal-pane-pane-links.ts`
   `onSelectionChange` → `copyTerminalSelection(...)` — notify on `true` result, debounced mode.
2. Shortcut copy: `src/renderer/src/components/terminal-pane/terminal-keyboard-action-dispatch.ts`
   `copySelection` → `copyTerminalSelection(...)` — notify on `true` result, immediate mode.

`copyTerminalSelection` already returns `false` on empty selection and throws are swallowed by
callers; notify only fires after the clipboard write resolves successfully.

Out of scope (not triggered): OSC 52 TUI writes, agent-session copy commands, context-menu copy.

## Files

| File | Change |
|---|---|
| `terminal-pane/terminal-copy-flash-store.ts` | NEW — pub/sub store, per-pane debounce + visibility timers, `notifyTerminalCopyFlash`, `useTerminalCopyFlash` |
| `terminal-pane/TerminalCopyFeedbackPopup.tsx` | NEW — the box (pure presentational) |
| `terminal-pane/TerminalPaneRuntimePortals.tsx` | MODIFY — portal the popup into each `pane.container` |
| `terminal-pane/terminal-pane-pane-links.ts` | MODIFY — notify after copy-on-select succeeds |
| `terminal-pane/terminal-keyboard-action-dispatch.ts` | MODIFY — notify after shortcut copy succeeds |
| `src/renderer/src/i18n/locales/en.json` | MODIFY — new key via i18next-cli extract (`config/i18next.config.ts`) |
| `terminal-pane/terminal-copy-flash-store.test.ts` | NEW — timer/debounce semantics |
| `terminal-pane/TerminalCopyFeedbackPopup.test.tsx` | NEW — render/visibility/styling contract |

## Edge cases

- Selection cleared (plain click): handler exits early, no notify.
- Rapid re-copy during visible window: timer restarts, popup stays up 2s from last copy.
- Theme change mid-popup: green re-read at render; a 2s window makes stale color a non-issue.
- Custom/missing theme green: fallback to `--color-status-success`.
- Pane close during popup: portal unmounts; store prunes timers.
- Light themes: theme green is the dark-optimal ANSI green the pane already uses — consistent
  with what the user sees in the terminal.

## Test plan

- Store: rapid notifies coalesce into one show after debounce; immediate notify shows at once;
  auto-hide after 2s; re-notify while visible extends; pane prune stops pending timers.
- Popup: renders into container, hidden without flash, shows dot + message, `aria-hidden`,
  uses supplied green or fallback.
- Regression: existing `terminal-copy-rejection-handling` / selection tests stay green.

## Verification

1. `pnpm tc`, `oxlint` on changed files, targeted `pnpm test` for new + adjacent suites.
2. App smoke with `ORCA_BACKGROUND_LAUNCH=1` (no focus stealing): connect a pane, programmatically
   select text, trigger Cmd+C copy path, CDP screenshot of the hidden renderer showing the popup;
   repeat drag-select scenario and confirm a single popup after release.

## Progress

- [x] Scout herdr + Orca implementations
- [x] Draft plan (committed as 6abc431e03)
- [x] Copy flash store + tests (`terminal-copy-flash-store.ts`, 7 tests)
- [x] Popup component + portals + tests (`TerminalCopyFeedbackPopup.tsx`, `TerminalPaneRuntimePortals.tsx` `TerminalPaneCopyFeedbackPortals`, mounted in `TerminalPaneSurface.tsx`, 4 tests)
- [x] Wire both copy sites (`terminal-pane-pane-links.ts` drag-quiet, `terminal-keyboard-action-dispatch.ts` immediate)
- [x] i18n key `auto.components.terminal.pane.TerminalCopyFeedbackPopup.ab2ac75664` in en.json
- [x] Typecheck (`pnpm tc:web` clean), oxlint clean, targeted suites: 55 tests green (7 store, 4 popup, 44 adjacent incl. copy-rejection, SSH overlay, session banner); `verify:localization-extraction` + `verify:localization-catalog` exit 0
- [ ] App smoke — handed to user for manual testing (dev build launched)
- [x] Plan progress recorded
