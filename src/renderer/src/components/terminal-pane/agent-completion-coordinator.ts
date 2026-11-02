import { detectAgentStatusFromTitle } from '../../../../shared/agent-detection'
import type { AgentStatus } from '../../../../shared/agent-detection'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type {
  AgentCompletionCoordinator,
  AgentCompletionCoordinatorOptions
} from './agent-completion-coordinator-types'
import {
  createAgentCompletionIdentityScope,
  getAgentCompletionCoordinatorIdentityCountForTest,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from './agent-completion-identity-store'
import { createTitleCompletionClaim } from './agent-completion-title-claim'
import { createAgentCompletionProcessMonitor } from './agent-completion-process-monitor'
import { createPendingTitleController } from './agent-completion-pending-title'
import {
  createAgentCompletionNotificationController,
  type CompletionState
} from './agent-completion-notification-controller'
import { createAgentCompletionTitleObserver } from './agent-completion-title-observer'
import { createAgentCompletionHookObserver } from './agent-completion-hook-observer'
import { createAgentCompletionLifecycle } from './agent-completion-lifecycle'

const COMPLETION_REPLAY_GUARD_MS = 1_000

export function createAgentCompletionCoordinator(
  options: AgentCompletionCoordinatorOptions
): AgentCompletionCoordinator {
  const identityScope = createAgentCompletionIdentityScope(options.paneKey, options.statusLane)
  let agentIdentityEstablished = false
  let hasAgentRunEvidence = false
  let lastTitleStatus: AgentStatus | null = null
  const completionState: CompletionState = {
    currentTurn: 0,
    workingStatusObserved: false,
    requiresFreshWorking: false,
    lastCompletionToken: null,
    lastCompletionAt: 0,
    lastCompletedTurn: null,
    lastCompletionSource: null,
    lastCompletionIdentity: null,
    lastAttentionToken: null,
    pendingHookDoneTimer: null,
    pendingHookDoneTitle: null,
    pendingHookDonePayload: null
  }
  // Why: output/title activity can arrive before async PTY bind; only re-arm cadence after bind starts process tracking.
  const processState = {
    disposed: false,
    inspectionInFlight: false,
    inspectionGeneration: 0,
    consecutiveInspectionErrors: 0,
    pollTrackingStarted: false,
    pollTimer: null as ReturnType<typeof setTimeout> | null,
    pollTimerTier: null as 'active' | 'idle' | 'hidden' | 'no-evidence' | null,
    lastPaneActivityAt: null,
    hasAgentRunEvidence: false,
    pendingProcessExit: null,
    lastForegroundAgent: null as RecognizedAgentProcess | null,
    processSession: 0
  }
  const titleClaim = createTitleCompletionClaim({
    options,
    state: completionState,
    processState,
    identityScope,
    titleAgentIdentity: (title) => titleObserver.titleCompletionAgentIdentity(title),
    dispatchTitle: (title) => titleObserver.dispatchTitle(title)
  })
  let processMonitor!: ReturnType<typeof createAgentCompletionProcessMonitor>
  let pendingTitle!: ReturnType<typeof createPendingTitleController>
  let notification!: ReturnType<typeof createAgentCompletionNotificationController>
  let titleObserver!: ReturnType<typeof createAgentCompletionTitleObserver>
  let hookObserver!: ReturnType<typeof createAgentCompletionHookObserver>
  let lifecycle!: ReturnType<typeof createAgentCompletionLifecycle>

  function establishAgentEvidence(): void {
    agentIdentityEstablished = true
    hasAgentRunEvidence = true
    processState.hasAgentRunEvidence = true
    processState.pendingProcessExit = null
    processMonitor?.scheduleNextPoll()
  }

  function clearAgentRunEvidence(): void {
    agentIdentityEstablished = false
    hasAgentRunEvidence = false
    completionState.workingStatusObserved = false
    processState.hasAgentRunEvidence = false
    processState.pendingProcessExit = null
    dropPendingTitle()
  }

  notification = createAgentCompletionNotificationController({
    options,
    state: completionState,
    processState,
    identityScope
  })

  const {
    clearPendingHookDone,
    dispatchCompletion,
    dispatchAttention,
    completionIdentityFor,
    hookCompletionIdentity,
    hookCompletionAgentIdentity,
    doneShouldUseQuietWindow,
    scheduleHookDoneCompletion
  } = notification

  const recordWorkingBoundary = identityScope.recordWorkingBoundary
  const clearWorkingBoundary = identityScope.clearWorkingBoundary
  const turnCompletedAtAlreadyHandled = identityScope.turnCompletedAtAlreadyHandled
  const rememberHandledTurnCompletedAt = identityScope.rememberTurnCompletedAt
  const consumePendingStampedTailForAgent = identityScope.consumePendingStampedTailForAgent
  const consumeStampedTailForCurrentCoordinator = identityScope.consumeStampedTail
  const hasUnconsumedStampedTail = identityScope.hasUnconsumedStampedTail

  pendingTitle = createPendingTitleController({
    hasAgentEvidence: () => hasAgentRunEvidence,
    onEligible: dispatchPendingTitleIfEligible,
    onExpired: () => {},
    requestInspection: () => processMonitor.requestInspection('pending-title'),
    schedulePoll: () => processMonitor.scheduleNextPoll()
  })
  processMonitor = createAgentCompletionProcessMonitor({
    options,
    state: processState,
    identityScope,
    pendingTitle,
    establishAgentEvidence,
    clearAgentRunEvidence,
    hasPendingHookDone: () => completionState.pendingHookDoneTimer !== null,
    dispatchCompletion
  })

  titleObserver = createAgentCompletionTitleObserver({
    getLastStatus: () => lastTitleStatus,
    setLastStatus: (status) => {
      lastTitleStatus = status
    },
    hasAgentEvidence: () => agentIdentityEstablished && hasAgentRunEvidence,
    establishAgentEvidence,
    recordPaneActivity,
    recordTitleWorking,
    holdTitleCompletionPending,
    hasPendingTitle: () => pendingTitle.get() !== null,
    dropPendingTitle,
    claimTitleCompletion: (title) => titleClaim.claim(title),
    dispatchTitleCompletion: (title) =>
      dispatchCompletion('title', title, {
        completionIdentity: {
          source: 'title',
          identity: title,
          agentIdentity: titleObserver.titleCompletionAgentIdentity(title)
        }
      })
  })

  function dropPendingTitle(): void {
    pendingTitle.drop()
    titleClaim.cancelOwnedIdle()
  }

  function dispatchPendingTitleIfEligible(): void {
    const currentPendingTitle = pendingTitle.get()
    if (
      !currentPendingTitle ||
      !currentPendingTitle.validatedByFreshInspection ||
      !agentIdentityEstablished ||
      !hasAgentRunEvidence
    ) {
      return
    }
    const title = currentPendingTitle.title
    dropPendingTitle()
    titleObserver.dispatchTitle(title)
  }

  function holdTitleCompletionPending(title: string): void {
    pendingTitle.hold(title)
  }

  function recordPaneActivity(): void {
    processMonitor.recordActivity()
  }

  function recordTitleWorking(title: string | null): boolean {
    // Why: hooks can report `done` before title tracking notices the next milestone, so the working title must cancel that provisional done.
    clearPendingHookDone()
    if (
      completionState.lastCompletionSource === 'hook' &&
      Date.now() - completionState.lastCompletionAt < COMPLETION_REPLAY_GUARD_MS
    ) {
      return false
    }
    completionState.workingStatusObserved = true
    completionState.requiresFreshWorking = false
    // Why: the turn is tracked even on a hook-owned pane, in case its end turns out ambiguous.
    if (!titleClaim.keepsHookReceipt(title) && !hasUnconsumedStampedTail()) {
      identityScope.deleteLast()
    }
    completionState.currentTurn += 1
    dropPendingTitle()
    return true
  }

  function observeTitleWorking(): void {
    recordTitleWorking(null)
  }

  hookObserver = createAgentCompletionHookObserver({
    options,
    state: completionState,
    establishAgentEvidence,
    recordPaneActivity,
    clearPendingHookDone,
    dispatchAttention,
    dispatchCompletion: (source, title, override) =>
      dispatchCompletion(
        source,
        title,
        override as Parameters<typeof notification.dispatchCompletion>[2]
      ),
    scheduleHookDoneCompletion,
    doneShouldUseQuietWindow,
    hookCompletionIdentity,
    hookCompletionAgentIdentity,
    completionIdentityFor,
    openStampedTail: (timestamp) => identityScope.openStampedTail(timestamp),
    rememberHandledTurnCompletedAt,
    turnCompletedAtAlreadyHandled,
    consumePendingStampedTailForAgent,
    consumeStampedTailForCurrentCoordinator,
    clearOriginStampedTail: () => identityScope.clearOriginStampedTail(),
    clearProcessExitCompletion: () => identityScope.clearProcessExitCompletion(),
    recordWorkingBoundary,
    dropPendingTitle
  })

  lifecycle = createAgentCompletionLifecycle({
    state: completionState,
    processState,
    identityScope,
    clearPendingHookDone,
    dropPendingTitle,
    clearWorkingBoundary,
    incrementGeneration: () => processMonitor.incrementGeneration(),
    clearPollTimer: () => processMonitor.clearPollTimer(),
    isLive: options.isLive,
    clearEvidence: () => {
      agentIdentityEstablished = false
      hasAgentRunEvidence = false
    },
    clearTitleStatus: () => {
      lastTitleStatus = null
    }
  })

  return {
    restoreCurrent: ({ title, working, status }) => {
      if (
        completionState.currentTurn !== 0 ||
        completionState.lastCompletionToken ||
        completionState.pendingHookDoneTimer !== null
      ) {
        return
      }
      if (title !== null) {
        lastTitleStatus = detectAgentStatusFromTitle(title)
      }
      if (lastTitleStatus !== null || status) {
        agentIdentityEstablished = hasAgentRunEvidence = processState.hasAgentRunEvidence = true
      }
      if (working && !completionState.requiresFreshWorking) {
        completionState.workingStatusObserved = true
      }
      if (status?.state === 'working') {
        recordWorkingBoundary(status.stateStartedAt)
      }
      if (status?.turnCompletedAt !== undefined && Number.isFinite(status.turnCompletedAt)) {
        rememberHandledTurnCompletedAt(status.turnCompletedAt)
      }
    },
    seedTitle: (title: string) => {
      if (
        completionState.currentTurn !== 0 ||
        completionState.lastCompletionToken ||
        completionState.pendingHookDoneTimer !== null
      ) {
        return
      }
      lastTitleStatus = detectAgentStatusFromTitle(title)
      if (lastTitleStatus !== null) {
        agentIdentityEstablished = hasAgentRunEvidence = processState.hasAgentRunEvidence = true
      }
      if (lastTitleStatus === 'working' && !completionState.requiresFreshWorking) {
        completionState.workingStatusObserved = true
      }
    },
    observeTitle: titleObserver.observeTitle,
    observeClassifiedTitleCompletion: titleObserver.observeClassifiedTitleCompletion,
    observeTitleWorking,
    observeOutputActivity: recordPaneActivity,
    observeHookStatus: hookObserver.observeHookStatus,
    seedHookStatus: hookObserver.seedHookStatus,
    startProcessTracking: () => processMonitor.start(),
    observeForegroundAgentProcess: processMonitor.observeRecognizedProcess,
    hasPendingHookDoneCompletion: lifecycle.hasPendingHookDoneCompletion,
    canAnnounceCompletion: notification.canAnnounceCompletion,
    resetCompletionState: lifecycle.resetCompletionState,
    dispose: lifecycle.dispose
  }
}

export {
  resetAgentCompletionCoordinatorIdentitiesForTest,
  getAgentCompletionCoordinatorIdentityCountForTest
}
