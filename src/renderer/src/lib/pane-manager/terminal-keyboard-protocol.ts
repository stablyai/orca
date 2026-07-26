import type { ITerminalOptions } from '@xterm/xterm'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/types'
import {
  isLocalNativeWindowsConpty,
  type WindowsPtyCompatibilityContext
} from './windows-pty-compatibility'

export type TerminalKeyboardProtocolContext = WindowsPtyCompatibilityContext & {
  executionHostId: ExecutionHostId
  /**
   * Known TUI agent for this pane when available (launchAgent / foreground).
   * Used only to opt specific agents out of the ConPTY KKP withhold.
   */
  tuiAgent?: TuiAgent | null
}

/**
 * Agents that correctly decode Kitty CSI-u and need modified-Enter chords
 * (Shift/Ctrl+Enter) on local Windows ConPTY. Global ConPTY withhold (#2434)
 * targets CSI-u-blind CLIs (e.g. Antigravity); Grok is not in that set and
 * relies on KKP for interject vs newline (official Grok Build keyboard docs).
 */
export function prefersKittyKeyboardDespiteWindowsConpty(
  agent: TuiAgent | null | undefined
): boolean {
  return agent === 'grok'
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
 *
 * Exception: when `tuiAgent` is an agent known to need KKP on ConPTY (Grok),
 * keep the advertisement so modified-Enter chords stay usable.
 */
export function shouldDisableKittyKeyboardForTerminal(
  context: TerminalKeyboardProtocolContext
): boolean {
  if (prefersKittyKeyboardDespiteWindowsConpty(context.tuiAgent)) {
    return false
  }
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
