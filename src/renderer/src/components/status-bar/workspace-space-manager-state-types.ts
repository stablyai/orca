import type { WorktreeForceDeleteReason } from '../../../../shared/worktree/removal'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type WorkspaceSpaceDeleteState = {
  isDeleting: boolean
  executionHostId?: ExecutionHostId | null
  error: string | null
  canForceDelete: boolean
  forceDeleteReason: WorktreeForceDeleteReason | null
}

export type WorkspaceGitRefreshState = {
  isRefreshing: boolean
  error: string | null
}
