import { useMemo } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Repo } from '../../../../shared/repo-types'
import { getWorkspaceDeleteLineage } from './workspace-delete-lineage'
import {
  countFolderWorkspaceDeletes,
  getDeleteWorktreeLineageDialogCopy
} from './delete-worktree-dialog-copy'

type UseDeleteWorktreeLineageStateParams = {
  worktree: Worktree | null
  allWorktrees: readonly Worktree[]
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  isBatchDelete: boolean
  repoMap: ReadonlyMap<string, Repo>
}

export function useDeleteWorktreeLineageState({
  worktree,
  allWorktrees,
  worktreeLineageById,
  isBatchDelete,
  repoMap
}: UseDeleteWorktreeLineageStateParams) {
  const lineageDelete = useMemo(
    () =>
      !isBatchDelete && worktree
        ? getWorkspaceDeleteLineage(worktree, allWorktrees, worktreeLineageById)
        : { descendants: [], deleteAllTargets: [] },
    [allWorktrees, isBatchDelete, worktree, worktreeLineageById]
  )
  // why: main worktree is the clone root — git worktree remove rejects it upfront
  const isMainWorktree = !isBatchDelete && (worktree?.isMainWorktree ?? false)
  const childWorkspaceCount = lineageDelete.descendants.length
  const hasLineageChildren = childWorkspaceCount > 0
  const canDeleteAllLineage =
    !isMainWorktree && !isBatchDelete && lineageDelete.deleteAllTargets.length > 1
  const lineageFolderWorkspaceDeleteCount = useMemo(
    () => countFolderWorkspaceDeletes(repoMap, lineageDelete.deleteAllTargets),
    [lineageDelete.deleteAllTargets, repoMap]
  )
  const lineageDeleteCopy = getDeleteWorktreeLineageDialogCopy({
    childWorkspaceCount,
    deleteTargetCount: lineageDelete.deleteAllTargets.length,
    folderWorkspaceDeleteCount: lineageFolderWorkspaceDeleteCount
  })

  return {
    lineageDelete,
    isMainWorktree,
    childWorkspaceCount,
    hasLineageChildren,
    canDeleteAllLineage,
    lineageDeleteCopy
  }
}
