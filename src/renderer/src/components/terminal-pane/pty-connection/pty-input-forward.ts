import {
  getTerminalSemanticResident,
  type TerminalSemanticResident
} from '../terminal-semantic-residents'
import type { TerminalInputCall } from '../terminal-input-call'
import { installPtyResizeForward } from './pty-resize-forward'

import { subscribeToTerminalInputData } from '../terminal-user-input-signal'
import { isPassiveTerminalInputReport } from '../terminal-passive-input-report'
import { installTerminalImeCompositionRoute } from '../terminal-ime-composition-route'
import { useAppStore } from '@/store'
import { clearUnchangedTitleOnlyWorking } from './terminal-pane-input'
import { isTerminalQueryReply } from '../../../../../shared/terminal-query-reply'

import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'

import { isPaneReplaying } from '../replay-guard'
import { isXtermMouseReport, isXtermWheelCursorKey } from '../terminal-pointer-input-sequences'
import { shouldDropQuarantinedTerminalInput } from '../terminal-input-quarantine'

import { TERMINAL_FOCUS_IN_SEQUENCE, TERMINAL_FOCUS_OUT_SEQUENCE } from './foreground-output-scan'
import { isCodexPaneStale } from './codex-pane-stale'
import { installTerminalSelectionFitGuard } from '../terminal-selection-fit-guard'
import { initializePaneGeometry, readPaneSize } from './read-pane-size'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyInputForward(session: ConnectPanePtySession): void {
  type InterruptWriter = ReturnType<
    TerminalSemanticResident['policy']['input']['createInterruptWriter']
  >
  let writer: { resident: TerminalSemanticResident; inference: InterruptWriter } | undefined
  const writerFor = (resident: TerminalSemanticResident) => {
    if (writer?.resident !== resident) {
      writer?.inference.release()
      writer = { resident, inference: resident.policy.input.createInterruptWriter() }
    }
    return writer.inference
  }
  session.releaseTerminalInputWriter = () => writer?.inference.release()
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
    if (!wasUserInput && !isPassiveTerminalInputReport(data)) {
      session.noteTerminalInputForPty(currentPtyId)
    }
    // Why xterm's provenance: its own focus reports reach onData too, and no person typed them.
    const inputKind = wasUserInput ? 'driving' : 'query-reply'
    const intent = session.pendingTerminalInputIntentFor(data)
    // Missed DOM keydowns can still yield exact Ctrl+C/Escape bytes; infer only on acknowledged transports, excluding fire-and-forget SSH.
    const acknowledgedIntent = intent ?? session.inferIntentFromExactTerminalInput(data)
    const baseline = useAppStore.getState().agentStatusByPaneKey[session.cacheKey] ?? null
    const launch = useAppStore.getState().agentLaunchConfigByPaneKey[session.cacheKey]
    const titleBaseline = session.getCurrentTerminalTitle()
    const capturedTransport = session.transport
    const acknowledged =
      acknowledgedIntent !== null && capturedTransport.sendInputAccepted !== undefined
    let folded = false
    let dispatched:
      | { resident: TerminalSemanticResident; inference: InterruptWriter; group: number }
      | undefined
    const pending = acknowledged ? Promise.withResolvers<boolean | null>() : undefined
    const call: TerminalInputCall = {
      onEligible: (ptyId) => {
        if (folded || acknowledged) {
          return
        }
        const resident = getTerminalSemanticResident(ptyId)
        if (resident?.isLive) {
          folded = true
          resident.policy.acceptInput(data)
        }
      },
      onDispatch: (ptyId) => {
        if (!acknowledgedIntent && !intent) {
          return
        }
        const resident = getTerminalSemanticResident(ptyId)
        if (!resident?.isLive || dispatched) {
          return
        }
        if (acknowledged) {
          resident.policy.recordInputDispatch()
        }
        dispatched = {
          resident,
          inference: writerFor(resident),
          group: resident.policy.input.reserveInterruptBaseline(baseline)
        }
        if (pending) {
          const release = dispatched.inference.retain()
          resident.policy.input.setPendingTerminalInputWrite(pending.promise)
          void pending.promise.finally(release)
          if (session.disposed) {
            dispatched.inference.release()
          }
        }
      }
    }
    session.claimViewportForUserActivity(data)
    session.clearPendingTerminalInputIntent()
    if (acknowledgedIntent && capturedTransport.sendInputAccepted && pending) {
      const view = new WeakRef(session)
      const paneEffects = session.observePaneInputEffects
      void capturedTransport
        .sendInputAccepted(data, inputKind, { call })
        .then((accepted) => {
          if (!accepted) {
            const mounted = view.deref()
            if (!mounted?.disposed) {
              mounted?.requestRecoveryForUndeliverableInput()
            }
            return null
          }
          if (dispatched && !dispatched.resident.isLive) {
            return null
          }
          // Receipt-independent effects keep their original true-ACK stage without inventing an execution.
          paneEffects(data, baseline)
          const mounted = view.deref()
          if (mounted && !mounted.disposed) {
            mounted.markAcceptedTerminalInputSent()
          }
          const captured = dispatched
          if (!captured) {
            if (
              mounted &&
              !mounted.disposed &&
              (useAppStore.getState().agentStatusByPaneKey[mounted.cacheKey] ?? null) ===
                baseline &&
              useAppStore.getState().agentLaunchConfigByPaneKey[mounted.cacheKey] === launch
            ) {
              clearUnchangedTitleOnlyWorking(mounted, titleBaseline)
            }
            return null
          }
          if (!captured.resident.isLive) {
            return null
          }
          const policy = captured.resident.policy
          policy.acceptInput(data, acknowledgedIntent)
          const result = captured.inference.observeInputIntent(
            acknowledgedIntent,
            baseline,
            captured.group
          )
          const current = useAppStore.getState()
          if (
            (current.agentStatusByPaneKey[policy.binding.paneKey] ?? null) === baseline &&
            current.agentLaunchConfigByPaneKey[policy.binding.paneKey] === launch
          ) {
            policy.shellInput.observeTitleOnlyInterrupt()
          }
          return result ?? null
        })
        .then(pending.resolve, (error) => {
          console.warn('[agent-interrupt] acknowledged terminal input failed:', error)
          pending.resolve(null)
        })
      return
    }
    if (capturedTransport.sendInput(data, inputKind, call)) {
      session.markAcceptedTerminalInputSent()
      session.observePaneInputEffects(data, baseline)
    } else {
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

  installPtyResizeForward(session)

  session.readPaneSize = () => readPaneSize(session)
  initializePaneGeometry(session)
}
