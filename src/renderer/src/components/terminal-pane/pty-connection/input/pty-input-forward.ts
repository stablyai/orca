import { subscribeToTerminalInputData } from '../../input/terminal-user-input-signal'
import { isPassiveTerminalInputReport } from '../../input/terminal-passive-input-report'
import { installTerminalImeCompositionRoute } from '../../input/ime/terminal-ime-composition-route'
import { useAppStore } from '@/store/index'
import { isTerminalQueryReply } from '../../../../../../shared/terminal/protocol/queries/terminal-query-reply'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { isPaneReplaying } from '../../snapshots/replay-guard'
import {
  isXtermMouseReport,
  isXtermWheelCursorKey
} from '../../input/pointer/terminal-pointer-input-sequences'
import { shouldDropQuarantinedTerminalInput } from '../../input/terminal-input-quarantine'
import {
  TERMINAL_FOCUS_IN_SEQUENCE,
  TERMINAL_FOCUS_OUT_SEQUENCE
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-focus-reports'
import { isCodexPaneStale } from './codex-pane-stale'
import { installTerminalSelectionFitGuard } from '../../viewport/terminal-selection-fit-guard'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { recordAdmittedTerminalUserInput } from '@/diagnostics/telemetry/telemetry'

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
    // Account switches change runtime auth; only this bound endpoint can own its input guard.
    if (
      isCodexPaneStale({
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        leafId: session.pane.leafId,
        panePtyId: currentPtyId,
        paneIncarnationId: session.remotePtyIncarnationId
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
    if (!wasUserInput && !isPassiveTerminalInputReport(data)) {
      session.noteTerminalInputForPty(currentPtyId)
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
            if (wasUserInput) {
              recordAdmittedTerminalUserInput()
            }
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
        if (wasUserInput) {
          recordAdmittedTerminalUserInput()
        }
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
      if (wasUserInput) {
        recordAdmittedTerminalUserInput()
      }
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
}
