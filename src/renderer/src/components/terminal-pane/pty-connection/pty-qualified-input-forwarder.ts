import type { PtyInputSource } from '../pty-input-source'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { useAppStore } from '@/store'
import { isPassiveTerminalInputReport } from '../terminal-passive-input-report'
import { isTerminalQueryReply } from '../../../../../shared/terminal-query-reply'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { isPaneReplaying } from '../replay-guard'
import { isXtermMouseReport, isXtermWheelCursorKey } from '../terminal-pointer-input-sequences'
import { shouldDropQuarantinedTerminalInput } from '../terminal-input-quarantine'
import { isCodexPaneStale } from './codex-pane-stale'
import { TERMINAL_FOCUS_IN_SEQUENCE, TERMINAL_FOCUS_OUT_SEQUENCE } from './foreground-output-scan'

export type QualifiedPtyInputSession = Pick<
  ConnectPanePtySession,
  | 'cacheKey'
  | 'cancelSuspendedShellCommandInference'
  | 'captureAgentPreReadyInput'
  | 'claimViewportForUserActivity'
  | 'clearPendingTerminalInputIntent'
  | 'inferIntentFromExactTerminalInput'
  | 'interruptInference'
  | 'interruptStatusBaselineSequence'
  | 'isNativeWindowsConpty'
  | 'markAcceptedTerminalInputSent'
  | 'noteTerminalInputForPty'
  | 'observeAcceptedShellCommandInput'
  | 'observeAcceptedTerminalInput'
  | 'observeSentTerminalInputIntent'
  | 'observeTitleOnlyInterrupt'
  | 'pendingTerminalInputIntentFor'
  | 'requestRecoveryForUndeliverableInput'
  | 'sendDesktopQueryReplyImmediate'
  | 'sequencedInterruptStatusBaseline'
  | 'setPendingTerminalInputWrite'
  | 'suppressNativeWindowsIdleCodexFocusReports'
  | 'transport'
> & {
  pane: { id: number; terminal: Pick<ConnectPanePtySession['pane']['terminal'], 'buffer'> }
  deps: Pick<ConnectPanePtySession['deps'], 'tabId' | 'worktreeId' | 'replayingPanesRef'>
}

/** Cached once for ordinary input and once per retained source lifetime. */
export function createQualifiedPtyInputForwarder(
  session: QualifiedPtyInputSession,
  source: PtyInputSource | null
) {
  const replayRefuses = (data: string, wasUserInput: boolean): boolean =>
    isPaneReplaying(session.deps.replayingPanesRef, session.pane.id) &&
    (!wasUserInput ||
      isXtermMouseReport(data) ||
      (isXtermWheelCursorKey(data) && session.pane.terminal.buffer.active.type === 'alternate'))
  const writer = source ?? session.transport
  const current = (): boolean => !source || source.isCurrent()
  const qualify = (data: string, wasUserInput: boolean): boolean => {
    if (!current()) {
      return false
    }
    // During replay, drop query replies and pointer-generated mouse/arrows but preserve typing; stale TUI modes could send reports or recall history in the fresh shell (replay-guard.ts).
    if (replayRefuses(data, wasUserInput)) {
      return false
    }
    const currentPtyId = source?.ptyId ?? session.transport.getPtyId()
    // Protocol replies keep the TUI responsive while an account notice blocks typing.
    if (isTerminalQueryReply(data)) {
      return true
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
      return false
    }
    // Mobile driver lock withholds desktop input until explicit Take back restores input and dimensions.
    if (currentPtyId && isPtyLocked(currentPtyId)) {
      session.clearPendingTerminalInputIntent()
      return false
    }
    if (
      session.isNativeWindowsConpty &&
      session.suppressNativeWindowsIdleCodexFocusReports &&
      (data === TERMINAL_FOCUS_IN_SEQUENCE || data === TERMINAL_FOCUS_OUT_SEQUENCE)
    ) {
      // Why: Codex can leave focus reporting armed after a Windows turn, but
      // disabling the mode would permanently silence focus events on resume.
      return false
    }
    // Reply to device queries before blocking stale-line tails; dropping replies hangs TUIs, but replaying a replaced shell’s partial command could execute its suffix (#10065).
    if (shouldDropQuarantinedTerminalInput(session.deps.tabId, data)) {
      session.clearPendingTerminalInputIntent()
      return false
    }
    if (session.captureAgentPreReadyInput?.(data, wasUserInput)) {
      session.clearPendingTerminalInputIntent()
      return false
    }
    return true
  }
  const forward = (data: string, wasUserInput = false, qualified = false): void => {
    if (!current() || (!qualified && !qualify(data, wasUserInput))) {
      return
    }
    if (isTerminalQueryReply(data)) {
      session.sendDesktopQueryReplyImmediate(data)
      return
    }
    if (!wasUserInput && !isPassiveTerminalInputReport(data)) {
      session.noteTerminalInputForPty(source?.ptyId ?? session.transport.getPtyId())
    }
    // Why xterm's provenance: its own focus reports reach onData too, and no person typed them.
    const inputKind = wasUserInput ? 'driving' : 'query-reply'
    const intent = session.pendingTerminalInputIntentFor(data)
    // Missed DOM keydowns can still yield exact Ctrl+C/Escape bytes; infer only on acknowledged transports, excluding fire-and-forget SSH.
    const acknowledgedIntent = intent ?? session.inferIntentFromExactTerminalInput(data)
    if (acknowledgedIntent && writer.sendInputAccepted) {
      const interruptStatusBaseline =
        useAppStore.getState().agentStatusByPaneKey[session.cacheKey] ?? null
      // Why: equal snapshots retain double-Escape semantics while older snapshots lose ack races.
      if (session.sequencedInterruptStatusBaseline !== interruptStatusBaseline) {
        session.sequencedInterruptStatusBaseline = interruptStatusBaseline
        session.interruptStatusBaselineSequence += 1
      }
      const capturedBaselineSequence = session.interruptStatusBaselineSequence
      session.claimViewportForUserActivity(data, source ?? undefined)
      if (!current()) {
        return
      }
      if (acknowledgedIntent === 'ctrl-c') {
        // Async acknowledgments must not delay fresh inference after cancelling an oversized line.
        session.cancelSuspendedShellCommandInference()
      }
      if (!current()) {
        return
      }
      session.clearPendingTerminalInputIntent()
      if (!current()) {
        return
      }
      const writePromise = writer
        .sendInputAccepted(data, inputKind)
        .then((accepted): boolean | Promise<boolean> | null => {
          if (!current()) {
            return null
          }
          if (accepted) {
            // Why: rejected writes use transport recovery and must not arm a parser probe.
            session.markAcceptedTerminalInputSent()
            if (!current()) {
              return null
            }
            session.observeAcceptedShellCommandInput(data)
            if (!current()) {
              return null
            }
            session.observeAcceptedTerminalInput(data, acknowledgedIntent)
            if (!current()) {
              return null
            }
            const immediateResult = session.interruptInference.observeInputIntent(
              acknowledgedIntent,
              interruptStatusBaseline,
              capturedBaselineSequence
            )
            if (current()) {
              session.observeTitleOnlyInterrupt()
            }
            return immediateResult ?? null
          }
          // Frozen-pane Escape/Ctrl+C rejects must still arm unbound recovery.
          session.requestRecoveryForUndeliverableInput()
          return null
        })
        .catch((err) => {
          if (current()) {
            console.warn('[agent-interrupt] acknowledged terminal input failed:', err)
          }
          return null
        })
      if (current()) {
        session.setPendingTerminalInputWrite(writePromise)
      }
      return
    }
    if (intent) {
      session.claimViewportForUserActivity(data, source ?? undefined)
      if (!current()) {
        return
      }
      if (writer.sendInput(data, inputKind) && current()) {
        session.markAcceptedTerminalInputSent()
        if (!current()) {
          return
        }
        session.observeAcceptedShellCommandInput(data)
        if (!current()) {
          return
        }
        session.observeAcceptedTerminalInput(data, intent)
      } else if (current()) {
        session.requestRecoveryForUndeliverableInput()
      }
      if (current()) {
        session.clearPendingTerminalInputIntent()
      }
      return
    }
    session.claimViewportForUserActivity(data, source ?? undefined)
    if (!current()) {
      return
    }
    if (writer.sendInput(data, inputKind) && current()) {
      session.markAcceptedTerminalInputSent()
      if (!current()) {
        return
      }
      session.observeAcceptedShellCommandInput(data)
      if (!current()) {
        return
      }
      session.observeAcceptedTerminalInput(data)
      if (current()) {
        session.observeSentTerminalInputIntent(data)
      }
    } else if (current()) {
      session.clearPendingTerminalInputIntent()
      if (current()) {
        session.requestRecoveryForUndeliverableInput()
      }
    }
  }
  return {
    qualify,
    forward,
    user: (data: string): void => forward(data, true, true),
    unclassified: (data: string): void => forward(data, false, true)
  }
}
