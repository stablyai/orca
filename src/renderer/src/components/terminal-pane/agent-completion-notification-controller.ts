import type {
  AgentCompletionCoordinatorOptions,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'
import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type {
  AgentCompletionIdentityScope,
  LastCompletionIdentity
} from './agent-completion-identity-store'
import { isPiCompatibleAgentType } from '../../../../shared/pi-agent-kind'

type CompletionSource = 'hook' | 'title' | 'process-exit'

const COMPLETION_REPLAY_GUARD_MS = 1_000
const HOOK_DONE_QUIET_MS = 1_500
const CODEX_ATTENTION_QUIET_MS = 1_500

type CompletionState = {
  currentTurn: number
  workingStatusObserved: boolean
  requiresFreshWorking: boolean
  lastCompletionToken: string | null
  lastCompletionAt: number
  lastCompletedTurn: number | null
  lastCompletionSource: CompletionSource | null
  lastCompletionIdentity: LastCompletionIdentity | null
  lastAttentionToken: string | null
  pendingHookDoneTimer: ReturnType<typeof setTimeout> | null
  pendingHookDoneTitle: string | null
  pendingHookDonePayload: AgentCompletionStatusSnapshot | null
  pendingCodexAttentionTimer: ReturnType<typeof setTimeout> | null
}

type ProcessState = {
  processSession: number
  lastForegroundAgent: RecognizedAgentProcess | null
  hasAgentRunEvidence: boolean
}

type CompletionControllerOptions = {
  options: AgentCompletionCoordinatorOptions
  state: CompletionState
  processState: ProcessState
  identityScope: AgentCompletionIdentityScope
}

export function createAgentCompletionNotificationController({
  options,
  state,
  processState,
  identityScope
}: CompletionControllerOptions) {
  function isFiniteTurnCompletedAt(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value)
  }

  function completionToken(source: CompletionSource): string {
    if (state.workingStatusObserved) {
      return `turn:${state.currentTurn}`
    }
    if (processState.lastForegroundAgent) {
      return `process:${processState.processSession}`
    }
    return `${source}:${state.currentTurn}:${processState.processSession}`
  }

  function completionIdentityFor(
    state: string,
    agentType: string | undefined,
    timestamp: number
  ): string {
    return [state, agentType ?? '', String(Math.trunc(timestamp))].join(':')
  }

  function hookCompletionIdentity(payload: AgentCompletionStatusSnapshot): string | null {
    // Why: `stateStartedAt` is pinned while the reported state does not change. A Claude pane held at `working` by background inventory would otherwise give every turn in the run the same identity.
    const timestamp = isFiniteTurnCompletedAt(payload.turnCompletedAt)
      ? payload.turnCompletedAt
      : payload.stateStartedAt
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return null
    }
    return completionIdentityFor(payload.state, payload.agentType, timestamp)
  }

  function hookCompletionAgentIdentity(payload: AgentCompletionStatusSnapshot): string | null {
    return payload.agentType?.trim().toLowerCase() || null
  }

  function doneShouldUseQuietWindow(payload: AgentCompletionStatusSnapshot): boolean {
    // Why: Pi/OMP emit milestone 'done' while still working, so route it through the quiet window so later work can cancel it.
    return (
      state.workingStatusObserved || isPiCompatibleAgentType(hookCompletionAgentIdentity(payload))
    )
  }

  function hookAttentionToken(payload: AgentCompletionStatusSnapshot): string {
    const identity = hookCompletionIdentity(payload)
    if (identity) {
      return `identity:${identity}`
    }
    return [
      'turn',
      String(state.currentTurn),
      payload.state,
      payload.agentType ?? '',
      payload.toolName ?? '',
      payload.toolInput ?? '',
      payload.prompt
    ].join(':')
  }

  function completionIdentityAlreadyNotified(
    completionIdentity: LastCompletionIdentity | null | undefined
  ): boolean {
    if (!completionIdentity) {
      return false
    }
    if (
      completionIdentity.source === 'hook' &&
      identityScope.hasConsumedIdentity(completionIdentity.identity)
    ) {
      return true
    }
    const previous = identityScope.getLast()
    if (!previous) {
      return false
    }
    if (previous.source === completionIdentity.source) {
      return (
        previous.identity === completionIdentity.identity ||
        (completionIdentity.source === 'hook' &&
          identityScope.consumePendingStampedTailForAgent(
            completionIdentity.agentIdentity,
            completionIdentity.identity
          ))
      )
    }
    return (
      previous.agentIdentity !== null &&
      completionIdentity.agentIdentity !== null &&
      previous.agentIdentity === completionIdentity.agentIdentity
    )
  }

  function dispatchCompletion(
    source: CompletionSource,
    title: string,
    optionsOverride: {
      quietedHookDone?: boolean
      terminalIdleConfirmed?: boolean
      agentStatus?: AgentCompletionStatusSnapshot
      completionIdentity?: LastCompletionIdentity | null
      /** Announce only. The pane is still genuinely `working` (Claude background inventory), so the synthetic `done` must not run pane lifecycle. */
      notifyWithoutLifecycle?: boolean
    } = {}
  ): boolean {
    if (source !== 'hook' && state.pendingHookDoneTimer !== null) {
      return false
    }
    if (state.requiresFreshWorking || state.lastCompletedTurn === state.currentTurn) {
      return false
    }
    if (!options.isLive() || !processState.hasAgentRunEvidence) {
      return false
    }
    const now = Date.now()
    const token = completionToken(source)
    if (
      token === state.lastCompletionToken &&
      now - state.lastCompletionAt < COMPLETION_REPLAY_GUARD_MS
    ) {
      return false
    }
    if (completionIdentityAlreadyNotified(optionsOverride.completionIdentity)) {
      return false
    }
    state.lastCompletionToken = token
    state.lastCompletionAt = now
    state.lastCompletedTurn = state.currentTurn
    state.lastCompletionSource = source
    state.workingStatusObserved = false
    // Why: any committed completion ends the turn, so a debounced Codex attention from an earlier pause must not fire after it.
    clearPendingCodexAttention()
    if (optionsOverride.completionIdentity) {
      identityScope.setLast(optionsOverride.completionIdentity)
      if (optionsOverride.completionIdentity.lastTurnCompletedAtNotified !== undefined) {
        identityScope.rememberTurnCompletedAt(
          optionsOverride.completionIdentity.lastTurnCompletedAtNotified
        )
      } else {
        identityScope.clearStampedTail()
      }
    }
    if (
      source === 'hook' &&
      optionsOverride.agentStatus &&
      optionsOverride.notifyWithoutLifecycle !== true
    ) {
      options.dispatchHookLifecycle?.(optionsOverride.agentStatus)
    }
    if (optionsOverride.quietedHookDone === true || source === 'process-exit') {
      // Why: confirmed process death is independent completion evidence; keep its provenance so stale hook rows can't veto it later.
      options.dispatchCompletion(title, {
        source,
        quietedHookDone: optionsOverride.quietedHookDone === true,
        ...(optionsOverride.terminalIdleConfirmed === true ? { terminalIdleConfirmed: true } : {}),
        ...(optionsOverride.agentStatus ? { agentStatus: optionsOverride.agentStatus } : {})
      })
    } else if (optionsOverride.notifyWithoutLifecycle === true && optionsOverride.agentStatus) {
      // Why: the pane is still `working`; the synthetic done must carry its own snapshot or the notification would read the pinned working row.
      options.dispatchCompletion(title, {
        source,
        quietedHookDone: false,
        agentStatus: optionsOverride.agentStatus
      })
    } else {
      options.dispatchCompletion(title)
    }
    return true
  }

  function dispatchAttentionNotification(payload: AgentCompletionStatusSnapshot): void {
    options.dispatchAttention?.(payload.agentType ?? options.paneKey, {
      source: 'hook',
      agentStatus: payload
    })
  }

  function dispatchAttention(payload: AgentCompletionStatusSnapshot): void {
    if (!options.dispatchAttention || !options.isLive() || !processState.hasAgentRunEvidence) {
      return
    }
    const token = hookAttentionToken(payload)
    if (token === state.lastAttentionToken) {
      return
    }
    state.lastAttentionToken = token
    // Why: the visual "needs input" status updates immediately; only the OS attention notification is debounced (Codex, below).
    options.dispatchHookLifecycle?.(payload)
    if (payload.agentType === 'codex') {
      // Why: an auto-resolved Codex "Approve for me" cancels this pending notification via a later hook; scoped to Codex so other agents notify at once.
      clearPendingCodexAttention()
      state.pendingCodexAttentionTimer = setTimeout(() => {
        state.pendingCodexAttentionTimer = null
        if (!options.isLive() || !processState.hasAgentRunEvidence) {
          return
        }
        dispatchAttentionNotification(payload)
      }, CODEX_ATTENTION_QUIET_MS)
      return
    }
    dispatchAttentionNotification(payload)
  }

  function scheduleHookDoneCompletion(title: string, payload: AgentCompletionStatusSnapshot): void {
    state.pendingHookDoneTitle = title
    state.pendingHookDonePayload = payload
    if (state.pendingHookDoneTimer !== null) {
      return
    }
    // Why: goal/mission agents can report a temporary done between milestones; wait a short quiet window so resumed work can cancel it.
    state.pendingHookDoneTimer = setTimeout(() => {
      state.pendingHookDoneTimer = null
      const pendingTitle = state.pendingHookDoneTitle
      const pendingPayload = state.pendingHookDonePayload
      state.pendingHookDoneTitle = null
      state.pendingHookDonePayload = null
      if (pendingTitle) {
        const hookIdentity = pendingPayload ? hookCompletionIdentity(pendingPayload) : null
        dispatchCompletion('hook', pendingTitle, {
          quietedHookDone: true,
          ...(pendingPayload ? { agentStatus: pendingPayload } : {}),
          ...(hookIdentity
            ? {
                completionIdentity: {
                  source: 'hook',
                  identity: hookIdentity,
                  agentIdentity: pendingPayload ? hookCompletionAgentIdentity(pendingPayload) : null
                }
              }
            : {})
        })
      }
    }, HOOK_DONE_QUIET_MS)
  }

  function clearPendingHookDone(): void {
    if (state.pendingHookDoneTimer !== null) {
      clearTimeout(state.pendingHookDoneTimer)
      state.pendingHookDoneTimer = null
    }
    state.pendingHookDoneTitle = null
    state.pendingHookDonePayload = null
  }

  function clearPendingCodexAttention(): void {
    if (state.pendingCodexAttentionTimer !== null) {
      clearTimeout(state.pendingCodexAttentionTimer)
      state.pendingCodexAttentionTimer = null
    }
  }

  return {
    completionIdentityFor,
    hookCompletionIdentity,
    hookCompletionAgentIdentity,
    doneShouldUseQuietWindow,
    clearPendingHookDone,
    clearPendingCodexAttention,
    dispatchCompletion,
    dispatchAttention,
    scheduleHookDoneCompletion,
    hasPendingHookDone: () => state.pendingHookDoneTimer !== null,
    hasPendingCodexAttention: () => state.pendingCodexAttentionTimer !== null
  }
}
