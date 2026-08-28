import {
  enqueueAgentProcessInspection,
  type InspectionPriority
} from './agent-process-inspection-queue'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import { recognizeAgentProcess } from '../../../../shared/agent-process-recognition'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import {
  NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS,
  POLL_TIER_INTERVAL_MS,
  type PollCadenceTier
} from './agent-completion-poll-cadence'
import type { ProcessMonitorOptions } from './agent-completion-process-types'

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
  function clearPollTimer(): void {
    if (state.pollTimer === null) {
      return
    }
    clearTimeout(state.pollTimer)
    state.pollTimer = null
    state.pollTimerTier = null
  }

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

  function handleInspectionResult(result: RuntimeTerminalProcessInspection): boolean {
    if (result.unavailable === true) {
      state.pendingProcessExitAgent = null
      state.consecutiveInspectionErrors += 1
      scheduleNextPoll()
      return false
    }
    state.consecutiveInspectionErrors = 0
    const recognized = recognizeAgentProcess(result.foregroundProcess)
    if (recognized) {
      handleRecognizedProcess(recognized)
      return true
    }
    if (hasPendingHookDone() || hasPendingCodexAttention()) {
      scheduleNextPoll()
      return false
    }
    if (state.lastForegroundAgent && state.hasAgentRunEvidence) {
      if (result.hasChildProcesses) {
        state.pendingProcessExitAgent = null
        scheduleNextPoll()
        return false
      }
      const pending = state.pendingProcessExitAgent
      if (
        !pending ||
        pending.agent !== state.lastForegroundAgent.agent ||
        pending.processName !== state.lastForegroundAgent.processName
      ) {
        state.pendingProcessExitAgent = state.lastForegroundAgent
        scheduleNextPoll()
        return false
      }
      const exited = state.lastForegroundAgent
      state.pendingProcessExitAgent = null
      if (options.shouldSuppressConfirmedProcessExitCompletion?.(exited) !== true) {
        const replayIdentityBeforeExit = identityScope.getLast()
        const committed = dispatchCompletion('process-exit', exited.processName, {
          terminalIdleConfirmed: true,
          completionIdentity: {
            source: 'process-exit',
            identity: `${exited.agent}:${exited.processName}`,
            agentIdentity: exited.agent
          }
        })
        if (
          !committed &&
          !identityScope.hasUnconsumedStampedTail() &&
          replayIdentityBeforeExit?.source === 'hook' &&
          replayIdentityBeforeExit.agentIdentity === exited.agent
        ) {
          identityScope.deleteLast()
        }
      }
      state.lastForegroundAgent = null
      clearAgentRunEvidence()
    } else {
      state.lastForegroundAgent = null
      clearAgentRunEvidence()
    }
    return false
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
    state.inspectionInFlight = true
    const generationAtRequest = state.inspectionGeneration
    const pendingTitleIdAtRequest = priority === 'pending-title' ? pendingTitle.get()?.id : null
    enqueueAgentProcessInspection({
      priority,
      run: async () => {
        let inspectedRecognizedAgent = false
        let inspectionSucceeded = false
        try {
          const result = await options.inspectProcess(options.getSettings(), ptyId)
          if (!state.disposed && generationAtRequest === state.inspectionGeneration) {
            const currentPendingTitle = pendingTitle.get()
            const appliesToCurrentPendingTitle =
              !currentPendingTitle ||
              (priority === 'pending-title' && currentPendingTitle.id === pendingTitleIdAtRequest)
            if (appliesToCurrentPendingTitle) {
              inspectedRecognizedAgent = handleInspectionResult(result)
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

  function shouldRunCadenceInspection(): boolean {
    return (
      state.hasAgentRunEvidence ||
      state.lastForegroundAgent !== null ||
      options.shouldPollProcessCadence?.() !== false
    )
  }

  function currentPollTier(): PollCadenceTier {
    if (options.shouldPollProcessCadence?.() === false) {
      return 'hidden'
    }
    if (state.lastForegroundAgent) {
      return 'active'
    }
    if (state.hasAgentRunEvidence) {
      return 'idle'
    }
    if (
      options.isProcessInspectionCostly?.() === true &&
      (state.lastPaneActivityAt === 0 ||
        Date.now() - state.lastPaneActivityAt >= NO_EVIDENCE_ACTIVITY_HOT_WINDOW_MS)
    ) {
      return 'no-evidence'
    }
    return 'idle'
  }

  function scheduleNextPoll(): void {
    if (state.disposed || !state.pollTrackingStarted || !options.isLive() || pendingTitle.get()) {
      return
    }
    const tier = currentPollTier()
    if (state.pollTimer !== null) {
      if (
        state.pollTimerTier !== null &&
        POLL_TIER_INTERVAL_MS[tier] < POLL_TIER_INTERVAL_MS[state.pollTimerTier]
      ) {
        clearPollTimer()
      } else {
        return
      }
    }
    if (!shouldRunCadenceInspection() || !options.getPtyId()) {
      return
    }
    const base = POLL_TIER_INTERVAL_MS[tier]
    const backoff =
      state.consecutiveInspectionErrors > 0
        ? Math.min(Math.max(10_000, base), base * 2 ** state.consecutiveInspectionErrors)
        : base
    const interval = Math.round(backoff * (1 + (Math.random() * 0.2 - 0.1)))
    state.pollTimerTier = tier
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null
      state.pollTimerTier = null
      requestInspection('cadence')
    }, interval)
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
