import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'

import { getWorktreeSidebarDragAutoscroll } from './worktree-sidebar-drag-autoscroll'

export type SidebarHeaderPointerDragSessionBase = {
  pointerId: number
  handleEl: HTMLElement
  startX: number
  startY: number
  latestPointerY: number
  promoted: boolean
}

/** Shared window listeners + autoscroll for virtualized sidebar header drags. */
export function useSidebarHeaderPointerDragSession<
  TSession extends SidebarHeaderPointerDragSessionBase
>(args: {
  sessionArmed: boolean
  dragSessionRef: MutableRefObject<TSession | null>
  clickSwallowTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  getScrollContainer: () => HTMLElement | null
  dragThresholdPx: number
  isDragging: boolean
  refreshHeaderRects: () => void
  onPromoted: (session: TSession) => void
  onPointerMoveDrop: (session: TSession, clientY: number) => void
  endDrag: (commit: boolean) => void
}): {
  cancelAutoscroll: () => void
  releasePointerCapture: (session: TSession) => void
  armClickSwallow: (session: TSession) => void
} {
  const autoscrollLastFrameTimeRef = useRef<number | null>(null)
  const autoscrollFrameIdRef = useRef<number | null>(null)
  const getContainerRef = useRef(args.getScrollContainer)
  getContainerRef.current = args.getScrollContainer
  const refreshHeaderRectsRef = useRef(args.refreshHeaderRects)
  refreshHeaderRectsRef.current = args.refreshHeaderRects
  const onPointerMoveDropRef = useRef(args.onPointerMoveDrop)
  onPointerMoveDropRef.current = args.onPointerMoveDrop
  const onPromotedRef = useRef(args.onPromoted)
  onPromotedRef.current = args.onPromoted
  const endDragRef = useRef(args.endDrag)
  endDragRef.current = args.endDrag
  const dragThresholdPx = args.dragThresholdPx

  const cancelAutoscroll = useCallback(() => {
    if (autoscrollFrameIdRef.current !== null) {
      window.cancelAnimationFrame(autoscrollFrameIdRef.current)
      autoscrollFrameIdRef.current = null
    }
    autoscrollLastFrameTimeRef.current = null
  }, [])

  const runAutoscrollFrame = useCallback(
    (frameTime: number) => {
      autoscrollFrameIdRef.current = null
      const session = args.dragSessionRef.current
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
        refreshHeaderRectsRef.current()
      }
      onPointerMoveDropRef.current(session, session.latestPointerY)
      autoscrollFrameIdRef.current = window.requestAnimationFrame(runAutoscrollFrame)
    },
    [args.dragSessionRef, cancelAutoscroll]
  )

  const ensureAutoscroll = useCallback(() => {
    if (autoscrollFrameIdRef.current !== null) {
      return
    }
    autoscrollLastFrameTimeRef.current = null
    autoscrollFrameIdRef.current = window.requestAnimationFrame(runAutoscrollFrame)
  }, [runAutoscrollFrame])

  const releasePointerCapture = useCallback((session: TSession) => {
    try {
      session.handleEl.releasePointerCapture(session.pointerId)
    } catch {
      // capture may already be released (pointercancel, element unmounted)
    }
  }, [])

  const armClickSwallow = useCallback(
    (session: TSession) => {
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
      args.clickSwallowTimeoutRef.current = setTimeout(() => {
        window.removeEventListener('click', swallow, true)
        args.clickSwallowTimeoutRef.current = null
      }, 0)
    },
    [args.clickSwallowTimeoutRef]
  )

  useEffect(() => {
    if (!args.sessionArmed) {
      return
    }
    const onPointerMove = (event: PointerEvent): void => {
      const session = args.dragSessionRef.current
      if (!session || event.pointerId !== session.pointerId) {
        return
      }
      session.latestPointerY = event.clientY
      if (!session.promoted) {
        const dx = event.clientX - session.startX
        const dy = event.clientY - session.startY
        if (dx * dx + dy * dy < dragThresholdPx * dragThresholdPx) {
          return
        }
        session.promoted = true
        // Why: virtualized headers may detach; global listeners keep drag alive.
        if (session.handleEl.isConnected) {
          try {
            session.handleEl.setPointerCapture(session.pointerId)
          } catch {
            // Ignore capture failure; global listeners will handle the drag.
          }
        }
        refreshHeaderRectsRef.current()
        onPromotedRef.current(session)
      }
      refreshHeaderRectsRef.current()
      onPointerMoveDropRef.current(session, event.clientY)
      ensureAutoscroll()
    }
    const onPointerUp = (event: PointerEvent): void => {
      const session = args.dragSessionRef.current
      if (!session || event.pointerId !== session.pointerId) {
        return
      }
      endDragRef.current(true)
    }
    const onPointerCancel = (event: PointerEvent): void => {
      const session = args.dragSessionRef.current
      if (!session || event.pointerId !== session.pointerId) {
        return
      }
      endDragRef.current(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        endDragRef.current(false)
      }
    }
    const onBlur = (): void => endDragRef.current(false)

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
      if (args.clickSwallowTimeoutRef.current !== null) {
        clearTimeout(args.clickSwallowTimeoutRef.current)
        args.clickSwallowTimeoutRef.current = null
      }
    }
  }, [
    args.clickSwallowTimeoutRef,
    args.dragSessionRef,
    args.sessionArmed,
    cancelAutoscroll,
    dragThresholdPx,
    ensureAutoscroll
  ])

  useEffect(() => {
    if (!args.isDragging) {
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
  }, [args.isDragging])

  return { cancelAutoscroll, releasePointerCapture, armClickSwallow }
}
