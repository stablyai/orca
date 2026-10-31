import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'

/** A context's list and latest attempt outcome; a list kept through a failed refresh is failed. */
export function readLocalAgentInventoryOutcome(
  state: AppState,
  worktreeId: string | null | undefined,
  keptThroughFailure: WeakSet<TuiAgent[]>
): { ids: TuiAgent[] | null; state: 'pending' | 'successful' | 'failed' } {
  const key = localAgentInventoryContextKey(
    getLocalAgentPreflightContext(state, undefined, undefined, worktreeId)
  )
  return readLocalAgentInventoryOutcomeByKey(state, key, keptThroughFailure)
}

export function readLocalAgentInventoryOutcomeByKey(
  state: AppState,
  key: string,
  keptThroughFailure: WeakSet<TuiAgent[]>
): { ids: TuiAgent[] | null; state: 'pending' | 'successful' | 'failed' } {
  const ids = state.localDetectedAgentIdsByContext[key] ?? null
  const inFlight =
    state.isDetectingLocalAgentsByContext[key] || state.isRefreshingLocalAgentsByContext[key]
  return {
    ids,
    state: inFlight
      ? 'pending'
      : state.localAgentInventoryFailedByContext[key] ||
          (ids !== null && keptThroughFailure.has(ids))
        ? 'failed'
        : ids === null
          ? 'pending'
          : 'successful'
  }
}
