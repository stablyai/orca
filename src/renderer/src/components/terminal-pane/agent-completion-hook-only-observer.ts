import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type {
  AgentCompletionCoordinatorOptions,
  AgentCompletionHookCandidate
} from './agent-completion-coordinator-types'
import {
  createAgentCompletionIdentityScope,
  type AgentCompletionIdentityScope
} from './agent-completion-identity-store'
import { createAgentCompletionHookObserver } from './agent-completion-hook-observer'
import {
  createAgentCompletionNotificationController,
  type CompletionState
} from './agent-completion-notification-controller'

export function createHookOnlyCompletionObserver(input: {
  paneKey: string
  isLive: () => boolean
  workingObserved?: boolean
  identityScope?: AgentCompletionIdentityScope
  dispatch: (candidate: AgentCompletionHookCandidate) => void
}) {
  const identityScope =
    input.identityScope ?? createAgentCompletionIdentityScope(input.paneKey, 'hook')
  let seeding = false
  let disposed = false
  const state: CompletionState = {
    currentTurn: input.workingObserved ? 1 : 0,
    workingStatusObserved: input.workingObserved === true,
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
  const processState = { processSession: 0, lastForegroundAgent: null, hasAgentRunEvidence: false }
  const dispatch = (candidate: AgentCompletionHookCandidate | undefined): void => {
    if (!seeding && !disposed && input.isLive() && candidate) {
      input.dispatch(candidate)
    }
  }
  const options: AgentCompletionCoordinatorOptions = {
    paneKey: input.paneKey,
    getPtyId: () => null,
    inspectProcess: async () => ({ foregroundProcess: null, hasChildProcesses: false }),
    isLive: () => !disposed && input.isLive(),
    usesHookTurnEnds: (snapshot) => snapshot.turnEndDisposition === 'identified',
    dispatchCompletion: (_title, meta) => dispatch(meta?.hookCandidate),
    dispatchAttention: (_title, meta) => dispatch(meta.hookCandidate)
  }
  const notification = createAgentCompletionNotificationController({
    options,
    state,
    processState,
    identityScope
  })
  const observer = createAgentCompletionHookObserver({
    options,
    state,
    establishAgentEvidence: () => {
      processState.hasAgentRunEvidence = true
    },
    recordPaneActivity: () => {},
    ...notification,
    openStampedTail: identityScope.openStampedTail,
    rememberHandledTurnCompletedAt: identityScope.rememberTurnCompletedAt,
    turnCompletedAtAlreadyHandled: identityScope.turnCompletedAtAlreadyHandled,
    consumePendingStampedTailForAgent: identityScope.consumePendingStampedTailForAgent,
    consumeStampedTailForCurrentCoordinator: identityScope.consumeStampedTail,
    clearOriginStampedTail: identityScope.clearOriginStampedTail,
    clearProcessExitCompletion: identityScope.clearProcessExitCompletion,
    recordWorkingBoundary: identityScope.recordWorkingBoundary,
    dropPendingTitle: () => {}
  })
  return {
    observeHookStatus: (row: AgentStatusIpcPayload) => {
      observer.observeHookStatus(row, { snapshot: row, originalRow: row })
    },
    clearPendingHookDone: notification.clearPendingHookDone,
    rememberTurnCompletedAt: identityScope.rememberTurnCompletedAt,
    seedHookStatus: (row: AgentStatusIpcPayload) => {
      seeding = true
      observer.seedHookStatus(row, { snapshot: row, originalRow: row })
      notification.clearPendingHookDone()
      seeding = false
    },
    dispose: () => {
      disposed = true
      notification.clearPendingHookDone()
      identityScope.clearWorkingBoundary()
      identityScope.dispose(false)
    }
  }
}
