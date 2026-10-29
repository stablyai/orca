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

/** No-op for existing dashboard callers: mounted sidebar cards still need the shared index. */
export function releaseRuntimeAgentOrchestrationBatchCache(): void {}

/** Share the full index; callers only look up requested IDs, and an empty request avoids reading runtime data. */
export function selectRuntimeAgentOrchestrationBatch(
  state: RuntimeOrchestrationState,
  worktreeIds: readonly string[]
): ReadonlyMap<string, Record<string, AgentStatusOrchestrationContext>> {
  if (worktreeIds.length === 0) {
    return EMPTY_WORKTREE_AGENT_ORCHESTRATION_INDEX
  }
  return selectWorktreeAgentOrchestrationIndex(state)
}
