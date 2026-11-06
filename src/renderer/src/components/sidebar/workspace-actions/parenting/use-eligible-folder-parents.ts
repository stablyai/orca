import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getFolderWorkspaceWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getEligibleFolderParents, storeAcceptsFolderParentIn } from './worktree-parent-candidates'

const NO_FOLDER_PARENTS: Worktree[] = []

/** The folder workspaces any child may take as a parent: Set Parent's menu gate, its picker and a
 * sidebar drop all read this one policy. Null while disabled. */
export function useFolderParentEligibility(
  enabled = true
): ((child: Worktree) => Worktree[]) | null {
  const folderWorkspaces = useAppStore((s) => (enabled ? selectFolderWorkspaces(s) : undefined))
  const workspaceLineageByChildKey = useAppStore((s) =>
    enabled ? s.workspaceLineageByChildKey : undefined
  )
  const runtimeStatusByEnvironmentId = useAppStore((s) =>
    enabled ? s.runtimeStatusByEnvironmentId : undefined
  )
  const folderRows = useMemo(
    () => folderWorkspaces?.map((folder) => getFolderWorkspaceWorktree(folder)) ?? [],
    [folderWorkspaces]
  )
  const eligibleFor = useCallback(
    (child: Worktree): Worktree[] =>
      folderRows.length > 0 && runtimeStatusByEnvironmentId
        ? getEligibleFolderParents({
            child,
            folderRows,
            currentParentWorkspaceKey:
              workspaceLineageByChildKey?.[worktreeWorkspaceKey(child.id)]?.parentWorkspaceKey,
            storeAcceptsFolderParent: storeAcceptsFolderParentIn(runtimeStatusByEnvironmentId)
          })
        : NO_FOLDER_PARENTS,
    [folderRows, runtimeStatusByEnvironmentId, workspaceLineageByChildKey]
  )
  return enabled ? eligibleFor : null
}

/** Folder workspaces Set Parent offers `child`; the menu gate and the picker read the same list. */
export function useEligibleFolderParents(child: Worktree | undefined, enabled = true): Worktree[] {
  const eligibleFor = useFolderParentEligibility(enabled)
  return useMemo(
    () => (eligibleFor && child ? eligibleFor(child) : NO_FOLDER_PARENTS),
    [child, eligibleFor]
  )
}
