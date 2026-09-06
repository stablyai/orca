import type { ActiveDashboardWorkspace } from './dashboard-snapshot-workspaces'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import {
  releaseRuntimeAgentOrchestrationBatchCache,
  selectRuntimeAgentOrchestrationBatch
} from '../sidebar/worktree-agent-orchestration-batch'
import { selectRuntimeAgentOrchestrationForWorktree } from '../sidebar/worktree-agent-row-selectors'

/** Select the singleton or batched orchestration view for active workspaces. */
export function selectDashboardOrchestration(
  state: DashboardSnapshotState,
  activeWorkspaces: readonly Pick<ActiveDashboardWorkspace, 'worktree'>[]
): {
  singletonOrchestration: ReturnType<typeof selectRuntimeAgentOrchestrationForWorktree> | null
  orchestrationByWorktree: ReturnType<typeof selectRuntimeAgentOrchestrationBatch> | null
} {
  let singletonOrchestration: ReturnType<typeof selectRuntimeAgentOrchestrationForWorktree> | null =
    null
  let orchestrationByWorktree: ReturnType<typeof selectRuntimeAgentOrchestrationBatch> | null = null

  if (activeWorkspaces.length >= 2) {
    orchestrationByWorktree = selectRuntimeAgentOrchestrationBatch(
      state,
      activeWorkspaces.map(({ worktree }) => worktree.id)
    )
  } else {
    releaseRuntimeAgentOrchestrationBatchCache()
    if (activeWorkspaces.length === 1) {
      singletonOrchestration = selectRuntimeAgentOrchestrationForWorktree(
        state,
        activeWorkspaces[0].worktree.id
      )
    }
  }

  return {
    singletonOrchestration,
    orchestrationByWorktree
  }
}
