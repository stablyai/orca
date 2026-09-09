import type { AgentCompletionIdentityScope } from './agent-completion-identity-store'

type LifecycleState = {
  workingStatusObserved: boolean
  lastCompletionToken: string | null
  lastCompletionAt: number
  lastCompletedTurn: number | null
  lastCompletionSource: 'hook' | 'title' | 'process-exit' | null
  lastCompletionIdentity: unknown
  lastAttentionToken: string | null
  requiresFreshWorking: boolean
  pendingHookDoneTimer: ReturnType<typeof setTimeout> | null
}

type LifecycleOptions = {
  state: LifecycleState
  processState: { disposed: boolean; lastForegroundAgent: unknown; hasAgentRunEvidence: boolean }
  identityScope: AgentCompletionIdentityScope
  clearPendingHookDone: () => void
  clearPendingCodexAttention: () => void
  dropPendingTitle: () => void
  clearWorkingBoundary: () => void
  incrementGeneration: () => void
  clearPollTimer: () => void
  isLive: () => boolean
  clearEvidence: () => void
  clearTitleStatus: () => void
}

export function createAgentCompletionLifecycle({
  state,
  processState,
  identityScope,
  clearPendingHookDone,
  clearPendingCodexAttention,
  dropPendingTitle,
  clearWorkingBoundary,
  incrementGeneration,
  clearPollTimer,
  isLive,
  clearEvidence,
  clearTitleStatus
}: LifecycleOptions) {
  function resetCompletionState(options: { requireFreshWorking?: boolean } = {}): void {
    clearPendingHookDone()
    clearPendingCodexAttention()
    dropPendingTitle()
    clearEvidence()
    clearTitleStatus()
    state.workingStatusObserved = false
    state.lastCompletionToken = null
    state.lastCompletionAt = 0
    state.lastCompletedTurn = null
    state.lastCompletionSource = null
    state.lastCompletionIdentity = null
    state.lastAttentionToken = null
    processState.lastForegroundAgent = null
    processState.hasAgentRunEvidence = false
    state.requiresFreshWorking = options.requireFreshWorking ?? false
    incrementGeneration()
    clearWorkingBoundary()
  }

  function dispose(): void {
    if (processState.disposed) {
      return
    }
    processState.disposed = true
    clearPollTimer()
    clearPendingHookDone()
    clearPendingCodexAttention()
    dropPendingTitle()
    clearWorkingBoundary()
    identityScope.dispose(isLive())
  }

  return {
    resetCompletionState,
    dispose,
    startProcessTracking: (start: () => void) => start(),
    hasPendingHookDoneCompletion: () => state.pendingHookDoneTimer !== null
  }
}
