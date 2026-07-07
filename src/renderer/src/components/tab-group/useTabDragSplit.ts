/* oxlint-disable max-lines -- Why: the drag-split hook co-locates drop-zone
 * resolution, same-group reordering, and cross-group handoff so state
 * transitions stay readable in one place. */
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
import type { TabGroup, TuiAgent } from '../../../../shared/types'
import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { mirrorWebRuntimeTabMove } from '../tab-bar/web-runtime-tab-move-mirror'
import {
  resolveTabInsertion,
  useHoveredTabInsertion,
  type HoveredTabInsertion
} from './tab-insertion'
import { acquireWebviewsDragPassthrough } from '../browser-pane/webview-registry'
import {
  applyDragPreviewTab,
  captureTabDragActivationSnapshot,
  restoreSourceGroupActiveTabAfterCrossGroupDrop,
  restoreTabDragActivationSnapshot,
  type TabDragActivationSnapshot
} from './tab-drag-preview-activation'
import { resolveDragPreviewTabId, resolveSourceGroupRestoreOnDrop } from './tab-drag-preview-target'
import { getDragPointer } from './tab-drag-pointer'
import { TabDragPointerSensor } from './tab-drag-pointer-sensor'
import {
  captureTabGroupPanelGeometrySnapshot,
  resolveActivePaneColumnSplitTarget,
  type ActivePaneColumnSplitTarget,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'

export type { HoveredTabInsertion }

export type TabDropZone = 'center' | TabSplitDirection

// Why: tab activation waits for pointerup, so dnd-kit needs enough movement
// tolerance to avoid treating ordinary click jitter as an intentional drag.
export const TAB_DRAG_ACTIVATION_DISTANCE_PX = 12

export type TabDragItemData = {
  kind: 'tab'
  worktreeId: string
  groupId: string
  unifiedTabId: string
  visibleTabId: string
  tabType: 'terminal' | 'editor' | 'browser' | 'simulator' | 'tasks'
  /** Rendered by the DragOverlay ghost that follows the cursor across
   *  groups. Source tab strips use overflow-hidden, so without the overlay
   *  the dragged tab would be invisible once the cursor leaves its own
   *  group's strip. */
  label: string
  iconPath?: string
  color?: string | null
  /** Coding-harness agent running in a terminal tab, so the drag ghost shows
   *  the provider glyph and matches the resting tab. Resolved per-tab in
   *  SortableTab (not at the TabBar level) to avoid re-rendering the whole tab
   *  strip on every agent-status ping. */
  agent?: TuiAgent | null
}

export type TabPaneDropData = {
  kind: 'pane-body'
  worktreeId: string
  groupId: string
}

export type HoveredTabDropTarget = {
  groupId: string
  zone: TabDropZone
  panelRect?: DOMRect
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

export function isTabDragData(value: unknown): value is TabDragItemData {
  return Boolean(value) && typeof value === 'object' && (value as TabDragItemData).kind === 'tab'
}

export function isPaneDropData(value: unknown): value is TabPaneDropData {
  return (
    Boolean(value) && typeof value === 'object' && (value as TabPaneDropData).kind === 'pane-body'
  )
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
  const [hoveredDropTarget, setHoveredDropTarget] = useState<HoveredTabDropTarget | null>(null)
  const releaseWebviewDragPassthroughRef = useRef<(() => void) | null>(null)
  const preDragActivationSnapshotRef = useRef<TabDragActivationSnapshot | null>(null)
  const lastPreviewRef = useRef<{ groupId: string; tabId: string | null } | null>(null)
  const lastHoveredTabPreviewRef = useRef<{ groupId: string; tabId: string } | null>(null)
  const tabDragActiveRef = useRef(false)
  const dragGeometryRef = useRef<TabGroupPanelGeometrySnapshot | null>(null)
  const releaseMissedEndFallbackRef = useRef<(() => void) | null>(null)
  const tabInsertion = useHoveredTabInsertion(isTabDragData, getDragPointer)

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

  const releaseWebviewDragPassthrough = useCallback(() => {
    releaseWebviewDragPassthroughRef.current?.()
    releaseWebviewDragPassthroughRef.current = null
  }, [])

  const releaseMissedEndFallback = useCallback(() => {
    releaseMissedEndFallbackRef.current?.()
    releaseMissedEndFallbackRef.current = null
  }, [])

  const clearDragStateRef = useRef<() => void>(() => {})

  const installMissedEndFallback = useCallback(() => {
    releaseMissedEndFallback()

    let cleanupTimer: number | null = null
    const clearIfDndMissedEnd = (): void => {
      if (cleanupTimer !== null) {
        window.clearTimeout(cleanupTimer)
      }
      cleanupTimer = window.setTimeout(() => {
        cleanupTimer = null
        if (tabDragActiveRef.current) {
          // Why: Electron/dnd-kit can occasionally miss drag end/cancel; a
          // stuck drag ref makes all later tab clicks look like drag releases.
          clearDragStateRef.current()
        }
      }, 0)
    }

    window.addEventListener('pointerup', clearIfDndMissedEnd)
    window.addEventListener('pointercancel', clearIfDndMissedEnd)
    window.addEventListener('blur', clearIfDndMissedEnd)
    window.addEventListener('focus', clearIfDndMissedEnd)
    releaseMissedEndFallbackRef.current = () => {
      if (cleanupTimer !== null) {
        window.clearTimeout(cleanupTimer)
      }
      window.removeEventListener('pointerup', clearIfDndMissedEnd)
      window.removeEventListener('pointercancel', clearIfDndMissedEnd)
      window.removeEventListener('blur', clearIfDndMissedEnd)
      window.removeEventListener('focus', clearIfDndMissedEnd)
    }
  }, [releaseMissedEndFallback])

  const acquireWebviewDragPassthrough = useCallback(() => {
    // Why: dnd-kit tab drags are pointer-driven, so the native drag listeners
    // in webview-registry never fire. Put webviews in passthrough explicitly.
    releaseWebviewDragPassthrough()
    releaseWebviewDragPassthroughRef.current = acquireWebviewsDragPassthrough()
  }, [releaseWebviewDragPassthrough])

  const setDragRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node) {
        return
      }
      // Why: this root owns the dnd-kit gesture that temporarily puts browser
      // webviews in pointer passthrough and installs global fallback listeners,
      // so root teardown must release both.
      releaseWebviewDragPassthrough()
      releaseMissedEndFallback()
    },
    [releaseMissedEndFallback, releaseWebviewDragPassthrough]
  )

  const clearDragState = useCallback(() => {
    tabDragActiveRef.current = false
    releaseWebviewDragPassthrough()
    releaseMissedEndFallback()
    setActiveDrag(null)
    setHoveredDropTarget(null)
    tabInsertion.clear()
    preDragActivationSnapshotRef.current = null
    lastPreviewRef.current = null
    lastHoveredTabPreviewRef.current = null
    dragGeometryRef.current = null
  }, [releaseMissedEndFallback, releaseWebviewDragPassthrough, tabInsertion])
  clearDragStateRef.current = clearDragState

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

  const updateDragPreviewActivation = useCallback(
    (event: DragMoveEvent | DragOverEvent, activeData: TabDragItemData) => {
      const snapshot = preDragActivationSnapshotRef.current
      if (!snapshot) {
        return
      }

      const overData = event.over?.data.current
      if (isTabDragData(overData) && overData.unifiedTabId !== activeData.unifiedTabId) {
        lastHoveredTabPreviewRef.current = {
          groupId: overData.groupId,
          tabId: overData.unifiedTabId
        }
      }

      const preview = resolveDragPreviewTabId({
        activeDrag: activeData,
        overData,
        preDragActiveTabIdByGroup: snapshot.activeTabIdByGroup,
        lastHoveredTabPreview: lastHoveredTabPreviewRef.current
      })
      const lastPreview = lastPreviewRef.current
      if (lastPreview?.groupId === preview.groupId && lastPreview.tabId === preview.tabId) {
        return
      }
      lastPreviewRef.current = preview
      applyDragPreviewTab({
        worktreeId,
        groupId: preview.groupId,
        tabId: preview.tabId,
        activeGroupId: preview.groupId
      })
    },
    [worktreeId]
  )

  const updateHoveredDropTargetFromSplit = useCallback(
    (splitTarget: ActivePaneColumnSplitTarget | null) => {
      if (!splitTarget) {
        setHoveredDropTarget((prev) => (prev === null ? prev : null))
        return
      }
      setHoveredDropTarget((prev) => {
        if (prev?.groupId === splitTarget.groupId && prev?.zone === splitTarget.zone) {
          return prev
        }
        return {
          groupId: splitTarget.groupId,
          zone: splitTarget.zone,
          panelRect: splitTarget.panelRect
        }
      })
    },
    []
  )

  const handleDragUpdate = useCallback(
    (event: DragMoveEvent | DragOverEvent) => {
      const activeData = event.active.data.current
      if (isTabDragData(activeData) && activeData.worktreeId === worktreeId) {
        updateDragPreviewActivation(event, activeData)
      }

      const state = useAppStore.getState()
      const splitTarget = resolveActivePaneColumnSplitTarget({
        event,
        groupsByWorktree: state.groupsByWorktree,
        layoutByWorktree: state.layoutByWorktree,
        worktreeId,
        getDragPointer,
        geometry: dragGeometryRef.current
      })
      updateHoveredDropTargetFromSplit(splitTarget)
      if (splitTarget) {
        tabInsertion.clear()
      } else {
        tabInsertion.update(event)
      }
    },
    [tabInsertion, updateDragPreviewActivation, updateHoveredDropTargetFromSplit, worktreeId]
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
          resolveSourceGroupRestoreOnDrop(
            activeData,
            overData.groupId,
            shouldRestorePreDragActivation
          )
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
    },
    [dropUnifiedTab, finishDrag, reorderUnifiedTabs, worktreeId]
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
