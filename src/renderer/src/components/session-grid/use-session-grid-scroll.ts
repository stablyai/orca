import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  SessionGridScrollMode,
  SessionGridWheelTarget
} from '../../../../shared/session-grid-types'
import { SESSION_GRID_ROW_GAP_PX, computeSessionGridRowHeight } from './session-grid-slot-layout'
import {
  createSessionGridWheelGesture,
  normalizeSessionGridWheelPixels,
  isDiscreteWheelEvent
} from './session-grid-wheel-gesture'
import { installSessionGridWheelRouting } from './session-grid-wheel-routing'
import { readPrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

// Wheel travel smaller than this reads as jitter, not intent to move a row/page.
const ROW_SNAP_THRESHOLD = 30
const PAGE_SNAP_THRESHOLD = 40

export const SESSION_GRID_SCROLL_CONTAINER_ID = 'session-grid-scroll-container'

/**
 * Owns the grid's scroll element: measures it for pixel-exact row heights,
 * tracks the current position (a row in row mode, a page otherwise), and
 * intercepts the wheel in capture phase — a full-screen TUI in a card calls
 * preventDefault() on wheel events, which would otherwise freeze the grid.
 * In the snapping modes the wheel never moves the element directly; a gesture
 * resolves to a number of positions from where it began, so trackpad momentum
 * cannot stack extra rows onto a flick.
 */
export function useSessionGridScroll(args: {
  mode: SessionGridScrollMode
  wheelTarget?: SessionGridWheelTarget
  rowsPerView: number
  totalRowCount: number
  totalPageCount: number
}): {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  setScrollContainer: (element: HTMLDivElement | null) => void
  currentPosition: number
  currentPositionRef: React.RefObject<number>
  /**
   * Topmost row actually on screen. Equal to the position in `row` mode and to
   * `position * rowsPerView` in `page` mode, but in `free` mode scrolling is continuous and
   * the position is a ROUNDED page — so anything deriving a visible window from it is off by
   * up to half a viewport mid-scroll. This is measured instead.
   */
  firstVisibleRow: number
  /** Last reachable position; the navigator shows `maxPosition + 1` stops. */
  maxPosition: number
  rowHeight: number
  handleScroll: () => void
  scrollToPosition: (targetIndex: number) => void
} {
  const { mode, wheelTarget = 'focus', rowsPerView, totalRowCount, totalPageCount } = args
  const isRowMode = mode === 'row'
  const isFreeMode = mode === 'free'
  const isPageMode = mode === 'page'
  const [currentPosition, setCurrentPosition] = useState(0)
  // Why only free mode keeps its own: the other two snap, so their top row is the position.
  // Here it changes a row at a time rather than a page at a time — still bounded, and local
  // component state, never a store write on a scroll tick.
  const [freeModeFirstRow, setFreeModeFirstRow] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)
  const bindScrollContainer = useCallback((element: HTMLDivElement | null) => {
    scrollContainerRef.current = element
    setScrollContainer(element)
  }, [])
  const currentPositionRef = useRef(currentPosition)
  currentPositionRef.current = currentPosition
  // Why: while a smooth scroll is in flight the position read off scrollTop
  // rounds to the old row half the way; the wheel anchors on the commanded one.
  const pendingTargetRef = useRef<number | null>(null)

  useEffect(() => {
    const el = scrollContainer
    if (!el) {
      return
    }
    const update = (): void => {
      if (el.clientHeight > 0) {
        setContainerHeight(el.clientHeight)
      }
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollContainer])

  const rowHeight = useMemo(
    () => computeSessionGridRowHeight(containerHeight, rowsPerView),
    [containerHeight, rowsPerView]
  )
  // One position is a row in row mode and a viewport of rows in free mode. In
  // page mode it is one page, and a page is `h-full` — the container itself,
  // which is a gap taller than the rows it holds.
  const positionStepPx = isPageMode
    ? containerHeight
    : (rowHeight + SESSION_GRID_ROW_GAP_PX) * (isRowMode ? 1 : rowsPerView)
  const maxPosition = isRowMode ? Math.max(0, totalRowCount - rowsPerView) : totalPageCount - 1
  const clampPosition = useCallback(
    (position: number) => Math.min(maxPosition, Math.max(0, position)),
    [maxPosition]
  )

  const rowStepPx = rowHeight + SESSION_GRID_ROW_GAP_PX
  const syncPositionFromScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el || el.clientHeight === 0 || positionStepPx <= 0) {
      return
    }
    const position = clampPosition(Math.round(el.scrollTop / positionStepPx))
    if (position === pendingTargetRef.current) {
      pendingTargetRef.current = null
    }
    setCurrentPosition(position)
    if (isFreeMode && rowStepPx > 0) {
      setFreeModeFirstRow(Math.max(0, Math.floor(el.scrollTop / rowStepPx)))
    }
  }, [clampPosition, isFreeMode, positionStepPx, rowStepPx])

  // Why: a position counted in rows means something else once the step counts
  // pages, so a mode or preset change must re-derive it from where the
  // container actually sits rather than reinterpret the old number.
  useEffect(() => {
    pendingTargetRef.current = null
    syncPositionFromScroll()
  }, [scrollContainer, syncPositionFromScroll])

  const scrollToPosition = useCallback(
    (targetIndex: number) => {
      const el = scrollContainerRef.current
      if (!el || el.clientHeight === 0 || positionStepPx <= 0) {
        return
      }
      const clamped = clampPosition(targetIndex)
      pendingTargetRef.current = clamped
      // Same rule as the sidebar's reveal: jump instead of animating when the user asked for
      // less motion — which also makes the move deterministic where nothing ticks the animation.
      el.scrollTo({
        top: clamped * positionStepPx,
        behavior: readPrefersReducedMotion() ? 'auto' : 'smooth'
      })
      setCurrentPosition(clamped)
    },
    [clampPosition, positionStepPx]
  )

  useEffect(() => {
    const container = scrollContainer
    if (!container) {
      return
    }
    const createGesture = (): ReturnType<typeof createSessionGridWheelGesture> =>
      createSessionGridWheelGesture({
        intentThresholdPx: isRowMode ? ROW_SNAP_THRESHOLD : PAGE_SNAP_THRESHOLD,
        getPositionStepPx: () => positionStepPx
      })
    let gesture = createGesture()
    let anchor = 0
    const settledPosition = (): number => pendingTargetRef.current ?? currentPositionRef.current

    const processGridScroll = (delta: number, discrete: boolean, deltaMode = 0): void => {
      const deltaY = normalizeSessionGridWheelPixels(delta, deltaMode, container.clientHeight)
      const now = Date.now()
      if (isFreeMode) {
        container.scrollBy({ top: deltaY, behavior: 'auto' })
        return
      }
      const move = gesture.feed({ deltaY, discrete, at: now })
      if (!move) {
        return
      }
      if (move.newGesture) {
        anchor = settledPosition()
      }
      const target = clampPosition(anchor + move.offset)
      if (target !== settledPosition()) {
        scrollToPosition(target)
      }
    }

    return installSessionGridWheelRouting({
      container,
      getWheelTarget: () => wheelTarget,
      onGestureReset: () => {
        gesture = createGesture()
      },
      onGridWheel: (event, deltaY) =>
        processGridScroll(deltaY, isDiscreteWheelEvent(event), event.deltaMode)
    })
  }, [
    scrollContainer,
    clampPosition,
    isFreeMode,
    isRowMode,
    positionStepPx,
    scrollToPosition,
    wheelTarget
  ])

  return {
    scrollContainerRef,
    setScrollContainer: bindScrollContainer,
    currentPosition,
    currentPositionRef,
    firstVisibleRow: isRowMode
      ? currentPosition
      : isFreeMode
        ? freeModeFirstRow
        : currentPosition * rowsPerView,
    maxPosition,
    rowHeight,
    handleScroll: syncPositionFromScroll,
    scrollToPosition
  }
}
