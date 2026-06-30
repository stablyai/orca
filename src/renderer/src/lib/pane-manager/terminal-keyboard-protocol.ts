import type { ITerminalOptions } from '@xterm/xterm'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  isLocalNativeWindowsConpty,
  type WindowsPtyCompatibilityContext
} from './windows-pty-compatibility'

export type TerminalKeyboardProtocolContext = WindowsPtyCompatibilityContext & {
  executionHostId: ExecutionHostId
}

/**
 * Whether the Kitty enhanced keyboard protocol (CSI-u) must be withheld from a
 * pane's xterm advertisement.
 *
 * Why: Orca's default options advertise `vtExtensions.kittyKeyboard` so probing
 * CLIs enable enhanced key reporting. But local native Windows shells are backed
 * by ConPTY, and several local Windows CLIs (e.g. the Antigravity `agy` CLI) read
 * the advertisement yet do not decode CSI-u, so once it is on they ignore
 * Enter/Up/Down and other navigation keys. Disabling the advertisement only for
 * a genuine local Windows ConPTY pane restores standard navigation there while
 * preserving enhanced keyboard reporting for SSH and macOS/Linux panes (which
 * decode CSI-u correctly, including inside tmux).
 */
export function shouldDisableKittyKeyboardForTerminal(
  context: TerminalKeyboardProtocolContext
): boolean {
  return isLocalNativeWindowsConpty(context)
}

/**
 * xterm option overrides that withhold the Kitty enhanced keyboard protocol for
 * local Windows ConPTY panes and leave every other pane untouched. Merged after
 * `buildDefaultTerminalOptions()`, so `{}` keeps the advertised default on.
 */
export function buildTerminalKeyboardProtocolOptions(
  context: TerminalKeyboardProtocolContext
): Partial<ITerminalOptions> {
  if (!shouldDisableKittyKeyboardForTerminal(context)) {
    return {}
  }
  return { vtExtensions: { kittyKeyboard: false } }
}
