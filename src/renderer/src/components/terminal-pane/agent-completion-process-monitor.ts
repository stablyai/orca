import {
  enqueueAgentProcessInspection,
  type InspectionPriority
} from './agent-process-inspection-queue'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { ProcessMonitorOptions } from './agent-completion-process-types'
import { createAgentCompletionPollScheduler } from './agent-completion-poll-scheduler'
import {
  handleAgentCompletionInspectionResult,
  type RemoteInspectionState
} from './agent-completion-inspection-result'

export function createAgentCompletionProcessMonitor({
  options,
  state,
  identityScope,
  pendingTitle,
  establishAgentEvidence,
  clearAgentRunEvidence,
  hasPendingHookDone,
  hasPendingCodexAttention,
  dispatchCompletion
}: ProcessMonitorOptions) {
  const remoteInspection: RemoteInspectionState = {
    authorityGeneration: null,
    observationEpoch: -1,
    bindingKey: null,
    knownAuthorityGenerations: new Set<string>()
  }

  function bindRemoteInspectionGeneration(ptyId: string, incarnationId: string | null): void {
    if (options.isRemotePtyId?.(ptyId) !== true) {
      return
    }
    const bindingKey = `${ptyId}\0${incarnationId ?? ''}`
    if (remoteInspection.bindingKey === bindingKey) {
      return
    }
    remoteInspection.bindingKey = bindingKey
    remoteInspection.authorityGeneration = null
    remoteInspection.observationEpoch = -1
    remoteInspection.knownAuthorityGenerations.clear()
    // Invalidate reads queued for a prior same-id incarnation.
    state.inspectionGeneration += 1
  }
  const { clearPollTimer, scheduleNextPoll, shouldRunCadenceInspection } =
    createAgentCompletionPollScheduler({ options, state, pendingTitle, requestInspection })

  function handleRecognizedProcess(process: RecognizedAgentProcess): void {
    state.pendingProcessExitAgent = null
    const replayIdentity = identityScope.getLast()
    if (
      !state.lastForegroundAgent &&
      state.processSession > 0 &&
      !identityScope.hasUnconsumedStampedTail() &&
      replayIdentity?.source === 'hook' &&
      replayIdentity.agentIdentity === process.agent
    ) {
      identityScope.deleteLast()
    }
    if (state.lastForegroundAgent?.agent !== process.agent) {
      if (state.lastForegroundAgent && state.hasAgentRunEvidence) {
        if (
          options.shouldSuppressProcessReplacementCompletion?.(
            state.lastForegroundAgent,
            process
          ) !== true
        ) {
          dispatchCompletion('process-exit', state.lastForegroundAgent.processName, {
            completionIdentity: {
              source: 'process-exit',
              identity: `${state.lastForegroundAgent.agent}:${state.lastForegroundAgent.processName}`,
              agentIdentity: state.lastForegroundAgent.agent
            }
          })
        }
      }
      state.processSession += 1
    }
    state.lastForegroundAgent = process
    establishAgentEvidence()
  }

  function requestInspection(priority: InspectionPriority): void {
    if (state.disposed || state.inspectionInFlight || !options.isLive()) {
      return
    }
    if (priority === 'cadence' && !shouldRunCadenceInspection()) {
      return
    }
    const ptyId = options.getPtyId()
    if (!ptyId) {
      return
    }
    const expectedIncarnationIdAtRequest = options.getExpectedIncarnationId?.() ?? null
    bindRemoteInspectionGeneration(ptyId, expectedIncarnationIdAtRequest)
    state.inspectionInFlight = true
    const generationAtRequest = state.inspectionGeneration
    const requestStartedAtMonotonic = performance.now()
    const pendingTitleIdAtRequest = priority === 'pending-title' ? pendingTitle.get()?.id : null
    enqueueAgentProcessInspection({
      priority,
      canRun: () => !state.disposed,
      run: async () => {
        let inspectedRecognizedAgent = false
        let inspectionSucceeded = false
        try {
          const result = await (expectedIncarnationIdAtRequest
            ? options.inspectProcess(options.getSettings(), ptyId, {
                expectedIncarnationId: expectedIncarnationIdAtRequest
              })
            : options.inspectProcess(options.getSettings(), ptyId))
          if (
            !state.disposed &&
            generationAtRequest === state.inspectionGeneration &&
            (options.getExpectedIncarnationId?.() ?? null) === expectedIncarnationIdAtRequest
          ) {
            const currentPendingTitle = pendingTitle.get()
            const appliesToCurrentPendingTitle =
              !currentPendingTitle ||
              (priority === 'pending-title' && currentPendingTitle.id === pendingTitleIdAtRequest)
            if (appliesToCurrentPendingTitle) {
              inspectedRecognizedAgent = handleAgentCompletionInspectionResult({
                result,
                requestStartedAtMonotonic,
                options,
                state,
                identityScope,
                clearAgentRunEvidence,
                hasPendingHookDone,
                hasPendingCodexAttention,
                scheduleNextPoll,
                handleRecognizedProcess,
                dispatchCompletion,
                remoteInspection
              })
            }
            inspectionSucceeded = true
          }
        } catch {
          state.pendingProcessExitAgent = null
          state.consecutiveInspectionErrors += 1
        } finally {
          state.inspectionInFlight = false
          if (generationAtRequest !== state.inspectionGeneration) {
            if (pendingTitle.get()) {
              requestInspection('pending-title')
            } else {
              scheduleNextPoll()
            }
          } else {
            const currentPendingTitle = pendingTitle.get()
            if (currentPendingTitle) {
              if (
                priority === 'pending-title' &&
                currentPendingTitle.id === pendingTitleIdAtRequest
              ) {
                pendingTitle.finishInspection(
                  currentPendingTitle.id,
                  inspectionSucceeded,
                  inspectedRecognizedAgent
                )
              } else {
                requestInspection('pending-title')
              }
            }
            scheduleNextPoll()
          }
        }
      }
    })
  }

  return {
    requestInspection,
    scheduleNextPoll,
    clearPollTimer,
    start: () => {
      state.pollTrackingStarted = true
      scheduleNextPoll()
    },
    recordActivity: () => {
      state.lastPaneActivityAt = Date.now()
      if (state.pollTimer === null || state.pollTimerTier === 'no-evidence') {
        scheduleNextPoll()
      }
    },
    incrementGeneration: () => {
      state.inspectionGeneration += 1
    }
  }
}
