import { useCallback, useEffect, useRef, useState } from 'react'

import {
  computeProjectGroupHeaderDropPreview,
  measureProjectGroupHeaderDragRects
} from './project-group-header-drop'
import { commitProjectGroupHeaderDragDrop } from './project-group-header-drag-commit'
import {
  INITIAL_PROJECT_GROUP_DRAG_STATE,
  PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX,
  type ProjectGroupDragState,
  type ProjectGroupHeaderDragController,
  type ProjectGroupHeaderDragSession,
  type UseProjectGroupHeaderDragArgs
} from './project-group-header-drag-contract'
import { createProjectGroupHeaderDragSession } from './project-group-header-drag-start'
import { getWorktreeSidebarDragAutoscroll } from './worktree-sidebar-drag-autoscroll'

// Why pointer events instead of HTML5 DnD: Project Group rows are virtualized
// and may unmount while scrolling; cached row-model indices keep drops stable.

export function useProjectGroupHeaderDrag({
  sidebarProjectGroupHeaderIdsByBucket,
  projectGroupById,
  onCommitProjectGroupTabOrder,
  getScrollContainer
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
    const rects = measureProjectGroupHeaderDragRects(container, session.bucketKey)
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
        sidebarProjectGroupHeaderIds: session.sidebarProjectGroupHeaderIds
      })
    },
    []
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
        // capture may already be released (pointercancel, element unmounted)
      }
      if (session.promoted) {
        const handleEl = session.handleEl
        const swallow = (event: MouseEvent): void => {
          const target = event.target as Node | null
          if (target && handleEl.contains(target)) {
            event.stopPropagation()
            event.preventDefault()
          }
          window.removeEventListener('click', swallow, true)
        }
        window.addEventListener('click', swallow, true)
        clickSwallowTimeoutRef.current = setTimeout(() => {
          window.removeEventListener('click', swallow, true)
          clickSwallowTimeoutRef.current = null
        }, 0)
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
        onCommitProjectGroupTabOrder: onCommitProjectGroupTabOrderRef.current
      })
    },
    [cancelAutoscroll]
  )

  const runAutoscrollFrame = useCallback(
    (frameTime: number) => {
      autoscrollFrameIdRef.current = null
      const session = dragSessionRef.current
      const container = getContainerRef.current()
      if (!session?.promoted || !container) {
        cancelAutoscroll()
        return
      }

      const previousFrameTime = autoscrollLastFrameTimeRef.current ?? frameTime
      autoscrollLastFrameTimeRef.current = frameTime
      const autoscroll = getWorktreeSidebarDragAutoscroll({
        point: { clientX: 0, clientY: session.latestPointerY },
        containerRect: container.getBoundingClientRect(),
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        elapsedMs: frameTime - previousFrameTime
      })
      if (autoscroll) {
        container.scrollTop = autoscroll.scrollTop
        refreshHeaderRects()
      }

      const drop = computeDrop(session.latestPointerY)
      if (drop) {
        setState((prev) =>
          prev.dropIndex === drop.dropIndex && prev.dropIndicatorY === drop.dropIndicatorY
            ? prev
            : { draggingGroupId: session.groupId, ...drop }
        )
      }

      autoscrollFrameIdRef.current = window.requestAnimationFrame(runAutoscrollFrame)
    },
    [cancelAutoscroll, computeDrop, refreshHeaderRects]
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
        // Why: virtualized headers may detach during drag; global listeners
        // still keep the operation alive if pointer capture is unavailable.
        if (session.handleEl.isConnected) {
          try {
            session.handleEl.setPointerCapture(session.pointerId)
          } catch {
            // Ignore capture failure; global listeners will handle the drag.
          }
        }
        refreshHeaderRects()
        setState({ draggingGroupId: session.groupId, dropIndex: null, dropIndicatorY: null })
      }
      refreshHeaderRects()
      const drop = computeDrop(event.clientY)
      if (drop) {
        setState((prev) =>
          prev.dropIndex === drop.dropIndex && prev.dropIndicatorY === drop.dropIndicatorY
            ? prev
            : { draggingGroupId: session.groupId, ...drop }
        )
      }
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
  }, [cancelAutoscroll, computeDrop, endDrag, ensureAutoscroll, refreshHeaderRects, sessionArmed])

  useEffect(() => {
    if (state.draggingGroupId === null) {
      return
    }
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'grabbing'
    body.style.userSelect = 'none'
    return () => {
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
    }
  }, [state.draggingGroupId])

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, groupId: string) => {
      const session = createProjectGroupHeaderDragSession({
        event,
        groupId,
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

export {
  isProjectGroupHeaderActionTarget,
  isProjectGroupHeaderDragHandleTarget
} from './project-group-header-drag-contract'
