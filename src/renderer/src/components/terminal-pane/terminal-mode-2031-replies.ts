import type { ITheme, Terminal } from '@xterm/xterm'
import { mode2031SequenceFor } from '../../../../shared/terminal-color-scheme-protocol'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import type { PtyTransport } from './pty-transport'

type Mode2031ReplyTransport = Pick<PtyTransport, 'isConnected' | 'sendInputImmediate'>

function sendMode2031Reply(
  transport: Mode2031ReplyTransport,
  mode: TerminalColorSchemeMode
): boolean {
  // Why: fish stops reading mode-2031 replies quickly; remote input batching
  // can otherwise deliver this terminal response after the shell regains input.
  return transport.sendInputImmediate(mode2031SequenceFor(mode))
}

// Appearance updates include font and opacity changes, so only report actual
// color-mode flips to programs that still have mode 2031 enabled.
export function maybePushMode2031Flip(
  paneId: number,
  mode: TerminalColorSchemeMode,
  transport: Mode2031ReplyTransport,
  paneMode2031: Map<number, boolean>,
  paneLastThemeMode: Map<number, TerminalColorSchemeMode>
): boolean {
  if (!transport.isConnected()) {
    return false
  }
  if (!paneMode2031.get(paneId)) {
    return false
  }
  if (paneLastThemeMode.get(paneId) === mode) {
    return false
  }
  if (!sendMode2031Reply(transport, mode)) {
    return false
  }
  paneLastThemeMode.set(paneId, mode)
  return true
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

// Why private: xterm has no public switch for its own 2031 report. If a future xterm moves
// the field this returns null and the theme write keeps xterm's duplicate report.
function xtermColorSchemeUpdateModes(
  terminal: Terminal
): Record<'colorSchemeUpdates', unknown> | null {
  const core = '_core' in terminal ? terminal._core : null
  const coreService = isObject(core) && 'coreService' in core ? core.coreService : null
  const modes =
    isObject(coreService) && 'decPrivateModes' in coreService ? coreService.decPrivateModes : null
  return isObject(modes) && 'colorSchemeUpdates' in modes ? modes : null
}

// xterm reports CSI ?997 on every palette write while a program has DECSET 2031 on. Use this
// only for a write whose flip maybePushMode2031Flip already reported, so the program hears it once.
export function setThemeWithoutXtermColorSchemeReport(terminal: Terminal, theme: ITheme): void {
  const modes = xtermColorSchemeUpdateModes(terminal)
  const subscribed = modes?.colorSchemeUpdates
  if (modes) {
    modes.colorSchemeUpdates = false
  }
  try {
    terminal.options.theme = theme
  } finally {
    if (modes) {
      modes.colorSchemeUpdates = subscribed
    }
  }
}
