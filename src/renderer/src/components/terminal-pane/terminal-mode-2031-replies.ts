import { mode2031SequenceFor } from '../../../../shared/terminal-color-scheme-protocol'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import type { PtyTransport } from './pty-transport-types'

type Mode2031ReplyTransport = Pick<PtyTransport, 'isConnected' | 'sendInputImmediate'>

function sendMode2031Reply(
  transport: Mode2031ReplyTransport,
  mode: TerminalColorSchemeMode
): boolean {
  // Why: fish stops reading mode-2031 replies quickly; remote input batching
  // can otherwise deliver this terminal response after the shell regains input.
  return transport.sendInputImmediate(mode2031SequenceFor(mode))
}

// Why off: this client-side check carries no host-admitted subscription revision, so a flip queued
// as the program withdraws reaches its shell as typed `?997;Nn` (#9993). Real queries still get
// answers; flips return once the host admits mode writes itself (STA-11321 slice 4).
const UNSOLICITED_MODE_2031_FLIPS_ENABLED = false

// Appearance updates include font and opacity changes, so only report actual
// color-mode flips to programs that still have mode 2031 enabled.
export function maybePushMode2031Flip(
  paneId: number,
  mode: TerminalColorSchemeMode,
  transport: Mode2031ReplyTransport,
  paneMode2031: Map<number, boolean>,
  paneLastThemeMode: Map<number, TerminalColorSchemeMode>
): boolean {
  if (!UNSOLICITED_MODE_2031_FLIPS_ENABLED || !transport.isConnected()) {
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
