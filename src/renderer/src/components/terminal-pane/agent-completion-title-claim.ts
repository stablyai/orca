import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'
import type {
  AgentCompletionIdentityScope,
  LastCompletionIdentity
} from './agent-completion-identity-store'
import type { CompletionState } from './agent-completion-notification-controller'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './agent-task-complete-policy'

type TitleClaimDeps = {
  options: AgentCompletionCoordinatorOptions
  state: CompletionState
  processState: { lastForegroundAgent: RecognizedAgentProcess | null }
  identityScope: AgentCompletionIdentityScope
  titleAgentIdentity: (title: string) => string | null
  dispatchTitle: (title: string) => void
}

/**
 * The title lane's claim on a pane's turn ends. Where the hook lane owns an identified end, a
 * title working edge keeps the hook's receipt (a /btw or quit spin ends no hook turn) and the idle
 * edge is not claimed; it settles after main's max wait unless the host meanwhile calls the end
 * ambiguous (a turn whose opening hook was lost), which main's title completion then announces.
 */
export function createTitleCompletionClaim(deps: TitleClaimDeps) {
  const { options, state, identityScope } = deps
  let keptHookReceipt: LastCompletionIdentity | undefined
  let ownedIdleTimer: ReturnType<typeof setTimeout> | null = null

  function evidence(title: string | null): 'identified' | 'ambiguous' | null {
    const foreground = deps.processState.lastForegroundAgent?.agent ?? null
    return options.titleTurnEndEvidence?.(title, foreground) ?? null
  }

  function cancelOwnedIdle(): void {
    if (ownedIdleTimer !== null) {
      clearTimeout(ownedIdleTimer)
      ownedIdleTimer = null
    }
  }

  function settleOwnedIdle(title: string): void {
    cancelOwnedIdle()
    const turn = state.currentTurn
    ownedIdleTimer = setTimeout(() => {
      ownedIdleTimer = null
      if (state.currentTurn !== turn) {
        return
      }
      if (evidence(title) === 'ambiguous') {
        deps.dispatchTitle(title)
        return
      }
      state.lastCompletedTurn = turn
      state.workingStatusObserved = false
    }, AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
  }

  return {
    /** A working edge's turn: true when the hook's receipt is kept instead of deleted. */
    keepsHookReceipt(title: string | null): boolean {
      keptHookReceipt = evidence(title) === 'identified' ? identityScope.getLast() : undefined
      return keptHookReceipt !== undefined
    },
    claim(title: string): boolean {
      // Why: the hook lane announces this turn end; a claim would swallow its Done.
      if (evidence(title) === 'identified') {
        options.onHookOwnedTitleIdle?.()
        settleOwnedIdle(title)
        return false
      }
      // Why: once this turn's end is ambiguous, the receipt its working edge kept is obsolete.
      if (keptHookReceipt && identityScope.getLast() === keptHookReceipt) {
        identityScope.deleteLast()
      }
      keptHookReceipt = undefined
      state.lastCompletionIdentity = {
        source: 'title',
        identity: title,
        agentIdentity: deps.titleAgentIdentity(title)
      }
      return true
    },
    cancelOwnedIdle
  }
}
