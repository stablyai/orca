import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../../../shared/worktree/types'
import { getWorkspaceStatus, getWorkspaceStatusGroupKey } from '../../workspace-status'
import {
  buildManualOrderUpdatesForGroupDrop,
  buildManualOrderUpdatesForVisibleGroups,
  shouldWriteManualOrderForGroupDrop
} from '../../worktree-manual-order'
import { buildWorkspaceKanbanSidebarDropUpdates } from '../../workspace-kanban-sidebar-drop'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import { switchSortToManualAfterDrop } from '../../manual-sort-switch-toast'
import type { WorktreeReorderArgs, WorktreeStatusDropAtIndexArgs } from './drop-commit-context'
import type { WorktreeManualOrderCatalog } from '../../worktree-manual-order-catalog'
import {
  collectDropWrites,
  dropWriteRows,
  type DraggedWorktreeCopies
} from './dragged-worktree-copies'

// Every write a sidebar drop can make: status changes, pin, manual order, and the board lane drop.
// Each id is written through `dropWriteRows`, never an id-keyed map: a twin on another host shares it.
export function useWorktreeStatusMutations(args: {
  manualOrderCatalog: WorktreeManualOrderCatalog
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  sortBy: SortBy
}) {
  const { manualOrderCatalog, workspaceStatuses, sortBy } = args
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const updateWorktreesMeta = useAppStore((s) => s.updateWorktreesMeta)
  const setWorktreesPinnedAndReveal = useAppStore((s) => s.setWorktreesPinnedAndReveal)

  const moveWorktreesToStatus = useCallback(
    (
      worktreeIds: readonly string[],
      status: WorkspaceStatus,
      draggedCopies?: DraggedWorktreeCopies
    ) => {
      const updates = collectDropWrites({
        rowsFor: dropWriteRows(useAppStore.getState(), draggedCopies),
        statusIds: worktreeIds,
        status,
        workspaceStatuses,
        orderUpdates: new Map()
      })
      if (updates.length > 0) {
        void updateWorktreesMeta(updates)
      }
    },
    [updateWorktreesMeta, workspaceStatuses]
  )

  const moveWorktreeToStatus = useCallback(
    (worktreeId: string, status: WorkspaceStatus) => {
      for (const row of dropWriteRows(useAppStore.getState(), undefined).status(worktreeId)) {
        if (getWorkspaceStatus(row, workspaceStatuses) !== status) {
          void updateWorktreeMeta(
            worktreeId,
            { workspaceStatus: status },
            { executionHostId: row.hostId ?? 'local' }
          )
        }
      }
    },
    [updateWorktreeMeta, workspaceStatuses]
  )

  const moveWorktreesToStatusAtIndex = useCallback(
    (dropArgs: WorktreeStatusDropAtIndexArgs) => {
      const order = buildManualOrderUpdatesForGroupDrop({
        groups: dropArgs.groups,
        targetGroupKey: getWorkspaceStatusGroupKey(dropArgs.status),
        draggedIds: dropArgs.worktreeIds,
        dropIndex: dropArgs.dropIndex,
        now: Date.now(),
        rankByWorktreeId: manualOrderCatalog.rankByWorktreeId,
        allWorktreeIds: manualOrderCatalog.orderedIds
      })
      const dragged = new Set(dropArgs.worktreeIds)
      const updates = collectDropWrites({
        rowsFor: dropWriteRows(useAppStore.getState(), dropArgs.draggedCopies),
        statusIds: dropArgs.worktreeIds,
        status: dropArgs.status,
        workspaceStatuses,
        orderUpdates: new Map([...order.updates].filter(([worktreeId]) => dragged.has(worktreeId)))
      })
      if (updates.length === 0) {
        return
      }
      // Why: the insertion line promises exact placement, so persist manual order on a cross-status drop.
      if (order.changed) {
        switchSortToManualAfterDrop()
      }
      void updateWorktreesMeta(updates)
    },
    [manualOrderCatalog, updateWorktreesMeta, workspaceStatuses]
  )

  const pinWorktrees = useCallback(
    (worktreeIds: readonly string[], draggedCopies?: DraggedWorktreeCopies) => {
      const rowsFor = dropWriteRows(useAppStore.getState(), draggedCopies)
      setWorktreesPinnedAndReveal(worktreeIds.flatMap(rowsFor.status), true)
    },
    [setWorktreesPinnedAndReveal]
  )

  const pinWorktree = useCallback(
    (worktreeId: string) => pinWorktrees([worktreeId]),
    [pinWorktrees]
  )

  const reorderWorktrees = useCallback(
    (reorderArgs: WorktreeReorderArgs) => {
      const result = buildManualOrderUpdatesForVisibleGroups({
        ...reorderArgs,
        now: Date.now(),
        rankByWorktreeId: manualOrderCatalog.rankByWorktreeId,
        allWorktreeIds: manualOrderCatalog.orderedIds
      })
      const updates = collectDropWrites({
        rowsFor: dropWriteRows(useAppStore.getState(), reorderArgs.draggedCopies),
        statusIds: [],
        status: null,
        workspaceStatuses,
        orderUpdates: result.updates
      })
      if (updates.length === 0) {
        return
      }
      if (result.changed) {
        switchSortToManualAfterDrop()
      }
      void updateWorktreesMeta(updates)
    },
    [manualOrderCatalog, updateWorktreesMeta, workspaceStatuses]
  )

  const shouldShowWorkspaceBoardDropIndicator = useCallback(
    (
      worktreeIds: readonly string[],
      status: WorkspaceStatus,
      draggedCopies?: DraggedWorktreeCopies
    ) => {
      const rowsFor = dropWriteRows(useAppStore.getState(), draggedCopies)
      return shouldWriteManualOrderForGroupDrop({
        sortBy,
        sourceGroupKeys: worktreeIds.flatMap((worktreeId) =>
          rowsFor.status(worktreeId).map((row) => getWorkspaceStatus(row, workspaceStatuses))
        ),
        targetGroupKey: status
      })
    },
    [sortBy, workspaceStatuses]
  )

  const dropWorktreesOnWorkspaceBoard = useCallback(
    (dropArgs: WorktreeStatusDropAtIndexArgs) => {
      const result = buildWorkspaceKanbanSidebarDropUpdates({
        ...dropArgs,
        rowsFor: dropWriteRows(useAppStore.getState(), dropArgs.draggedCopies),
        workspaceStatuses,
        sortBy,
        now: Date.now(),
        allWorktreeIds: manualOrderCatalog.orderedIds,
        rankByWorktreeId: manualOrderCatalog.rankByWorktreeId
      })
      if (result.updates.length === 0) {
        return
      }
      // Why: switch to Manual when the drop changes order so the placement stays visible.
      if (result.shouldSwitchToManual) {
        switchSortToManualAfterDrop()
      }
      useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
      void updateWorktreesMeta(result.updates)
    },
    [manualOrderCatalog, sortBy, updateWorktreesMeta, workspaceStatuses]
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
