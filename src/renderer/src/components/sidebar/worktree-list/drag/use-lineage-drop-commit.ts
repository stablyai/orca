import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { isEligibleWorktreeParent } from '../../worktree-parent-candidates'
import { getCyclicProjectedWorktreeLineageIds } from '../../worktree-lineage-projection'
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
  const { repoMap, worktreeMap, worktreeLineageById, worktreeDragGroups } = args
  const assignWorktreeParent = useAppStore((s) => s.assignWorktreeParent)
  const updateWorktreeLineage = useAppStore((s) => s.updateWorktreeLineage)
  const cyclicLineageIds = useMemo(
    () => getCyclicProjectedWorktreeLineageIds(worktreeLineageById, worktreeMap),
    [worktreeLineageById, worktreeMap]
  )

  const getEligibleLineageDropTarget = useCallback(
    (
      target: WorktreeSidebarLineageDropTarget,
      draggedIds: readonly string[]
    ): WorktreeSidebarLineageDropTarget => {
      const parentId = target.lineageParentId
      if (!parentId) {
        return target
      }
      const canAssignAll = draggedIds.every((draggedId) => {
        const child = worktreeMap.get(draggedId)
        if (!child) {
          return false
        }
        const candidateParent = worktreeMap.get(parentId)
        return Boolean(
          candidateParent &&
          isEligibleWorktreeParent({
            child,
            candidateParent,
            lineageById: worktreeLineageById,
            worktreeMap,
            repoMap,
            cyclicLineageIds
          })
        )
      })
      return canAssignAll ? target : { ...target, lineageParentId: null }
    },
    [cyclicLineageIds, repoMap, worktreeLineageById, worktreeMap]
  )

  const commitWorktreeLineageParentDrop = useCallback(
    (draggedIds: readonly string[], parentId: string): boolean => {
      const target = getEligibleLineageDropTarget(
        { status: null, isPinDrop: false, lineageParentId: parentId },
        draggedIds
      )
      if (!target.lineageParentId) {
        return false
      }
      void Promise.all(
        draggedIds.map((id) => assignWorktreeParent(id, { parentWorktreeId: parentId }))
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
    (unnestArgs: { draggedIds: readonly string[]; sourceGroupKey: string }) => {
      const sourceGroup = worktreeDragGroups.find(
        (group) => group.key === unnestArgs.sourceGroupKey
      )
      if (!sourceGroup) {
        return
      }
      const ids = getReorderedWorktreeIdsToUnnest({
        draggedIds: unnestArgs.draggedIds,
        sourceGroupIds: sourceGroup.worktreeIds,
        lineageById: worktreeLineageById,
        worktreeMap,
        cyclicLineageIds
      })
      if (ids.length === 0) {
        return
      }
      // Why: dropping a nested card on a reorder line is the un-nest escape hatch; clear only the dragged children.
      void unnestWorktrees(ids, updateWorktreeLineage)
    },
    [cyclicLineageIds, updateWorktreeLineage, worktreeDragGroups, worktreeLineageById, worktreeMap]
  )

  return {
    getEligibleLineageDropTarget,
    commitWorktreeLineageParentDrop,
    clearReorderedWorktreeParents
  }
}
