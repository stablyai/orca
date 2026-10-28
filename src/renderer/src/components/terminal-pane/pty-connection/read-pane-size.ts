import type { ConnectPanePtySession } from './connect-pane-pty-session'

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
  session.terminalGridDriftedFromFit = (): boolean => {
    const proposed = session.readProposedTerminalGrid()
    return Boolean(
      proposed &&
      (session.pane.terminal.cols !== proposed.cols || session.pane.terminal.rows !== proposed.rows)
    )
  }
}
