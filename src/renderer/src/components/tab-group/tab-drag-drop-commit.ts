import type { RefObject } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'
import { resolveHostSessionTabIdForWebSessionTab } from '../../runtime/web-session-tabs-sync/tracking-mappings'
import { isWebTerminalSurfaceTabId } from '../../runtime/web-terminal-surface-id'
import { mirrorWebRuntimeTabMove } from '../tab-bar/web-runtime-tab-move-mirror'
import { resolveTabInsertion } from './tab-insertion'
import { resolveSourceGroupRestoreOnDrop } from './tab-drag-preview-target'
import { getDragPointer } from './tab-drag-pointer'
import {
  resolveActivePaneColumnSplitTarget,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'
import {
  isPaneDropData,
  isTabClusterDragData,
  isTabDragData,
  isTabStripDragData,
  type TabStripDragItemData
} from './tab-drag-data'
import { resolveTabClusterDropTarget } from './tab-cluster-drop-target'
import { getTabClusterSplitBlocker } from './tab-cluster-split-availability'

export function commitTabDragDrop({
  event,
  worktreeId,
  dragGeometryRef,
  dropUnifiedTab,
  moveTabsInStrip,
  moveTabCluster,
  finishDrag
}: {
  event: DragEndEvent
  worktreeId: string
  dragGeometryRef: RefObject<TabGroupPanelGeometrySnapshot | null>
  dropUnifiedTab: AppState['dropUnifiedTab']
  moveTabsInStrip: AppState['moveTabsInStrip']
  moveTabCluster: AppState['moveTabCluster']
  finishDrag: (restoreSnapshot: boolean, activeData?: TabStripDragItemData) => void
}): void {
  const activeData = event.active.data.current
  const overData = event.over?.data.current
  if (!isTabStripDragData(activeData) || activeData.worktreeId !== worktreeId) {
    finishDrag(true)
    return
  }

  const state = useAppStore.getState()
  const sourceGroup = state.groupsByWorktree[worktreeId]?.find(
    (group) => group.id === activeData.groupId
  )
  const movedTabIds = isTabClusterDragData(activeData)
    ? sourceGroup?.tabClusters?.find((cluster) => cluster.id === activeData.clusterId)?.tabIds
    : [activeData.unifiedTabId]
  if (!movedTabIds?.length) {
    finishDrag(true)
    return
  }

  const paneColumnSplit = resolveActivePaneColumnSplitTarget({
    event,
    groupsByWorktree: state.groupsByWorktree,
    layoutByWorktree: state.layoutByWorktree,
    worktreeId,
    getDragPointer,
    geometry: dragGeometryRef.current
  })
  if (paneColumnSplit) {
    if (isTabClusterDragData(activeData) && getTabClusterSplitBlocker(state, worktreeId)) {
      finishDrag(true)
      return
    }
    const target = {
      groupId: paneColumnSplit.groupId,
      splitDirection: paneColumnSplit.zone
    }
    const moved = isTabClusterDragData(activeData)
      ? moveTabCluster(activeData.groupId, activeData.clusterId, target)
      : dropUnifiedTab(activeData.unifiedTabId, target)
    if (moved && isTabDragData(activeData)) {
      mirrorWebRuntimeTabMove({
        kind: 'split',
        worktreeId,
        tabId: activeData.unifiedTabId,
        targetGroupId: paneColumnSplit.groupId,
        splitDirection: paneColumnSplit.zone
      })
    }
    finishDrag(!moved, resolveSourceGroupRestoreOnDrop(activeData, paneColumnSplit.groupId, !moved))
    return
  }

  if (isTabStripDragData(overData) && overData.worktreeId === worktreeId) {
    const targetGroup = state.groupsByWorktree[worktreeId]?.find(
      (group) => group.id === overData.groupId
    )
    const insertion = resolveTabInsertion(event, isTabDragData, getDragPointer)
    const target =
      targetGroup && insertion
        ? resolveTabClusterDropTarget({
            activeDrag: activeData,
            overData,
            targetGroup,
            side: insertion.side
          })
        : null
    if (!targetGroup || !target) {
      finishDrag(true)
      return
    }

    if (activeData.groupId === targetGroup.id) {
      moveTabsInStrip(targetGroup.id, movedTabIds, target)
      const nextOrder = useAppStore
        .getState()
        .groupsByWorktree[worktreeId]?.find((group) => group.id === targetGroup.id)?.tabOrder
      if (
        nextOrder &&
        (nextOrder.length !== targetGroup.tabOrder.length ||
          nextOrder.some((id, index) => id !== targetGroup.tabOrder[index]))
      ) {
        mirrorTabStripReorder(worktreeId, targetGroup.id, movedTabIds[0], nextOrder)
      }
      finishDrag(true)
      return
    }

    const moved = isTabClusterDragData(activeData)
      ? moveTabCluster(activeData.groupId, activeData.clusterId, {
          groupId: targetGroup.id,
          index: target.index
        })
      : dropUnifiedTab(activeData.unifiedTabId, {
          groupId: targetGroup.id,
          index: target.index,
          clusterId: target.clusterId
        })
    if (moved) {
      mirrorMovedTabs(worktreeId, targetGroup.id, movedTabIds)
    }
    finishDrag(!moved, resolveSourceGroupRestoreOnDrop(activeData, targetGroup.id, !moved))
    return
  }

  if (
    isPaneDropData(overData) &&
    overData.worktreeId === worktreeId &&
    activeData.groupId !== overData.groupId
  ) {
    const moved = isTabClusterDragData(activeData)
      ? moveTabCluster(activeData.groupId, activeData.clusterId, { groupId: overData.groupId })
      : dropUnifiedTab(activeData.unifiedTabId, { groupId: overData.groupId })
    if (moved) {
      mirrorMovedTabs(worktreeId, overData.groupId, movedTabIds)
    }
    finishDrag(!moved, resolveSourceGroupRestoreOnDrop(activeData, overData.groupId, !moved))
    return
  }
  finishDrag(true)
}

function mirrorMovedTabs(
  worktreeId: string,
  targetGroupId: string,
  tabIds: readonly string[]
): void {
  const targetOrder = useAppStore
    .getState()
    .groupsByWorktree[worktreeId]?.find((group) => group.id === targetGroupId)?.tabOrder
  for (const tabId of tabIds) {
    const index = targetOrder?.indexOf(tabId)
    mirrorWebRuntimeTabMove({
      kind: 'move-to-group',
      worktreeId,
      tabId,
      targetGroupId,
      ...(index !== undefined && index !== -1 ? { index } : {})
    })
  }
}

function mirrorTabStripReorder(
  worktreeId: string,
  targetGroupId: string,
  draggedTabId: string,
  tabOrder: string[]
): void {
  const state = useAppStore.getState()
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  const tabId = environmentId
    ? (tabOrder.find(
        (id) =>
          isWebTerminalSurfaceTabId(id) ||
          resolveHostSessionTabIdForWebSessionTab(state, { environmentId, worktreeId, tabId: id })
      ) ?? draggedTabId)
    : draggedTabId
  mirrorWebRuntimeTabMove({ kind: 'reorder', worktreeId, tabId, targetGroupId, tabOrder })
}
