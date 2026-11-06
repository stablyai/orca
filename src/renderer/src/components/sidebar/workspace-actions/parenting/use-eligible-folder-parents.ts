import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getFolderWorkspaceWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getEligibleFolderParents, storeAcceptsFolderParentIn } from './worktree-parent-candidates'

const NO_FOLDER_PARENTS: Worktree[] = []

/** Folder workspaces Set Parent offers `child`; the menu gate and the picker read the same list. */
export function useEligibleFolderParents(child: Worktree | undefined, enabled = true): Worktree[] {
  const folderWorkspaces = useAppStore((s) => (enabled ? selectFolderWorkspaces(s) : undefined))
  const currentParentWorkspaceKey = useAppStore((s) =>
    enabled && child
      ? s.workspaceLineageByChildKey[worktreeWorkspaceKey(child.id)]?.parentWorkspaceKey
      : undefined
  )
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  return useMemo(
    () =>
      enabled && child && folderWorkspaces?.length
        ? getEligibleFolderParents({
            child,
            folderRows: folderWorkspaces.map((folder) => getFolderWorkspaceWorktree(folder)),
            currentParentWorkspaceKey,
            storeAcceptsFolderParent: storeAcceptsFolderParentIn(runtimeStatusByEnvironmentId)
          })
        : NO_FOLDER_PARENTS,
    [child, currentParentWorkspaceKey, enabled, folderWorkspaces, runtimeStatusByEnvironmentId]
  )
}
