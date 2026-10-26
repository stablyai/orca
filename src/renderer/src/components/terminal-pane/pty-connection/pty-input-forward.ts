import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import { subscribeToTerminalInputData } from '../terminal-user-input-signal'
import { installTerminalImeCompositionRoute } from '../terminal-ime-composition-route'
import { useAppStore } from '@/store'
import { isTerminalQueryReply } from '../../../../../shared/terminal-query-reply'
import { safeFitAndThen } from '@/lib/pane-manager/pane-tree-ops'
import { requestStablePaneFit } from '@/lib/pane-manager/pane-fit-resize-observer'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { getAppliedSizeReadE2eDelayMs } from '../pty-applied-size-read-e2e-delay'
import { createPtySizeReassertion } from '../pty-size-reassertion'
import { isPaneReplaying } from '../replay-guard'
import { isXtermMouseReport, isXtermWheelCursorKey } from '../terminal-pointer-input-sequences'
import { shouldDropQuarantinedTerminalInput } from '../terminal-input-quarantine'
import {
  PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
  queuePanePtyResizeIfHeld,
  type PanePtyResizeHoldFlushDetail
} from '@/lib/pane-manager/pane-pty-resize-hold'

import { FOREGROUND_GRID_DRIFT_CHECK_MIN_MS } from './foreground-output-budgets'
import { TERMINAL_FOCUS_IN_SEQUENCE, TERMINAL_FOCUS_OUT_SEQUENCE } from './foreground-output-scan'
import { isCodexPaneStale } from './codex-pane-stale'
import { installTerminalSelectionFitGuard } from '../terminal-selection-fit-guard'
import { initializePaneGeometry, readPaneSize } from './read-pane-size'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyInputForward(session: ConnectPanePtySession): void {
  session.forwardPtyInput = (data: string, wasUserInput = false): void => {
    // During replay, drop query replies and pointer-generated mouse/arrows but preserve typing; stale TUI modes could send reports or recall history in the fresh shell (replay-guard.ts).
    if (
      isPaneReplaying(session.deps.replayingPanesRef, session.pane.id) &&
      (!wasUserInput ||
        isXtermMouseReport(data) ||
        (isXtermWheelCursorKey(data) && session.pane.terminal.buffer.active.type === 'alternate'))
    ) {
      return
    }
    const currentPtyId = session.transport.getPtyId()
    // Protocol replies keep the TUI responsive while an account notice blocks typing.
    if (isTerminalQueryReply(data)) {
      session.sendDesktopQueryReplyImmediate(data)
      return
    }
    // Account switches change runtime auth; block stale-pane typing until restart, using persisted IDs during unbound reconnect windows.
    if (
      isCodexPaneStale({
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        panePtyId: currentPtyId
      })
    ) {
      session.clearPendingTerminalInputIntent()
      return
    }
    // Mobile driver lock withholds desktop input until explicit Take back restores input and dimensions.
    if (currentPtyId && isPtyLocked(currentPtyId)) {
      session.clearPendingTerminalInputIntent()
      return
    }
    if (
      session.isNativeWindowsConpty &&
      session.suppressNativeWindowsIdleCodexFocusReports &&
      (data === TERMINAL_FOCUS_IN_SEQUENCE || data === TERMINAL_FOCUS_OUT_SEQUENCE)
    ) {
      // Why: Codex can leave focus reporting armed after a Windows turn, but
      // disabling the mode would permanently silence focus events on resume.
      return
    }
    // Reply to device queries before blocking stale-line tails; dropping replies hangs TUIs, but replaying a replaced shell’s partial command could execute its suffix (#10065).
    if (shouldDropQuarantinedTerminalInput(session.deps.tabId, data)) {
      session.clearPendingTerminalInputIntent()
      return
    }
    if (session.captureAgentPreReadyInput?.(data, wasUserInput)) {
      session.clearPendingTerminalInputIntent()
      return
    }
    // Why xterm's provenance: its own focus reports reach onData too, and no person typed them.
    const inputKind = wasUserInput ? 'driving' : 'query-reply'
    const intent = session.pendingTerminalInputIntentFor(data)
    // Missed DOM keydowns can still yield exact Ctrl+C/Escape bytes; infer only on acknowledged transports, excluding fire-and-forget SSH.
    const acknowledgedIntent = intent ?? session.inferIntentFromExactTerminalInput(data)
    if (acknowledgedIntent && session.transport.sendInputAccepted) {
      const interruptStatusBaseline =
        useAppStore.getState().agentStatusByPaneKey[session.cacheKey] ?? null
      // Why: equal snapshots retain double-Escape semantics while older snapshots lose ack races.
      if (session.sequencedInterruptStatusBaseline !== interruptStatusBaseline) {
        session.sequencedInterruptStatusBaseline = interruptStatusBaseline
        session.interruptStatusBaselineSequence += 1
      }
      const capturedBaselineSequence = session.interruptStatusBaselineSequence
      session.claimViewportForUserActivity(data)
      if (acknowledgedIntent === 'ctrl-c') {
        // Async acknowledgments must not delay fresh inference after cancelling an oversized line.
        session.cancelSuspendedShellCommandInference()
      }
      session.clearPendingTerminalInputIntent()
      const writePromise = session.transport
        .sendInputAccepted(data, inputKind)
        .then((accepted): boolean | Promise<boolean> | null => {
          if (accepted) {
            // Why: rejected writes use transport recovery and must not arm a parser probe.
            session.markAcceptedTerminalInputSent()
            session.observeAcceptedShellCommandInput(data)
            session.observeAcceptedTerminalInput(data, acknowledgedIntent)
            const immediateResult = session.interruptInference.observeInputIntent(
              acknowledgedIntent,
              interruptStatusBaseline,
              capturedBaselineSequence
            )
            session.observeTitleOnlyInterrupt()
            return immediateResult ?? null
          }
          // Frozen-pane Escape/Ctrl+C rejects must still arm unbound recovery.
          session.requestRecoveryForUndeliverableInput()
          return null
        })
        .catch((err) => {
          console.warn('[agent-interrupt] acknowledged terminal input failed:', err)
          return null
        })
      session.setPendingTerminalInputWrite(writePromise)
      return
    }
    if (intent) {
      session.claimViewportForUserActivity(data)
      if (session.transport.sendInput(data, inputKind)) {
        session.markAcceptedTerminalInputSent()
        session.observeAcceptedShellCommandInput(data)
        session.observeAcceptedTerminalInput(data, intent)
      } else {
        session.requestRecoveryForUndeliverableInput()
      }
      session.clearPendingTerminalInputIntent()
      return
    }
    session.claimViewportForUserActivity(data)
    if (session.transport.sendInput(data, inputKind)) {
      session.markAcceptedTerminalInputSent()
      session.observeAcceptedShellCommandInput(data)
      session.observeAcceptedTerminalInput(data)
      session.observeSentTerminalInputIntent(data)
    } else {
      session.clearPendingTerminalInputIntent()
      session.requestRecoveryForUndeliverableInput()
    }
  }
  // Bind once so provenance survives deferred input without allocating per-keystroke closures.
  const forwardUserInput = (data: string): void => session.forwardPtyInput(data, true)
  const forwardUnclassifiedInput = (data: string): void => session.forwardPtyInput(data, false)
  session.onDataDisposable = subscribeToTerminalInputData(
    session.pane.terminal,
    (data, wasUserInput) => {
      const forward = wasUserInput ? forwardUserInput : forwardUnclassifiedInput
      if (session.deps.deferPtyInput) {
        session.deps.deferPtyInput(session.pane.id, data, forward)
        return
      }
      forward(data)
    }
  )
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
  session.pendingForegroundGridDriftCheckRaf = null
  session.lastForegroundGridDriftCheckAt = Number.NEGATIVE_INFINITY
  session.scheduleForegroundGridDriftCheck = (force = false): void => {
    if (
      session.disposed ||
      !session.deps.isVisibleRef.current ||
      session.shouldSuppressDesktopPtyResize() ||
      session.pendingForegroundGridDriftCheckRaf !== null ||
      (!force && session.terminalSelectionFitGuard?.isActive())
    ) {
      return
    }
    const now = performance.now()
    if (
      !force &&
      now - session.lastForegroundGridDriftCheckAt < FOREGROUND_GRID_DRIFT_CHECK_MIN_MS
    ) {
      return
    }
    session.lastForegroundGridDriftCheckAt = now
    session.pendingForegroundGridDriftCheckRaf = requestAnimationFrame(() => {
      session.pendingForegroundGridDriftCheckRaf = null
      if (
        session.disposed ||
        !session.deps.isVisibleRef.current ||
        session.shouldSuppressDesktopPtyResize() ||
        session.terminalSelectionFitGuard?.isActive() ||
        !session.terminalGridDriftedFromFit()
      ) {
        return
      }
      requestStablePaneFit(session.pane as ManagedPaneInternal, () =>
        session.ptySizeReassertion.request({ fit: false })
      )
    })
  }

  session.readPaneSize = () => readPaneSize(session)
  initializePaneGeometry(session)
}
