import { TERMINAL_FOCUS_IN_SEQUENCE, TERMINAL_FOCUS_OUT_SEQUENCE } from './foreground-output-scan'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function isTerminalFocusReport(data: string): boolean {
  return data === TERMINAL_FOCUS_IN_SEQUENCE || data === TERMINAL_FOCUS_OUT_SEQUENCE
}

export function claimViewportForTerminalInput(session: ConnectPanePtySession, data: string): void {
  // Why: xterm answers every DECSET 1004 with a focus report, and TUIs re-arm 1004 after each
  // resize. Claiming on it lets two mirrors of different sizes take the PTY from each other forever.
  if (!isTerminalFocusReport(data)) {
    session.claimViewportForUserActivity()
  }
}
