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
import { useHoveredTabInsertion, type HoveredTabInsertion } from './tab-insertion'
import {
  captureTabDragActivationSnapshot,
  restoreSourceGroupActiveTabAfterCrossGroupDrop,
  restoreTabDragActivationSnapshot,
  type TabDragActivationSnapshot
} from './tab-drag-preview-activation'
import { getDragPointer } from './tab-drag-pointer'
import { TabDragPointerSensor } from './tab-drag-pointer-sensor'
import {
  captureTabGroupPanelGeometrySnapshot,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'
import {
  canDropTabIntoPaneBody,
  isTabDragData,
  isTabStripDragData,
  type TabStripDragItemData
} from './tab-drag-data'
import { useTabDragGestureLifecycle } from './tab-drag-gesture-lifecycle'
import { useTabDragHoverPreview, type HoveredTabDropTarget } from './tab-drag-hover-preview'
import { commitTabDragDrop } from './tab-drag-drop-commit'

export type { HoveredTabInsertion }
export type { HoveredTabDropTarget }
export {
  canDropTabIntoPaneBody,
  isPaneDropData,
  isTabDragData,
  isTabClusterDragData,
  isTabStripDragData,
  type TabClusterDragItemData,
  type TabStripDragItemData,
  type TabDragItemData,
  type TabDropZone,
  type TabPaneDropData
} from './tab-drag-data'

// Why: tab activation waits for pointerup, so dnd-kit needs enough movement
// tolerance to avoid treating ordinary click jitter as an intentional drag.
export const TAB_DRAG_ACTIVATION_DISTANCE_PX = 12

export function canDropTabForPaneColumnSplit(args: {
  activeDrag: TabStripDragItemData | null
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
  /** When false (e.g. for hidden worktrees), returns empty sensors so no
   *  DndContext pointer listeners are registered on the document. Multiple
   *  simultaneous DndContext instances with active sensors can interfere. */
  enabled?: boolean
}): {
  activeDrag: TabStripDragItemData | null
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
  const moveTabsInStrip = useAppStore((state) => state.moveTabsInStrip)
  const moveTabCluster = useAppStore((state) => state.moveTabCluster)
  const dropUnifiedTab = useAppStore((state) => state.dropUnifiedTab)
  const [activeDrag, setActiveDrag] = useState<TabStripDragItemData | null>(null)
  const movedTabIdsRef = useRef<readonly string[]>([])
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

  // Why: hidden worktrees stay mounted so their PTYs survive worktree
  // switches, but their DndContext should not activate drags. We use an
  // impossible activation distance rather than switching between
  // useSensors(ptr) / useSensors(), because dnd-kit internally spreads
  // the sensors array into a useEffect dependency list — changing its
  // length between renders violates React's rules of hooks.
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
    movedTabIdsRef.current = []
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
    restoreTabDragActivationSnapshot(worktreeId, snapshot)
  }, [worktreeId])

  const restoreSourceGroupAfterCrossGroupDrop = useCallback(
    (activeData: TabStripDragItemData) => {
      const snapshot = preDragActivationSnapshotRef.current
      if (!snapshot) {
        return
      }
      restoreSourceGroupActiveTabAfterCrossGroupDrop({
        worktreeId,
        snapshot,
        sourceGroupId: activeData.groupId,
        movedTabIds: movedTabIdsRef.current
      })
    },
    [worktreeId]
  )

  const finishDrag = useCallback(
    (restoreSnapshot: boolean, activeData?: TabStripDragItemData) => {
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
      if (!isTabStripDragData(dragData) || dragData.worktreeId !== worktreeId) {
        clearDragState()
        return
      }

      const state = useAppStore.getState()
      const movedTabIds = isTabDragData(dragData)
        ? [dragData.unifiedTabId]
        : state.groupsByWorktree[worktreeId]
            ?.find((group) => group.id === dragData.groupId)
            ?.tabClusters?.find((cluster) => cluster.id === dragData.clusterId)?.tabIds
      if (!movedTabIds?.length) {
        clearDragState()
        return
      }
      movedTabIdsRef.current = movedTabIds
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
    // Why: onDragMove already carries over + delta; skipping duplicate work here
    // avoids running split/insertion resolution twice in the same frame.
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
        moveTabsInStrip,
        moveTabCluster,
        finishDrag
      })
    },
    [dragGeometryRef, dropUnifiedTab, finishDrag, moveTabsInStrip, moveTabCluster, worktreeId]
  )

  // Why: dnd-kit fires onDragCancel (not onDragEnd) when the user presses
  // Escape or the drag is otherwise aborted. Without this handler the
  // activeDrag and hoveredDropTarget state would remain stale, leaving the
  // drop overlay visible indefinitely.
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
