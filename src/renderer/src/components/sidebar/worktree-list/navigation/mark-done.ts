import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  getWorkspaceStatus,
  isWorkspaceStatusId
} from '../../../../../../shared/workspace-statuses'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'

const IN_PROGRESS_STATUS_ID = DEFAULT_WORKSPACE_STATUS_ID
const DONE_STATUS_ID = 'completed'

function isInProgress(
  worktree: Pick<Worktree, 'workspaceStatus'> | undefined,
  statuses: readonly WorkspaceStatusDefinition[]
): boolean {
  return (
    worktree !== undefined &&
    isWorkspaceStatusId(IN_PROGRESS_STATUS_ID, statuses) &&
    getWorkspaceStatus(worktree, statuses) === IN_PROGRESS_STATUS_ID
  )
}

/** Requests moving the active workspace from In progress to Done; true means the write was requested, not persisted. */
export function markActiveWorkspaceDone(
  state: Pick<AppState, 'getKnownWorktreeById' | 'updateWorktreeMeta' | 'workspaceStatuses'>,
  activeWorktreeId: string | null,
  activeWorkspaceExecutionHostId: ExecutionHostId | null
): boolean {
  const statuses = state.workspaceStatuses
  // Why: statuses are user-editable; a board without Done has nothing to move to.
  if (!activeWorktreeId || !isWorkspaceStatusId(DONE_STATUS_ID, statuses)) {
    return false
  }
  const worktree = state.getKnownWorktreeById(
    activeWorktreeId,
    activeWorkspaceExecutionHostId ?? undefined
  )
  if (!worktree || !isInProgress(worktree, statuses)) {
    return false
  }
  void state
    .updateWorktreeMeta(
      worktree.id,
      { workspaceStatus: DONE_STATUS_ID },
      {
        executionHostId: worktree.hostId ?? 'local',
        shouldApply: (current) => isInProgress(current, statuses)
      }
    )
    .then((result) => {
      // Why: a failed save (e.g. SSH host unreachable) reverts the optimistic status.
      if (!result.ok) {
        toast.error(result.error)
      }
    })
  return true
}
