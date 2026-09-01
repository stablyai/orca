import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { requestStablePaneFit } from '@/lib/pane-manager/pane-fit-resize-observer'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { reconcilePtySizeAcrossFrames } from '../pty-size-reconcile'
import { shouldClaimRemoteDesktopViewport } from '../remote-desktop-viewport-claim'
import { deferTerminalGeometryMutationDuringRebuild } from '@/lib/pane-manager/terminal-scroll-intent-rebuild'
import { waitForStableStartupGrid } from '../terminal-startup-grid-settle'

import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { isSetupSplitGeometryReady } from './setup-split-geometry'

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
      // Why: ResizeObserver may deliver its initial measurement before the
      // remote binding completes; retain that passive baseline for the first
      // real focused resize instead of swallowing the user's first claim.
      const proposed = session.readProposedTerminalGrid()
      if (proposed) {
        session.lastObservedDesktopGrid = proposed
      }
      return
    }
    const fitOverride = getFitOverrideForPty(currentPtyId)
    if (!fitOverride) {
      if (session.pane.terminal.cols > 0 && session.pane.terminal.rows > 0) {
        // Why: record the local grid before a later remote hold parks xterm;
        // the first real window/split resize can then claim immediately.
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
        // Why: a focused, visible layout change is genuine activity; release
        // the park and update xterm before claiming so the owner does not keep
        // rendering the prior owner's stale grid.
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
  // Why: pane.xtermContainer is created later in pane-lifecycle's
  // attachWebgl/initial-fit path; pane.container is always present at the
  // moment connectPanePty runs (it's the .pane element). Both report the
  // same layout signal — when the outer pane resizes, the inner xterm
  // container resizes too — so this is the safe element to observe.
  if (session.geometryReportObserver && session.pane.container instanceof Element) {
    session.geometryReportObserver.observe(session.pane.container)
  }

  // Why: the deferred-rAF fit can spawn the PTY at a stale width when the pane's
  // real (e.g. split/narrower) layout has not settled by the first frame — the
  // PTY is born at the wide window width while xterm later reflows to the pane
  // width. The corrective onResize is then dropped (isRendererPtyResizeAuthoritative()
  // is false mid-mount), pinning process.stdout.columns forever and garbling
  // TUIs. The reconcile re-fits across frames until the grid settles and forces
  // the PTY to xterm's dimensions; the spawn-time sync is authoritative by
  // definition so it bypasses the visibility gate (but not the mobile-fit
  // override, which legitimately parks the PTY at phone dims). See
  // pty-size-reconcile.ts for the convergence loop.
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
      // Mobile legitimately parks the PTY at phone dims; skip those frames
      // (neither fit nor forward) instead of cancelling the reconcile window.
      isParked: () => Boolean(getFitOverrideForPty(ptyId)) || isPtyLocked(ptyId),
      // Once the renderer resize is authoritative (pane visible), the live
      // onResize owns future corrections, so the reconcile can hand off after
      // the grid stabilizes. While hidden it keeps watching for a late settle.
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
      // Why: confirm the PTY actually applied the size we forwarded before the
      // reconcile hands off. transport.resize is fire-and-forget for daemon/SSH
      // PTYs, so the loop can otherwise settle on a size the PTY dropped, leaving
      // it pinned wide while xterm shows narrow — the mount-time desync. Skip
      // remote-runtime PTYs (separate viewport channel; pty:getSize never tracks
      // them) so they fall back to the grid-stable handoff.
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
  session.measureStartupGrid = (): { cols: number; rows: number } | null => {
    if (!safeFit(session.pane)) {
      return null
    }
    const cols = session.pane.terminal.cols
    const rows = session.pane.terminal.rows
    return cols > 0 && rows > 0 ? { cols, rows } : null
  }
  session.shouldSettleStartupGridBeforeConnect = (): boolean =>
    Boolean(session.paneStartup?.command || session.paneStartup?.agentLaunch) &&
    session.deps.isVisibleRef.current &&
    !session.connectionId &&
    session.runtimeEnvironmentId === null
  session.isStartupGridReadyForConnect = (): boolean => {
    const setupSplitDirection = session.paneStartup?.waitForSetupSplitDirection
    if (!setupSplitDirection) {
      return true
    }
    // Why: the setup split reparents the main pane before its xterm grid
    // necessarily reflects the new flex geometry; wait for both to agree.
    return isSetupSplitGeometryReady(session.pane, session.manager, setupSplitDirection)
  }
  session.settleStartupGridBeforeConnect = (connect: () => void): void => {
    session.startupGridSettleHandle?.cancel()
    let settledSynchronously = false
    // Why: local startup commands can launch a TUI before the split-pane grid
    // has settled; spawn from a briefly stable grid so the TUI paints cleanly.
    const handle = waitForStableStartupGrid({
      isAlive: () => !session.disposed,
      isReadyToSettle: session.paneStartup?.waitForSetupSplitDirection
        ? session.isStartupGridReadyForConnect
        : undefined,
      measure: session.measureStartupGrid,
      onSettled: () => {
        settledSynchronously = true
        session.startupGridSettleHandle = null
        connect()
      },
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(handle)
        }
      }
    })
    if (!settledSynchronously) {
      session.startupGridSettleHandle = handle
    }
  }
}
