import { useCallback, useMemo, useState } from 'react'
import {
  closestCenter,
  pointerWithin,
  PointerSensor,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import type { TabGroup } from '../../../../shared/types'
import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs'

export type TabDropZone = 'center' | TabSplitDirection

export type TabDragItemData = {
  kind: 'tab'
  worktreeId: string
  groupId: string
  unifiedTabId: string
  visibleTabId: string
  tabType: 'terminal' | 'editor' | 'browser'
}

export type TabPaneDropData = {
  kind: 'pane-body'
  worktreeId: string
  groupId: string
}

export type HoveredTabDropTarget = {
  groupId: string
  zone: TabDropZone
}

export function canDropTabIntoPaneBody({
  activeDrag,
  groupsByWorktree,
  overGroupId,
  worktreeId
}: {
  activeDrag: TabDragItemData | null
  groupsByWorktree: Record<string, TabGroup[]>
  overGroupId: string
  worktreeId: string
}): boolean {
  if (!activeDrag || activeDrag.worktreeId !== worktreeId) {
    return false
  }

  const overGroup = (groupsByWorktree[worktreeId] ?? []).find((group) => group.id === overGroupId)
  if (!overGroup) {
    return false
  }

  // Why: splitting the only tab in a group onto that same group's body is a
  // visual no-op. The store already rejects that drop, so the hover layer must
  // suppress the pane overlay too or the user sees a split affordance that can
  // never produce a layout change.
  if (activeDrag.groupId === overGroupId && overGroup.tabOrder.length <= 1) {
    return false
  }

  return true
}

function isTabDragData(value: unknown): value is TabDragItemData {
  return Boolean(value) && typeof value === 'object' && (value as TabDragItemData).kind === 'tab'
}

function isPaneDropData(value: unknown): value is TabPaneDropData {
  return (
    Boolean(value) && typeof value === 'object' && (value as TabPaneDropData).kind === 'pane-body'
  )
}

function getDragCenter(
  event: Pick<DragMoveEvent, 'active' | 'delta'>
): { x: number; y: number } | null {
  const translated = event.active.rect.current.translated
  if (translated) {
    return {
      x: translated.left + translated.width / 2,
      y: translated.top + translated.height / 2
    }
  }

  const initial = event.active.rect.current.initial
  if (!initial) {
    return null
  }

  return {
    x: initial.left + initial.width / 2 + event.delta.x,
    y: initial.top + initial.height / 2 + event.delta.y
  }
}

function resolveDropZone(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number }
): TabDropZone {
  const localX = point.x - rect.left
  const localY = point.y - rect.top
  const edgeWidthThreshold = rect.width * 0.1
  const edgeHeightThreshold = rect.height * 0.1
  const splitWidthThreshold = rect.width / 3

  // Why: VS Code keeps a center "merge" zone while biasing side-by-side drops
  // toward left/right, which feels much more stable than a generic nearest-edge
  // calculation once a workspace has nested splits.
  if (
    localX > edgeWidthThreshold &&
    localX < rect.width - edgeWidthThreshold &&
    localY > edgeHeightThreshold &&
    localY < rect.height - edgeHeightThreshold
  ) {
    return 'center'
  }

  if (localX < splitWidthThreshold) {
    return 'left'
  }
  if (localX > splitWidthThreshold * 2) {
    return 'right'
  }
  return localY < rect.height / 2 ? 'up' : 'down'
}

const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args)
}

export function getTabPaneBodyDroppableId(groupId: string): UniqueIdentifier {
  return `tab-group-pane-body:${groupId}`
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
  onDragCancel: () => void
  onDragEnd: (event: DragEndEvent) => void
  onDragMove: (event: DragMoveEvent) => void
  onDragOver: (event: DragOverEvent) => void
  onDragStart: (event: DragStartEvent) => void
  sensors: ReturnType<typeof useSensors>
} {
  const reorderUnifiedTabs = useAppStore((state) => state.reorderUnifiedTabs)
  const dropUnifiedTab = useAppStore((state) => state.dropUnifiedTab)
  const [activeDrag, setActiveDrag] = useState<TabDragItemData | null>(null)
  const [hoveredDropTarget, setHoveredDropTarget] = useState<HoveredTabDropTarget | null>(null)

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 5 }
  })
  const activeSensors = useSensors(pointerSensor)
  const emptySensors = useSensors()
  // Why: hidden worktrees stay mounted so their PTYs survive worktree
  // switches, but their DndContext should not register pointer listeners
  // on the document. Multiple active DndContext instances can interfere
  // with each other.
  const sensors = enabled ? activeSensors : emptySensors

  const clearDragState = useCallback(() => {
    setActiveDrag(null)
    setHoveredDropTarget(null)
  }, [])

  const updateHoveredPane = useCallback(
    (event: DragMoveEvent | DragOverEvent) => {
      const overData = event.over?.data.current
      if (!event.over || !isPaneDropData(overData)) {
        // Why: using functional updater to avoid a new null reference when
        // the state is already null — prevents unnecessary re-renders during
        // high-frequency onDragMove events.
        setHoveredDropTarget((prev) => (prev === null ? prev : null))
        return
      }

      const activeData = event.active.data.current
      if (
        !isTabDragData(activeData) ||
        !canDropTabIntoPaneBody({
          activeDrag: activeData,
          groupsByWorktree: useAppStore.getState().groupsByWorktree,
          overGroupId: overData.groupId,
          worktreeId
        })
      ) {
        setHoveredDropTarget((prev) => (prev === null ? prev : null))
        return
      }

      const center = getDragCenter(event)
      if (!center) {
        setHoveredDropTarget((prev) => (prev === null ? prev : null))
        return
      }

      // Why: onDragMove fires at pointer-move frequency (~60 fps). Creating
      // a new { groupId, zone } object every time would trigger a state
      // update and full re-render of the SplitNode tree on every frame even
      // when nothing meaningful changed. The functional updater lets us
      // compare against the previous value and return the same reference
      // when groupId and zone are unchanged.
      setHoveredDropTarget((prev) => {
        const zone = resolveDropZone(event.over!.rect, center)
        if (prev?.groupId === overData.groupId && prev?.zone === zone) {
          return prev
        }
        return { groupId: overData.groupId, zone }
      })
    },
    [worktreeId]
  )

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const dragData = event.active.data.current
      if (!isTabDragData(dragData) || dragData.worktreeId !== worktreeId) {
        clearDragState()
        return
      }

      setActiveDrag(dragData)
    },
    [clearDragState, worktreeId]
  )

  const onDragMove = useCallback(
    (event: DragMoveEvent) => {
      updateHoveredPane(event)
    },
    [updateHoveredPane]
  )

  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      updateHoveredPane(event)
    },
    [updateHoveredPane]
  )

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeData = event.active.data.current
      const overData = event.over?.data.current

      if (!event.over || !isTabDragData(activeData) || activeData.worktreeId !== worktreeId) {
        clearDragState()
        return
      }

      if (isTabDragData(overData)) {
        if (activeData.unifiedTabId === overData.unifiedTabId) {
          clearDragState()
          return
        }

        const state = useAppStore.getState()
        const groups = state.groupsByWorktree[worktreeId] ?? []
        const targetGroup = groups.find((group) => group.id === overData.groupId)
        if (!targetGroup) {
          clearDragState()
          return
        }

        if (activeData.groupId === overData.groupId) {
          const oldIndex = targetGroup.tabOrder.indexOf(activeData.unifiedTabId)
          const newIndex = targetGroup.tabOrder.indexOf(overData.unifiedTabId)
          if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
            reorderUnifiedTabs(
              overData.groupId,
              arrayMove(targetGroup.tabOrder, oldIndex, newIndex)
            )
          }
        } else {
          const targetIndex = targetGroup.tabOrder.indexOf(overData.unifiedTabId)
          dropUnifiedTab(activeData.unifiedTabId, {
            groupId: overData.groupId,
            index: targetIndex === -1 ? targetGroup.tabOrder.length : targetIndex
          })
        }

        clearDragState()
        return
      }

      if (isPaneDropData(overData)) {
        if (
          !canDropTabIntoPaneBody({
            activeDrag: activeData,
            groupsByWorktree: useAppStore.getState().groupsByWorktree,
            overGroupId: overData.groupId,
            worktreeId
          })
        ) {
          clearDragState()
          return
        }

        const center = getDragCenter(event)
        if (center) {
          const zone = resolveDropZone(event.over.rect, center)
          // Why: a center drop onto the tab's own pane body is a no-op in the
          // store (non-split same-group drops are ignored), but
          // canDropTabIntoPaneBody still allows it when the source group has
          // >1 tab — so the overlay advertises "center" as a valid target.
          // Skip the call in that case to avoid misleading the user via a
          // drop that silently does nothing.
          if (zone !== 'center' || activeData.groupId !== overData.groupId) {
            dropUnifiedTab(activeData.unifiedTabId, {
              groupId: overData.groupId,
              splitDirection: zone === 'center' ? undefined : zone
            })
          }
        }
      }

      clearDragState()
    },
    [clearDragState, dropUnifiedTab, reorderUnifiedTabs, worktreeId]
  )

  // Why: dnd-kit fires onDragCancel (not onDragEnd) when the user presses
  // Escape or the drag is otherwise aborted. Without this handler the
  // activeDrag and hoveredDropTarget state would remain stale, leaving the
  // drop overlay visible indefinitely.
  const onDragCancel = useCallback(() => {
    clearDragState()
  }, [clearDragState])

  return useMemo(
    () => ({
      activeDrag,
      collisionDetection,
      hoveredDropTarget,
      onDragCancel,
      onDragEnd,
      onDragMove,
      onDragOver,
      onDragStart,
      sensors
    }),
    [
      activeDrag,
      hoveredDropTarget,
      onDragCancel,
      onDragEnd,
      onDragMove,
      onDragOver,
      onDragStart,
      sensors
    ]
  )
}
