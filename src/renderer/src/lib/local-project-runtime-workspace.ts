import type { AppState } from '@/store/types'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  findLocalFolderWorkspaceRuntimeRepo,
  resolveQualifiedFolderWorkspaceResult
} from '../../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type RuntimeWorkspaceState = Pick<AppState, 'activeWorktreeId' | 'repos' | 'worktreesByRepo'> &
  Partial<Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'activeWorkspaceExecutionHostId'>>

const EMPTY_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}

export function getProjectRuntimeFolder(
  state: RuntimeWorkspaceState,
  worktreeId: string,
  hostId?: ExecutionHostId
) {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type !== 'folder') {
    return null
  }
  const result = resolveQualifiedFolderWorkspaceResult(
    state,
    scope.folderWorkspaceId,
    hostId ??
      (worktreeId === state.activeWorktreeId
        ? (state.activeWorkspaceExecutionHostId ?? undefined)
        : undefined)
  )
  return result.kind === 'selected' ? result.value : null
}

export function getLocalProjectRuntimeWorkspace(
  state: RuntimeWorkspaceState,
  worktreeId?: string | null,
  selectedFolder?: FolderWorkspace
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
  const selected = selectedFolder ? null : getProjectRuntimeFolder(state, targetWorktreeId)
  const folder =
    selectedFolder ??
    (selected && {
      ...selected.workspace,
      executionHostId: selected.hostId,
      connectionId: selected.connectionId
    }) ??
    undefined
  const repo = findLocalFolderWorkspaceRuntimeRepo(folderState, scope.folderWorkspaceId, folder)
  return folder && repo
    ? {
        id: targetWorktreeId,
        repoId: repo.id,
        path: folder.folderPath,
        hostId: getRepoExecutionHostId(folder)
      }
    : null
}
