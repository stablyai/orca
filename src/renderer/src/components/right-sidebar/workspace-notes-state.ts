import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace
} from '../../lib/folder-workspace-runtime-owner'
import { getExecutionHostIdForWorktree } from '../../lib/worktree-runtime-owner'
import type { AppState } from '../../store/types'

export type WorkspaceNoteTarget = {
  scopeKey: string
  executionHostId: ExecutionHostId
  displayName: string
  branch: string | null
  comment: string
}

export function selectActiveWorkspaceNote(state: AppState): WorkspaceNoteTarget | null {
  const scope = state.activeWorkspaceKey ? parseWorkspaceKey(state.activeWorkspaceKey) : null
  if (scope?.type === 'folder') {
    const activeHostId = state.activeWorkspaceExecutionHostId
    const folderOwner = activeHostId
      ? findFolderWorkspaceOwner(state, scope.folderWorkspaceId, activeHostId)
      : null
    const folder = state.folderWorkspaces.find(
      (entry) => entry.id === scope.folderWorkspaceId && (!activeHostId || entry === folderOwner)
    )
    return folder
      ? {
          scopeKey: `folder:${folder.id}`,
          executionHostId:
            activeHostId ??
            getExecutionHostIdForFolderWorkspace(
              state,
              scope.folderWorkspaceId,
              activeHostId ?? undefined
            ),
          displayName: folder.name,
          branch: null,
          comment: folder.comment
        }
      : null
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : state.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const worktree = state.getKnownWorktreeById(
    worktreeId,
    state.activeWorkspaceExecutionHostId ?? undefined
  )
  return worktree
    ? {
        scopeKey: `worktree:${worktree.id}`,
        executionHostId:
          state.activeWorkspaceExecutionHostId ?? getExecutionHostIdForWorktree(state, worktreeId),
        displayName: worktree.displayName,
        branch: worktree.branch ?? null,
        comment: worktree.comment
      }
    : null
}
