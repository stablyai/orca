import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { requestStablePaneFit } from '@/lib/pane-manager/pane-fit-resize-observer'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { reconcilePtySizeAcrossFrames } from '../pty-size-reconcile'
import { shouldClaimRemoteDesktopViewport } from '../remote-desktop-viewport-claim'
import { deferTerminalGeometryMutationDuringRebuild } from '@/lib/pane-manager/terminal-scroll-intent-rebuild'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyResizeGeometry(session: ConnectPanePtySession): void {
  session.handleObservedPaneGeometry = (): void => {
    session.pendingGeometryReportRaf = null
    if (session.disposed) {
      return
    }
    if (
      deferTerminalGeometryMutationDuringRebuild(
        session.pane.terminal,
        'observed-pane-geometry',
        session.handleObservedPaneGeometry
      )
    ) {
      return
    }
    const paneGeometryChanged = session.pendingPaneGeometryChanged
    session.pendingPaneGeometryChanged = false
    const currentPtyId = session.transport.getPtyId()
    if (!currentPtyId) {
      // Initial ResizeObserver measurements can precede binding; retain them so the first focused resize still claims ownership.
      const proposed = session.readProposedTerminalGrid()
      if (proposed) {
        session.lastObservedDesktopGrid = proposed
      }
      return
    }
    const fitOverride = getFitOverrideForPty(currentPtyId)
    if (!fitOverride) {
      if (session.pane.terminal.cols > 0 && session.pane.terminal.rows > 0) {
        // Record the local grid before remote holding so the next genuine layout change can claim immediately.
        session.lastObservedDesktopGrid = {
          cols: session.pane.terminal.cols,
          rows: session.pane.terminal.rows
        }
      }
      if (session.shouldSuppressDesktopPtyResize()) {
        return
      }
      requestStablePaneFit(session.pane as ManagedPaneInternal, () =>
        session.ptySizeReassertion.request({ fit: false })
      )
      return
    }
    let proposed: { cols: number; rows: number } | undefined
    try {
      proposed = session.pane.fitAddon.proposeDimensions()
    } catch {
      proposed = undefined
    }
    if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) {
      return
    }
    const priorProposed = session.lastObservedDesktopGrid
    session.lastObservedDesktopGrid = proposed
    if (fitOverride.mode === 'remote-desktop-fit') {
      if (
        shouldClaimRemoteDesktopViewport({
          holdMode: fitOverride.mode,
          prior: priorProposed,
          current: proposed,
          paneGeometryChanged,
          paneVisible: session.deps.isVisibleRef.current,
          documentVisible: document.visibilityState !== 'hidden',
          documentFocused: document.hasFocus()
        })
      ) {
        // A focused visible layout change releases parking; update xterm before claiming to avoid rendering the previous owner’s grid.
        session.suppressViewportClaimTerminalResize = true
        try {
          session.pane.terminal.resize(proposed.cols, proposed.rows)
        } finally {
          session.suppressViewportClaimTerminalResize = false
        }
        session.transport.resize(proposed.cols, proposed.rows, { claim: true })
      }
      return
    }
    if (isRemoteRuntimePtyId(currentPtyId)) {
      session.transport.resize(proposed.cols, proposed.rows)
    } else {
      window.api.pty.reportGeometry(currentPtyId, proposed.cols, proposed.rows)
    }
  }
  session.geometryReportObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const paneSize = session.readPaneSize()
          if (
            paneSize &&
            session.lastObservedPaneSize &&
            (paneSize.width !== session.lastObservedPaneSize.width ||
              paneSize.height !== session.lastObservedPaneSize.height)
          ) {
            session.pendingPaneGeometryChanged = true
          }
          session.lastObservedPaneSize = paneSize
          if (session.pendingGeometryReportRaf !== null) {
            return
          }
          session.pendingGeometryReportRaf = requestAnimationFrame(
            session.handleObservedPaneGeometry
          )
        })
  // Observe pane.container, which exists at connect; the inner xterm container is created later but follows the same layout.
  if (session.geometryReportObserver && session.pane.container instanceof Element) {
    session.geometryReportObserver.observe(session.pane.container)
  }

  // Deferred first fit can spawn at stale width while visibility suppresses correction; reconcile across frames, bypassing visibility but honoring mobile ownership (pty-size-reconcile.ts).
  session.ptySizeReconcileHandle = null
  session.liveScrollbackRestore = null
  session.reconcilePtySizeAfterSpawn = (
    ptyId: string,
    spawnCols: number,
    spawnRows: number
  ): void => {
    session.ptySizeReconcileHandle?.cancel()
    session.ptySizeReconcileHandle = reconcilePtySizeAcrossFrames({
      spawnCols,
      spawnRows,
      isAlive: () => !session.disposed && session.transport.getPtyId() === ptyId,
      // Skip mobile-owned frames without cancelling the reconcile window.
      isParked: () => Boolean(getFitOverrideForPty(ptyId)) || isPtyLocked(ptyId),
      // Hand off only after visible grid stability; hidden mounts still need late-layout correction.
      isAuthoritative: () => session.isRendererPtyResizeAuthoritative(),
      measure: () => {
        if (!safeFit(session.pane)) {
          return null
        }
        const cols = session.pane.terminal.cols
        const rows = session.pane.terminal.rows
        return cols > 0 && rows > 0 ? { cols, rows } : null
      },
      resize: (cols, rows) => {
        if (!session.shouldSuppressDesktopPtyResize()) {
          session.transport.resize(cols, rows)
        }
      },
      // Verify applied size before handoff because daemon/SSH resize is fire-and-forget; remote-runtime hosts use their separate viewport channel.
      getAppliedSize: isRemoteRuntimePtyId(ptyId) ? undefined : () => window.api.pty.getSize(ptyId),
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(handle)
        }
      }
    })
  }

  // Defer PTY spawn/attach to next frame so FitAddon has time to calculate
  // the correct terminal dimensions from the laid-out container.
  session.cancelScheduledConnectFrame = (): void => {
    if (session.connectFrame !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(session.connectFrame)
      }
      session.connectFrame = null
    }
  }
}
