import {
  enqueueAgentProcessInspection,
  type InspectionPriority
} from './process-inspection/agent-process-inspection-queue'
import {
  recognizeAgentProcess,
  type RecognizedAgentProcess
} from '../../../../../shared/agent-status/process/agent-process-recognition'
import { isShellProcess } from '../../../../../shared/agent-status/process/shell-process-detection'
import {
  clientOnlyUnverifiableInspection,
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import type { ProcessMonitorOptions } from './agent-completion-process-types'
import { createAgentCompletionPollScheduler } from './agent-completion-poll-scheduler'
import { HIDDEN_OUTPUT_ACTIVITY_NOTICE_INTERVAL_MS } from '../../../../../shared/terminal/replay/pty-model-restore-marker'
import {
  handleAgentCompletionInspectionResult,
  type RemoteInspectionState
} from './agent-completion-inspection-result'

export function createAgentCompletionProcessMonitor({
  options,
  state,
  pendingTitle,
  establishAgentEvidence,
  clearAgentRunEvidence,
  hasPendingHookDone,
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
  const {
    clearPollTimer,
    scheduleNextPoll,
    shouldRunCadenceInspection,
    noteForegroundEvent,
    requestFollowUp,
    consumeReadDue
  } = createAgentCompletionPollScheduler({ options, state, pendingTitle, requestInspection })

  function recordActivityUntil(until: number, eventAt: number): void {
    state.lastPaneActivityAt = Math.max(state.lastPaneActivityAt ?? until, until)
    noteForegroundEvent(eventAt)
  }

  function observationPredatesActivity(result: TerminalProcessInspection): boolean {
    const capturedAgeMs = isClientOnlyUnverifiableInspection(result)
      ? undefined
      : result.foregroundProcessEvidence?.capturedAgeMs
    const lastActivity = state.lastPaneActivityAt
    return (
      capturedAgeMs !== undefined &&
      lastActivity !== null &&
      lastActivity <= Date.now() &&
      Date.now() - capturedAgeMs < lastActivity
    )
  }

  function handleRecognizedProcess(process: RecognizedAgentProcess): void {
    state.pendingProcessExit = null
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
      // Local reads share one capture; remote reads consume separate host round trips.
      sharesHostObservation: options.isRemotePtyId?.(ptyId) !== true,
      run: async () => {
        consumeReadDue()
        let inspectedRecognizedAgent = false
        let inspectionSucceeded = false
        try {
          const steadyState = priority === 'cadence' && options.isRemotePtyId?.(ptyId) !== true
          // A proven idle macOS shell answers from its group; newer daemons ignore it elsewhere for shells, and an older
          // daemon keeps its cheap job-only read (it never proves a shell idle, so the pane keeps re-checking anyway).
          const jobMembershipOnly =
            steadyState && !(state.lastForegroundAgent && state.hasAgentRunEvidence)
          // Only local cadence reads may omit evidence; pending-title and remote decisions require the full capture.
          const inspectOptions = {
            ...(expectedIncarnationIdAtRequest
              ? { expectedIncarnationId: expectedIncarnationIdAtRequest }
              : {}),
            ...(steadyState ? { steadyState: true } : {}),
            ...(jobMembershipOnly ? { jobMembershipOnly: true } : {})
          }
          let result = await (Object.keys(inspectOptions).length > 0
            ? options.inspectProcess(ptyId, inspectOptions)
            : options.inspectProcess(ptyId))
          // An agent tracked while a job-only read was in flight needs full child evidence; the next poll gets it.
          if (jobMembershipOnly && state.lastForegroundAgent && state.hasAgentRunEvidence) {
            requestFollowUp('unresolved')
            return
          }
          // A stale shell cache must not retire a live agent and disable its mouse reporting (#29996).
          if (
            options.isRemotePtyId?.(ptyId) !== true &&
            options.confirmForegroundProcess &&
            state.lastForegroundAgent &&
            state.hasAgentRunEvidence &&
            !isClientOnlyUnverifiableInspection(result) &&
            result.childProcessEvidence !== 'unverifiable' &&
            !result.hasChildProcesses &&
            !recognizeAgentProcess(result.foregroundProcess)
          ) {
            const processSessionAtConfirmation = state.processSession
            const foregroundProcess = await options.confirmForegroundProcess(ptyId)
            // Another foreground reader can replace the agent while this check is pending.
            if (state.processSession !== processSessionAtConfirmation) {
              return
            }
            result =
              foregroundProcess === null
                ? clientOnlyUnverifiableInspection('foreground_unconfirmed')
                : {
                    ...result,
                    foregroundProcess,
                    // An unlisted shell name (-zsh, wsl.exe) that matches the cached read is still exit evidence.
                    hasChildProcesses:
                      !isShellProcess(foregroundProcess) &&
                      foregroundProcess !== result.foregroundProcess
                  }
          }
          if (
            !state.disposed &&
            options.isLive() &&
            options.getPtyId() === ptyId &&
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
                clearAgentRunEvidence,
                hasPendingHookDone,
                requestFollowUp,
                handleRecognizedProcess,
                dispatchCompletion,
                remoteInspection
              })
              // A shared capture can predate the output that asked for this read; read once more after it.
              if (observationPredatesActivity(result)) {
                requestFollowUp('unresolved')
              }
            }
            inspectionSucceeded = true
          }
        } catch {
          state.pendingProcessExit = null
          state.consecutiveInspectionErrors += 1
          requestFollowUp('error')
        } finally {
          state.inspectionInFlight = false
          if (generationAtRequest !== state.inspectionGeneration) {
            if (pendingTitle.get()) {
              requestInspection('pending-title')
            } else {
              // The discarded read answered nothing.
              requestFollowUp('unresolved')
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

  let trackedPtyId: string | null = null

  return {
    requestInspection,
    scheduleNextPoll,
    clearPollTimer,
    observeRecognizedProcess: (process: RecognizedAgentProcess) => {
      if (!state.disposed) {
        handleRecognizedProcess(process)
        // Another reader found the agent; a read lets the host watch its exit.
        noteForegroundEvent()
      }
    },
    start: () => {
      // A new binding is an event; visibility re-syncs only release a read deferred while hidden.
      const ptyId = options.getPtyId()
      if (!state.pollTrackingStarted || ptyId !== trackedPtyId) {
        state.pollTrackingStarted = true
        trackedPtyId = ptyId
        const now = Date.now()
        recordActivityUntil(now, now)
        return
      }
      scheduleNextPoll()
    },
    recordActivity: () => {
      const now = Date.now()
      recordActivityUntil(now, now)
    },
    // Main reports hidden output only on the leading edge of its throttle window, so read after that window.
    recordHiddenOutputActivity: () => {
      const until = Date.now() + HIDDEN_OUTPUT_ACTIVITY_NOTICE_INTERVAL_MS
      recordActivityUntil(until, until)
    },
    incrementGeneration: () => {
      state.inspectionGeneration += 1
    }
  }
}
