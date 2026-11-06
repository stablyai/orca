import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getFolderWorkspaceWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getEligibleFolderParents, storeAcceptsFolderParentIn } from './worktree-parent-candidates'

const NO_FOLDER_PARENTS: Worktree[] = []

function eligibleFolderParents(
  child: Worktree,
  folderWorkspaces: readonly FolderWorkspace[] | undefined,
  currentParentWorkspaceKey: string | undefined,
  runtimeStatusByEnvironmentId: AppState['runtimeStatusByEnvironmentId']
): Worktree[] {
  return folderWorkspaces?.length
    ? getEligibleFolderParents({
        child,
        folderRows: folderWorkspaces.map((folder) => getFolderWorkspaceWorktree(folder)),
        currentParentWorkspaceKey,
        storeAcceptsFolderParent: storeAcceptsFolderParentIn(runtimeStatusByEnvironmentId)
      })
    : NO_FOLDER_PARENTS
}

/** Folder workspaces `child` may take as a parent, read once from the store: a sidebar drop asks
 * this at drop time instead of re-rendering on every lineage or runtime status change. */
export function getEligibleFolderParentsInState(state: AppState, child: Worktree): Worktree[] {
  return eligibleFolderParents(
    child,
    selectFolderWorkspaces(state),
    state.workspaceLineageByChildKey[worktreeWorkspaceKey(child.id)]?.parentWorkspaceKey,
    state.runtimeStatusByEnvironmentId
  )
}

/** Folder workspaces Set Parent offers `child`; the menu gate, the picker and a sidebar drop read
 * the same policy. */
export function useEligibleFolderParents(child: Worktree | undefined, enabled = true): Worktree[] {
  const folderWorkspaces = useAppStore((s) => (enabled ? selectFolderWorkspaces(s) : undefined))
  const currentParentWorkspaceKey = useAppStore((s) =>
    enabled && child
      ? s.workspaceLineageByChildKey[worktreeWorkspaceKey(child.id)]?.parentWorkspaceKey
      : undefined
  )
  const runtimeStatusByEnvironmentId = useAppStore((s) =>
    enabled ? s.runtimeStatusByEnvironmentId : undefined
  )
  return useMemo(
    () =>
      enabled && child && runtimeStatusByEnvironmentId
        ? eligibleFolderParents(
            child,
            folderWorkspaces,
            currentParentWorkspaceKey,
            runtimeStatusByEnvironmentId
          )
        : NO_FOLDER_PARENTS,
    [child, currentParentWorkspaceKey, enabled, folderWorkspaces, runtimeStatusByEnvironmentId]
  )
}
