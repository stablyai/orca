import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { acquireWebviewsDragPassthrough } from '../../host-guest/drag/webview-drag-passthrough'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'

/** Gap kept between the palette and the page's left and right edges. */
export const PALETTE_EDGE_INSET_PX = 8
/** Releasing this close to centre (as a fraction of travel) snaps back to centre. */
const PALETTE_CENTRE_SNAP = 0.04
const KEY_STEP = 0.05
const KEY_STEP_LARGE = 0.25
const SNAP_ANIMATION_MS = 180

/** Left edge in px for a 0–1 fraction of the free travel. */
export function paletteLeftForRatio(
  ratio: number,
  boundsWidth: number,
  paletteWidth: number
): number {
  const travel = Math.max(0, boundsWidth - paletteWidth - PALETTE_EDGE_INSET_PX * 2)
  return PALETTE_EDGE_INSET_PX + travel * Math.min(1, Math.max(0, ratio))
}

/** Inverse of paletteLeftForRatio; with no travel the fraction is meaningless, so keep centre. */
export function paletteRatioForLeft(
  left: number,
  boundsWidth: number,
  paletteWidth: number
): number {
  const travel = boundsWidth - paletteWidth - PALETTE_EDGE_INSET_PX * 2
  if (travel <= 0) {
    return 0.5
  }
  return Math.min(1, Math.max(0, (left - PALETTE_EDGE_INSET_PX) / travel))
}

/** Keeps the palette inside the bounds; a palette wider than its bounds pins to the left inset. */
export function clampPaletteLeft(left: number, boundsWidth: number, paletteWidth: number): number {
  const max = Math.max(PALETTE_EDGE_INSET_PX, boundsWidth - paletteWidth - PALETTE_EDGE_INSET_PX)
  return Math.min(max, Math.max(PALETTE_EDGE_INSET_PX, left))
}

export function snapPaletteRatio(ratio: number): number {
  return Math.abs(ratio - 0.5) < PALETTE_CENTRE_SNAP ? 0.5 : ratio
}

/** Screen-reader value for the grip slider. */
export function paletteRatioPercent(ratio: number): number {
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100)
}

type Layout = { boundsWidth: number; paletteWidth: number; left: number; ratio: number }

/**
 * Horizontal-only placement and drag for a palette inside a bounds element.
 * Why the left edge is anchored: switching tools changes the palette's width, and a palette that slides on every
 * switch is hard to aim at. Only drags, saved-position changes and bounds resizes re-derive it from the ratio.
 */
export function usePaletteHorizontalDrag({
  bounds,
  paletteRef,
  ratio,
  onRatioChange
}: {
  /** The page area; null until it is attached. */
  bounds: HTMLElement | null
  paletteRef: RefObject<HTMLElement | null>
  ratio: number
  onRatioChange: (ratio: number) => void
}): {
  left: number | null
  /** False when the palette fills the bounds; the grip hides then. */
  canMove: boolean
  dragging: boolean
  snapping: boolean
  /** Fraction the palette shows at now (its anchored edge can differ from the saved ratio). */
  shownRatio: number
  gripProps: Pick<
    React.HTMLAttributes<HTMLElement>,
    'onPointerDown' | 'onDoubleClick' | 'onKeyDown'
  >
} {
  const [layout, setLayout] = useState<Layout | null>(null)
  const [dragging, setDragging] = useState(false)
  const [snapping, setSnapping] = useState(false)
  const snapTimerRef = useRef<number | undefined>(undefined)
  const endDragRef = useRef<((commit: boolean) => void) | null>(null)
  const layoutRef = useRef<Layout | null>(null)
  useLayoutEffect(() => {
    layoutRef.current = layout
  }, [layout])

  useLayoutEffect(() => {
    const palette = paletteRef.current
    if (!bounds || !palette) {
      return
    }
    const measure = (): void => {
      const boundsWidth = bounds.clientWidth
      const paletteWidth = palette.offsetWidth
      // A hidden pane measures zero; keep the last layout so the saved position isn't recomputed from nothing.
      if (boundsWidth === 0) {
        // Hidden mid-drag: end it so the pages get pointer input back.
        endDragRef.current?.(false)
        return
      }
      // The drag's clamp was computed for the old width; give up the drag rather than move out of bounds.
      if (endDragRef.current && boundsWidth !== layoutRef.current?.boundsWidth) {
        endDragRef.current(false)
      }
      setLayout((prev) => {
        // Bounds resize or a new saved ratio: re-derive from the ratio. Content-only width change: keep the edge.
        const left =
          prev && prev.boundsWidth === boundsWidth && prev.ratio === ratio
            ? clampPaletteLeft(prev.left, boundsWidth, paletteWidth)
            : clampPaletteLeft(
                paletteLeftForRatio(ratio, boundsWidth, paletteWidth),
                boundsWidth,
                paletteWidth
              )
        if (
          prev &&
          prev.boundsWidth === boundsWidth &&
          prev.paletteWidth === paletteWidth &&
          prev.left === left &&
          prev.ratio === ratio
        ) {
          return prev
        }
        return { boundsWidth, paletteWidth, left, ratio }
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(bounds)
    observer.observe(palette)
    return () => observer.disconnect()
  }, [bounds, paletteRef, ratio])

  // Unmount mid-drag (Done, Esc, navigation) must still give pointer input back to the page.
  useEffect(
    () => () => {
      endDragRef.current?.(false)
      window.clearTimeout(snapTimerRef.current)
    },
    []
  )

  const canMove =
    layout !== null && layout.boundsWidth - layout.paletteWidth - PALETTE_EDGE_INSET_PX * 2 > 0
  const shownRatio = layout
    ? paletteRatioForLeft(layout.left, layout.boundsWidth, layout.paletteWidth)
    : ratio

  const commitRatio = (next: number, animate: boolean): void => {
    if (animate) {
      setSnapping(true)
      window.clearTimeout(snapTimerRef.current)
      snapTimerRef.current = window.setTimeout(() => setSnapping(false), SNAP_ANIMATION_MS)
    }
    const clamped = Math.min(1, Math.max(0, next))
    if (clamped === ratio && layout) {
      // Same saved value: re-anchor to it anyway (the edge may have drifted with content changes).
      setLayout({
        ...layout,
        left: paletteLeftForRatio(clamped, layout.boundsWidth, layout.paletteWidth)
      })
    }
    onRatioChange(clamped)
  }

  return {
    left: layout?.left ?? null,
    canMove,
    dragging,
    snapping,
    shownRatio,
    gripProps: {
      onPointerDown: (event) => {
        const palette = paletteRef.current
        if (event.button !== 0 || !layout || !canMove || !palette || endDragRef.current) {
          return
        }
        event.preventDefault()
        const grip = event.currentTarget
        const pointerId = event.pointerId
        // Focus the grip so Esc reaches the drag (and not a focused page, which would exit the mode).
        // focusVisible:false: a mouse drag shouldn't leave a keyboard focus ring on the grip.
        grip.focus({ preventScroll: true, focusVisible: false })
        grip.setPointerCapture?.(pointerId)
        // Pages would swallow the pointer once it crosses them; let the drag see every move.
        const releasePassthrough = acquireWebviewsDragPassthrough()
        const { boundsWidth, paletteWidth } = layout
        const startX = event.clientX
        const startLeft = layout.left
        let currentLeft = startLeft
        setDragging(true)

        const onMove = (moveEvent: PointerEvent): void => {
          if (moveEvent.pointerId !== pointerId) {
            return
          }
          if (moveEvent.buttons === 0) {
            endDrag(true)
            return
          }
          currentLeft = clampPaletteLeft(
            startLeft + moveEvent.clientX - startX,
            boundsWidth,
            paletteWidth
          )
          // Why straight to the style: one state write per drag, not one render per pointer move.
          palette.style.left = `${currentLeft}px`
        }
        const onUp = (upEvent: PointerEvent): void => {
          if (upEvent.pointerId === pointerId) {
            endDrag(true)
          }
        }
        const onCancel = (): void => endDrag(false)
        const onKeyDown = (keyEvent: KeyboardEvent): void => {
          if (keyEvent.key !== 'Escape') {
            return
          }
          // Esc mid-drag puts the palette back and must not also exit the mode: registered first on the app key router,
          // ahead of the picker's and the mode's Esc owners.
          keyEvent.preventDefault()
          keyEvent.stopImmediatePropagation()
          endDrag(false)
        }
        const endDrag = (commit: boolean): void => {
          grip.removeEventListener('pointermove', onMove)
          grip.removeEventListener('pointerup', onUp)
          grip.removeEventListener('pointercancel', onCancel)
          grip.removeEventListener('lostpointercapture', onCancel)
          window.removeEventListener('blur', onCancel)
          removeAppKeyListener('keydown', onKeyDown)
          releasePassthrough()
          endDragRef.current = null
          if (!commit) {
            palette.style.left = `${startLeft}px`
            setDragging(false)
            return
          }
          const raw = paletteRatioForLeft(currentLeft, boundsWidth, paletteWidth)
          const snapped = snapPaletteRatio(raw)
          setLayout((prev) => (prev ? { ...prev, left: currentLeft } : prev))
          setDragging(false)
          commitRatio(snapped, snapped !== raw)
        }
        grip.addEventListener('pointermove', onMove)
        grip.addEventListener('pointerup', onUp)
        grip.addEventListener('pointercancel', onCancel)
        grip.addEventListener('lostpointercapture', onCancel)
        window.addEventListener('blur', onCancel)
        addAppKeyListener('keydown', onKeyDown, { first: true })
        endDragRef.current = endDrag
      },
      onDoubleClick: () => commitRatio(0.5, true),
      onKeyDown: (event) => {
        if (!canMove) {
          return
        }
        const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
        const next =
          event.key === 'ArrowLeft'
            ? shownRatio - step
            : event.key === 'ArrowRight'
              ? shownRatio + step
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? 1
                  : null
        if (next === null) {
          return
        }
        event.preventDefault()
        commitRatio(next, false)
      }
    }
  }
}
