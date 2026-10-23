import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { DragMoveEvent, DragOverEvent } from '@dnd-kit/core'
import { useAppStore } from '../../store'
import type { useHoveredTabInsertion } from './tab-insertion'
import type { TabDragActivationSnapshot } from '../../store/slices/tabs/tabs-slice-contract'
import { resolveDragPreviewTabId } from './tab-drag-preview-target'
import { getDragPointer } from './tab-drag-pointer'
import {
  resolveActivePaneColumnSplitTarget,
  type ActivePaneColumnSplitTarget,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'
import { isTabDragData, type TabDragItemData, type TabDropZone } from './tab-drag-data'
import { resolveTabDragLeafTarget, type TabDragLeafTarget } from './tab-drag-leaf-target'

export type HoveredTabDropTarget = {
  groupId: string
  zone: TabDropZone
  panelRect?: DOMRect
}

function isSameLeafTarget(a: TabDragLeafTarget | null, b: TabDragLeafTarget | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.groupId === b.groupId &&
      a.targetTabId === b.targetTabId &&
      a.leafId === b.leafId &&
      a.zone === b.zone &&
      a.refusal === b.refusal &&
      a.leafRect.left === b.leafRect.left &&
      a.leafRect.top === b.leafRect.top &&
      a.leafRect.width === b.leafRect.width &&
      a.leafRect.height === b.leafRect.height)
  )
}

/** Derives the in-flight hover state of a tab drag: the live preview tab to
 *  activate (deduped through private memo refs), the hovered pane-column split
 *  target, and the pane edge a terminal tab would join. Tab-strip insertion is
 *  delegated to the injected tabInsertion. */
export function useTabDragHoverPreview({
  worktreeId,
  preDragActivationSnapshotRef,
  dragGeometryRef,
  tabInsertion
}: {
  worktreeId: string
  preDragActivationSnapshotRef: RefObject<TabDragActivationSnapshot | null>
  dragGeometryRef: RefObject<TabGroupPanelGeometrySnapshot | null>
  tabInsertion: ReturnType<typeof useHoveredTabInsertion>
}): {
  clear: () => void
  handleDragUpdate: (event: DragMoveEvent | DragOverEvent) => void
  hoveredDropTarget: HoveredTabDropTarget | null
  hoveredLeafTarget: TabDragLeafTarget | null
  shownLeafTargetRef: RefObject<TabDragLeafTarget | null>
} {
  const [hoveredDropTarget, setHoveredDropTarget] = useState<HoveredTabDropTarget | null>(null)
  const [hoveredLeafTarget, setHoveredLeafTarget] = useState<TabDragLeafTarget | null>(null)
  const shownLeafTargetRef = useRef<TabDragLeafTarget | null>(null)
  const lastPreviewRef = useRef<{ groupId: string; tabId: string | null } | null>(null)
  const lastHoveredTabPreviewRef = useRef<{ groupId: string; tabId: string } | null>(null)

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
      useAppStore.getState().previewDragActiveTab({
        worktreeId,
        groupId: preview.groupId,
        tabId: preview.tabId,
        activeGroupId: preview.groupId
      })
    },
    [preDragActivationSnapshotRef, worktreeId]
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

  const updateHoveredLeafTarget = useCallback((next: TabDragLeafTarget | null) => {
    setHoveredLeafTarget((prev) => (isSameLeafTarget(prev, next) ? prev : next))
  }, [])

  // Only a committed overlay counts as shown: a drop before React draws it must not join.
  useLayoutEffect(() => {
    shownLeafTargetRef.current = hoveredLeafTarget
  }, [hoveredLeafTarget])

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
      // The Level 1 band and the interior never overlap, so at most one of the two resolves.
      const leafTarget =
        !splitTarget && isTabDragData(activeData)
          ? resolveTabDragLeafTarget({
              activeDrag: activeData,
              pointer: getDragPointer(event),
              worktreeId,
              state,
              geometry: dragGeometryRef.current
            })
          : null
      updateHoveredLeafTarget(leafTarget)
      if (splitTarget || leafTarget) {
        tabInsertion.clear()
      } else {
        tabInsertion.update(event)
      }
    },
    [
      dragGeometryRef,
      tabInsertion,
      updateDragPreviewActivation,
      updateHoveredDropTargetFromSplit,
      updateHoveredLeafTarget,
      worktreeId
    ]
  )

  const clear = useCallback(() => {
    setHoveredDropTarget(null)
    setHoveredLeafTarget(null)
    shownLeafTargetRef.current = null
    lastPreviewRef.current = null
    lastHoveredTabPreviewRef.current = null
  }, [])

  return { clear, handleDragUpdate, hoveredDropTarget, hoveredLeafTarget, shownLeafTargetRef }
}
