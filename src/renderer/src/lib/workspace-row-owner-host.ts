import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getFolderWorkspaceHostId } from '../../../shared/folder-workspace-execution-host'
import type { AppState } from '../store/types'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

/**
 * The host that owns a workspace's own row; null while that row is unknown. Unlike
 * `getKnownExecutionHostIdForWorktree`, never falls back to the focused runtime, so local work is
 * never read as a WSL host's and cannot boot its distro.
 */
export function workspaceOwnerHostId(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos'>,
  workspaceId: string
): ExecutionHostId | null {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const workspace = selectFolderWorkspaces(state).find(({ id }) => id === scope.folderWorkspaceId)
    return workspace ? getFolderWorkspaceHostId(workspace, state.projectGroups) : null
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repo = state.repos.find(({ id }) => id === getRepoIdFromWorktreeId(worktreeId))
  return repo ? getRepoExecutionHostId(repo) : null
}
