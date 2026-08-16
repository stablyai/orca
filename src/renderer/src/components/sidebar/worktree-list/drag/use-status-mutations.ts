import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from '../../workspace-status'
import {
  buildManualOrderUpdatesForGroupDrop,
  buildManualOrderUpdatesForVisibleGroups,
  shouldWriteManualOrderForGroupDrop,
  type WorktreeDragGroup
} from '../../worktree-manual-order'
import { buildWorkspaceKanbanSidebarDropUpdates } from '../../workspace-kanban-sidebar-drop'
import type { SortBy } from '../../smart-sort'
import type { WorktreeStatusDropAtIndexArgs } from './drop-commit-context'

function buildRankByWorktreeId(
  groups: readonly WorktreeDragGroup[],
  worktreeMap: Map<string, Worktree>
): Map<string, number> {
  const rankByWorktreeId = new Map<string, number>()
  for (const group of groups) {
    for (const worktreeId of group.worktreeIds) {
      const worktree = worktreeMap.get(worktreeId)
      if (worktree) {
        rankByWorktreeId.set(worktreeId, worktree.manualOrder ?? worktree.sortOrder)
      }
    }
  }
  return rankByWorktreeId
}

// Every write a sidebar drop can make: status changes, pin, manual order, and the board lane drop.
export function useWorktreeStatusMutations(args: {
  worktreeMap: Map<string, Worktree>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  sortBy: SortBy
}) {
  const { worktreeMap, workspaceStatuses, sortBy } = args
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const updateWorktreesMeta = useAppStore((s) => s.updateWorktreesMeta)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const setWorktreesPinnedAndReveal = useAppStore((s) => s.setWorktreesPinnedAndReveal)

  const moveWorktreeToStatus = useCallback(
    (worktreeId: string, status: WorkspaceStatus) => {
      const current = worktreeMap.get(worktreeId)
      if (!current || getWorkspaceStatus(current, workspaceStatuses) === status) {
        return
      }
      void updateWorktreeMeta(worktreeId, { workspaceStatus: status })
    },
    [updateWorktreeMeta, worktreeMap, workspaceStatuses]
  )

  const moveWorktreesToStatus = useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus) => {
      const updates = new Map<string, { workspaceStatus: WorkspaceStatus }>()
      for (const worktreeId of worktreeIds) {
        const current = worktreeMap.get(worktreeId)
        if (!current || getWorkspaceStatus(current, workspaceStatuses) === status) {
          continue
        }
        updates.set(worktreeId, { workspaceStatus: status })
      }
      if (updates.size > 0) {
        void updateWorktreesMeta(updates)
      }
    },
    [updateWorktreesMeta, worktreeMap, workspaceStatuses]
  )

  const moveWorktreesToStatusAtIndex = useCallback(
    (dropArgs: WorktreeStatusDropAtIndexArgs) => {
      const order = buildManualOrderUpdatesForGroupDrop({
        groups: dropArgs.groups,
        targetGroupKey: getWorkspaceStatusGroupKey(dropArgs.status),
        draggedIds: dropArgs.worktreeIds,
        dropIndex: dropArgs.dropIndex,
        now: Date.now(),
        rankByWorktreeId: buildRankByWorktreeId(dropArgs.groups, worktreeMap)
      })
      const updates = new Map<string, Partial<WorktreeMeta>>()
      for (const worktreeId of dropArgs.worktreeIds) {
        const current = worktreeMap.get(worktreeId)
        if (!current) {
          continue
        }
        const next: Partial<WorktreeMeta> = {}
        if (getWorkspaceStatus(current, workspaceStatuses) !== dropArgs.status) {
          next.workspaceStatus = dropArgs.status
        }
        updates.set(worktreeId, next)
      }
      for (const [worktreeId, manualOrder] of order.updates) {
        updates.set(worktreeId, { ...updates.get(worktreeId), ...manualOrder })
      }
      for (const [worktreeId, update] of Array.from(updates)) {
        if (Object.keys(update).length === 0) {
          updates.delete(worktreeId)
        }
      }
      if (updates.size === 0) {
        return
      }
      // Why: the insertion line promises exact placement, so persist manual order on a cross-status drop.
      if (order.changed) {
        setSortBy('manual')
      }
      void updateWorktreesMeta(updates)
    },
    [setSortBy, updateWorktreesMeta, worktreeMap, workspaceStatuses]
  )

  const pinWorktree = useCallback(
    (worktreeId: string) => {
      setWorktreesPinnedAndReveal([worktreeId], true)
    },
    [setWorktreesPinnedAndReveal]
  )

  const pinWorktrees = useCallback(
    (worktreeIds: readonly string[]) => {
      setWorktreesPinnedAndReveal(worktreeIds, true)
    },
    [setWorktreesPinnedAndReveal]
  )

  const reorderWorktrees = useCallback(
    (reorderArgs: {
      groups: readonly WorktreeDragGroup[]
      sourceGroupKey: string
      draggedIds: readonly string[]
      dropIndex: number
    }) => {
      const result = buildManualOrderUpdatesForVisibleGroups({
        ...reorderArgs,
        now: Date.now(),
        rankByWorktreeId: buildRankByWorktreeId(reorderArgs.groups, worktreeMap)
      })
      if (!result.changed) {
        return
      }
      // Why: only switch to Manual after a real move so accidental click-drags don't change the sort.
      setSortBy('manual')
      void updateWorktreesMeta(result.updates)
    },
    [setSortBy, updateWorktreesMeta, worktreeMap]
  )

  const shouldShowWorkspaceBoardDropIndicator = useCallback(
    (worktreeIds: readonly string[], status: WorkspaceStatus) => {
      const sourceGroupKeys = worktreeIds.flatMap((worktreeId) => {
        const worktree = worktreeMap.get(worktreeId)
        return worktree ? [getWorkspaceStatus(worktree, workspaceStatuses)] : []
      })
      return shouldWriteManualOrderForGroupDrop({
        sortBy,
        sourceGroupKeys,
        targetGroupKey: status
      })
    },
    [sortBy, worktreeMap, workspaceStatuses]
  )

  const dropWorktreesOnWorkspaceBoard = useCallback(
    (dropArgs: WorktreeStatusDropAtIndexArgs) => {
      const result = buildWorkspaceKanbanSidebarDropUpdates({
        ...dropArgs,
        worktreeById: worktreeMap,
        workspaceStatuses,
        sortBy,
        now: Date.now()
      })
      if (result.updates.size === 0) {
        return
      }
      // Why: switch to Manual when the drop changes order so the placement stays visible.
      if (result.shouldSwitchToManual) {
        setSortBy('manual')
      }
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
      void updateWorktreesMeta(result.updates)
    },
    [setSortBy, sortBy, updateWorktreesMeta, worktreeMap, workspaceStatuses]
  )

  return {
    moveWorktreeToStatus,
    moveWorktreesToStatus,
    moveWorktreesToStatusAtIndex,
    pinWorktree,
    pinWorktrees,
    reorderWorktrees,
    shouldShowWorkspaceBoardDropIndicator,
    dropWorktreesOnWorkspaceBoard
  }
}
