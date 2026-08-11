import { useCallback, useEffect, useRef, useState } from 'react'

import {
  computeProjectHeaderDropPreview,
  getProjectHeaderDragSectionHeight,
  measureProjectHeaderDragRects,
  type ProjectHeaderDropPreview
} from './project-header-drop'
import { useProjectHeaderDragCursor } from './project-header-drag-cursor'
import { endProjectHeaderDrag } from './project-header-drag-end'
import {
  EMPTY_HEADER_PREVIEW_OFFSETS,
  getProjectHeaderDragPointerOffsetY,
  haveSameHeaderPreviewOffsets,
  INITIAL_REPO_DRAG_STATE,
  PROJECT_HEADER_DRAG_THRESHOLD_PX,
  type ProjectHeaderDragSession,
  type RepoDragState,
  type RepoHeaderDragController,
  type UseRepoHeaderDragArgs
} from './project-header-drag-contract'
import { createProjectHeaderDragSession } from './project-header-drag-start'
import { useProjectHeaderDragAutoscroll } from './project-header-drag-autoscroll'

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
  const latestDropPreviewRef = useRef<ProjectHeaderDropPreview | null>(null)
  const settlingRef = useRef(false)
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
  const dragSessionRef = useRef<ProjectHeaderDragSession | null>(null)
  const clickSwallowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshHeaderRects = useCallback(() => {
    const container = getContainerRef.current()
    const session = dragSessionRef.current
    if (!container || !session) {
      return []
    }
    const rects = measureProjectHeaderDragRects(container, session.bucketKey)
    session.headerRects = rects
    const sectionHeight = getProjectHeaderDragSectionHeight(rects, session.repoId)
    if (sectionHeight > 0) {
      session.draggedSectionHeight = sectionHeight
    }
    return rects
  }, [])

  const computeDrop = useCallback((pointerY: number): ProjectHeaderDropPreview | null => {
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
      draggedRepoId: session.repoId,
      draggedSectionHeight: session.draggedSectionHeight,
      contentBottom: container.scrollHeight
    })
  }, [])

  const pointerOffsetY = useCallback((session: ProjectHeaderDragSession): number => {
    return getProjectHeaderDragPointerOffsetY(session, getContainerRef.current())
  }, [])

  const applyDrop = useCallback(
    (repoId: string, drop: ProjectHeaderDropPreview | null, pointerOffsetY: number | null) => {
      latestDropIndexRef.current = drop?.dropIndex ?? null
      latestDropPreviewRef.current = drop
      const nextState: RepoDragState = drop
        ? { draggingRepoId: repoId, pointerOffsetY, settling: false, ...drop }
        : {
            draggingRepoId: repoId,
            pointerOffsetY,
            settling: false,
            dropIndex: null,
            dropIndicatorY: null,
            dropPlaceholderY: null,
            dropPlaceholderHeight: 0,
            previewOffsetsByRepoId: EMPTY_HEADER_PREVIEW_OFFSETS
          }
      setState((prev) =>
        prev.draggingRepoId === nextState.draggingRepoId &&
        prev.dropIndex === nextState.dropIndex &&
        prev.dropIndicatorY === nextState.dropIndicatorY &&
        prev.dropPlaceholderY === nextState.dropPlaceholderY &&
        prev.dropPlaceholderHeight === nextState.dropPlaceholderHeight &&
        prev.settling === nextState.settling &&
        // Why: the pointer delta moves on nearly every frame, so it has to take
        // part in the bail-out or the dragged header would never re-render.
        prev.pointerOffsetY === nextState.pointerOffsetY &&
        haveSameHeaderPreviewOffsets(prev.previewOffsetsByRepoId, nextState.previewOffsetsByRepoId)
          ? prev
          : nextState
      )
    },
    []
  )

  const { ensureAutoscroll, cancelAutoscroll } = useProjectHeaderDragAutoscroll({
    dragSessionRef,
    getScrollContainerRef: getContainerRef,
    refreshHeaderRects,
    onFrame: (session) =>
      applyDrop(session.repoId, computeDrop(session.latestPointerY), pointerOffsetY(session))
  })

  const endDrag = useCallback(
    (commit: boolean) => {
      cancelAutoscroll()
      setSessionArmed(false)
      const session = dragSessionRef.current
      dragSessionRef.current = null
      endProjectHeaderDrag({
        commit,
        session,
        dropIndex: latestDropIndexRef.current,
        dropPreview: latestDropPreviewRef.current,
        orderedRepoIds: orderedIdsRef.current,
        repoById: repoByIdRef.current,
        usesProjectGroupOrdering: usesProjectGroupOrderingRef.current,
        onCommitRepoOrder: onCommitRepoOrderRef.current,
        onCommitProjectGroupOrder: onCommitProjectGroupOrderRef.current,
        onSettle: (offsetY) => {
          settlingRef.current = true
          setState((current) => ({ ...current, pointerOffsetY: offsetY, settling: true }))
        },
        onFinish: () => {
          settlingRef.current = false
          latestDropIndexRef.current = null
          latestDropPreviewRef.current = null
          setState(INITIAL_REPO_DRAG_STATE)
        },
        onClickSwallowTimeout: (timeout) => {
          clickSwallowTimeoutRef.current = timeout
        }
      })
    },
    [cancelAutoscroll]
  )

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
        // Why: setPointerCapture can throw if the element is detached. Check
        // isConnected first to avoid the throw; the global pointer listeners
        // still fire, so dragging keeps working even if capture fails.
        if (session.handleEl.isConnected) {
          try {
            session.handleEl.setPointerCapture(session.pointerId)
          } catch {
            // Ignore capture failure; global listeners will handle the drag.
          }
        }
        refreshHeaderRects()
        setState({
          draggingRepoId: session.repoId,
          pointerOffsetY: pointerOffsetY(session),
          settling: false,
          dropIndex: null,
          dropIndicatorY: null,
          dropPlaceholderY: null,
          dropPlaceholderHeight: 0,
          previewOffsetsByRepoId: EMPTY_HEADER_PREVIEW_OFFSETS
        })
      }
      refreshHeaderRects()
      applyDrop(session.repoId, computeDrop(e.clientY), pointerOffsetY(session))
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
    pointerOffsetY,
    refreshHeaderRects,
    sessionArmed
  ])

  useProjectHeaderDragCursor(state.draggingRepoId !== null)

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, repoId: string) => {
      if (settlingRef.current) {
        return
      }
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
