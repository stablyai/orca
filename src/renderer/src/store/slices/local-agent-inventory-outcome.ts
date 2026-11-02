import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'

/** A context's list and latest attempt outcome; a list kept through a failed refresh is failed. */
export function readLocalAgentInventoryOutcome(
  state: AppState,
  worktreeId: string | null | undefined,
  failedContextKeys: ReadonlySet<string>,
  keptThroughFailure: WeakSet<TuiAgent[]>
): { ids: TuiAgent[] | null; state: 'pending' | 'successful' | 'failed' } {
  const key = localAgentInventoryContextKey(
    getLocalAgentPreflightContext(state, undefined, undefined, worktreeId)
  )
  const ids = state.localDetectedAgentIdsByContext[key] ?? null
  const inFlight =
    state.isDetectingLocalAgentsByContext[key] || state.isRefreshingLocalAgentsByContext[key]
  return {
    ids,
    state:
      ids === null || inFlight
        ? 'pending'
        : failedContextKeys.has(key) || keptThroughFailure.has(ids)
          ? 'failed'
          : 'successful'
  }
}
