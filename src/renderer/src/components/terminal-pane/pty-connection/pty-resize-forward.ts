import { installForegroundGridDriftProbe } from './foreground-grid-drift-probe'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'

import { safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { getAppliedSizeReadE2eDelayMs } from '../pty-applied-size-read-e2e-delay'
import { createPtySizeReassertion } from '../pty-size-reassertion'

import {
  PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
  queuePanePtyResizeIfHeld,
  type PanePtyResizeHoldFlushDetail
} from '@/lib/pane-manager/pane-pty-resize-hold'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

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
    // Why: hidden-tab layout churn is not authoritative; visible resume
    // owns correction, and hidden SIGWINCH can reset full-screen TUIs.
    return false
  }

  session.forwardPtyResize = (cols: number, rows: number): void => {
    if (!session.isRendererPtyResizeAuthoritative()) {
      return
    }
    // Why: when a mobile-fit override is active OR mobile is currently the
    // driver of this PTY, the PTY is already at phone dims and any desktop
    // resize is wrong. Suppress resize forwarding to avoid spurious SIGWINCH
    // signals (TUI flicker / wrap corruption). Both checks are needed:
    // - getFitOverrideForPty covers the "phone-fit dims" state.
    // - isPtyLocked covers the broader "mobile driving" state, including
    //   transitions where override may not be set (e.g. legacy code paths).
    // The pty:resize IPC has a defense-in-depth twin. See
    // docs/mobile-presence-lock.md.
    if (session.shouldSuppressDesktopPtyResize()) {
      return
    }
    if (queuePanePtyResizeIfHeld(session.pane.container, cols, rows)) {
      return
    }
    session.transport.resize(cols, rows, { claim: true })
  }

  session.onHeldPtyResizeFlush = (event: Event): void => {
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

  // Why: renderer resize forwarding is fire-and-forget. A visible pane can
  // finish with xterm at the right grid while the PTY silently kept an older
  // grid, so Codex keeps composing against stale columns. Fit first so xterm's
  // normal onResize can send, then read applied PTY size and repair only drift.
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
      // Why: e2e seam — delays the read past the reveal fit to reproduce the
      // busy-daemon/SSH ordering; returns 0 outside e2e builds.
      const delayMs = getAppliedSizeReadE2eDelayMs()
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return window.api.pty.getSize(ptyId)
    },
    forwardResize: session.forwardPtyResize
  })
  // Why built here and not inside session.handleReattachResult: a hidden pane parks this until it is
  // revealed, and a closure created in that scope would pin the whole reattach payload
  // (snapshot/replay/coldRestore bytes) for as long as the pane stays hidden. Taking the
  // generation and pty id by value keeps only connection-level state alive.
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
        // Why re-checked at fire time: the caller's pre-check cannot see a mobile takeover that
        // lands while the pane waits for a box, and transport.resize here bypasses
        // forwardPtyResize's own suppression.
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
}
