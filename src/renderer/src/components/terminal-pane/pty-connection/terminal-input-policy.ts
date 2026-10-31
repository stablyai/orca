import { captureTerminalFactSubject, type TerminalFactSubject } from '../terminal-fact-subject'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import { createAgentInterruptInference } from '../agent-interrupt-inference'
import { createAgentQuestionAnsweredInference } from '../agent-question-answered-inference'
import type { AgentInterruptInputIntent } from '../../../../../shared/agent-interrupt-intent'
import { isPassiveTerminalInputReport } from '../terminal-passive-input-report'
import { dismissRetainedProgramResult } from '@/lib/program-status/result-retention'
import { isRetainedProgramResult } from '@/lib/program-status/row'
import type { AgentInterruptInference } from '../agent-interrupt-inference'

export function createTerminalInputPolicy(services: {
  paneKey: string
  isLive?: () => boolean
  clearInferredInterruptWorkingTitle: () => void
  observeTitleOnlyInterrupt: () => void
  markBracketedPasteInterrupted: () => void
}) {
  const writers = new Set<
    AgentInterruptInference & { release: () => void; retain: () => () => void }
  >()
  const createInterruptWriter = () => {
    let attached = true
    let pendingWrites = 0
    const releaseIfIdle = () => {
      if (!attached && pendingWrites === 0 && !inference.hasPending()) {
        writers.delete(writer)
        inference.dispose()
      }
    }
    const inference = createAgentInterruptInference({
      paneKey: services.paneKey,
      getStatusEntry: () => useAppStore.getState().agentStatusByPaneKey[services.paneKey],
      inferInterrupt: (request) => {
        if (services.isLive?.() === false) {
          return false
        }
        // Why: the explicit hook row is the authority for an in-flight agent turn.
        // Codex can reset its terminal title while handling Ctrl+C/Escape, so title
        // state must not veto clearing the row's working state.
        const subject = captureTerminalFactSubject(services.paneKey)
        return window.api.agentStatus
          .inferInterrupt(request)
          .then((applied) => {
            const state = useAppStore.getState()
            const current = state.agentStatusByPaneKey[services.paneKey]
            const sameTurn =
              current?.agentType === request.baselineAgentType &&
              current.prompt === request.baselinePrompt &&
              (current.updatedAt === request.baselineUpdatedAt ||
                (current.interrupted === true &&
                  current.stateHistory?.some(
                    (history) =>
                      history.prompt === request.baselinePrompt &&
                      history.startedAt === request.baselineStateStartedAt
                  ) === true))
            if (
              applied &&
              services.isLive?.() !== false &&
              sameTurn &&
              state.agentLaunchConfigByPaneKey[services.paneKey] === subject.launch
            ) {
              services.clearInferredInterruptWorkingTitle()
            }
            return applied
          })
          .catch((err) => {
            console.warn('[agent-interrupt] inferInterrupt failed:', err)
            return false
          })
      },
      setTimer: (callback, ms) =>
        setTimeout(() => {
          callback()
          releaseIfIdle()
        }, ms)
    })
    const writer = {
      ...inference,
      observeInputIntent(...args: Parameters<AgentInterruptInference['observeInputIntent']>) {
        if (args[2] !== undefined && args[2] < interruptStatusBaselineSequence) {
          return
        }
        const result = inference.observeInputIntent(...args)
        releaseIfIdle()
        return result
      },
      release() {
        attached = false
        releaseIfIdle()
      },
      retain() {
        pendingWrites += 1
        return () => {
          pendingWrites -= 1
          releaseIfIdle()
        }
      }
    }
    writers.add(writer)
    return writer
  }
  const interruptInference = createInterruptWriter()
  const questionAnsweredInference = createAgentQuestionAnsweredInference({
    paneKey: services.paneKey,
    getStatusEntry: () => useAppStore.getState().agentStatusByPaneKey[services.paneKey],
    inferQuestionAnswered: (request) =>
      window.api.agentStatus.inferQuestionAnswered(request).catch((err) => {
        console.warn('[agent-question] inferQuestionAnswered failed:', err)
        return false
      })
  })
  const dropCommandFinishedStatusIfSameTurn = (
    entry: AgentStatusEntry | undefined,
    options?: { allowInferredInterrupt?: boolean; subject?: TerminalFactSubject }
  ): void => {
    const state = useAppStore.getState()
    const subject = options?.subject ?? captureTerminalFactSubject(services.paneKey)
    if (state.agentLaunchConfigByPaneKey[services.paneKey] !== subject.launch) {
      return
    }
    if (!entry) {
      if (state.agentStatusByPaneKey[services.paneKey]) {
        return
      }
      // Why: an Orca-started agent can exit before its first hook status. The
      // launch registry was still created up front, so clear it on command exit.
      state.clearAgentLaunchConfig(services.paneKey)
      return
    }
    const current = state.agentStatusByPaneKey[services.paneKey]
    if (!current) {
      state.clearAgentLaunchConfig(services.paneKey)
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
    if (!isRetainedProgramResult(current)) {
      state.dropAgentStatus(services.paneKey)
    }
  }
  let pendingTerminalInputIntent: AgentInterruptInputIntent | null = null
  let clearPendingTerminalInputIntentTimer: ReturnType<typeof setTimeout> | null = null
  const clearPendingTerminalInputIntent = (): void => {
    pendingTerminalInputIntent = null
    if (clearPendingTerminalInputIntentTimer !== null) {
      clearTimeout(clearPendingTerminalInputIntentTimer)
      clearPendingTerminalInputIntentTimer = null
    }
  }
  const setPendingTerminalInputIntent = (intent: AgentInterruptInputIntent): void => {
    clearPendingTerminalInputIntent()
    pendingTerminalInputIntent = intent
    clearPendingTerminalInputIntentTimer = setTimeout(() => {
      clearPendingTerminalInputIntent()
    }, 0)
  }
  // Why: a focus or hover report landing between a keydown and its byte must not consume the intent.
  const pendingTerminalInputIntentFor = (data: string): AgentInterruptInputIntent | null =>
    isPassiveTerminalInputReport(data) ? null : pendingTerminalInputIntent
  const inputMatchesIntent = (intent: AgentInterruptInputIntent, data: string): boolean => {
    return (
      (intent === 'plain-escape' && data === '\x1b') || (intent === 'ctrl-c' && data === '\x03')
    )
  }
  const inferIntentFromExactTerminalInput = (data: string): AgentInterruptInputIntent | null => {
    if (data === '\x03') {
      return 'ctrl-c'
    }
    if (data === '\x1b') {
      return 'plain-escape'
    }
    return null
  }
  const observeSentTerminalInputIntent = (
    data: string,
    intent = pendingTerminalInputIntent
  ): void => {
    if (intent && inputMatchesIntent(intent, data)) {
      interruptInference.observeInputIntent(intent)
      services.observeTitleOnlyInterrupt()
    }
  }
  const observeAcceptedTerminalInput = (
    data: string,
    intent: AgentInterruptInputIntent | null = null
  ): void => {
    if (intent === 'ctrl-c' || data === '\x03') {
      services.markBracketedPasteInterrupted()
    }
    // Why: every delivered-input path funnels through here, so this is where a
    // submit keystroke into a waiting AskUserQuestion pane becomes the
    // "question answered" signal no hook will ever deliver.
    questionAnsweredInference.observeSentTerminalInput(data)
    if (!isPassiveTerminalInputReport(data)) {
      dismissRetainedProgramResult(services.paneKey, useAppStore.getState())
    }
  }
  let pendingTerminalInputWrite: Promise<boolean | null> | null = null
  const pendingWrites = new Set<Promise<boolean | null>>()
  // Why: an unset baseline must differ from the first `?? null` snapshot so the
  // first acknowledged input still advances the sequence.
  let sequencedInterruptStatusBaseline: AgentStatusEntry | null | undefined = undefined
  let interruptStatusBaselineSequence: number = 0
  const setPendingTerminalInputWrite = (promise: Promise<boolean | null>): void => {
    pendingTerminalInputWrite = promise
    pendingWrites.add(promise)
    void promise.finally(() => {
      pendingWrites.delete(promise)
      if (pendingTerminalInputWrite === promise) {
        pendingTerminalInputWrite = null
      }
    })
  }
  const flushPendingInterruptInference = (): boolean | Promise<boolean> => {
    const flush = (): boolean | Promise<boolean> => {
      const results = Array.from(writers, (writer) => writer.flushPending())
      return results.some((result) => result instanceof Promise)
        ? Promise.all(results.map((result) => Promise.resolve(result))).then((values) =>
            values.some(Boolean)
          )
        : results.some(Boolean)
    }
    if (pendingWrites.size === 0) {
      return flush()
    }
    return Promise.all(Array.from(pendingWrites)).then(async (results) => {
      const inferred = await flush()
      return results.some(Boolean) || inferred
    })
  }
  return {
    interruptInference,
    createInterruptWriter,
    dispose() {
      for (const writer of writers) {
        writer.dispose()
      }
      writers.clear()
    },
    reserveInterruptBaseline(entry: AgentStatusEntry | null): number {
      if (entry !== (useAppStore.getState().agentStatusByPaneKey[services.paneKey] ?? null)) {
        return interruptStatusBaselineSequence - 1
      }
      if (sequencedInterruptStatusBaseline !== entry) {
        sequencedInterruptStatusBaseline = entry
        interruptStatusBaselineSequence += 1
      }
      return interruptStatusBaselineSequence
    },
    questionAnsweredInference,
    dropCommandFinishedStatusIfSameTurn,
    get pendingTerminalInputIntent() {
      return pendingTerminalInputIntent
    },
    set pendingTerminalInputIntent(value: AgentInterruptInputIntent | null) {
      pendingTerminalInputIntent = value
    },
    get clearPendingTerminalInputIntentTimer() {
      return clearPendingTerminalInputIntentTimer
    },
    set clearPendingTerminalInputIntentTimer(value: ReturnType<typeof setTimeout> | null) {
      clearPendingTerminalInputIntentTimer = value
    },
    clearPendingTerminalInputIntent,
    setPendingTerminalInputIntent,
    pendingTerminalInputIntentFor,
    inputMatchesIntent,
    inferIntentFromExactTerminalInput,
    observeSentTerminalInputIntent,
    observeAcceptedTerminalInput,
    get pendingTerminalInputWrite() {
      return pendingTerminalInputWrite
    },
    set pendingTerminalInputWrite(value: Promise<boolean | null> | null) {
      pendingTerminalInputWrite = value
    },
    get sequencedInterruptStatusBaseline() {
      return sequencedInterruptStatusBaseline
    },
    set sequencedInterruptStatusBaseline(value: AgentStatusEntry | null | undefined) {
      sequencedInterruptStatusBaseline = value
    },
    get interruptStatusBaselineSequence() {
      return interruptStatusBaselineSequence
    },
    set interruptStatusBaselineSequence(value: number) {
      interruptStatusBaselineSequence = value
    },
    setPendingTerminalInputWrite,
    flushPendingInterruptInference
  }
}
