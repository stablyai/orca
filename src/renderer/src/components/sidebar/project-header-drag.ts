import { useRef } from 'react'

import {
  computeProjectHeaderDropPreviewAcrossBuckets,
  measureProjectGroupHeaderDropZones,
  measureProjectHeaderDragRects,
  type ProjectHeaderCrossBucketDropPreview
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
import { collectHeaderDragBlockRowElements } from './header-drag-preview-rows'

export function useRepoHeaderDrag(args: UseRepoHeaderDragArgs): RepoHeaderDragController {
  const argsRef = useRef(args)
  argsRef.current = args
  return useSidebarHeaderPointerDrag<
    ProjectHeaderDragSession,
    RepoDragState,
    ProjectHeaderCrossBucketDropPreview
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
        // Complete count (incl. collapsed groups) so a project stays draggable
        // when other groups are collapsed and hide their projects from the rows.
        totalProjectCount: argsRef.current.orderedRepoIds.length,
        getScrollContainer: argsRef.current.getScrollContainer
      }),
    // Why: cross-group drops need every bucket's headers, not just the source's.
    measureRects: (container, session) => {
      session.headerRects = measureProjectHeaderDragRects(container)
    },
    getDragPreviewRows: (session) =>
      collectHeaderDragBlockRowElements({ headerEl: session.handleEl, mode: 'project' }),
    computeDrop: (session, container) => {
      const containerRect = container.getBoundingClientRect()
      return computeProjectHeaderDropPreviewAcrossBuckets({
        pointerY: session.latestPointerY,
        containerTop: containerRect.top,
        scrollTop: container.scrollTop,
        repoRects: session.headerRects,
        groupZones: measureProjectGroupHeaderDropZones(container)
      })
    },
    buildState: (repoId, drop) =>
      drop
        ? {
            draggingRepoId: repoId,
            dropIndex: drop.dropIndex,
            dropIndicatorY: drop.dropIndicatorY,
            targetBucketKey: drop.targetBucketKey,
            dropIntoGroupId: drop.intoGroupId ?? null
          }
        : {
            draggingRepoId: repoId,
            dropIndex: null,
            dropIndicatorY: null,
            targetBucketKey: null,
            dropIntoGroupId: null
          },
    areStatesEqual: (a, b) =>
      a.draggingRepoId === b.draggingRepoId &&
      a.dropIndex === b.dropIndex &&
      a.dropIndicatorY === b.dropIndicatorY &&
      a.targetBucketKey === b.targetBucketKey &&
      a.dropIntoGroupId === b.dropIntoGroupId,
    commit: (session, drop) => {
      commitProjectHeaderDragDrop({
        session,
        sidebarDropIndex: drop.dropIndex,
        targetBucketKey: drop.targetBucketKey,
        sidebarRepoHeaderIdsByBucketAll: session.sidebarRepoHeaderIdsByBucketAll,
        orderedRepoIds: argsRef.current.orderedRepoIds,
        repoById: argsRef.current.repoById,
        usesProjectGroupOrdering: argsRef.current.usesProjectGroupOrdering,
        onCommitRepoOrder: argsRef.current.onCommitRepoOrder,
        onCommitProjectGroupOrder: argsRef.current.onCommitProjectGroupOrder
      })
    }
  })
}

export { isProjectHeaderDragHandleTarget } from './project-header-drag-contract'
