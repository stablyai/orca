import type { AppState } from '@/store/types'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { getActivityThreadWorkspaceTitle } from './workspace/activity/activity-thread-display'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'

/** The name a worker's workspace goes by in the sidebar; null when this window does not know it. */
export function selectOrchestrationWorkerWorkspaceLabel(
  state: AppState,
  worktreeId: string
): string | null {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return (
      selectFolderWorkspaces(state).find((folder) => folder.id === scope.folderWorkspaceId)?.name ??
      null
    )
  }
  const worktree = findWorktreeById(state, worktreeId)
  return worktree ? getActivityThreadWorkspaceTitle(worktree) : null
}
