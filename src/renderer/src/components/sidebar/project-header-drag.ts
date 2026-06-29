import { useRef } from 'react'

import {
  computeProjectHeaderDropPreview,
  measureProjectHeaderDragRects,
  type ProjectHeaderDropPreview
} from './project-header-drop'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import {
  INITIAL_REPO_DRAG_STATE,
  PROJECT_HEADER_DRAG_THRESHOLD_PX,
  type ProjectHeaderDragSession,
  type RepoDragState,
  type RepoHeaderDragController,
  type UseRepoHeaderDragArgs
} from './project-header-drag-contract'
import { createProjectHeaderDragSession } from './project-header-drag-start'
import { useSidebarHeaderPointerDrag } from './sidebar-header-pointer-drag'

export function useRepoHeaderDrag(args: UseRepoHeaderDragArgs): RepoHeaderDragController {
  const argsRef = useRef(args)
  argsRef.current = args
  return useSidebarHeaderPointerDrag<
    ProjectHeaderDragSession,
    RepoDragState,
    ProjectHeaderDropPreview
  >({
    threshold: PROJECT_HEADER_DRAG_THRESHOLD_PX,
    initialState: INITIAL_REPO_DRAG_STATE,
    getScrollContainer: () => argsRef.current.getScrollContainer(),
    getSessionId: (session) => session.repoId,
    getDraggingId: (dragState) => dragState.draggingRepoId,
    createSession: (event, repoId) =>
      createProjectHeaderDragSession({
        event,
        repoId,
        repoById: argsRef.current.repoById,
        sidebarRepoHeaderIdsByBucket: argsRef.current.sidebarRepoHeaderIdsByBucket,
        getScrollContainer: argsRef.current.getScrollContainer
      }),
    measureRects: (container, session) => {
      session.headerRects = measureProjectHeaderDragRects(container, session.bucketKey)
    },
    computeDrop: (session, container) => {
      const containerRect = container.getBoundingClientRect()
      return computeProjectHeaderDropPreview({
        pointerY: session.latestPointerY,
        containerTop: containerRect.top,
        scrollTop: container.scrollTop,
        rects: session.headerRects,
        sidebarRepoHeaderIds: session.sidebarRepoHeaderIds
      })
    },
    buildState: (repoId, drop) =>
      drop
        ? { draggingRepoId: repoId, dropIndex: drop.dropIndex, dropIndicatorY: drop.dropIndicatorY }
        : { draggingRepoId: repoId, dropIndex: null, dropIndicatorY: null },
    areStatesEqual: (a, b) =>
      a.draggingRepoId === b.draggingRepoId &&
      a.dropIndex === b.dropIndex &&
      a.dropIndicatorY === b.dropIndicatorY,
    commit: (session, drop) => {
      commitProjectHeaderDragDrop({
        session,
        sidebarDropIndex: drop.dropIndex,
        orderedRepoIds: argsRef.current.orderedRepoIds,
        repoById: argsRef.current.repoById,
        usesProjectGroupOrdering: argsRef.current.usesProjectGroupOrdering,
        onCommitRepoOrder: argsRef.current.onCommitRepoOrder,
        onCommitProjectGroupOrder: argsRef.current.onCommitProjectGroupOrder
      })
    }
  })
}

export {
  isRepoHeaderActionTarget,
  isProjectHeaderDragHandleTarget
} from './project-header-drag-contract'
