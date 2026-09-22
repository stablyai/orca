import { useCallback, useRef, useState, type RefObject } from 'react'
import type { DragMoveEvent, DragOverEvent } from '@dnd-kit/core'
import { useAppStore } from '../../store'
import type { useHoveredTabInsertion } from './tab-insertion'
import { applyDragPreviewTab, type TabDragActivationSnapshot } from './tab-drag-preview-activation'
import { resolveDragPreviewTabId } from './tab-drag-preview-target'
import { getDragPointer } from './tab-drag-pointer'
import {
  resolveActivePaneColumnSplitTarget,
  type ActivePaneColumnSplitTarget,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'
import { isTabDragData, type TabDragItemData, type TabDropZone } from './tab-drag-data'

export type HoveredTabDropTarget = {
  groupId: string
  zone: TabDropZone
  panelRect?: DOMRect
}

/** Derives the in-flight hover state of a tab drag: the live preview tab to
 *  activate (deduped through private memo refs) and the hovered pane-column
 *  split target, delegating tab-strip insertion to the injected tabInsertion. */
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
} {
  const [hoveredDropTarget, setHoveredDropTarget] = useState<HoveredTabDropTarget | null>(null)
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
      applyDragPreviewTab({
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
    [
      dragGeometryRef,
      tabInsertion,
      updateDragPreviewActivation,
      updateHoveredDropTargetFromSplit,
      worktreeId
    ]
  )

  const clear = useCallback(() => {
    setHoveredDropTarget(null)
    lastPreviewRef.current = null
    lastHoveredTabPreviewRef.current = null
  }, [])

  return { clear, handleDragUpdate, hoveredDropTarget }
}
