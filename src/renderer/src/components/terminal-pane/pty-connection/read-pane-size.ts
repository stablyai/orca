import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Why: 'unknown' (no valid fit proposal) must not count as a match that settles the drift probe.
export type TerminalGridFitDrift = 'drifted' | 'matched' | 'unknown'

export function readPaneSize(
  session: ConnectPanePtySession
): { width: number; height: number } | null {
  if (typeof session.pane.container.getBoundingClientRect !== 'function') {
    return null
  }
  const rect = session.pane.container.getBoundingClientRect()
  return { width: rect.width, height: rect.height }
}

export function initializePaneGeometry(session: ConnectPanePtySession): void {
  session.pendingGeometryReportRaf = null
  session.lastObservedDesktopGrid = null
  session.lastObservedPaneSize = readPaneSize(session)
  session.pendingPaneGeometryChanged = false
  session.readProposedTerminalGrid = (): { cols: number; rows: number } | null => {
    try {
      const proposed = session.pane.fitAddon.proposeDimensions()
      if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) {
        return null
      }
      return proposed
    } catch {
      return null
    }
  }
  session.measureTerminalGridFitDrift = (): TerminalGridFitDrift => {
    const proposed = session.readProposedTerminalGrid()
    if (!proposed) {
      return 'unknown'
    }
    return session.pane.terminal.cols !== proposed.cols ||
      session.pane.terminal.rows !== proposed.rows
      ? 'drifted'
      : 'matched'
  }
}
