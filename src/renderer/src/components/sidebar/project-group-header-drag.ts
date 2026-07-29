import { useCallback, useRef, useState } from 'react'

import {
  computeProjectGroupHeaderDropPreview,
  measureProjectGroupHeaderDragRects
} from './project-group-header-drop'
import { commitProjectGroupHeaderDragDrop } from './project-group-header-drag-commit'
import { measureSidebarRootSlotDragRects } from './sidebar-root-slot-order'
import {
  INITIAL_PROJECT_GROUP_DRAG_STATE,
  PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX,
  type ProjectGroupDragState,
  type ProjectGroupHeaderDragController,
  type ProjectGroupHeaderDragSession,
  type UseProjectGroupHeaderDragArgs
} from './project-group-header-drag-contract'
import { createProjectGroupHeaderDragSession } from './project-group-header-drag-start'
import { useSidebarHeaderPointerDragSession } from './sidebar-header-pointer-drag-session'

// Why pointer events instead of HTML5 DnD: Project Group rows are virtualized
// and may unmount while scrolling; cached row-model indices keep drops stable.

export function useProjectGroupHeaderDrag({
  sidebarProjectGroupHeaderIdsByBucket,
  sidebarRootSlots,
  projectGroupById,
  repoById,
  onCommitProjectGroupTabOrder,
  onCommitProjectGroupOrder,
  getScrollContainer
}: UseProjectGroupHeaderDragArgs): ProjectGroupHeaderDragController {
  const [state, setState] = useState<ProjectGroupDragState>(INITIAL_PROJECT_GROUP_DRAG_STATE)
  const [sessionArmed, setSessionArmed] = useState(false)
  const latestDropIndexRef = useRef<number | null>(null)
  latestDropIndexRef.current = state.dropIndex
  const sidebarProjectGroupHeaderIdsByBucketRef = useRef(sidebarProjectGroupHeaderIdsByBucket)
  sidebarProjectGroupHeaderIdsByBucketRef.current = sidebarProjectGroupHeaderIdsByBucket
  const sidebarRootSlotsRef = useRef(sidebarRootSlots)
  sidebarRootSlotsRef.current = sidebarRootSlots
  const projectGroupByIdRef = useRef(projectGroupById)
  projectGroupByIdRef.current = projectGroupById
  const repoByIdRef = useRef(repoById)
  repoByIdRef.current = repoById
  const onCommitProjectGroupTabOrderRef = useRef(onCommitProjectGroupTabOrder)
  onCommitProjectGroupTabOrderRef.current = onCommitProjectGroupTabOrder
  const onCommitProjectGroupOrderRef = useRef(onCommitProjectGroupOrder)
  onCommitProjectGroupOrderRef.current = onCommitProjectGroupOrder
  const getContainerRef = useRef(getScrollContainer)
  getContainerRef.current = getScrollContainer

  const dragSessionRef = useRef<ProjectGroupHeaderDragSession | null>(null)
  const clickSwallowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshHeaderRects = useCallback(() => {
    const container = getContainerRef.current()
    const session = dragSessionRef.current
    if (!container || !session) {
      return []
    }
    const rects = session.orderedRootSlots
      ? measureSidebarRootSlotDragRects(container)
      : measureProjectGroupHeaderDragRects(container, session.bucketKey)
    session.headerRects = rects
    return rects
  }, [])

  const computeDrop = useCallback(
    (pointerY: number): { dropIndex: number; dropIndicatorY: number } | null => {
      const session = dragSessionRef.current
      const container = getContainerRef.current()
      if (!session || !container) {
        return null
      }
      const containerRect = container.getBoundingClientRect()
      return computeProjectGroupHeaderDropPreview({
        pointerY,
        containerTop: containerRect.top,
        scrollTop: container.scrollTop,
        rects: session.headerRects,
        sidebarProjectGroupHeaderIds: session.sidebarProjectGroupHeaderIds,
        contentBottom: container.scrollHeight
      })
    },
    []
  )

  const applyDrop = useCallback(
    (groupId: string, drop: { dropIndex: number; dropIndicatorY: number } | null) => {
      latestDropIndexRef.current = drop?.dropIndex ?? null
      const nextState: ProjectGroupDragState = drop
        ? { draggingGroupId: groupId, ...drop }
        : { draggingGroupId: groupId, dropIndex: null, dropIndicatorY: null }
      setState((prev) =>
        prev.draggingGroupId === nextState.draggingGroupId &&
        prev.dropIndex === nextState.dropIndex &&
        prev.dropIndicatorY === nextState.dropIndicatorY
          ? prev
          : nextState
      )
    },
    []
  )

  const endDragRef = useRef<(commit: boolean) => void>(() => {})
  const { cancelAutoscroll, releasePointerCapture, armClickSwallow } =
    useSidebarHeaderPointerDragSession({
      sessionArmed,
      dragSessionRef,
      clickSwallowTimeoutRef,
      getScrollContainer: () => getContainerRef.current(),
      dragThresholdPx: PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX,
      isDragging: state.draggingGroupId !== null,
      refreshHeaderRects,
      onPromoted: (session) => {
        setState({ draggingGroupId: session.groupId, dropIndex: null, dropIndicatorY: null })
      },
      onPointerMoveDrop: (session, clientY) => {
        applyDrop(session.groupId, computeDrop(clientY))
      },
      endDrag: (commit) => endDragRef.current(commit)
    })

  const endDrag = useCallback(
    (commit: boolean) => {
      cancelAutoscroll()
      const session = dragSessionRef.current
      if (!session) {
        setState(INITIAL_PROJECT_GROUP_DRAG_STATE)
        setSessionArmed(false)
        return
      }
      releasePointerCapture(session)
      if (session.promoted) {
        armClickSwallow(session)
      }
      const sidebarDropIndex =
        commit && session.promoted && latestDropIndexRef.current !== null
          ? latestDropIndexRef.current
          : null
      dragSessionRef.current = null
      setState(INITIAL_PROJECT_GROUP_DRAG_STATE)
      setSessionArmed(false)
      if (sidebarDropIndex === null) {
        return
      }
      commitProjectGroupHeaderDragDrop({
        session,
        sidebarDropIndex,
        projectGroupById: projectGroupByIdRef.current,
        repoById: repoByIdRef.current,
        onCommitProjectGroupTabOrder: onCommitProjectGroupTabOrderRef.current,
        onCommitProjectGroupOrder: onCommitProjectGroupOrderRef.current
      })
    },
    [armClickSwallow, cancelAutoscroll, releasePointerCapture]
  )
  endDragRef.current = endDrag

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, groupId: string) => {
      const session = createProjectGroupHeaderDragSession({
        event,
        groupId,
        projectGroupById: projectGroupByIdRef.current,
        sidebarProjectGroupHeaderIdsByBucket: sidebarProjectGroupHeaderIdsByBucketRef.current,
        sidebarRootSlots: sidebarRootSlotsRef.current,
        getScrollContainer: getContainerRef.current
      })
      if (!session) {
        return
      }
      dragSessionRef.current = session
      setSessionArmed(true)
    },
    []
  )

  return { state, onHandlePointerDown }
}

export {
  isProjectGroupHeaderActionTarget,
  isProjectGroupHeaderDragHandleTarget
} from './project-group-header-drag-contract'
