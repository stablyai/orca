import type { AppState } from '@/store/types'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import {
  EMPTY_WORKTREE_AGENT_ORCHESTRATION_INDEX,
  selectWorktreeAgentOrchestrationIndex
} from './worktree-agent-orchestration-index'

export { EMPTY_WORKTREE_AGENT_ORCHESTRATION } from './worktree-agent-orchestration-index'

type RuntimeOrchestrationState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'tabsByWorktree'
>

/**
 * No-op: the batch has no cache of its own. Kept because the dashboard's singleton and
 * zero-worktree branches still announce that they are done with the batch view, and the shared
 * index behind it must survive that — mounted sidebar cards are reading the same records.
 */
export function releaseRuntimeAgentOrchestrationBatchCache(): void {}

/**
 * The dashboard's multi-worktree orchestration view.
 *
 * Why this is the shared index verbatim: the batch used to build its own worktree-keyed records
 * from the same four slices, restricted to the requested ids. Callers only ever `.get(id)`, so
 * the extra keys are unobservable, and one builder means one cache to keep honest and one
 * correctness oracle to satisfy. `worktreeIds` survives only as the empty-dashboard
 * short-circuit, which keeps the runtime map unread when nothing is on screen.
 */
export function selectRuntimeAgentOrchestrationBatch(
  state: RuntimeOrchestrationState,
  worktreeIds: readonly string[]
): ReadonlyMap<string, Record<string, AgentStatusOrchestrationContext>> {
  if (worktreeIds.length === 0) {
    return EMPTY_WORKTREE_AGENT_ORCHESTRATION_INDEX
  }
  return selectWorktreeAgentOrchestrationIndex(state)
}
