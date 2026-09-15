import type { HostSectionRow } from '../../host-section-rows'
import type { WorktreeSidebarDragSession } from '../../worktree-sidebar-drag-autoscroll'
import {
  getWorktreeLineageRuntimeOwner,
  sharesWorktreeLineageBoundary
} from '../../../../../../shared/resolved-worktree-lineage'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import { useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { getEligibleWorktreeParents } from '../../worktree-parent-candidates'
import { getIndexedAllWorktrees, getIndexedWorktreesById } from '@/store/worktree-repo-index'
import { getCyclicProjectedWorktreeLineageIds } from '../../worktree-lineage-projection'
import { getReorderedWorktreeIdsToUnnest } from '../../worktree-lineage-drag-drop'
import { unnestWorktrees } from '../../worktree-unnest'
import type { WorktreeDragGroup } from '../../worktree-manual-order'
import type { WorktreeSidebarLineageDropTarget } from './row-state'

export type WorktreeLineageDropCommit = ReturnType<typeof useWorktreeLineageDropCommit>

// Nesting and un-nesting are the two lineage mutations a sidebar drag can commit.
export function useWorktreeLineageDropCommit(args: {
  rows: readonly HostSectionRow[]
  dragSessionRef: React.RefObject<WorktreeSidebarDragSession | null>
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreeDragGroups: readonly WorktreeDragGroup[]
}) {
  const { repoMap, worktreeMap, worktreeLineageById, worktreeDragGroups, rows, dragSessionRef } =
    args
  const lastTarget = useRef<WorktreeSidebarLineageDropTarget | null>(null)
  const getSourceWorktree = useCallback(() => {
    const source = rows.find(
      (row) => row.type === 'item' && row.rowKey === dragSessionRef.current?.sourceRowKey
    )
    return source?.type === 'item' ? source.worktree : undefined
  }, [rows, dragSessionRef])
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
      lastTarget.current = target
      const sourceWorktree = getSourceWorktree()
      const owner = sourceWorktree
        ? { runtimeOwnerEnvironmentId: getWorktreeLineageRuntimeOwner(sourceWorktree) }
        : undefined
      const parentRow = rows.find(
        (row) => row.type === 'item' && row.rowKey === target.lineageParentRowKey
      )
      const canAssignAll = draggedIds.every((draggedId) => {
        const state = useAppStore.getState()
        const children = getIndexedWorktreesById(state.worktreesByRepo, draggedId, owner).filter(
          (child) => !sourceWorktree || sharesWorktreeLineageBoundary(child, sourceWorktree)
        )
        const child = children.length === 1 ? children[0] : undefined
        if (
          !child ||
          (parentRow?.type === 'item' && !sharesWorktreeLineageBoundary(child, parentRow.worktree))
        ) {
          return false
        }
        return getEligibleWorktreeParents({
          child,
          worktrees: getIndexedAllWorktrees(state.worktreesByRepo, owner),
          lineageById: state.worktreeLineageById,
          worktreeMap,
          repoMap,
          repos: state.repos
        }).some((candidate) => candidate.id === parentId)
      })
      return canAssignAll ? target : { ...target, lineageParentId: null }
    },
    [repoMap, worktreeMap, rows, getSourceWorktree]
  )

  const commitWorktreeLineageParentDrop = useCallback(
    (draggedIds: readonly string[], parentId: string): boolean => {
      const target = getEligibleLineageDropTarget(
        lastTarget.current?.lineageParentId === parentId
          ? lastTarget.current
          : { status: null, isPinDrop: false, lineageParentId: parentId },
        draggedIds
      )
      if (!target.lineageParentId) {
        return false
      }
      void Promise.all(
        draggedIds.map((id) => {
          const sourceWorktree = getSourceWorktree()
          const runtimeOwner = sourceWorktree && getWorktreeLineageRuntimeOwner(sourceWorktree)
          const executionHostId = runtimeOwner
            ? toRuntimeExecutionHostId(runtimeOwner)
            : sourceWorktree?.hostId
          return assignWorktreeParent(id, {
            parentWorktreeId: parentId,
            ...(executionHostId ? { executionHostId } : {})
          })
        })
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
    [assignWorktreeParent, getEligibleLineageDropTarget, getSourceWorktree]
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
