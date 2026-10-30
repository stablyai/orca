import { createQualifiedPtyInputForwarder } from './pty-qualified-input-forwarder'
import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { subscribeToTerminalInputData } from '../terminal-user-input-signal'
import { installTerminalImeCompositionRoute } from '../terminal-ime-composition-route'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { getAppliedSizeReadE2eDelayMs } from '../pty-applied-size-read-e2e-delay'
import { createPtySizeReassertion } from '../pty-size-reassertion'
import {
  PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
  queuePanePtyResizeIfHeld,
  type PanePtyResizeHoldFlushDetail
} from '@/lib/pane-manager/pane-pty-resize-hold'

import { installForegroundGridDriftProbe } from './foreground-grid-drift-probe'
import { installTerminalSelectionFitGuard } from '../terminal-selection-fit-guard'
import { initializePaneGeometry, readPaneSize } from './read-pane-size'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyInputForward(session: ConnectPanePtySession): void {
  const owner = session.deps.getPtyInputOwner?.(session.pane.id)
  const ordinary = createQualifiedPtyInputForwarder(session, null)
  let bound = ordinary
  const sourceObservation = session.transport.observeInputSource?.({
    beforeChange: () => owner?.invalidateSource(),
    afterChange: (source) => {
      bound = createQualifiedPtyInputForwarder(session, source)
      owner?.bindSource(
        source && {
          isCurrent: source.isCurrent,
          qualify: bound.qualify,
          user: bound.user,
          unclassified: bound.unclassified
        }
      )
    }
  })
  session.forwardPtyInput = (data: string, wasUserInput = false): void =>
    ordinary.forward(data, wasUserInput)
  const onData = subscribeToTerminalInputData(session.pane.terminal, (data, wasUserInput) => {
    const forward = wasUserInput ? ordinary.user : ordinary.unclassified
    if (owner) {
      owner.handlePtyInput(data, forward, wasUserInput, ordinary.qualify)
      return
    }
    if (!ordinary.qualify(data, wasUserInput)) {
      return
    }
    if (session.deps.deferPtyInput) {
      session.deps.deferPtyInput(session.pane.id, data, forward, wasUserInput)
      return
    }
    forward(data)
  })
  let inputDetached = false
  session.onDataDisposable = {
    dispose: () => {
      if (inputDetached) {
        return
      }
      inputDetached = true
      let failure: unknown
      for (const cleanup of [
        () => onData.dispose(),
        () => owner?.invalidateSource(),
        () => sourceObservation?.dispose()
      ]) {
        try {
          cleanup()
        } catch (error) {
          failure ??= error
        }
      }
      if (failure !== undefined) {
        throw failure
      }
    }
  }
  session.imeCompositionRouteDisposable = installTerminalImeCompositionRoute({
    terminalElement: session.pane.terminal.element,
    terminal: session.pane.terminal,
    capturedTransport: session.transport,
    getCurrentTransport: () => session.deps.paneTransportsRef.current.get(session.pane.id)
  })
  session.terminalSelectionFitGuard = installTerminalSelectionFitGuard(session.pane.terminal, () =>
    session.scheduleForegroundGridDriftCheck(true)
  )

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
