import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { safeFitAndThen } from '@/lib/pane-manager/terminal-fit/pane-fit'
import { getFitOverrideForPty } from '@/lib/pane-manager/terminal-fit/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { getAppliedSizeReadE2eDelayMs } from './pty-applied-size-read-e2e-delay'
import { createPtySizeReassertion } from '../../viewport/pty-size-reassertion'
import {
  PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
  queuePanePtyResizeIfHeld,
  type PanePtyResizeHoldFlushDetail
} from '@/lib/pane-manager/pane-layout/pane-pty-resize-hold'
import { installForegroundGridDriftProbe } from './foreground-grid-drift-probe'
import { initializePaneGeometry, readPaneSize } from './read-pane-size'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function installPtyResizeForward(session: ConnectPanePtySession): void {
  session.shouldSuppressDesktopPtyResize = (): boolean => {
    const currentPtyId = session.transport.getPtyId()
    return Boolean(
      currentPtyId && (getFitOverrideForPty(currentPtyId) || isPtyLocked(currentPtyId))
    )
  }

  session.isRendererPtyResizeAuthoritative = (): boolean => {
    if (session.deps.isVisibleRef.current) {
      return true
    }
    // Hidden layout churn cannot own the grid; hidden SIGWINCH can reset full-screen TUIs.
    return false
  }

  session.forwardPtyResize = (cols: number, rows: number): void => {
    if (!session.isRendererPtyResizeAuthoritative()) {
      return
    }
    // Suppress desktop resize under phone-fit or mobile-driver ownership, including transitions without an override (docs/mobile-presence-lock.md).
    if (session.shouldSuppressDesktopPtyResize()) {
      return
    }
    if (queuePanePtyResizeIfHeld(session.pane.container, cols, rows)) {
      return
    }
    session.transport.resize(cols, rows, { claim: true })
  }

  session.onHeldPtyResizeFlush = (event: Event): void => {
    // SAFETY: The resize-hold event producer supplies this custom-event detail.
    const detail = (event as CustomEvent<PanePtyResizeHoldFlushDetail>).detail
    if (!detail) {
      return
    }
    session.forwardPtyResize(detail.cols, detail.rows)
  }
  session.pane.container.addEventListener(
    PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
    session.onHeldPtyResizeFlush
  )

  session.onResizeDisposable = session.pane.terminal.onResize(({ cols, rows }) => {
    session.foregroundGridDriftProbeSettled = false
    if (session.suppressStructuralReplayPtyResize || session.suppressViewportClaimTerminalResize) {
      return
    }
    session.forwardPtyResize(cols, rows)
  })

  // Resize is fire-and-forget; fit, then verify applied PTY size and repair drift so Codex cannot keep composing at stale columns.
  session.ptySizeReassertion = createPtySizeReassertion({
    isDisposed: () => session.disposed,
    getPtyId: () => session.transport.getPtyId(),
    isRemotePtyId: isRemoteRuntimePtyId,
    shouldSuppressDesktopResize: () => session.shouldSuppressDesktopPtyResize(),
    fitAndRun: (continuation) => safeFitAndThen(session.pane, 'pty-size-reassertion', continuation),
    getTerminalDimensions: () => ({
      cols: session.pane.terminal.cols,
      rows: session.pane.terminal.rows
    }),
    getAppliedSize: async (ptyId) => {
      // E2E-only delay races size readback behind reveal fit to model busy daemon/SSH ordering.
      const delayMs = getAppliedSizeReadE2eDelayMs()
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return window.api.pty.getSize(ptyId)
    },
    forwardResize: session.forwardPtyResize
  })
  // Capture only generation and PTY ID here; a deferred reveal closure inside reattach would retain its entire multi-MB payload while hidden.
  session.createReattachGridPush = (
    attemptGeneration: number,
    reattachPtyId: string
  ): { shouldContinue: () => boolean; continuation: () => void } => {
    const isCurrent = (): boolean =>
      !session.disposed &&
      attemptGeneration === session.transportStreamGeneration &&
      session.transport.getPtyId() === reattachPtyId
    return {
      shouldContinue: isCurrent,
      continuation: () => {
        if (!isCurrent()) {
          return
        }
        // Recheck mobile takeover after waiting for layout; direct transport.resize bypasses ordinary forwarding suppression.
        if (session.shouldSuppressDesktopPtyResize()) {
          return
        }
        const reattachCols = session.pane.terminal.cols
        const reattachRows = session.pane.terminal.rows
        if (reattachCols > 0 && reattachRows > 0) {
          session.transport.resize(reattachCols, reattachRows)
        }
        if (!isRemoteRuntimePtyId(reattachPtyId)) {
          window.api.pty.signal(reattachPtyId, 'SIGWINCH')
        }
        if (session.deps.isVisibleRef.current) {
          session.ptySizeReassertion.request({ fit: false })
        }
      }
    }
  }
  installForegroundGridDriftProbe(session)
  session.readPaneSize = () => readPaneSize(session)
  initializePaneGeometry(session)
}
