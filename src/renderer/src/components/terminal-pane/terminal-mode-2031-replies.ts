import { mode2031SequenceFor } from '../../../../shared/terminal-color-scheme-protocol'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import type { PtyTransport } from './pty-transport-types'

type Mode2031ReplyTransport = Pick<PtyTransport, 'isConnected' | 'sendInputImmediate'>

function sendMode2031Reply(
  transport: Mode2031ReplyTransport,
  mode: TerminalColorSchemeMode
): boolean {
  // Send replies promptly: fish can stop reading before remote batches arrive, leaking the response into shell input.
  return transport.sendInputImmediate(mode2031SequenceFor(mode))
}

// Appearance updates include non-color changes; report only color-mode flips while mode 2031 remains enabled.
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
