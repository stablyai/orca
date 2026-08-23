import { useCallback, useRef, useState, type RefObject } from 'react'
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
import { getDragPointer, isDragPointerOutsideViewport } from './tab-drag-pointer'
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

// Why: tab activation waits for pointerup, so dnd-kit needs enough movement
// tolerance to avoid treating ordinary click jitter as an intentional drag.
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
  if (isDragPointerOutsideViewport(args.pointerCoordinates)) {
    return []
  }
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
  const dragGenerationRef = useRef(0)
  const pendingDragEndGenerationRef = useRef<number | null>(null)
  const dragOutsideWindowRef = useRef(false)
  const dragGeometryRef = useRef<TabGroupPanelGeometrySnapshot | null>(null)
  const finishMissedDragRef = useRef<() => void>(() => {})
  const teardownDragRef = useRef<() => void>(() => {})
  const tabInsertion = useHoveredTabInsertion(isTabDragData, getDragPointer)
  const {
    acquireWebviewDragPassthrough,
    installMissedEndFallback,
    releaseMissedEndFallback,
    releaseWebviewDragPassthrough,
    setDragRootNode
  } = useTabDragGestureLifecycle({
    dragOutsideWindowRef,
    finishMissedDragRef,
    tabDragActiveRef,
    teardownDragRef
  })
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
  const pointerSensor = useSensor(TabDragPointerSensor, {
    activationConstraint: { distance: getTabDragActivationDistance(enabled) }
  })
  const sensors = useSensors(pointerSensor)

  const invalidateDragRefs = useCallback(() => {
    dragGenerationRef.current += 1
    pendingDragEndGenerationRef.current = null
    tabDragActiveRef.current = false
    dragOutsideWindowRef.current = false
    preDragActivationSnapshotRef.current = null
    dragGeometryRef.current = null
  }, [])

  const clearDragState = useCallback(() => {
    invalidateDragRefs()
    releaseWebviewDragPassthrough()
    releaseMissedEndFallback()
    setActiveDrag(null)
    clearHoveredDropTarget()
    tabInsertion.clear()
  }, [
    clearHoveredDropTarget,
    invalidateDragRefs,
    releaseMissedEndFallback,
    releaseWebviewDragPassthrough,
    tabInsertion
  ])

  const restorePreDragActivation = useCallback(() => {
    const snapshot = preDragActivationSnapshotRef.current
    if (!snapshot) {
      return
    }
    restoreTabDragActivationSnapshot(worktreeId, snapshot)
  }, [worktreeId])

  const restoreSourceGroupAfterCrossGroupDrop = useCallback(
    (activeData: TabDragItemData) => {
      const snapshot = preDragActivationSnapshotRef.current
      if (!snapshot) {
        return
      }
      restoreSourceGroupActiveTabAfterCrossGroupDrop({
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
  finishMissedDragRef.current = () => finishDrag(true)
  teardownDragRef.current = () => {
    invalidateDragRefs()
    finishMissedDragRef.current = () => {}
  }

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const dragData = event.active.data.current
      if (!enabled || !isTabDragData(dragData) || dragData.worktreeId !== worktreeId) {
        finishDrag(true)
        return
      }

      dragGenerationRef.current += 1
      pendingDragEndGenerationRef.current = null
      setActiveDrag(dragData)
      tabDragActiveRef.current = true
      dragOutsideWindowRef.current = false
      installMissedEndFallback()
      dragGeometryRef.current = captureTabGroupPanelGeometrySnapshot(worktreeId)
      preDragActivationSnapshotRef.current = captureTabDragActivationSnapshot(worktreeId)
      acquireWebviewDragPassthrough()
    },
    [acquireWebviewDragPassthrough, enabled, finishDrag, installMissedEndFallback, worktreeId]
  )

  const onDragMove = useCallback(
    (event: DragMoveEvent) => {
      const pointer = getDragPointer(event)
      dragOutsideWindowRef.current = isDragPointerOutsideViewport(pointer)
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
        return
      }
      const dragGeneration = dragGenerationRef.current
      if (pendingDragEndGenerationRef.current === dragGeneration) {
        return
      }
      pendingDragEndGenerationRef.current = dragGeneration
      releaseMissedEndFallback()
      commitTabDragDrop({
        event,
        worktreeId,
        dragGeometryRef,
        dropUnifiedTab,
        reorderUnifiedTabs,
        finishDrag: (restoreSnapshot, activeData) => {
          if (dragGenerationRef.current === dragGeneration) {
            finishDrag(restoreSnapshot, activeData)
          }
        }
      })
    },
    [
      dragGeometryRef,
      dropUnifiedTab,
      finishDrag,
      releaseMissedEndFallback,
      reorderUnifiedTabs,
      worktreeId
    ]
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
