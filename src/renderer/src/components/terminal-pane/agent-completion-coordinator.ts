import type { AgentStatus } from '../../../../shared/agent-detection'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type {
  AgentCompletionCoordinator,
  AgentCompletionCoordinatorOptions,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'
import {
  createAgentCompletionIdentityScope,
  getAgentCompletionCoordinatorIdentityCountForTest,
  resetAgentCompletionCoordinatorIdentitiesForTest,
  type LastCompletionIdentity
} from './agent-completion-identity-store'
import { createAgentCompletionProcessMonitor } from './agent-completion-process-monitor'
import { createPendingTitleController } from './agent-completion-pending-title'
import { createAgentCompletionNotificationController } from './agent-completion-notification-controller'
import { createAgentCompletionTitleObserver } from './agent-completion-title-observer'
import { createAgentCompletionHookObserver } from './agent-completion-hook-observer'
import { createAgentCompletionLifecycle } from './agent-completion-lifecycle'

type CompletionSource = 'hook' | 'title' | 'process-exit'

const COMPLETION_REPLAY_GUARD_MS = 1_000

export function createAgentCompletionCoordinator(
  options: AgentCompletionCoordinatorOptions
): AgentCompletionCoordinator {
  const identityScope = createAgentCompletionIdentityScope(options.paneKey, options.statusLane)
  let agentIdentityEstablished = false
  let hasAgentRunEvidence = false
  let lastTitleStatus: AgentStatus | null = null
  const completionState = {
    currentTurn: 0,
    workingStatusObserved: false,
    requiresFreshWorking: false,
    lastCompletionToken: null as string | null,
    lastCompletionAt: 0,
    lastCompletedTurn: null as number | null,
    lastCompletionSource: null as CompletionSource | null,
    lastCompletionIdentity: null as LastCompletionIdentity | null,
    lastAttentionToken: null as string | null,
    pendingHookDoneTimer: null as ReturnType<typeof setTimeout> | null,
    pendingHookDoneTitle: null as string | null,
    pendingHookDonePayload: null as AgentCompletionStatusSnapshot | null,
    pendingCodexAttentionTimer: null as ReturnType<typeof setTimeout> | null
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
    pendingProcessExitAgent: null as RecognizedAgentProcess | null,
    lastForegroundAgent: null as RecognizedAgentProcess | null,
    processSession: 0
  }
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
    processMonitor?.scheduleNextPoll()
  }

  function clearAgentRunEvidence(): void {
    agentIdentityEstablished = false
    hasAgentRunEvidence = false
    completionState.workingStatusObserved = false
    processState.hasAgentRunEvidence = false
    processState.pendingProcessExitAgent = null
    dropPendingTitle()
  }

  function clearPendingHookDone(): void {
    notification.clearPendingHookDone()
  }

  function clearPendingCodexAttention(): void {
    notification.clearPendingCodexAttention()
  }

  function dispatchCompletion(
    source: CompletionSource,
    title: string,
    override: Parameters<typeof notification.dispatchCompletion>[2] = {}
  ): boolean {
    return notification.dispatchCompletion(source, title, override)
  }

  function dispatchAttention(payload: AgentCompletionStatusSnapshot): void {
    notification.dispatchAttention(payload)
  }

  const completionIdentityFor = (state: string, agentType: string | undefined, timestamp: number) =>
    notification.completionIdentityFor(state, agentType, timestamp)
  const hookCompletionIdentity = (payload: AgentCompletionStatusSnapshot) =>
    notification.hookCompletionIdentity(payload)
  const hookCompletionAgentIdentity = (payload: AgentCompletionStatusSnapshot) =>
    notification.hookCompletionAgentIdentity(payload)
  const doneShouldUseQuietWindow = (payload: AgentCompletionStatusSnapshot) =>
    notification.doneShouldUseQuietWindow(payload)

  function scheduleHookDoneCompletion(title: string, payload: AgentCompletionStatusSnapshot): void {
    notification.scheduleHookDoneCompletion(title, payload)
  }

  notification = createAgentCompletionNotificationController({
    options,
    state: completionState,
    processState,
    identityScope
  })

  function recordWorkingBoundary(stateStartedAt: number | undefined): void {
    identityScope.recordWorkingBoundary(stateStartedAt)
  }

  function clearWorkingBoundary(): void {
    identityScope.clearWorkingBoundary()
  }

  function turnCompletedAtAlreadyHandled(turnCompletedAt: number): boolean {
    return identityScope.turnCompletedAtAlreadyHandled(turnCompletedAt)
  }

  function rememberHandledTurnCompletedAt(turnCompletedAt: number): void {
    identityScope.rememberTurnCompletedAt(turnCompletedAt)
  }

  function consumePendingStampedTailForAgent(
    agentIdentity: string | null,
    completionIdentity: string | null
  ): boolean {
    return identityScope.consumePendingStampedTailForAgent(agentIdentity, completionIdentity)
  }

  function consumeStampedTailForCurrentCoordinator(turnCompletedAt: number): void {
    identityScope.consumeStampedTail(turnCompletedAt)
  }

  function hasUnconsumedStampedTail(): boolean {
    return identityScope.hasUnconsumedStampedTail()
  }

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
    hasPendingCodexAttention: () => completionState.pendingCodexAttentionTimer !== null,
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
    markTitleCompletionNotified,
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
    markTitleCompletionNotified(title)
    dispatchCompletion('title', title, {
      completionIdentity: {
        source: 'title',
        identity: title,
        agentIdentity: titleObserver.titleCompletionAgentIdentity(title)
      }
    })
  }

  function holdTitleCompletionPending(title: string): void {
    pendingTitle.hold(title)
  }

  function recordPaneActivity(): void {
    processMonitor.recordActivity()
  }

  function observeOutputActivity(): void {
    recordPaneActivity()
  }

  function recordTitleWorking(): boolean {
    // Why: hooks can report `done` before title tracking notices the next milestone, so the working title must cancel that provisional done.
    clearPendingHookDone()
    if (
      completionState.lastCompletionSource === 'hook' &&
      Date.now() - completionState.lastCompletionAt < COMPLETION_REPLAY_GUARD_MS
    ) {
      return false
    }
    // Why: cancel debounced attention when a Codex resume surfaces as a working title (else false banner #8387); placed after the replay guard so a stale post-completion replay can't drop it.
    clearPendingCodexAttention()
    completionState.workingStatusObserved = true
    completionState.requiresFreshWorking = false
    if (!hasUnconsumedStampedTail()) {
      identityScope.deleteLast()
    }
    completionState.currentTurn += 1
    dropPendingTitle()
    return true
  }

  function observeTitleWorking(): void {
    recordTitleWorking()
  }

  function markTitleCompletionNotified(title: string): void {
    completionState.lastCompletionIdentity = {
      source: 'title',
      identity: title,
      agentIdentity: titleObserver.titleCompletionAgentIdentity(title)
    }
  }

  hookObserver = createAgentCompletionHookObserver({
    options,
    state: completionState,
    establishAgentEvidence,
    recordPaneActivity,
    clearPendingHookDone,
    clearPendingCodexAttention,
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
    recordWorkingBoundary,
    dropPendingTitle
  })

  lifecycle = createAgentCompletionLifecycle({
    state: completionState,
    processState,
    identityScope,
    clearPendingHookDone,
    clearPendingCodexAttention,
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
    observeTitle: titleObserver.observeTitle,
    observeClassifiedTitleCompletion: titleObserver.observeClassifiedTitleCompletion,
    observeTitleWorking,
    observeOutputActivity,
    observeHookStatus: hookObserver.observeHookStatus,
    seedHookStatus: hookObserver.seedHookStatus,
    startProcessTracking: () => processMonitor.start(),
    hasPendingHookDoneCompletion: lifecycle.hasPendingHookDoneCompletion,
    resetCompletionState: lifecycle.resetCompletionState,
    dispose: lifecycle.dispose
  }
}

export {
  resetAgentCompletionCoordinatorIdentitiesForTest,
  getAgentCompletionCoordinatorIdentityCountForTest
}
