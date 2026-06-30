import { useRef } from 'react'

import {
  computeGroupHeaderDropPreview,
  measureGroupHeaderDragRects,
  type GroupHeaderDropPreview
} from './group-header-drop'
import { commitGroupHeaderDragDrop } from './group-header-drag-commit'
import {
  GROUP_HEADER_DRAG_THRESHOLD_PX,
  INITIAL_GROUP_DRAG_STATE,
  type GroupDragState,
  type GroupHeaderDragController,
  type GroupHeaderDragSession,
  type UseGroupHeaderDragArgs
} from './group-header-drag-contract'
import { createGroupHeaderDragSession } from './group-header-drag-start'
import { useSidebarHeaderPointerDrag } from './sidebar-header-pointer-drag'
import { collectHeaderDragBlockRowElements } from './header-drag-preview-rows'

export function useGroupHeaderDrag(args: UseGroupHeaderDragArgs): GroupHeaderDragController {
  const argsRef = useRef(args)
  argsRef.current = args
  return useSidebarHeaderPointerDrag<
    GroupHeaderDragSession,
    GroupDragState,
    GroupHeaderDropPreview
  >({
    threshold: GROUP_HEADER_DRAG_THRESHOLD_PX,
    initialState: INITIAL_GROUP_DRAG_STATE,
    getScrollContainer: () => argsRef.current.getScrollContainer(),
    getSessionId: (session) => session.groupId,
    getDraggingId: (dragState) => dragState.draggingGroupId,
    createSession: (event, groupId) =>
      createGroupHeaderDragSession({
        event,
        groupId,
        groupsById: argsRef.current.groupsById,
        siblingGroupIdsByParent: argsRef.current.siblingGroupIdsByParent,
        getScrollContainer: argsRef.current.getScrollContainer
      }),
    measureRects: (container, session) => {
      session.headerRects = measureGroupHeaderDragRects(container, session.parentGroupId)
    },
    getDragPreviewRows: (session) =>
      collectHeaderDragBlockRowElements({
        headerEl: session.handleEl,
        mode: 'group',
        parentAttr: session.parentGroupId ?? ''
      }),
    computeDrop: (session, container) => {
      const containerRect = container.getBoundingClientRect()
      return computeGroupHeaderDropPreview({
        pointerY: session.latestPointerY,
        containerTop: containerRect.top,
        scrollTop: container.scrollTop,
        rects: session.headerRects,
        siblingGroupIds: session.siblingGroupIds
      })
    },
    buildState: (groupId, drop) =>
      drop
        ? {
            draggingGroupId: groupId,
            dropIndex: drop.dropIndex,
            dropIndicatorY: drop.dropIndicatorY
          }
        : { draggingGroupId: groupId, dropIndex: null, dropIndicatorY: null },
    areStatesEqual: (a, b) =>
      a.draggingGroupId === b.draggingGroupId &&
      a.dropIndex === b.dropIndex &&
      a.dropIndicatorY === b.dropIndicatorY,
    commit: (session, drop) => {
      commitGroupHeaderDragDrop({
        session,
        sidebarDropIndex: drop.dropIndex,
        groupsById: argsRef.current.groupsById,
        onCommitGroupOrder: argsRef.current.onCommitGroupOrder
      })
    }
  })
}

export { isGroupHeaderDragHandleTarget } from './group-header-drag-contract'
