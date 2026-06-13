import { useCallback, useEffect, useRef, useState } from 'react'

import {
  computeProjectHeaderDropPreview,
  measureProjectHeaderDragRects
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
import { getWorktreeSidebarDragAutoscroll } from './worktree-sidebar-drag-autoscroll'

// Why pointer events instead of HTML5 DnD: rows are absolutely-positioned by
// react-virtual and unmount/remount as scroll changes, so DnD enter/leave fire
// against stale targets. With pointer events we cache the active set of repo
// header positions and compute the drop index from the live pointer Y.

export function useRepoHeaderDrag({
  orderedRepoIds,
  sidebarRepoHeaderIdsByBucket,
  repoById,
  usesProjectGroupOrdering,
  onCommitRepoOrder,
  onCommitProjectGroupOrder,
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
  const repoByIdRef = useRef(repoById)
  repoByIdRef.current = repoById
  const usesProjectGroupOrderingRef = useRef(usesProjectGroupOrdering)
  usesProjectGroupOrderingRef.current = usesProjectGroupOrdering
  const onCommitRepoOrderRef = useRef(onCommitRepoOrder)
  onCommitRepoOrderRef.current = onCommitRepoOrder
  const onCommitProjectGroupOrderRef = useRef(onCommitProjectGroupOrder)
  onCommitProjectGroupOrderRef.current = onCommitProjectGroupOrder
  const getContainerRef = useRef(getScrollContainer)
  getContainerRef.current = getScrollContainer
  const autoscrollLastFrameTimeRef = useRef<number | null>(null)
  const autoscrollFrameIdRef = useRef<number | null>(null)

  const dragSessionRef = useRef<ProjectHeaderDragSession | null>(null)

  const refreshHeaderRects = useCallback(() => {
    const container = getContainerRef.current()
    const session = dragSessionRef.current
    if (!container || !session) {
      return []
    }
    const rects = measureProjectHeaderDragRects(container, session.bucketKey)
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
      return computeProjectHeaderDropPreview({
        pointerY,
        containerTop: containerRect.top,
        scrollTop: container.scrollTop,
        rects: session.headerRects,
        sidebarRepoHeaderIds: session.sidebarRepoHeaderIds
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
        setState(INITIAL_REPO_DRAG_STATE)
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
        const swallow = (e: MouseEvent): void => {
          const target = e.target as Node | null
          if (target && handleEl.contains(target)) {
            e.stopPropagation()
            e.preventDefault()
          }
          window.removeEventListener('click', swallow, true)
        }
        window.addEventListener('click', swallow, true)
        setTimeout(() => window.removeEventListener('click', swallow, true), 0)
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
        usesProjectGroupOrdering: usesProjectGroupOrderingRef.current,
        onCommitRepoOrder: onCommitRepoOrderRef.current,
        onCommitProjectGroupOrder: onCommitProjectGroupOrderRef.current
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
            : { draggingRepoId: session.repoId, ...drop }
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
    const onPointerMove = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || e.pointerId !== session.pointerId) {
        return
      }
      session.latestPointerY = e.clientY
      if (!session.promoted) {
        const dx = e.clientX - session.startX
        const dy = e.clientY - session.startY
        if (
          dx * dx + dy * dy <
          PROJECT_HEADER_DRAG_THRESHOLD_PX * PROJECT_HEADER_DRAG_THRESHOLD_PX
        ) {
          return
        }
        session.promoted = true
        try {
          session.handleEl.setPointerCapture(session.pointerId)
        } catch {
          // setPointerCapture can throw if the element is detached; the global
          // pointer listeners still fire, so dragging keeps working.
        }
        refreshHeaderRects()
        setState({ draggingRepoId: session.repoId, dropIndex: null, dropIndicatorY: null })
      }
      refreshHeaderRects()
      const drop = computeDrop(e.clientY)
      if (drop) {
        setState((prev) =>
          prev.dropIndex === drop.dropIndex && prev.dropIndicatorY === drop.dropIndicatorY
            ? prev
            : { draggingRepoId: session.repoId, ...drop }
        )
      }
      ensureAutoscroll()
    }
    const onPointerUp = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || e.pointerId !== session.pointerId) {
        return
      }
      endDrag(true)
    }
    const onPointerCancel = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || e.pointerId !== session.pointerId) {
        return
      }
      endDrag(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
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
    }
  }, [cancelAutoscroll, computeDrop, endDrag, ensureAutoscroll, refreshHeaderRects, sessionArmed])

  useEffect(() => {
    if (state.draggingRepoId === null) {
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
  }, [state.draggingRepoId])

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, repoId: string) => {
      const session = createProjectHeaderDragSession({
        event,
        repoId,
        repoById: repoByIdRef.current,
        sidebarRepoHeaderIdsByBucket: sidebarRepoHeaderIdsByBucketRef.current,
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
