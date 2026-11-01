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
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { dropTabThroughLayoutOwner } from './tab-group-layout-owner-commands'
import {
  isSameJoinTarget,
  resolveTabDragLeafTarget,
  type LeafRect,
  type TabDragLeafTarget
} from './tab-drag-leaf-target'
import { resolveTerminalTabIntoPaneEligibility } from '../terminal-pane/terminal-tab-into-pane-eligibility'
import type {
  TerminalTabIntoPaneArgs,
  TerminalTabIntoPaneOutcome
} from '../terminal-pane/terminal-tab-into-pane-types'

type AppState = ReturnType<typeof useAppStore.getState>

export type LeafJoinDeps = {
  moveTabIntoPane: (args: TerminalTabIntoPaneArgs) => Promise<TerminalTabIntoPaneOutcome>
  readLeafRects: (tabId: string) => LeafRect[]
  getShownLeafTarget: () => TabDragLeafTarget | null
}

/** A refused join changes nothing, so the hovered tab stays selected. */
function commitLeafEdgeDrop({
  leafJoin,
  leafTarget,
  activeData,
  finishDrag
}: {
  leafJoin: LeafJoinDeps
  leafTarget: TabDragLeafTarget
  activeData: TabDragItemData
  finishDrag: (restoreSnapshot: boolean) => void
}): void {
  // The join activates the target tab itself, so the previewed tab is kept rather than restored.
  finishDrag(false)
  if (leafTarget.refusal) {
    return
  }
  void leafJoin.moveTabIntoPane({
    sourceTabId: activeData.visibleTabId,
    targetTabId: leafTarget.targetTabId,
    targetLeafId: leafTarget.leafId,
    side: leafTarget.side
  })
}

/** Commit splits/reorders/moves through the layout owner or window path, then finish or restore the drag snapshot. */
export function commitTabDragDrop({
  event,
  worktreeId,
  dragGeometryRef,
  dropUnifiedTab,
  reorderUnifiedTabs,
  finishDrag,
  leafJoin
}: {
  event: DragEndEvent
  worktreeId: string
  dragGeometryRef: RefObject<TabGroupPanelGeometrySnapshot | null>
  dropUnifiedTab: AppState['dropUnifiedTab']
  reorderUnifiedTabs: AppState['reorderUnifiedTabs']
  finishDrag: (restoreSnapshot: boolean, activeData?: TabDragItemData) => void
  leafJoin: LeafJoinDeps
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
    // End the drag now; main’s answer draws the requested pane placement.
    if (
      ORCA_LAYOUT_OWNER_IS_MAIN &&
      dropTabThroughLayoutOwner(worktreeId, {
        kind: 'split',
        tabId: activeData.unifiedTabId,
        groupId: paneColumnSplit.groupId,
        direction: paneColumnSplit.zone
      })
    ) {
      finishDrag(true)
      return
    }
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

  const leafTarget = resolveTabDragLeafTarget({
    activeDrag: activeData,
    pointer: getDragPointer(event),
    worktreeId,
    state,
    geometry: dragGeometryRef.current,
    readLeafRects: leafJoin.readLeafRects
  })
  // Join only the shown target: a layout change after drawing can move the pointer onto another pane.
  const shownLeafTarget = leafJoin.getShownLeafTarget()
  if (leafTarget && shownLeafTarget && isSameJoinTarget(leafTarget, shownLeafTarget)) {
    // An overlay that showed a refusal keeps it, even if the blocking move ended before the drop.
    commitLeafEdgeDrop({
      leafJoin,
      leafTarget: shownLeafTarget.refusal ? shownLeafTarget : leafTarget,
      activeData,
      finishDrag
    })
    return
  }

  // A shown join that lost eligibility before the drop is a refusal, never a plain drop.
  if (
    !leafTarget &&
    shownLeafTarget &&
    !resolveTerminalTabIntoPaneEligibility(state, {
      sourceTabId: activeData.visibleTabId,
      targetTabId: shownLeafTarget.targetTabId,
      targetLeafId: shownLeafTarget.leafId
    }).ok
  ) {
    finishDrag(false)
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

    // Recompute insertion side at drop so the destination matches the drawn bar without stale closure state.
    const insertion = resolveTabInsertion(event, isTabDragData, getDragPointer)
    if (!insertion) {
      finishDrag(true)
      return
    }

    const overIndex = targetGroup.tabOrder.indexOf(overData.unifiedTabId)
    const rawInsertIndex = overIndex + (insertion.side === 'right' ? 1 : 0)

    if (activeData.groupId === overData.groupId) {
      const oldIndex = targetGroup.tabOrder.indexOf(activeData.unifiedTabId)
      // Adjust forward insertion after removing the source tab so the target slot does not shift left.
      const nextIndex = oldIndex < rawInsertIndex ? rawInsertIndex - 1 : rawInsertIndex
      if (oldIndex !== -1 && oldIndex !== nextIndex) {
        const nextOrder = targetGroup.tabOrder.filter((id) => id !== activeData.unifiedTabId)
        nextOrder.splice(nextIndex, 0, activeData.unifiedTabId)
        if (
          ORCA_LAYOUT_OWNER_IS_MAIN &&
          dropTabThroughLayoutOwner(worktreeId, {
            kind: 'reorder',
            tabId: activeData.unifiedTabId,
            groupId: overData.groupId,
            tabOrder: nextOrder
          })
        ) {
          finishDrag(true)
          return
        }
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
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        dropTabThroughLayoutOwner(worktreeId, {
          kind: 'move',
          tabId: activeData.unifiedTabId,
          groupId: overData.groupId,
          index
        })
      ) {
        finishDrag(true)
        return
      }
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
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        dropTabThroughLayoutOwner(worktreeId, {
          kind: 'move',
          tabId: activeData.unifiedTabId,
          groupId: overData.groupId
        })
      ) {
        finishDrag(true)
        return
      }
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
