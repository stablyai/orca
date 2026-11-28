import { getFolderWorkspaceWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { readInlineFolderLineage } from '../../../../../../shared/worktree/lineage/folder-lineage-parents'
import { getIndexedAllWorktrees } from '../listing/worktree-catalog-index'
import type { AppState } from '../../../types'

export type CrossStoreLineageInputs = Pick<
  AppState,
  | 'worktreesByRepo'
  | 'worktreeLineageById'
  | 'crossStoreLineageByStoreKey'
  | 'ownLineageInstallationId'
  | 'removedRuntimeEnvironmentIds'
> &
  Partial<Pick<AppState, 'workspaceLineageByChildKey' | 'folderWorkspaces'>>

export function hasAnyOwnKey(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false
  }
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      return true
    }
  }
  return false
}

export function hasCrossStoreRecords(state: CrossStoreLineageInputs): boolean {
  // Partial store snapshots (tests, early boot) may lack the slice.
  const byStore = state.crossStoreLineageByStoreKey
  if (!byStore) {
    return false
  }
  for (const storeKey in byStore) {
    if (Object.hasOwn(byStore, storeKey) && hasAnyOwnKey(byStore[storeKey])) {
      return true
    }
  }
  return false
}

export function hasFolderParentRecords(
  state: CrossStoreLineageInputs,
  worktreesByRepo: AppState['worktreesByRepo'],
  folderWorkspaces: AppState['folderWorkspaces'] | undefined
): boolean {
  if ((folderWorkspaces?.length ?? 0) === 0) {
    return false
  }
  const byChild = state.workspaceLineageByChildKey
  if (byChild) {
    for (const key in byChild) {
      if (Object.hasOwn(byChild, key) && byChild[key].parentWorkspaceKey.startsWith('folder:')) {
        return true
      }
    }
  }
  // A paired server reports each row's own folder parent, which the merged records can miss.
  const allWorktrees = getIndexedAllWorktrees(worktreesByRepo)
  for (let i = 0; i < allWorktrees.length; i += 1) {
    if (readInlineFolderLineage(allWorktrees[i])) {
      return true
    }
  }
  return false
}

export function hasInlineParent(worktreesByRepo: AppState['worktreesByRepo']): boolean {
  const allWorktrees = getIndexedAllWorktrees(worktreesByRepo)
  for (let i = 0; i < allWorktrees.length; i += 1) {
    const row = allWorktrees[i]
    if ('lineage' in row && Boolean(row.lineage)) {
      return true
    }
  }
  return false
}

export function buildRowsByHostIdentity(
  worktreesByRepo: AppState['worktreesByRepo'],
  folderWorkspaces: AppState['folderWorkspaces'] | undefined
): Map<string, Worktree> {
  const rows = new Map<string, Worktree>()
  const allWorktrees = getIndexedAllWorktrees(worktreesByRepo)
  for (let i = 0; i < allWorktrees.length; i += 1) {
    const row = allWorktrees[i]
    rows.set(getWorktreeHostIdentity(row), row)
  }
  if (folderWorkspaces) {
    // Folder rows parent through their own records and through other stores' records.
    for (let i = 0; i < folderWorkspaces.length; i += 1) {
      const row = getFolderWorkspaceWorktree(folderWorkspaces[i])
      rows.set(getWorktreeHostIdentity(row), row)
    }
  }
  return rows
}
