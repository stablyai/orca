// Why: when a CLI activates kitty progressive enhancement (CSI > N u), xterm's
// KittyKeyboard encoder turns every modifier chord — including plain Cmd+C —
// into a CSI-u sequence with `cancel: true`, which calls preventDefault() on
// the keydown. That preventDefault suppresses Chromium's native `copy` event,
// so xterm's own `copy` listener on its container never fires and the
// selection is never written to the clipboard.
//
// Fix: intercept in `attachCustomKeyEventHandler` and return `false` for chords
// that should bubble to the browser / host (clipboard, native menu). Returning
// `false` makes xterm bail *before* the kitty encoder runs, so the browser's
// copy pipeline and the OS-level keybinding both fire normally.
//
// Rule source — Ghostty (src/input/key_encode.zig:543-545):
//   "on macOS, command+keys do not encode text ... They don't in native text
//    inputs (TextEdit) and they also don't in other native terminals
//    (Terminal.app, iTerm2)."
// VS Code (terminalInstance.ts:1115-1171) and Superset's terminal (which hit
// this exact bug) both converge on the same pattern.

export type XtermBypassEvent = {
  key: string
  code?: string
  defaultPrevented?: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type XtermBypassOptions = {
  isMac: boolean
  /** True when the terminal has a current text selection — Ctrl+C on
   *  Windows/Linux should only bubble to clipboard when something is selected,
   *  otherwise it must reach the shell as SIGINT. */
  hasSelection: boolean
}

/**
 * Decide whether a chord should bypass xterm's keydown handler so the native
 * browser pipeline (Chromium `copy` event, Electron menu accelerators) can
 * handle it instead of the kitty CSI-u encoder swallowing it.
 */
export function shouldBypassXtermKeydown(
  event: XtermBypassEvent,
  options: XtermBypassOptions
): boolean {
  const { isMac, hasSelection } = options
  const platformModifierHeld = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey

  if (event.defaultPrevented && platformModifierHeld) {
    // Why: window-level Orca shortcuts may have already handled the chord but
    // not stopped propagation. Match VS Code by preventing xterm's kitty
    // encoder from also sending that app shortcut to the shell.
    return true
  }

  if (isMac) {
    // Narrow Ghostty rule to Cmd+C only: Ghostty bubbles every Cmd chord on
    // macOS, but Orca's window-level handlers (keyboard-handlers.ts,
    // TerminalPane.tsx Cmd+V interception) already swallow every Cmd chord
    // that does something meaningful before xterm sees it. Cmd+C is the one
    // chord that was never intercepted, so it's the only real-world breakage.
    // Limiting the bypass to Cmd+C avoids accidentally regressing xterm's
    // native Cmd+A select-all path, which goes through a different evaluator
    // branch than the kitty encoder.
    return (
      event.code === 'KeyC' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    )
  }

  // Windows/Linux: standard clipboard bindings bubble; Ctrl+C only bubbles
  // with a selection (otherwise it's SIGINT and must reach the shell).
  const onlyCtrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  const ctrlShiftOnly = event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey
  const onlyShift = event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey

  if (event.code === 'KeyC' && ctrlShiftOnly) {
    return true
  }
  if (event.code === 'KeyC' && onlyCtrl && hasSelection) {
    return true
  }
  if (event.code === 'KeyV' && (onlyCtrl || ctrlShiftOnly)) {
    return true
  }
  if (event.code === 'Insert' && onlyShift) {
    return true
  }

  return false
}
