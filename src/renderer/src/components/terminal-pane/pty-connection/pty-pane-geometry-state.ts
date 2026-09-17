import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyPaneGeometryState(session: ConnectPanePtySession): void {
  session.pendingGeometryReportRaf = null
  session.lastObservedDesktopGrid = null
  session.readPaneSize = (): { width: number; height: number } | null => {
    if (typeof session.pane.container.getBoundingClientRect !== 'function') {
      return null
    }
    const rect = session.pane.container.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }
  session.lastObservedPaneSize = session.readPaneSize()
  session.pendingPaneGeometryChanged = false
}
