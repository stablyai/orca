import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { getWorktreeSidebarDragAutoscroll } from './worktree-sidebar-drag-autoscroll'
import {
  createSidebarDragPreview,
  updateSidebarDragPreviewPosition
} from './worktree-sidebar-pointer-drag-dom'

/** Common fields the lifecycle reads/writes on any header drag session. */
export type SidebarHeaderDragSessionBase = {
  pointerId: number
  handleEl: HTMLElement
  startX: number
  startY: number
  latestPointerY: number
  promoted: boolean
}

/** Minimum a drop preview carries so the lifecycle can render an indicator. */
export type SidebarHeaderDragDrop = {
  dropIndex: number
  dropIndicatorY: number
}

export type SidebarHeaderPointerDragConfig<
  TSession extends SidebarHeaderDragSessionBase,
  TState,
  TDrop extends SidebarHeaderDragDrop
> = {
  threshold: number
  initialState: TState
  getScrollContainer: () => HTMLElement | null
  getSessionId: (session: TSession) => string
  getDraggingId: (state: TState) => string | null
  createSession: (event: ReactPointerEvent<HTMLElement>, id: string) => TSession | null
  measureRects: (container: HTMLElement, session: TSession) => void
  computeDrop: (session: TSession, container: HTMLElement) => TDrop | null
  buildState: (id: string, drop: TDrop | null) => TState
  areStatesEqual: (a: TState, b: TState) => boolean
  commit: (session: TSession, drop: TDrop) => void
}

export type SidebarHeaderDragController<TState> = {
  state: TState
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, id: string) => void
}

// Why pointer events instead of HTML5 DnD: rows are absolutely-positioned by
// react-virtual and unmount/remount as scroll changes, so DnD enter/leave fire
// against stale targets. We cache header positions and compute the drop index
// from the live pointer Y instead.
export function useSidebarHeaderPointerDrag<
  TSession extends SidebarHeaderDragSessionBase,
  TState,
  TDrop extends SidebarHeaderDragDrop
>(
  config: SidebarHeaderPointerDragConfig<TSession, TState, TDrop>
): SidebarHeaderDragController<TState> {
  const [state, setState] = useState<TState>(config.initialState)
  const [sessionArmed, setSessionArmed] = useState(false)
  const configRef = useRef(config)
  configRef.current = config
  const latestDropRef = useRef<TDrop | null>(null)
  const dragSessionRef = useRef<TSession | null>(null)
  const clickSwallowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoscrollLastFrameTimeRef = useRef<number | null>(null)
  const autoscrollFrameIdRef = useRef<number | null>(null)
  // Floating clone that follows the cursor, shared with the worktree drag so
  // header drags look identical (source row hides; this is the visible thing).
  const previewRef = useRef<{ preview: HTMLElement; offsetX: number; offsetY: number } | null>(null)

  const removeDragPreview = useCallback(() => {
    previewRef.current?.preview.remove()
    previewRef.current = null
  }, [])

  const refreshHeaderRects = useCallback(() => {
    const container = configRef.current.getScrollContainer()
    const session = dragSessionRef.current
    if (!container || !session) {
      return
    }
    configRef.current.measureRects(container, session)
  }, [])

  const applyDrop = useCallback((session: TSession, drop: TDrop | null) => {
    if (drop) {
      latestDropRef.current = drop
    }
    const next = configRef.current.buildState(configRef.current.getSessionId(session), drop)
    setState((prev) => (configRef.current.areStatesEqual(prev, next) ? prev : next))
  }, [])

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
      removeDragPreview()
      const session = dragSessionRef.current
      if (!session) {
        setState(configRef.current.initialState)
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
        clickSwallowTimeoutRef.current = setTimeout(() => {
          window.removeEventListener('click', swallow, true)
          clickSwallowTimeoutRef.current = null
        }, 0)
      }
      const drop = commit && session.promoted ? latestDropRef.current : null
      dragSessionRef.current = null
      latestDropRef.current = null
      setState(configRef.current.initialState)
      setSessionArmed(false)
      if (drop === null) {
        return
      }
      configRef.current.commit(session, drop)
    },
    [cancelAutoscroll, removeDragPreview]
  )

  const runAutoscrollFrame = useCallback(
    (frameTime: number) => {
      autoscrollFrameIdRef.current = null
      const session = dragSessionRef.current
      const container = configRef.current.getScrollContainer()
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
      const drop = configRef.current.computeDrop(session, container)
      // Why: same as the move handler — skip null drops to keep the last
      // indicator visible when the pointer is outside the header band.
      if (drop !== null) {
        applyDrop(session, drop)
      }
      autoscrollFrameIdRef.current = window.requestAnimationFrame(runAutoscrollFrame)
    },
    [applyDrop, cancelAutoscroll, refreshHeaderRects]
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
      const container = configRef.current.getScrollContainer()
      if (!container) {
        return
      }
      if (!session.promoted) {
        const dx = e.clientX - session.startX
        const dy = e.clientY - session.startY
        if (dx * dx + dy * dy < configRef.current.threshold * configRef.current.threshold) {
          return
        }
        session.promoted = true
        // Why: setPointerCapture throws if the element detached; the global
        // listeners still fire so dragging keeps working even if capture fails.
        if (session.handleEl.isConnected) {
          try {
            session.handleEl.setPointerCapture(session.pointerId)
          } catch {
            // Ignore capture failure; global listeners handle the drag.
          }
        }
        refreshHeaderRects()
        // Clone the header row into a floating preview that follows the cursor
        // (same primitive the worktree drag uses); the source row then hides.
        try {
          previewRef.current = createSidebarDragPreview({
            sourceRow: session.handleEl,
            pointerX: e.clientX,
            pointerY: e.clientY,
            draggedCount: 1
          })
        } catch {
          previewRef.current = null
        }
        // Why: null here is intentional — sets the initial dragging state
        // (indicator hidden) on promotion. Unlike mid-drag moves, we always
        // write this null so the dragging identity appears in state immediately.
        setState(configRef.current.buildState(configRef.current.getSessionId(session), null))
      }
      if (previewRef.current) {
        updateSidebarDragPreviewPosition({
          preview: previewRef.current.preview,
          pointerX: e.clientX,
          pointerY: e.clientY,
          offsetX: previewRef.current.offsetX,
          offsetY: previewRef.current.offsetY
        })
      }
      refreshHeaderRects()
      const drop = configRef.current.computeDrop(session, container)
      // Why: only update when the pointer is over a valid drop zone. If
      // computeDrop returns null (pointer left the header band) the last
      // indicator stays rendered, matching the original behavior.
      if (drop !== null) {
        applyDrop(session, drop)
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
      removeDragPreview()
      if (clickSwallowTimeoutRef.current !== null) {
        clearTimeout(clickSwallowTimeoutRef.current)
        clickSwallowTimeoutRef.current = null
      }
    }
  }, [
    applyDrop,
    cancelAutoscroll,
    endDrag,
    ensureAutoscroll,
    refreshHeaderRects,
    removeDragPreview,
    sessionArmed
  ])

  // Why: depend only on the dragging identity, not the full state object,
  // so the cursor/userSelect effect does not re-run every frame when only
  // drop coordinates change (matches original per-id dependency).
  const draggingId = configRef.current.getDraggingId(state)
  useEffect(() => {
    if (draggingId === null) {
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
  }, [draggingId])

  const onHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, id: string) => {
    const session = configRef.current.createSession(event, id)
    if (!session) {
      return
    }
    dragSessionRef.current = session
    latestDropRef.current = null
    setSessionArmed(true)
  }, [])

  return { state, onHandlePointerDown }
}
