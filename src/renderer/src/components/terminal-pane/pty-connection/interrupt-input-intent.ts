import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import { createAgentInterruptInference } from '../agent-interrupt-inference'
import { createAgentQuestionAnsweredInference } from '../agent-question-answered-inference'
import type { AgentInterruptInputIntent } from '../../../../../shared/agent-interrupt-intent'
import { markTerminalBracketedPasteInterrupted } from '../terminal-bracketed-paste'

import { REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS } from './foreground-output-scan'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { installPaneAgentIdentity } from './pane-agent-identity'

export function installInterruptInputIntent(session: ConnectPanePtySession): void {
  session.scheduleReattachIdleAgentCursorReset = (): void => {
    const status = detectAgentStatusFromTitle(session.getCurrentTerminalTitle() ?? '')
    if (status !== 'idle' && status !== 'permission') {
      return
    }
    session.clearReattachIdleAgentCursorResetTimer()
    session.reattachIdleAgentCursorResetTimer = setTimeout(() => {
      session.reattachIdleAgentCursorResetTimer = null
      if (session.disposed) {
        return
      }
      const latestStatus = detectAgentStatusFromTitle(session.getCurrentTerminalTitle() ?? '')
      if (latestStatus !== 'idle' && latestStatus !== 'permission') {
        return
      }
      // Why: restored idle agent TUIs can repaint after reattach SIGWINCH and
      // reapply DECSCUSR steady-bar; the normal working→idle reset will not
      // fire because the agent was already idle before Orca restarted.
      session.queueAgentIdleTerminalModeReset()
    }, REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS)
  }
  session.interruptInference = createAgentInterruptInference({
    paneKey: session.cacheKey,
    getStatusEntry: () => useAppStore.getState().agentStatusByPaneKey[session.cacheKey],
    inferInterrupt: (request) => {
      // Why: the explicit hook row is the authority for an in-flight agent turn.
      // Codex can reset its terminal title while handling Ctrl+C/Escape, so title
      // state must not veto clearing the row's working state.
      return window.api.agentStatus
        .inferInterrupt(request)
        .then((applied) => {
          if (applied) {
            session.clearInferredInterruptWorkingTitle()
          }
          return applied
        })
        .catch((err) => {
          console.warn('[agent-interrupt] inferInterrupt failed:', err)
          return false
        })
    }
  })
  session.questionAnsweredInference = createAgentQuestionAnsweredInference({
    paneKey: session.cacheKey,
    getStatusEntry: () => useAppStore.getState().agentStatusByPaneKey[session.cacheKey],
    inferQuestionAnswered: (request) =>
      window.api.agentStatus.inferQuestionAnswered(request).catch((err) => {
        console.warn('[agent-question] inferQuestionAnswered failed:', err)
        return false
      })
  })
  session.dropCommandFinishedStatusIfSameTurn = (
    entry: AgentStatusEntry | undefined,
    options?: { allowInferredInterrupt?: boolean }
  ): void => {
    const state = useAppStore.getState()
    if (!entry) {
      // Why: an Orca-started agent can exit before its first hook status. The
      // launch registry was still created up front, so clear it on command exit.
      state.clearAgentLaunchConfig(session.cacheKey)
      return
    }
    const current = state.agentStatusByPaneKey[session.cacheKey]
    if (!current) {
      state.clearAgentLaunchConfig(session.cacheKey)
      return
    }
    const unchanged =
      current.state === entry.state &&
      current.prompt === entry.prompt &&
      current.updatedAt === entry.updatedAt &&
      current.stateStartedAt === entry.stateStartedAt &&
      current.agentType === entry.agentType
    const inferredFromEntry =
      options?.allowInferredInterrupt === true &&
      current.state === 'done' &&
      current.interrupted === true &&
      current.prompt === entry.prompt &&
      current.agentType === entry.agentType &&
      current.stateHistory?.some(
        (history) =>
          history.state === entry.state &&
          history.prompt === entry.prompt &&
          history.startedAt === entry.stateStartedAt
      ) === true
    if (!unchanged && !inferredFromEntry) {
      return
    }
    state.dropAgentStatus(session.cacheKey)
  }
  session.pendingTerminalInputIntent = null
  session.clearPendingTerminalInputIntentTimer = null
  session.clearPendingTerminalInputIntent = (): void => {
    session.pendingTerminalInputIntent = null
    if (session.clearPendingTerminalInputIntentTimer !== null) {
      clearTimeout(session.clearPendingTerminalInputIntentTimer)
      session.clearPendingTerminalInputIntentTimer = null
    }
  }
  session.setPendingTerminalInputIntent = (intent: AgentInterruptInputIntent): void => {
    session.clearPendingTerminalInputIntent()
    session.pendingTerminalInputIntent = intent
    session.clearPendingTerminalInputIntentTimer = setTimeout(() => {
      session.clearPendingTerminalInputIntent()
    }, 0)
  }
  session.inputMatchesIntent = (intent: AgentInterruptInputIntent, data: string): boolean => {
    return (
      (intent === 'plain-escape' && data === '\x1b') || (intent === 'ctrl-c' && data === '\x03')
    )
  }
  session.inferIntentFromExactTerminalInput = (data: string): AgentInterruptInputIntent | null => {
    if (data === '\x03') {
      return 'ctrl-c'
    }
    if (data === '\x1b') {
      return 'plain-escape'
    }
    return null
  }
  session.observeSentTerminalInputIntent = (
    data: string,
    intent = session.pendingTerminalInputIntent
  ): void => {
    if (intent && session.inputMatchesIntent(intent, data)) {
      session.interruptInference.observeInputIntent(intent)
      session.observeTitleOnlyInterrupt()
    }
  }
  session.observeAcceptedTerminalInput = (
    data: string,
    intent: AgentInterruptInputIntent | null = null
  ): void => {
    if (intent === 'ctrl-c' || data === '\x03') {
      markTerminalBracketedPasteInterrupted(session.pane.terminal)
    }
    // Why: every delivered-input path funnels through here, so this is where a
    // submit keystroke into a waiting AskUserQuestion pane becomes the
    // "question answered" signal no hook will ever deliver.
    session.questionAnsweredInference.observeSentTerminalInput(data)
  }
  session.pendingTerminalInputWrite = null
  // Why: an unset baseline must differ from the first `?? null` snapshot so the
  // first acknowledged input still advances the sequence.
  session.sequencedInterruptStatusBaseline = undefined
  session.interruptStatusBaselineSequence = 0
  session.setPendingTerminalInputWrite = (promise: Promise<boolean | null>): void => {
    session.pendingTerminalInputWrite = promise
    void promise.finally(() => {
      if (session.pendingTerminalInputWrite === promise) {
        session.pendingTerminalInputWrite = null
      }
    })
  }
  session.flushPendingInterruptInference = (): boolean | Promise<boolean> => {
    const pendingWrite = session.pendingTerminalInputWrite
    if (!pendingWrite) {
      return session.interruptInference.flushPending()
    }
    return pendingWrite.then((immediateResult) => {
      return immediateResult ?? session.interruptInference.flushPending()
    })
  }
  installPaneAgentIdentity(session)
}
