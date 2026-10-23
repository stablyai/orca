import type { AppState } from '@/store/types'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { findLocalFolderWorkspaceRuntimeRepo } from '../../../shared/folder-workspace-execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type RuntimeWorkspaceState = Pick<AppState, 'activeWorktreeId' | 'repos' | 'worktreesByRepo'> &
  Partial<Pick<AppState, 'folderWorkspaces' | 'projectGroups'>>

const EMPTY_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}

export function getLocalProjectRuntimeWorkspace(
  state: RuntimeWorkspaceState,
  worktreeId?: string | null
): Pick<Worktree, 'id' | 'repoId' | 'projectId' | 'path' | 'hostId'> | null {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  if (!targetWorktreeId) {
    return null
  }
  const scope = parseWorkspaceKey(targetWorktreeId)
  if (scope?.type !== 'folder') {
    return (
      getIndexedWorktreeById(
        selectWorktreesByRepo(state) ?? EMPTY_WORKTREES_BY_REPO,
        targetWorktreeId
      ) ?? null
    )
  }
  const folderState = {
    folderWorkspaces: state.folderWorkspaces ?? [],
    projectGroups: state.projectGroups ?? [],
    repos: state.repos
  }
  const folder = folderState.folderWorkspaces.find((entry) => entry.id === scope.folderWorkspaceId)
  const repo = findLocalFolderWorkspaceRuntimeRepo(folderState, scope.folderWorkspaceId)
  return folder && repo
    ? {
        id: targetWorktreeId,
        repoId: repo.id,
        path: folder.folderPath,
        hostId: LOCAL_EXECUTION_HOST_ID
      }
    : null
}
