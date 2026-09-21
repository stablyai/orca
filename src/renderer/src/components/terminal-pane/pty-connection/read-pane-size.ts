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
}
