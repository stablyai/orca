import type { ITerminalOptions } from '@xterm/xterm'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/tui-agent'
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

/** Known CSI-u-capable ConPTY agents need modified Enter. Grok uses KKP for interject/newline, unlike CSI-u-blind CLIs targeted by #2434. */
function prefersKittyKeyboardDespiteWindowsConpty(agent: TuiAgent | null | undefined): boolean {
  return agent === 'grok'
}

/** Withhold KKP only for genuine local Windows ConPTY: some CLIs enable it but ignore CSI-u navigation (#2434). Preserve SSH/macOS/Linux support and known ConPTY-capable agents such as Grok, which needs modified Enter. */
export function shouldDisableKittyKeyboardForTerminal(
  context: TerminalKeyboardProtocolContext
): boolean {
  if (prefersKittyKeyboardDespiteWindowsConpty(context.tuiAgent)) {
    return false
  }
  return isLocalNativeWindowsConpty(context)
}

/** Merge after defaults; an empty override preserves advertised KKP outside local ConPTY. */
export function buildTerminalKeyboardProtocolOptions(
  context: TerminalKeyboardProtocolContext
): Partial<ITerminalOptions> {
  if (!shouldDisableKittyKeyboardForTerminal(context)) {
    return {}
  }
  return { vtExtensions: { kittyKeyboard: false } }
}
