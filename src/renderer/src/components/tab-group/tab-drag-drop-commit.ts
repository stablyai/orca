import type { RefObject } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { useAppStore } from '../../store'
import { mirrorWebRuntimeTabMove } from '../tab-bar/web-runtime-tab-move-mirror'
import { resolveTabInsertion } from './tab-insertion'
import { resolveSourceGroupRestoreOnDrop } from './tab-drag-preview-target'
import { getDragPointer } from './tab-drag-pointer'
import {
  resolveActivePaneColumnSplitTarget,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'
import { isPaneDropData, isTabDragData, type TabDragItemData } from './tab-drag-data'

type AppState = ReturnType<typeof useAppStore.getState>

/** Turns a finished tab drag into store mutations: pane-column split,
 *  same-group reorder, cross-group move, or pane-body drop — each mirrored to
 *  the web runtime — then hands the snapshot-restore decision to finishDrag. */
export function commitTabDragDrop({
  event,
  worktreeId,
  dragGeometryRef,
  dropUnifiedTab,
  reorderUnifiedTabs,
  finishDrag
}: {
  event: DragEndEvent
  worktreeId: string
  dragGeometryRef: RefObject<TabGroupPanelGeometrySnapshot | null>
  dropUnifiedTab: AppState['dropUnifiedTab']
  reorderUnifiedTabs: AppState['reorderUnifiedTabs']
  finishDrag: (restoreSnapshot: boolean, activeData?: TabDragItemData) => void
}): void {
  const activeData = event.active.data.current
  const overData = event.over?.data.current
  let shouldRestorePreDragActivation = true

  if (!isTabDragData(activeData) || activeData.worktreeId !== worktreeId) {
    finishDrag(true)
    return
  }

  const state = useAppStore.getState()
  const paneColumnSplit = resolveActivePaneColumnSplitTarget({
    event,
    groupsByWorktree: state.groupsByWorktree,
    layoutByWorktree: state.layoutByWorktree,
    worktreeId,
    getDragPointer,
    geometry: dragGeometryRef.current
  })
  if (paneColumnSplit) {
    const moved = dropUnifiedTab(activeData.unifiedTabId, {
      groupId: paneColumnSplit.groupId,
      splitDirection: paneColumnSplit.zone
    })
    if (moved) {
      shouldRestorePreDragActivation = false
      mirrorWebRuntimeTabMove({
        kind: 'split',
        worktreeId,
        tabId: activeData.unifiedTabId,
        targetGroupId: paneColumnSplit.groupId,
        splitDirection: paneColumnSplit.zone
      })
    }
    finishDrag(
      shouldRestorePreDragActivation,
      resolveSourceGroupRestoreOnDrop(
        activeData,
        paneColumnSplit.groupId,
        shouldRestorePreDragActivation
      )
    )
    return
  }

  if (!event.over) {
    finishDrag(true)
    return
  }

  if (isTabDragData(overData)) {
    if (activeData.unifiedTabId === overData.unifiedTabId) {
      finishDrag(true)
      return
    }

    const groups = state.groupsByWorktree[worktreeId] ?? []
    const targetGroup = groups.find((group) => group.id === overData.groupId)
    if (!targetGroup) {
      finishDrag(true)
      return
    }

    // Why: dnd-kit's `over` is the hovered tab, but the drop's true
    // insertion point depends on which side of that tab the cursor sits.
    // Using the bar's computed side (re-derived here to avoid stale
    // closures) means the drop always lands where the blue bar was drawn.
    const insertion = resolveTabInsertion(event, isTabDragData, getDragPointer)
    if (!insertion) {
      finishDrag(true)
      return
    }

    const overIndex = targetGroup.tabOrder.indexOf(overData.unifiedTabId)
    const rawInsertIndex = overIndex + (insertion.side === 'right' ? 1 : 0)

    if (activeData.groupId === overData.groupId) {
      const oldIndex = targetGroup.tabOrder.indexOf(activeData.unifiedTabId)
      // Why: splicing out the dragged tab before inserting would shift the
      // intended target slot left by one when moving forward. Adjust the
      // insertion index to match the post-removal order.
      const nextIndex = oldIndex < rawInsertIndex ? rawInsertIndex - 1 : rawInsertIndex
      if (oldIndex !== -1 && oldIndex !== nextIndex) {
        const nextOrder = targetGroup.tabOrder.filter((id) => id !== activeData.unifiedTabId)
        nextOrder.splice(nextIndex, 0, activeData.unifiedTabId)
        reorderUnifiedTabs(overData.groupId, nextOrder)
        mirrorWebRuntimeTabMove({
          kind: 'reorder',
          worktreeId,
          tabId: activeData.unifiedTabId,
          targetGroupId: overData.groupId,
          tabOrder: nextOrder
        })
      }
    } else {
      const index = overIndex === -1 ? targetGroup.tabOrder.length : rawInsertIndex
      const moved = dropUnifiedTab(activeData.unifiedTabId, {
        groupId: overData.groupId,
        index
      })
      if (moved) {
        shouldRestorePreDragActivation = false
        mirrorWebRuntimeTabMove({
          kind: 'move-to-group',
          worktreeId,
          tabId: activeData.unifiedTabId,
          targetGroupId: overData.groupId,
          index
        })
      }
    }

    finishDrag(
      shouldRestorePreDragActivation,
      resolveSourceGroupRestoreOnDrop(activeData, overData.groupId, shouldRestorePreDragActivation)
    )
    return
  }

  if (isPaneDropData(overData)) {
    if (activeData.groupId !== overData.groupId) {
      const moved = dropUnifiedTab(activeData.unifiedTabId, {
        groupId: overData.groupId
      })
      if (moved) {
        shouldRestorePreDragActivation = false
        mirrorWebRuntimeTabMove({
          kind: 'move-to-group',
          worktreeId,
          tabId: activeData.unifiedTabId,
          targetGroupId: overData.groupId
        })
      }
    }
  }

  finishDrag(
    shouldRestorePreDragActivation,
    isPaneDropData(overData)
      ? resolveSourceGroupRestoreOnDrop(
          activeData,
          overData.groupId,
          shouldRestorePreDragActivation
        )
      : undefined
  )
}
