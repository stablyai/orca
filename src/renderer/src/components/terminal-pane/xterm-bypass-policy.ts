import { keybindingMatchesInput } from '../../../../shared/keybindings'

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

export type XtermBypassEvent = {
  type: string
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

function isSingleNonAsciiPrintableText(key: string): boolean {
  const chars = Array.from(key)
  if (chars.length !== 1) {
    return false
  }
  const codePoint = chars[0].codePointAt(0)
  return codePoint !== undefined && codePoint >= 0x80
}

function isXtermHandledKeyEvent(type: string): boolean {
  return type === 'keydown' || type === 'keyup'
}

function matchesClipboardBinding(
  binding: string,
  event: XtermBypassEvent,
  platform: NodeJS.Platform
): boolean {
  return keybindingMatchesInput(binding, event, platform)
}

/**
 * Decide whether a chord should bypass xterm's key handlers so the native
 * browser pipeline (Chromium `copy` event, Electron menu accelerators) or
 * layout-aware text event can handle it instead of the kitty CSI-u encoder.
 */
export function shouldBypassXtermKeyboardEvent(
  event: XtermBypassEvent,
  options: XtermBypassOptions
): boolean {
  if (!isXtermHandledKeyEvent(event.type)) {
    return false
  }

  const { isMac, hasSelection } = options
  const platformModifierHeld = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey

  if (event.defaultPrevented && platformModifierHeld) {
    // Why: window-level Orca shortcuts may have already handled the chord but
    // not stopped propagation. Do not let xterm also send that shortcut to
    // the shell.
    return true
  }

  if (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    isSingleNonAsciiPrintableText(event.key)
  ) {
    // Why: xterm's kitty encoder derives shifted key codes from physical
    // `code` (KeyA -> Latin "a"). Bypass keydown so Chromium emits layout text
    // via keypress, and bypass keyup so xterm doesn't leak the release CSI-u.
    return true
  }

  if (isMac) {
    // Why: window-level handlers already consume other Cmd chords before xterm
    // sees them; this path covers native copy, which must bubble to Chromium.
    return matchesClipboardBinding('Mod+C', event, 'darwin')
  }

  // Windows/Linux: standard clipboard bindings bubble; Ctrl+C only bubbles
  // with a selection (otherwise it's SIGINT and must reach the shell).
  if (matchesClipboardBinding('Ctrl+Shift+C', event, 'linux')) {
    return true
  }
  if (matchesClipboardBinding('Ctrl+C', event, 'linux') && hasSelection) {
    return true
  }
  if (
    matchesClipboardBinding('Ctrl+V', event, 'linux') ||
    matchesClipboardBinding('Ctrl+Shift+V', event, 'linux')
  ) {
    return true
  }
  if (matchesClipboardBinding('Shift+Insert', event, 'linux')) {
    return true
  }

  return false
}
