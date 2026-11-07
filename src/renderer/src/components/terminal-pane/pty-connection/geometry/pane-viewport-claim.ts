import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getFitOverrideForPty, onOverrideChange } from '@/lib/pane-manager/mobile-fit-overrides'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { isPassiveTerminalInputReport } from '../../input/terminal-passive-input-report'

export function installPaneViewportClaim(session: ConnectPanePtySession): void {
  session.claimViewportForUserActivity = (input?: string): void => {
    const currentPtyId = session.transport.getPtyId()
    if (!currentPtyId || getFitOverrideForPty(currentPtyId)?.mode !== 'remote-desktop-fit') {
      return
    }
    // Focus reports after SIGWINCH are not ownership claims; otherwise different-grid mirrors steal the viewport forever (#26469).
    if (input !== undefined && isPassiveTerminalInputReport(input)) {
      return
    }
    let proposed: { cols: number; rows: number } | undefined
    try {
      proposed = session.pane.fitAddon.proposeDimensions()
    } catch {
      proposed = undefined
    }
    const cols = proposed?.cols ?? session.pane.terminal.cols
    const rows = proposed?.rows ?? session.pane.terminal.rows
    if (cols > 0 && rows > 0) {
      // Keep parked until runtime confirms desktop-fit; queued claims must remain retryable after transient failure.
      session.transport.claimViewport?.(cols, rows)
    }
  }
  session.claimPendingVisibleRemoteViewport = (): void => {
    if (
      !session.pendingVisibleRemoteViewportClaim ||
      !session.deps.isVisibleRef.current ||
      typeof document === 'undefined' ||
      document.visibilityState === 'hidden' ||
      typeof document.hasFocus !== 'function' ||
      !document.hasFocus()
    ) {
      return
    }
    session.claimViewportForUserActivity()
  }
  session.armVisibleRemoteViewportClaim = (): void => {
    const ptyId = session.transport.getPtyId()
    if (!ptyId || !isRemoteRuntimePtyId(ptyId)) {
      session.visibleRemoteViewportClaimPtyId = null
      session.pendingVisibleRemoteViewportClaim = false
      return
    }
    if (
      session.visibleRemoteViewportClaimPtyId !== ptyId ||
      session.pendingVisibleRemoteViewportClaim ||
      getFitOverrideForPty(ptyId)?.mode === 'remote-desktop-fit'
    ) {
      session.visibleRemoteViewportClaimPtyId = ptyId
      session.pendingVisibleRemoteViewportClaim = true
    }
  }
  session.unsubscribeFitOverrideChange = onOverrideChange((event) => {
    if (event.ptyId !== session.transport.getPtyId()) {
      return
    }
    if (event.mode === 'desktop-fit') {
      session.catchUpMode2031()
    } else {
      // The holder may have reported its own appearance; re-send ours once on release.
      session.deps.paneLastThemeModeRef.current.delete(session.pane.id)
    }
    if (!isRemoteRuntimePtyId(event.ptyId)) {
      return
    }
    if (event.mode === 'desktop-fit') {
      session.visibleRemoteViewportClaimPtyId = event.ptyId
      session.pendingVisibleRemoteViewportClaim = false
      return
    }
    if (event.mode === 'remote-desktop-fit') {
      if (
        session.deps.isVisibleRef.current &&
        session.visibleRemoteViewportClaimPtyId !== event.ptyId
      ) {
        session.visibleRemoteViewportClaimPtyId = event.ptyId
        session.pendingVisibleRemoteViewportClaim = true
      }
      session.claimPendingVisibleRemoteViewport()
    }
  })
}
