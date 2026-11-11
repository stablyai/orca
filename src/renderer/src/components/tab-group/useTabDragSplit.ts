import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import {
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import type { TabGroup } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import type { TabDragActivationSnapshot } from '../../store/slices/tabs/tabs-slice-contract'
import { useHoveredTabInsertion, type HoveredTabInsertion } from './tab-insertion'
import { captureTabDragActivationSnapshot } from './tab-drag-preview-activation'
import { getDragPointer } from './tab-drag-pointer'
import { TabDragPointerSensor } from './tab-drag-pointer-sensor'
import {
  captureTabGroupPanelGeometrySnapshot,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'
import { canDropTabIntoPaneBody, isTabDragData, type TabDragItemData } from './tab-drag-data'
import { useTabDragGestureLifecycle } from './tab-drag-gesture-lifecycle'
import { useTabDragHoverPreview, type HoveredTabDropTarget } from './tab-drag-hover-preview'
import { commitTabDragDrop } from './tab-drag-drop-commit'

export type { HoveredTabInsertion }
export type { HoveredTabDropTarget }
export {
  canDropTabIntoPaneBody,
  isPaneDropData,
  isTabDragData,
  type TabDragItemData,
  type TabDropZone,
  type TabPaneDropData
} from './tab-drag-data'

// Allow click jitter because tab activation waits until pointerup.
export const TAB_DRAG_ACTIVATION_DISTANCE_PX = 12

export function canDropTabForPaneColumnSplit(args: {
  activeDrag: TabDragItemData | null
  groupsByWorktree: Record<string, TabGroup[]>
  targetGroupId: string
  worktreeId: string
}): boolean {
  if (!args.activeDrag || args.activeDrag.groupId !== args.targetGroupId) {
    return false
  }
  return canDropTabIntoPaneBody({
    activeDrag: args.activeDrag,
    groupsByWorktree: args.groupsByWorktree,
    overGroupId: args.targetGroupId,
    worktreeId: args.worktreeId
  })
}

const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args)
}

export function getTabPaneBodyDroppableId(groupId: string): UniqueIdentifier {
  return `tab-group-pane-body:${groupId}`
}

export function getTabDragActivationDistance(enabled: boolean): number {
  return enabled ? TAB_DRAG_ACTIVATION_DISTANCE_PX : Number.MAX_SAFE_INTEGER
}

export function useTabDragSplit({
  worktreeId,
  enabled = true
}: {
  worktreeId: string
  /** Disable drag activation for hidden retained worktrees without changing sensor count. */
  enabled?: boolean
}): {
  activeDrag: TabDragItemData | null
  collisionDetection: CollisionDetection
  hoveredDropTarget: HoveredTabDropTarget | null
  hoveredTabInsertion: HoveredTabInsertion | null
  isTabDragActiveRef: RefObject<boolean>
  onDragCancel: () => void
  onDragEnd: (event: DragEndEvent) => void
  onDragMove: (event: DragMoveEvent) => void
  onDragOver: (event: DragOverEvent) => void
  onDragStart: (event: DragStartEvent) => void
  sensors: ReturnType<typeof useSensors>
  setDragRootNode: (node: HTMLDivElement | null) => void
} {
  const reorderUnifiedTabs = useAppStore((state) => state.reorderUnifiedTabs)
  const dropUnifiedTab = useAppStore((state) => state.dropUnifiedTab)
  const [activeDrag, setActiveDrag] = useState<TabDragItemData | null>(null)
  const preDragActivationSnapshotRef = useRef<TabDragActivationSnapshot | null>(null)
  const tabDragActiveRef = useRef(false)
  const dragGeometryRef = useRef<TabGroupPanelGeometrySnapshot | null>(null)
  const clearDragStateRef = useRef<() => void>(() => {})
  const tabInsertion = useHoveredTabInsertion(isTabDragData, getDragPointer)
  const {
    acquireWebviewDragPassthrough,
    installMissedEndFallback,
    releaseMissedEndFallback,
    releaseWebviewDragPassthrough,
    setDragRootNode
  } = useTabDragGestureLifecycle({ clearDragStateRef, tabDragActiveRef })
  const {
    clear: clearHoveredDropTarget,
    handleDragUpdate,
    hoveredDropTarget
  } = useTabDragHoverPreview({
    worktreeId,
    preDragActivationSnapshotRef,
    dragGeometryRef,
    tabInsertion
  })

  // Use an impossible activation distance for hidden worktrees; changing sensor count changes dnd-kit effect dependency length.
  const activationDistance = getTabDragActivationDistance(enabled)
  // Why memoized: fresh options rebuild every tab's drag listeners and wake every tab through dnd-kit's context.
  const pointerSensorOptions = useMemo(
    () => ({ activationConstraint: { distance: activationDistance } }),
    [activationDistance]
  )
  const pointerSensor = useSensor(TabDragPointerSensor, pointerSensorOptions)
  const sensors = useSensors(pointerSensor)

  const clearDragState = useCallback(() => {
    tabDragActiveRef.current = false
    releaseWebviewDragPassthrough()
    releaseMissedEndFallback()
    setActiveDrag(null)
    clearHoveredDropTarget()
    tabInsertion.clear()
    preDragActivationSnapshotRef.current = null
    dragGeometryRef.current = null
  }, [
    clearHoveredDropTarget,
    releaseMissedEndFallback,
    releaseWebviewDragPassthrough,
    tabInsertion
  ])
  clearDragStateRef.current = clearDragState

  const restorePreDragActivation = useCallback(() => {
    const snapshot = preDragActivationSnapshotRef.current
    if (!snapshot) {
      return
    }
    useAppStore.getState().restoreDragActivationSnapshot(worktreeId, snapshot)
  }, [worktreeId])

  const restoreSourceGroupAfterCrossGroupDrop = useCallback(
    (activeData: TabDragItemData) => {
      const snapshot = preDragActivationSnapshotRef.current
      if (!snapshot) {
        return
      }
      useAppStore.getState().restoreSourceGroupActiveTabAfterDrop({
        worktreeId,
        snapshot,
        sourceGroupId: activeData.groupId,
        movedTabId: activeData.unifiedTabId
      })
    },
    [worktreeId]
  )

  const finishDrag = useCallback(
    (restoreSnapshot: boolean, activeData?: TabDragItemData) => {
      if (restoreSnapshot) {
        restorePreDragActivation()
      } else if (activeData) {
        restoreSourceGroupAfterCrossGroupDrop(activeData)
      }
      clearDragState()
    },
    [clearDragState, restorePreDragActivation, restoreSourceGroupAfterCrossGroupDrop]
  )

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const dragData = event.active.data.current
      if (!isTabDragData(dragData) || dragData.worktreeId !== worktreeId) {
        clearDragState()
        return
      }

      setActiveDrag(dragData)
      tabDragActiveRef.current = true
      installMissedEndFallback()
      dragGeometryRef.current = captureTabGroupPanelGeometrySnapshot(worktreeId)
      preDragActivationSnapshotRef.current = captureTabDragActivationSnapshot(worktreeId)
      acquireWebviewDragPassthrough()
    },
    [acquireWebviewDragPassthrough, clearDragState, installMissedEndFallback, worktreeId]
  )

  const onDragMove = useCallback(
    (event: DragMoveEvent) => {
      // A missed-end cleanup can run before dnd-kit delivers its last move.
      if (!tabDragActiveRef.current) {
        return
      }
      handleDragUpdate(event)
    },
    [handleDragUpdate]
  )

  const onDragOver = useCallback((_event: DragOverEvent) => {
    // onDragMove already resolves split/insertion targets; avoid duplicate work in the same frame.
  }, [])

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!tabDragActiveRef.current) {
        finishDrag(true)
        return
      }
      commitTabDragDrop({
        event,
        worktreeId,
        dragGeometryRef,
        dropUnifiedTab,
        reorderUnifiedTabs,
        finishDrag
      })
    },
    [dragGeometryRef, dropUnifiedTab, finishDrag, reorderUnifiedTabs, worktreeId]
  )

  // Escape/aborted drags arrive here without onDragEnd; clear previews and restore the snapshot.
  const onDragCancel = useCallback(() => {
    finishDrag(true)
  }, [finishDrag])

  return {
    activeDrag,
    collisionDetection,
    hoveredDropTarget,
    hoveredTabInsertion: tabInsertion.hoveredTabInsertion,
    isTabDragActiveRef: tabDragActiveRef,
    onDragCancel,
    onDragEnd,
    onDragMove,
    onDragOver,
    onDragStart,
    sensors,
    setDragRootNode
  }
}
