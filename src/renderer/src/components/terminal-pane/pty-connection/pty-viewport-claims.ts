// Reclaims a remote viewport only after visible desktop activity and host confirmation.
import { getFitOverrideForPty, onOverrideChange } from '@/lib/pane-manager/mobile-fit-overrides'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyViewportClaims(session: ConnectPanePtySession): void {
  session.claimViewportForUserActivity = (): void => {
    const currentPtyId = session.transport.getPtyId()
    if (!currentPtyId || getFitOverrideForPty(currentPtyId)?.mode !== 'remote-desktop-fit') {
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
      // Why: queuing a claim is not convergence. Keep the pane parked until the
      // runtime confirms desktop-fit so a transient resize failure retries.
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
  session.unsubscribeRemoteDesktopActivationClaim = onOverrideChange((event) => {
    if (event.ptyId !== session.transport.getPtyId() || !isRemoteRuntimePtyId(event.ptyId)) {
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
