import { getLineageInputs } from '../../visible-worktree-indexes'
import {
  getWorktreeLineageSelection,
  findWorktreeLineageRow
} from '../../../../../../shared/sidebar-list/worktree-lineage-projection'
import type { DraggedWorktreeCopies } from './dragged-worktree-copies'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { isEligibleWorktreeParent } from '../../worktree-parent-candidates'
import { getReorderedWorktreeIdsToUnnest } from '../../worktree-lineage-drag-drop'
import { unnestWorktrees } from '../../worktree-unnest'
import type { WorktreeDragGroup } from '../../worktree-manual-order'
import type { WorktreeSidebarLineageDropTarget } from './row-state'

export type WorktreeLineageDropCommit = ReturnType<typeof useWorktreeLineageDropCommit>

// Nesting and un-nesting are the two lineage mutations a sidebar drag can commit.
export function useWorktreeLineageDropCommit(args: {
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreeDragGroups: readonly WorktreeDragGroup[]
}) {
  const { repoMap, worktreeDragGroups } = args
  const { worktreeMap, lineageById: worktreeLineageById } = useAppStore(getLineageInputs)
  const assignWorktreeParent = useAppStore((s) => s.assignWorktreeParent)
  const updateWorktreeLineage = useAppStore((s) => s.updateWorktreeLineage)
  const selectedKeys = (
    ids: readonly string[],
    copies?: DraggedWorktreeCopies
  ): readonly string[] => {
    const selected = new Set(ids)
    return copies
      ? copies.filter((copy) => selected.has(copy.id)).map(getWorktreeLineageSelection)
      : ids
  }

  const getEligibleLineageDropTarget = useCallback(
    (
      target: WorktreeSidebarLineageDropTarget,
      draggedIds: readonly string[],
      copies?: DraggedWorktreeCopies
    ): WorktreeSidebarLineageDropTarget => {
      const parentId = target.lineageParentId
      if (!parentId) {
        return target
      }
      const canAssignAll = selectedKeys(draggedIds, copies).every((draggedId) => {
        const child = findWorktreeLineageRow(worktreeMap, draggedId)
        if (!child) {
          return false
        }
        const candidateParent = findWorktreeLineageRow(worktreeMap, parentId)
        return Boolean(
          candidateParent &&
          isEligibleWorktreeParent({
            child,
            candidateParent,
            lineageById: worktreeLineageById,
            worktreeMap,
            repoMap
          })
        )
      })
      return canAssignAll ? target : { ...target, lineageParentId: null }
    },
    [repoMap, worktreeLineageById, worktreeMap]
  )

  const commitWorktreeLineageParentDrop = useCallback(
    (draggedIds: readonly string[], parentId: string, copies?: DraggedWorktreeCopies): boolean => {
      const target = getEligibleLineageDropTarget(
        { status: null, isPinDrop: false, lineageParentId: parentId },
        draggedIds,
        copies
      )
      if (!target.lineageParentId) {
        return false
      }
      void Promise.all(
        selectedKeys(draggedIds, copies).map((id) =>
          assignWorktreeParent(id, { parentWorktreeId: parentId })
        )
      ).catch((err) => {
        console.error('Failed to nest workspace:', err)
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.failedNestWorkspace',
            'Failed to nest workspace'
          )
        )
      })
      return true
    },
    [assignWorktreeParent, getEligibleLineageDropTarget]
  )

  const clearReorderedWorktreeParents = useCallback(
    (unnestArgs: {
      draggedIds: readonly string[]
      sourceGroupKey: string
      draggedCopies?: DraggedWorktreeCopies
    }) => {
      const sourceGroup = worktreeDragGroups.find(
        (group) => group.key === unnestArgs.sourceGroupKey
      )
      if (!sourceGroup) {
        return
      }
      const ids = getReorderedWorktreeIdsToUnnest({
        draggedIds: selectedKeys(unnestArgs.draggedIds, unnestArgs.draggedCopies),
        sourceGroupIds: sourceGroup.worktreeIds,
        lineageById: worktreeLineageById,
        worktreeMap
      })
      if (ids.length === 0) {
        return
      }
      // Why: dropping a nested card on a reorder line is the un-nest escape hatch; clear only the dragged children.
      void unnestWorktrees(ids, updateWorktreeLineage)
    },
    [updateWorktreeLineage, worktreeDragGroups, worktreeLineageById, worktreeMap]
  )

  return {
    getEligibleLineageDropTarget,
    commitWorktreeLineageParentDrop,
    clearReorderedWorktreeParents
  }
}
