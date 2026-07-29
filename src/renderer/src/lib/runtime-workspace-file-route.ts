import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { findRuntimeWorkspaceFileOwner } from '../../../shared/runtime-workspace-file-owner'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { getExplicitRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

export type RuntimeWorkspaceFileRoute = {
  worktreeId: string
  relativePath: string
}

export function findRuntimeWorkspaceFileRoute(
  state: AppState,
  runtimeEnvironmentId: string,
  absolutePath: string
): RuntimeWorkspaceFileRoute | null {
  const ownerId = runtimeEnvironmentId.trim()
  if (!ownerId) {
    return null
  }
  const executionHostId = toRuntimeExecutionHostId(ownerId)
  const roots = getIndexedAllWorktrees(state.worktreesByRepo).flatMap((worktree) =>
    getExplicitRuntimeEnvironmentIdForWorktree(state, worktree.id) === ownerId
      ? [{ workspaceId: worktree.id, rootPath: worktree.path, executionHostId }]
      : []
  )
  for (const workspace of state.folderWorkspaces) {
    const workspaceId = folderWorkspaceKey(workspace.id)
    if (getExplicitRuntimeEnvironmentIdForWorktree(state, workspaceId) === ownerId) {
      roots.push({ workspaceId, rootPath: workspace.folderPath, executionHostId })
    }
  }

  const owner = findRuntimeWorkspaceFileOwner(roots, absolutePath, executionHostId)
  return owner ? { worktreeId: owner.workspaceId, relativePath: owner.relativePath } : null
}
