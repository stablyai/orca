import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from 'react'
import { acquireWebviewsDragPassthrough } from '../../host-guest/drag/webview-drag-passthrough'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import {
  DEFAULT_ANNOTATE_PALETTE_POSITION,
  type AnnotatePalettePosition
} from './annotate-palette-position-store'
import {
  PALETTE_EDGE_INSET_PX,
  clampPaletteOffset,
  paletteKeyMove,
  paletteOffsetForRatio,
  paletteDragRest,
  paletteHintPlacement,
  paletteReanchor,
  paletteShownPosition,
  samePaletteLayout,
  type PaletteLayout
} from './palette-placement'

const SNAP_ANIMATION_MS = 180

/**
 * Placement and drag for a palette inside a bounds element, on both axes.
 * Why the edges are anchored: switching tools changes the palette's size, and a palette that slides on every
 * switch is hard to aim at. Only drags, saved-position changes and bounds resizes re-derive them from the position.
 */
export function usePaletteDrag({
  bounds,
  paletteRef,
  position,
  minTop,
  onPositionChange
}: {
  /** The page area; null until it is attached. */
  bounds: HTMLElement | null
  paletteRef: RefObject<HTMLElement | null>
  position: AnnotatePalettePosition
  /** Highest the palette may sit (below an overlapping find bar); never above the edge inset. */
  minTop: number
  onPositionChange: (position: AnnotatePalettePosition) => void
}): {
  left: number | null
  top: number
  /** False when the palette fills the bounds both ways; the grip hides then. */
  canMove: boolean
  dragging: boolean
  snapping: boolean
  /** Fractions the palette shows at now (its anchored edges can differ from the saved position). */
  shownPosition: AnnotatePalettePosition
  /** Where the hint goes: under the palette, or above it when the page has no room under it. */
  hintPlacement: CSSProperties
  gripProps: Pick<
    React.HTMLAttributes<HTMLElement>,
    'onPointerDown' | 'onDoubleClick' | 'onKeyDown'
  >
} {
  const { x, y } = position
  const topMin = Math.max(PALETTE_EDGE_INSET_PX, minTop)
  const [layout, setLayout] = useState<PaletteLayout | null>(null)
  const [dragging, setDragging] = useState(false)
  const [snapping, setSnapping] = useState(false)
  const snapTimerRef = useRef<number | undefined>(undefined)
  // A drag in progress reads the latest limit, so moving under the find bar mid-drag still clears it.
  const topMinRef = useRef(topMin)
  // The drag in progress and the sizes its clamp was computed for.
  const dragRef = useRef<{
    end: (commit: boolean) => void
    boundsWidth: number
    boundsHeight: number
    paletteWidth: number
    paletteHeight: number
  } | null>(null)

  useLayoutEffect(() => {
    topMinRef.current = topMin
  }, [topMin])

  useLayoutEffect(() => {
    const palette = paletteRef.current
    if (!bounds || !palette) {
      return
    }
    const measure = (): void => {
      const boundsWidth = bounds.clientWidth
      const boundsHeight = bounds.clientHeight
      const paletteWidth = palette.offsetWidth
      const paletteHeight = palette.offsetHeight
      // A hidden pane measures zero; keep the last layout so the saved position isn't recomputed from nothing.
      if (boundsWidth === 0) {
        // Hidden mid-drag: end it so the pages get pointer input back.
        dragRef.current?.end(false)
        return
      }
      // The drag's clamp was computed for the old sizes (a resize, or a tool switch or capability change that
      // reshaped the palette); give up the drag rather than move out of bounds or past where it can travel.
      const drag = dragRef.current
      if (drag) {
        if (
          boundsWidth !== drag.boundsWidth ||
          boundsHeight !== drag.boundsHeight ||
          paletteWidth !== drag.paletteWidth ||
          paletteHeight !== drag.paletteHeight
        ) {
          drag.end(false)
        } else {
          // The drag owns the position until it ends; a re-render now would put the palette back mid-drag.
          return
        }
      }
      setLayout((prev) => {
        // Bounds resize, a new saved position or a new top limit: re-derive that axis. Content-only size
        // change: keep the edge.
        const keepLeft = prev !== null && prev.boundsWidth === boundsWidth && prev.x === x
        const left = clampPaletteOffset(
          keepLeft ? prev.left : paletteOffsetForRatio(x, boundsWidth, paletteWidth),
          boundsWidth,
          paletteWidth
        )
        const keepTop =
          prev !== null &&
          prev.boundsHeight === boundsHeight &&
          prev.y === y &&
          prev.topMin === topMin
        const top = clampPaletteOffset(
          keepTop ? prev.top : paletteOffsetForRatio(y, boundsHeight, paletteHeight, topMin),
          boundsHeight,
          paletteHeight,
          topMin
        )
        const next: PaletteLayout = {
          boundsWidth,
          boundsHeight,
          paletteWidth,
          paletteHeight,
          left,
          top,
          x,
          y,
          topMin
        }
        return prev && samePaletteLayout(prev, next) ? prev : next
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
  }, [bounds, paletteRef, x, y, topMin])

  // Unmount mid-drag (Done, Esc, navigation) must still give pointer input back to the page.
  useEffect(
    () => () => {
      dragRef.current?.end(false)
      window.clearTimeout(snapTimerRef.current)
    },
    []
  )

  const canMoveX =
    layout !== null && layout.boundsWidth - layout.paletteWidth - PALETTE_EDGE_INSET_PX * 2 > 0
  const canMoveY =
    layout !== null &&
    layout.boundsHeight - layout.paletteHeight - PALETTE_EDGE_INSET_PX - layout.topMin > 0
  const canMove = canMoveX || canMoveY
  const shownPosition = layout ? paletteShownPosition(layout) : position

  /** `axis`: a grip key re-anchors only the axis it moves; a reset re-anchors both. */
  const commitPosition = (
    next: AnnotatePalettePosition,
    animate: boolean,
    axis?: 'x' | 'y'
  ): void => {
    if (animate) {
      setSnapping(true)
      window.clearTimeout(snapTimerRef.current)
      snapTimerRef.current = window.setTimeout(() => setSnapping(false), SNAP_ANIMATION_MS)
    }
    const clamped = { x: Math.min(1, Math.max(0, next.x)), y: Math.min(1, Math.max(0, next.y)) }
    if (clamped.x === x && clamped.y === y && layout) {
      // Same saved value: re-anchor to it anyway (the edges may have drifted with content changes).
      setLayout(paletteReanchor(layout, clamped, topMinRef.current, axis))
    }
    onPositionChange(clamped)
  }

  return {
    left: layout?.left ?? null,
    top: layout?.top ?? topMin,
    canMove,
    dragging,
    snapping,
    shownPosition,
    hintPlacement: layout ? paletteHintPlacement(layout) : {},
    gripProps: {
      onPointerDown: (event) => {
        const palette = paletteRef.current
        if (event.button !== 0 || !layout || !canMove || !palette || dragRef.current) {
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
        const { boundsWidth, boundsHeight, paletteWidth, paletteHeight } = layout
        const startX = event.clientX
        const startY = event.clientY
        const startLeft = layout.left
        const startTop = layout.top
        const dragStart = { ...layout, saved: position }
        let currentLeft = startLeft
        let currentTop = startTop
        // Only pointer motion moves the top: the find bar's limit can also clamp it while the pointer goes sideways.
        let movedY = false
        setDragging(true)

        const onMove = (moveEvent: PointerEvent): void => {
          if (moveEvent.pointerId !== pointerId) {
            return
          }
          if (moveEvent.buttons === 0) {
            endDrag(true)
            return
          }
          currentLeft = clampPaletteOffset(
            startLeft + moveEvent.clientX - startX,
            boundsWidth,
            paletteWidth
          )
          movedY ||= moveEvent.clientY !== startY
          currentTop = clampPaletteOffset(
            startTop + moveEvent.clientY - startY,
            boundsHeight,
            paletteHeight,
            topMinRef.current
          )
          // Why straight to the style: one state write per drag, not one render per pointer move.
          palette.style.left = `${currentLeft}px`
          palette.style.top = `${currentTop}px`
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
          dragRef.current = null
          // A top limit raised mid-drag (the find bar opened) applies where the palette comes to rest too: the
          // measure effect skipped it while the drag owned the position.
          const restTopMin = topMinRef.current
          const rest = paletteDragRest(
            dragStart,
            commit ? { left: currentLeft, top: movedY ? currentTop : startTop } : null,
            restTopMin
          )
          setLayout((prev) =>
            prev ? { ...prev, left: rest.left, top: rest.top, topMin: restTopMin } : prev
          )
          // The drag wrote the style directly, and React skips a value equal to its last render (a snap back to
          // where the drag started): write the resting place too.
          palette.style.left = `${rest.left}px`
          palette.style.top = `${rest.top}px`
          setDragging(false)
          if (rest.save) {
            commitPosition(rest.save, rest.snapped)
          }
        }
        grip.addEventListener('pointermove', onMove)
        grip.addEventListener('pointerup', onUp)
        grip.addEventListener('pointercancel', onCancel)
        grip.addEventListener('lostpointercapture', onCancel)
        window.addEventListener('blur', onCancel)
        addAppKeyListener('keydown', onKeyDown, { first: true })
        dragRef.current = { end: endDrag, boundsWidth, boundsHeight, paletteWidth, paletteHeight }
      },
      onDoubleClick: () => commitPosition(DEFAULT_ANNOTATE_PALETTE_POSITION, true),
      onKeyDown: (event) => {
        // The pointer drag owns the place until it ends; a key now would save a place Esc then abandons.
        if (dragRef.current) {
          return
        }
        const next = paletteKeyMove(
          event.key,
          event.shiftKey,
          shownPosition,
          position,
          canMoveX,
          canMoveY
        )
        if (next === null) {
          return
        }
        event.preventDefault()
        commitPosition(
          next,
          false,
          event.key === 'ArrowUp' || event.key === 'ArrowDown' ? 'y' : 'x'
        )
      }
    }
  }
}
