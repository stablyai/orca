import { useCallback, useRef, useState } from 'react'

import {
  computeProjectHeaderDropPreview,
  measureProjectHeaderDragRects
} from './project-header-drop'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import { measureSidebarRootSlotDragRects } from './sidebar-root-slot-order'
import {
  INITIAL_REPO_DRAG_STATE,
  PROJECT_HEADER_DRAG_THRESHOLD_PX,
  type ProjectHeaderDragSession,
  type RepoDragState,
  type RepoHeaderDragController,
  type UseRepoHeaderDragArgs
} from './project-header-drag-contract'
import { createProjectHeaderDragSession } from './project-header-drag-start'
import { useSidebarHeaderPointerDragSession } from './sidebar-header-pointer-drag-session'

// Why pointer events instead of HTML5 DnD: rows are absolutely-positioned by
// react-virtual and unmount/remount as scroll changes, so DnD enter/leave fire
// against stale targets. With pointer events we cache the active set of repo
// header positions and compute the drop index from the live pointer Y.

export function useRepoHeaderDrag({
  orderedRepoIds,
  sidebarRepoHeaderIdsByBucket,
  sidebarRootSlots,
  repoById,
  projectGroupById,
  usesProjectGroupOrdering,
  onCommitRepoOrder,
  onCommitProjectGroupOrder,
  onCommitProjectGroupTabOrder,
  getScrollContainer
}: UseRepoHeaderDragArgs): RepoHeaderDragController {
  const [state, setState] = useState<RepoDragState>(INITIAL_REPO_DRAG_STATE)
  const [sessionArmed, setSessionArmed] = useState(false)
  const latestDropIndexRef = useRef<number | null>(null)
  latestDropIndexRef.current = state.dropIndex
  const orderedIdsRef = useRef(orderedRepoIds)
  orderedIdsRef.current = orderedRepoIds
  const sidebarRepoHeaderIdsByBucketRef = useRef(sidebarRepoHeaderIdsByBucket)
  sidebarRepoHeaderIdsByBucketRef.current = sidebarRepoHeaderIdsByBucket
  const sidebarRootSlotsRef = useRef(sidebarRootSlots)
  sidebarRootSlotsRef.current = sidebarRootSlots
  const repoByIdRef = useRef(repoById)
  repoByIdRef.current = repoById
  const projectGroupByIdRef = useRef(projectGroupById)
  projectGroupByIdRef.current = projectGroupById
  const usesProjectGroupOrderingRef = useRef(usesProjectGroupOrdering)
  usesProjectGroupOrderingRef.current = usesProjectGroupOrdering
  const onCommitRepoOrderRef = useRef(onCommitRepoOrder)
  onCommitRepoOrderRef.current = onCommitRepoOrder
  const onCommitProjectGroupOrderRef = useRef(onCommitProjectGroupOrder)
  onCommitProjectGroupOrderRef.current = onCommitProjectGroupOrder
  const onCommitProjectGroupTabOrderRef = useRef(onCommitProjectGroupTabOrder)
  onCommitProjectGroupTabOrderRef.current = onCommitProjectGroupTabOrder
  const getContainerRef = useRef(getScrollContainer)
  getContainerRef.current = getScrollContainer

  const dragSessionRef = useRef<ProjectHeaderDragSession | null>(null)
  const clickSwallowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshHeaderRects = useCallback(() => {
    const container = getContainerRef.current()
    const session = dragSessionRef.current
    if (!container || !session) {
      return []
    }
    const rects = session.orderedRootSlots
      ? measureSidebarRootSlotDragRects(container)
      : measureProjectHeaderDragRects(container, session.bucketKey)
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
      return computeProjectHeaderDropPreview({
        pointerY,
        containerTop: container.getBoundingClientRect().top,
        scrollTop: container.scrollTop,
        rects: session.headerRects,
        sidebarRepoHeaderIds: session.sidebarRepoHeaderIds,
        contentBottom: container.scrollHeight
      })
    },
    []
  )

  const applyDrop = useCallback(
    (repoId: string, drop: { dropIndex: number; dropIndicatorY: number } | null) => {
      latestDropIndexRef.current = drop?.dropIndex ?? null
      const nextState: RepoDragState = drop
        ? { draggingRepoId: repoId, ...drop }
        : { draggingRepoId: repoId, dropIndex: null, dropIndicatorY: null }
      setState((prev) =>
        prev.draggingRepoId === nextState.draggingRepoId &&
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
      dragThresholdPx: PROJECT_HEADER_DRAG_THRESHOLD_PX,
      isDragging: state.draggingRepoId !== null,
      refreshHeaderRects,
      onPromoted: (session) => {
        setState({ draggingRepoId: session.repoId, dropIndex: null, dropIndicatorY: null })
      },
      onPointerMoveDrop: (session, clientY) => {
        applyDrop(session.repoId, computeDrop(clientY))
      },
      endDrag: (commit) => endDragRef.current(commit)
    })

  const endDrag = useCallback(
    (commit: boolean) => {
      cancelAutoscroll()
      const session = dragSessionRef.current
      if (!session) {
        setState(INITIAL_REPO_DRAG_STATE)
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
      setState(INITIAL_REPO_DRAG_STATE)
      setSessionArmed(false)
      if (sidebarDropIndex === null) {
        return
      }
      commitProjectHeaderDragDrop({
        session,
        sidebarDropIndex,
        orderedRepoIds: orderedIdsRef.current,
        repoById: repoByIdRef.current,
        projectGroupById: projectGroupByIdRef.current,
        usesProjectGroupOrdering: usesProjectGroupOrderingRef.current,
        onCommitRepoOrder: onCommitRepoOrderRef.current,
        onCommitProjectGroupOrder: onCommitProjectGroupOrderRef.current,
        onCommitProjectGroupTabOrder: onCommitProjectGroupTabOrderRef.current
      })
    },
    [armClickSwallow, cancelAutoscroll, releasePointerCapture]
  )
  endDragRef.current = endDrag

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, repoId: string) => {
      const session = createProjectHeaderDragSession({
        event,
        repoId,
        repoById: repoByIdRef.current,
        sidebarRepoHeaderIdsByBucket: sidebarRepoHeaderIdsByBucketRef.current,
        sidebarRootSlots: sidebarRootSlotsRef.current,
        usesProjectGroupOrdering: usesProjectGroupOrderingRef.current,
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
  isRepoHeaderActionTarget,
  isProjectHeaderDragHandleTarget
} from './project-header-drag-contract'
