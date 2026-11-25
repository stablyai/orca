import {
  requestVirtualizedScrollAnchorRecord,
  supersedeVirtualizedScrollAnchorRestore
} from '@/lib/list-interaction/virtualized-scrolling/requestVirtualizedScrollAnchorRecord'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { computeProjectGroupHeaderDropPreview } from './project-group-header-drop'
import { commitProjectGroupHeaderDragDrop } from './project-group-header-drag-commit'
import {
  INITIAL_PROJECT_GROUP_DRAG_STATE,
  PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX,
  type ProjectGroupDragState,
  type ProjectGroupHeaderDragController,
  type ProjectGroupHeaderDragSession,
  type UseProjectGroupHeaderDragArgs
} from './project-group-header-drag-contract'
import {
  createProjectGroupHeaderDragSession,
  measureProjectGroupHeaderSessionRects
} from './project-group-header-drag-start'
import {
  computeProjectGroupHeaderNestingDrop,
  type ProjectGroupHeaderDrop
} from './project-group-header-nesting-drop'
import { getWorktreeSidebarDragAutoscroll } from './worktree-sidebar-drag-autoscroll'
import { hasPointerBeenReleased } from './header-drag-pointer-release'
import { swallowNextClickOnDragHandle } from './header-drag-click-swallow'
import {
  getProjectGroupDragStateForDrop,
  isSameProjectGroupDragState
} from './project-group-header-drag-preview'
import { useHeaderDragBodyCursor } from './header-drag-body-cursor'

// Virtualized rows can unmount during drag; pointer events and cached model indices keep drops stable.

export function useProjectGroupHeaderDrag({
  sidebarProjectGroupHeaderIdsByBucket,
  projectGroupById,
  onCommitProjectGroupTabOrder,
  rootProjectHeaderKeys,
  onCommitRootProjectOrder,
  getScrollContainer,
  floatingPreview = false,
  nesting
}: UseProjectGroupHeaderDragArgs): ProjectGroupHeaderDragController {
  const [state, setState] = useState<ProjectGroupDragState>(INITIAL_PROJECT_GROUP_DRAG_STATE)
  const [sessionArmed, setSessionArmed] = useState(false)
  const latestDropIndexRef = useRef<number | null>(null)
  latestDropIndexRef.current = state.dropIndex
  const sidebarProjectGroupHeaderIdsByBucketRef = useRef(sidebarProjectGroupHeaderIdsByBucket)
  sidebarProjectGroupHeaderIdsByBucketRef.current = sidebarProjectGroupHeaderIdsByBucket
  const projectGroupByIdRef = useRef(projectGroupById)
  projectGroupByIdRef.current = projectGroupById
  const onCommitProjectGroupTabOrderRef = useRef(onCommitProjectGroupTabOrder)
  onCommitProjectGroupTabOrderRef.current = onCommitProjectGroupTabOrder
  const rootDragRef = useRef({ rootProjectHeaderKeys, onCommitRootProjectOrder, nesting })
  useLayoutEffect(() => {
    rootDragRef.current = { rootProjectHeaderKeys, onCommitRootProjectOrder, nesting }
  }, [rootProjectHeaderKeys, onCommitRootProjectOrder, nesting])
  const getContainerRef = useRef(getScrollContainer)
  getContainerRef.current = getScrollContainer
  const autoscrollLastFrameTimeRef = useRef<number | null>(null)
  const autoscrollFrameIdRef = useRef<number | null>(null)

  const dragSessionRef = useRef<ProjectGroupHeaderDragSession | null>(null)
  const clickSwallowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshHeaderRects = useCallback(() => {
    const container = getContainerRef.current()
    const session = dragSessionRef.current
    if (!container || !session) {
      return []
    }
    const rects = measureProjectGroupHeaderSessionRects(container, session)
    session.headerRects = rects
    return rects
  }, [])

  const computeDrop = useCallback((pointerY: number): ProjectGroupHeaderDrop | null => {
    const session = dragSessionRef.current
    const container = getContainerRef.current()
    if (!session || !container) {
      return null
    }
    const computeReorder = () =>
      computeProjectGroupHeaderDropPreview({
        pointerY,
        containerTop: container.getBoundingClientRect().top,
        scrollTop: container.scrollTop,
        rects: session.headerRects,
        sidebarProjectGroupHeaderIds: session.sidebarProjectGroupHeaderIds,
        contentBottom: container.scrollHeight
      })
    const groupNesting = rootDragRef.current.nesting
    return groupNesting
      ? computeProjectGroupHeaderNestingDrop({
          nesting: groupNesting,
          session,
          container,
          pointerY,
          computeReorder
        })
      : computeReorder()
  }, [])

  const applyDrop = useCallback(
    (groupId: string, drop: ProjectGroupHeaderDrop | null) => {
      latestDropIndexRef.current = drop?.dropIndex ?? null
      const session = dragSessionRef.current
      if (session) {
        session.nestingDrop = drop?.nestingDrop
      }
      const nextState = getProjectGroupDragStateForDrop(floatingPreview, session, groupId, drop)
      setState((prev) => (isSameProjectGroupDragState(prev, nextState) ? prev : nextState))
    },
    [floatingPreview]
  )

  const cancelAutoscroll = useCallback(() => {
    if (autoscrollFrameIdRef.current !== null) {
      window.cancelAnimationFrame(autoscrollFrameIdRef.current)
      autoscrollFrameIdRef.current = null
    }
    autoscrollLastFrameTimeRef.current = null
  }, [])

  const endDrag = useCallback(
    (commit: boolean) => {
      cancelAutoscroll()
      const session = dragSessionRef.current
      if (!session) {
        setState(INITIAL_PROJECT_GROUP_DRAG_STATE)
        setSessionArmed(false)
        return
      }
      try {
        session.handleEl.releasePointerCapture(session.pointerId)
      } catch {
        // Pointer cancellation or unmount may already have released capture.
      }
      if (session.promoted) {
        clickSwallowTimeoutRef.current = swallowNextClickOnDragHandle(session.handleEl)
      }
      const sidebarDropIndex =
        commit && session.promoted && latestDropIndexRef.current !== null
          ? latestDropIndexRef.current
          : null
      const nestingDrop = commit && session.promoted ? session.nestingDrop : undefined
      dragSessionRef.current = null
      setState(INITIAL_PROJECT_GROUP_DRAG_STATE)
      setSessionArmed(false)
      if (nestingDrop) {
        rootDragRef.current.nesting?.onCommitParent(session.groupId, nestingDrop)
        return
      }
      if (sidebarDropIndex === null) {
        return
      }

      commitProjectGroupHeaderDragDrop({
        session,
        sidebarDropIndex,
        onCommitRootProjectOrder: rootDragRef.current.onCommitRootProjectOrder,
        projectGroupById: projectGroupByIdRef.current,
        onCommitProjectGroupTabOrder: onCommitProjectGroupTabOrderRef.current
      })
    },
    [cancelAutoscroll]
  )

  const runAutoscrollFrame = useCallback(
    function runFrame(frameTime: number) {
      autoscrollFrameIdRef.current = null
      const session = dragSessionRef.current
      const container = getContainerRef.current()
      if (!session?.promoted || !container) {
        cancelAutoscroll()
        return
      }

      const previousFrameTime = autoscrollLastFrameTimeRef.current ?? frameTime
      autoscrollLastFrameTimeRef.current = frameTime
      const containerRect = container.getBoundingClientRect()
      const autoscroll = getWorktreeSidebarDragAutoscroll({
        point: { clientX: containerRect.left, clientY: session.latestPointerY },
        containerRect,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        elapsedMs: frameTime - previousFrameTime
      })
      if (autoscroll) {
        supersedeVirtualizedScrollAnchorRestore(container, autoscroll.scrollTop)
        container.scrollTop = autoscroll.scrollTop
        requestVirtualizedScrollAnchorRecord(container)
        refreshHeaderRects()
      }

      applyDrop(session.groupId, computeDrop(session.latestPointerY))

      autoscrollFrameIdRef.current = window.requestAnimationFrame(runFrame)
    },
    [applyDrop, cancelAutoscroll, computeDrop, refreshHeaderRects]
  )

  const ensureAutoscroll = useCallback(() => {
    if (autoscrollFrameIdRef.current !== null) {
      return
    }
    autoscrollLastFrameTimeRef.current = null
    autoscrollFrameIdRef.current = window.requestAnimationFrame(runAutoscrollFrame)
  }, [runAutoscrollFrame])

  useEffect(() => {
    if (!sessionArmed) {
      return
    }
    const onPointerMove = (event: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || event.pointerId !== session.pointerId) {
        return
      }
      if (hasPointerBeenReleased(event)) {
        endDrag(false)
        return
      }
      session.latestPointerY = event.clientY
      if (!session.promoted) {
        const dx = event.clientX - session.startX
        const dy = event.clientY - session.startY
        if (
          dx * dx + dy * dy <
          PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX * PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX
        ) {
          return
        }
        session.promoted = true
        // Virtualization may detach headers; global listeners keep dragging alive without capture.
        if (session.handleEl.isConnected) {
          try {
            session.handleEl.setPointerCapture(session.pointerId)
          } catch {}
        }
        refreshHeaderRects()
        setState({ draggingGroupId: session.groupId, dropIndex: null, dropIndicatorY: null })
      }
      refreshHeaderRects()
      applyDrop(session.groupId, computeDrop(event.clientY))
      ensureAutoscroll()
    }
    const onPointerUp = (event: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || event.pointerId !== session.pointerId) {
        return
      }
      endDrag(true)
    }
    const onPointerCancel = (event: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || event.pointerId !== session.pointerId) {
        return
      }
      endDrag(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        endDrag(false)
      }
    }
    const onBlur = (): void => endDrag(false)

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
      cancelAutoscroll()
      if (clickSwallowTimeoutRef.current !== null) {
        clearTimeout(clickSwallowTimeoutRef.current)
        clickSwallowTimeoutRef.current = null
      }
    }
  }, [
    applyDrop,
    cancelAutoscroll,
    computeDrop,
    endDrag,
    ensureAutoscroll,
    refreshHeaderRects,
    sessionArmed
  ])

  useHeaderDragBodyCursor(state.draggingGroupId !== null)

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, groupId: string) => {
      const session = createProjectGroupHeaderDragSession({
        event,
        groupId,
        rootProjectHeaderKeys: rootDragRef.current.rootProjectHeaderKeys,
        canNest: rootDragRef.current.nesting !== undefined,
        projectGroupById: projectGroupByIdRef.current,
        sidebarProjectGroupHeaderIdsByBucket: sidebarProjectGroupHeaderIdsByBucketRef.current,
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
