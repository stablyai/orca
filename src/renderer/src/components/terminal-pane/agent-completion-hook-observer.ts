import { isRecognizedAgentType } from '../../../../shared/agent-process-recognition'
import type {
  AgentCompletionCoordinatorOptions,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'
import type { LastCompletionIdentity } from './agent-completion-identity-store'

type HookObserverState = {
  workingStatusObserved: boolean
  requiresFreshWorking: boolean
  currentTurn: number
  lastCompletionIdentity: LastCompletionIdentity | null
  lastAttentionToken: string | null
  lastCompletionSource: 'hook' | 'title' | 'process-exit' | null
  lastCompletedTurn: number | null
  lastCompletionAt: number
  pendingHookDoneTimer: ReturnType<typeof setTimeout> | null
}

type HookObserverOptions = {
  options: AgentCompletionCoordinatorOptions
  state: HookObserverState
  establishAgentEvidence: () => void
  recordPaneActivity: () => void
  clearPendingHookDone: () => void
  clearPendingCodexAttention: () => void
  dispatchAttention: (payload: AgentCompletionStatusSnapshot) => void
  dispatchCompletion: (source: 'hook', title: string, override?: Record<string, unknown>) => boolean
  scheduleHookDoneCompletion: (title: string, payload: AgentCompletionStatusSnapshot) => void
  doneShouldUseQuietWindow: (payload: AgentCompletionStatusSnapshot) => boolean
  hookCompletionIdentity: (payload: AgentCompletionStatusSnapshot) => string | null
  hookCompletionAgentIdentity: (payload: AgentCompletionStatusSnapshot) => string | null
  completionIdentityFor: (state: string, agentType: string | undefined, timestamp: number) => string
  openStampedTail: (timestamp: number) => boolean
  rememberHandledTurnCompletedAt: (timestamp: number) => void
  turnCompletedAtAlreadyHandled: (timestamp: number) => boolean
  consumePendingStampedTailForAgent: (agent: string | null, identity: string | null) => boolean
  consumeStampedTailForCurrentCoordinator: (timestamp: number) => void
  clearOriginStampedTail: () => void
  recordWorkingBoundary: (timestamp: number | undefined) => void
  dropPendingTitle: () => void
}

function isFiniteTurnCompletedAt(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAttentionHookState(state: AgentCompletionStatusSnapshot['state']): boolean {
  return state === 'waiting' || state === 'blocked'
}

export function createAgentCompletionHookObserver({
  options,
  state,
  establishAgentEvidence,
  recordPaneActivity,
  clearPendingHookDone,
  clearPendingCodexAttention,
  dispatchAttention,
  dispatchCompletion,
  scheduleHookDoneCompletion,
  doneShouldUseQuietWindow,
  hookCompletionIdentity,
  hookCompletionAgentIdentity,
  completionIdentityFor,
  openStampedTail,
  rememberHandledTurnCompletedAt,
  turnCompletedAtAlreadyHandled,
  consumePendingStampedTailForAgent,
  consumeStampedTailForCurrentCoordinator,
  clearOriginStampedTail,
  recordWorkingBoundary,
  dropPendingTitle
}: HookObserverOptions) {
  function observeHookStatus(payload: AgentCompletionStatusSnapshot): void {
    recordPaneActivity()
    if (options.shouldSuppressHookCompletion?.(payload)) {
      if (isAttentionHookState(payload.state)) {
        clearPendingHookDone()
        clearPendingCodexAttention()
      }
      return
    }
    if (isRecognizedAgentType(payload.agentType)) {
      establishAgentEvidence()
    }
    if (payload.state === 'working') {
      const turnCompletedAt = isFiniteTurnCompletedAt(payload.turnCompletedAt)
        ? payload.turnCompletedAt
        : undefined
      if (turnCompletedAt !== undefined) {
        const alreadyHandled = openStampedTail(turnCompletedAt)
        if (
          state.workingStatusObserved &&
          !alreadyHandled &&
          state.lastCompletionIdentity?.lastTurnCompletedAtNotified !== turnCompletedAt
        ) {
          const completionSnapshot = {
            ...payload,
            state: 'done' as const,
            stateStartedAt: turnCompletedAt,
            turnCompletedAt
          }
          const identity: LastCompletionIdentity = {
            source: 'hook',
            identity: completionIdentityFor('done', payload.agentType, turnCompletedAt),
            agentIdentity: hookCompletionAgentIdentity(payload),
            lastTurnCompletedAtNotified: turnCompletedAt
          }
          if (
            dispatchCompletion('hook', payload.agentType ?? options.paneKey, {
              notifyWithoutLifecycle: true,
              agentStatus: completionSnapshot,
              completionIdentity: identity
            })
          ) {
            state.lastCompletionIdentity = identity
          }
        } else if (!state.workingStatusObserved) {
          rememberHandledTurnCompletedAt(turnCompletedAt)
        }
        options.dispatchHookLifecycle?.(payload)
        return
      }
      clearOriginStampedTail()
      recordWorkingBoundary(payload.stateStartedAt)
      clearPendingHookDone()
      clearPendingCodexAttention()
      state.workingStatusObserved = true
      state.requiresFreshWorking = false
      state.lastCompletionIdentity = null
      state.lastAttentionToken = null
      state.currentTurn += 1
      dropPendingTitle()
      options.dispatchHookLifecycle?.(payload)
      return
    }
    if (isAttentionHookState(payload.state)) {
      clearPendingHookDone()
      dispatchAttention(payload)
      return
    }
    if (payload.state === 'done' && payload.sessionBoundary === true) {
      return
    }
    if (payload.state !== 'done') {
      return
    }
    clearPendingCodexAttention()
    const identity = hookCompletionIdentity(payload)
    const turnCompletedAt = isFiniteTurnCompletedAt(payload.turnCompletedAt)
      ? payload.turnCompletedAt
      : undefined
    if (
      turnCompletedAt === undefined &&
      consumePendingStampedTailForAgent(hookCompletionAgentIdentity(payload), identity)
    ) {
      state.lastCompletionIdentity = identity
        ? { source: 'hook', identity, agentIdentity: hookCompletionAgentIdentity(payload) }
        : null
      options.dispatchHookLifecycle?.(payload)
      return
    }
    if (
      turnCompletedAt !== undefined &&
      (turnCompletedAtAlreadyHandled(turnCompletedAt) ||
        state.lastCompletionIdentity?.lastTurnCompletedAtNotified === turnCompletedAt ||
        state.lastCompletedTurn === state.currentTurn)
    ) {
      consumeStampedTailForCurrentCoordinator(turnCompletedAt)
      options.dispatchHookLifecycle?.(payload)
      return
    }
    if (
      identity &&
      state.lastCompletionIdentity?.source === 'hook' &&
      identity === state.lastCompletionIdentity.identity
    ) {
      if (state.pendingHookDoneTimer !== null) {
        scheduleHookDoneCompletion(payload.agentType ?? options.paneKey, payload)
      }
      return
    }
    if (
      !state.workingStatusObserved &&
      state.lastCompletionSource === 'hook' &&
      state.lastCompletedTurn === state.currentTurn &&
      Date.now() - state.lastCompletionAt >= 1_000
    ) {
      state.currentTurn += 1
    }
    state.lastCompletionIdentity = identity
      ? { source: 'hook', identity, agentIdentity: hookCompletionAgentIdentity(payload) }
      : null
    if (doneShouldUseQuietWindow(payload)) {
      scheduleHookDoneCompletion(payload.agentType ?? options.paneKey, payload)
      return
    }
    dispatchCompletion('hook', payload.agentType ?? options.paneKey, {
      agentStatus: payload,
      ...(state.lastCompletionIdentity ? { completionIdentity: state.lastCompletionIdentity } : {})
    })
  }

  return {
    observeHookStatus,
    seedHookStatus: (payload: AgentCompletionStatusSnapshot) => {
      const { turnCompletedAt, ...unstampedPayload } = payload
      if (isFiniteTurnCompletedAt(turnCompletedAt)) {
        rememberHandledTurnCompletedAt(turnCompletedAt)
      }
      observeHookStatus(unstampedPayload)
    }
  }
}
