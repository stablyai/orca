import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  createSidebarDragPreview,
  setSidebarPointerDragDocumentStyles,
  updateSidebarDragPreviewPosition
} from './worktree-sidebar-pointer-drag-dom'
import {
  isHostHeaderActionTarget,
  readHostHeaderRects,
  type HostHeaderRect
} from './host-header-drag-dom'

export type HostDragState = {
  draggingHostId: ExecutionHostId | null
  dropIndex: number | null
  dropIndicatorY: number | null
}

const INITIAL_STATE: HostDragState = {
  draggingHostId: null,
  dropIndex: null,
  dropIndicatorY: null
}

export type UseHostHeaderDragArgs = {
  orderedHostIds: readonly ExecutionHostId[]
  onCommit: (orderedIds: ExecutionHostId[]) => void
  getScrollContainer: () => HTMLElement | null
}

export type HostHeaderDragController = {
  state: HostDragState
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, hostId: ExecutionHostId) => void
}

const DRAG_THRESHOLD_PX = 4

export function useHostHeaderDrag({
  orderedHostIds,
  onCommit,
  getScrollContainer
}: UseHostHeaderDragArgs): HostHeaderDragController {
  const [state, setState] = useState<HostDragState>(INITIAL_STATE)
  const [sessionArmed, setSessionArmed] = useState(false)
  const latestDropIndexRef = useRef<number | null>(null)
  latestDropIndexRef.current = state.dropIndex
  const orderedIdsRef = useRef(orderedHostIds)
  orderedIdsRef.current = orderedHostIds
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const getContainerRef = useRef(getScrollContainer)
  getContainerRef.current = getScrollContainer

  const dragSessionRef = useRef<{
    hostId: ExecutionHostId
    pointerId: number
    headerRects: HostHeaderRect[]
    handleEl: HTMLElement
    startX: number
    startY: number
    promoted: boolean
    preview: HTMLElement | null
    previewOffsetX: number
    previewOffsetY: number
  } | null>(null)
  const deferredComputeFrameRef = useRef<number | null>(null)

  const clearDeferredComputeFrame = useCallback(() => {
    if (deferredComputeFrameRef.current !== null) {
      window.cancelAnimationFrame(deferredComputeFrameRef.current)
      deferredComputeFrameRef.current = null
    }
  }, [])

  const computeDrop = useCallback(
    (pointerY: number): { dropIndex: number; dropIndicatorY: number } | null => {
      const session = dragSessionRef.current
      const container = getContainerRef.current()
      if (!session || !container) {
        return null
      }
      // Why: dragging host headers temporarily collapses their sections, so
      // live rects are the source of truth after the first promoted move.
      const rects = readHostHeaderRects(container)
      if (rects.length === 0 || rects.length < orderedIdsRef.current.length) {
        return null
      }
      session.headerRects = rects
      const containerRect = container.getBoundingClientRect()
      const localY = pointerY - containerRect.top + container.scrollTop
      let insertBefore = rects.length
      for (let i = 0; i < rects.length; i++) {
        const mid = (rects[i].top + rects[i].bottom) / 2
        if (localY < mid) {
          insertBefore = i
          break
        }
      }
      const INDICATOR_GAP_PX = 4
      const rawIndicatorY =
        insertBefore >= rects.length
          ? rects.at(-1)!.bottom + INDICATOR_GAP_PX
          : Math.max(0, rects[insertBefore].top - INDICATOR_GAP_PX)
      return {
        dropIndex: insertBefore,
        dropIndicatorY: Math.max(container.scrollTop, rawIndicatorY)
      }
    },
    []
  )

  const applyDrop = useCallback((drop: { dropIndex: number; dropIndicatorY: number } | null) => {
    if (!drop) {
      return
    }
    latestDropIndexRef.current = drop.dropIndex
    setState((prev) =>
      prev.dropIndex === drop.dropIndex && prev.dropIndicatorY === drop.dropIndicatorY
        ? prev
        : { draggingHostId: dragSessionRef.current?.hostId ?? prev.draggingHostId, ...drop }
    )
  }, [])

  const scheduleDeferredDropCompute = useCallback(
    (pointerY: number) => {
      clearDeferredComputeFrame()
      deferredComputeFrameRef.current = window.requestAnimationFrame(() => {
        deferredComputeFrameRef.current = null
        applyDrop(computeDrop(pointerY))
      })
    },
    [applyDrop, clearDeferredComputeFrame, computeDrop]
  )

  const endDrag = useCallback(
    (commit: boolean, pointerY?: number) => {
      const session = dragSessionRef.current
      if (!session) {
        clearDeferredComputeFrame()
        setState(INITIAL_STATE)
        setSessionArmed(false)
        return
      }
      clearDeferredComputeFrame()
      try {
        session.handleEl.releasePointerCapture(session.pointerId)
      } catch {
        // Pointer capture may already be gone if the element unmounted.
      }
      session.preview?.remove()
      setSidebarPointerDragDocumentStyles(false)
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
      const finalIndex =
        commit && session.promoted
          ? (latestDropIndexRef.current ??
            (pointerY === undefined ? null : (computeDrop(pointerY)?.dropIndex ?? null)))
          : null
      dragSessionRef.current = null
      setState(INITIAL_STATE)
      setSessionArmed(false)
      if (finalIndex === null) {
        return
      }
      const ids = orderedIdsRef.current
      const fromIndex = ids.indexOf(session.hostId)
      if (fromIndex === -1) {
        return
      }
      const next = ids.slice()
      next.splice(fromIndex, 1)
      const insertAt = finalIndex > fromIndex ? finalIndex - 1 : finalIndex
      if (insertAt === fromIndex) {
        return
      }
      next.splice(insertAt, 0, session.hostId)
      onCommitRef.current(next)
    },
    [clearDeferredComputeFrame, computeDrop]
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
      if (!session.promoted) {
        const dx = e.clientX - session.startX
        const dy = e.clientY - session.startY
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          return
        }
        session.promoted = true
        const { preview, offsetX, offsetY } = createSidebarDragPreview({
          sourceRow: session.handleEl,
          pointerX: e.clientX,
          pointerY: e.clientY,
          draggedCount: 1
        })
        session.preview = preview
        session.previewOffsetX = offsetX
        session.previewOffsetY = offsetY
        setSidebarPointerDragDocumentStyles(true)
        setState({ draggingHostId: session.hostId, dropIndex: null, dropIndicatorY: null })
      }
      if (session.preview) {
        updateSidebarDragPreviewPosition({
          preview: session.preview,
          pointerX: e.clientX,
          pointerY: e.clientY,
          offsetX: session.previewOffsetX,
          offsetY: session.previewOffsetY
        })
      }
      const drop = computeDrop(e.clientY)
      if (!drop) {
        scheduleDeferredDropCompute(e.clientY)
        return
      }
      applyDrop(drop)
    }
    const onPointerUp = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (session && e.pointerId === session.pointerId) {
        endDrag(true, e.clientY)
      }
    }
    const onPointerCancel = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (session && e.pointerId === session.pointerId) {
        endDrag(false)
      }
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
    }
  }, [applyDrop, computeDrop, endDrag, scheduleDeferredDropCompute, sessionArmed])

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, hostId: ExecutionHostId) => {
      if (event.button !== 0 || isHostHeaderActionTarget(event.target, event.currentTarget)) {
        return
      }
      const container = getContainerRef.current()
      if (!container || orderedIdsRef.current.length <= 1) {
        return
      }
      const headerRects = readHostHeaderRects(container)
      dragSessionRef.current = {
        hostId,
        pointerId: event.pointerId,
        headerRects,
        handleEl: event.currentTarget,
        startX: event.clientX,
        startY: event.clientY,
        promoted: false,
        preview: null,
        previewOffsetX: 0,
        previewOffsetY: 0
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      setSessionArmed(true)
    },
    []
  )

  useEffect(() => {
    return () => {
      clearDeferredComputeFrame()
      dragSessionRef.current?.preview?.remove()
      setSidebarPointerDragDocumentStyles(false)
    }
  }, [clearDeferredComputeFrame])

  return { state, onHandlePointerDown }
}
