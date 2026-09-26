import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject
} from 'react'
import {
  matchesActiveDragPointer,
  releasePointerCaptureIfHeld
} from '@/lib/pane-manager/drag-pointer-session'
import { holdPtyResizesForPaneSubtrees } from '@/lib/pane-manager/pane-pty-resize-hold'
import { translate } from '@/i18n/i18n'

/** Floor keeps a dragged terminal wide enough to stay usable; the ceiling is the
 *  tab itself, so the cap can always be dragged back in from full width. */
export const MIN_SINGLE_PANE_WIDTH = 400

/** Pointer travel a single arrow key stands in for; Shift multiplies it. */
const KEYBOARD_STEP_PX = 20
const KEYBOARD_STEP_MULTIPLIER = 5

/** Mirrors the fallback baked into terminal.css so an unset setting shows the
 *  width it actually renders at. Change both together. */
export const DEFAULT_SINGLE_PANE_MAX_WIDTH = 1100

const SINGLE_PANE_MAX_WIDTH_PROPERTY = '--pane-single-max-width'

type TerminalSinglePaneWidthHandlesProps = {
  containerRef: RefObject<HTMLDivElement | null>
  maxWidth: number
  dividerStyle: CSSProperties
  onCommit: (maxWidth: number) => void
}

type DragState = {
  pointerId: number
  pointerType: string
  startX: number
  startWidth: number
  direction: 1 | -1
  width: number
  /** Inline value to restore when the drag is cancelled rather than committed. */
  restore: string
  releasePtyHold: (commit: boolean) => void
}

/** Doubled because the pane stays centered, so each edge carries half the growth.
 *  Clamped to the tab so the cap can always be dragged back in from full width. */
export function resolveDraggedSinglePaneWidth(input: {
  startWidth: number
  deltaX: number
  direction: 1 | -1
  containerWidth: number
}): number {
  const grown = input.startWidth + input.deltaX * input.direction * 2
  return Math.round(
    Math.min(Math.max(grown, MIN_SINGLE_PANE_WIDTH), Math.max(input.containerWidth, 0))
  )
}

export function TerminalSinglePaneWidthHandles({
  containerRef,
  maxWidth,
  dividerStyle,
  onCommit
}: TerminalSinglePaneWidthHandlesProps): React.JSX.Element | null {
  const [containerWidth, setContainerWidth] = useState(0)
  // The cap rule is scoped to the retained pane host, so outside one (floating
  // panel, onboarding, settings preview) the pane fills the tab and these handles
  // would sit invisibly on the terminal's own content edges.
  const [inCapHost, setInCapHost] = useState(false)
  const [draftWidth, setDraftWidth] = useState<number | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const handleRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) {
      return
    }
    setInCapHost(container.closest('[data-retained-pane-host]') !== null)
    const measure = (): void => setContainerWidth(container.getBoundingClientRect().width)
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    measure()
    return () => observer.disconnect()
  }, [containerRef])

  const finishDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current
      if (drag === null) {
        return
      }
      dragRef.current = null
      releasePointerCaptureIfHeld(handleRef.current, drag.pointerId)
      handleRef.current = null
      setDraftWidth(null)

      if (!commit || drag.width === drag.startWidth) {
        // Why restore verbatim: an abandoned drag must not strand its live preview
        // on the root, where nothing else would clear it.
        const container = containerRef.current
        if (drag.restore === '') {
          container?.style.removeProperty(SINGLE_PANE_MAX_WIDTH_PROPERTY)
        } else {
          container?.style.setProperty(SINGLE_PANE_MAX_WIDTH_PROPERTY, drag.restore)
        }
        drag.releasePtyHold(false)
        return
      }

      drag.releasePtyHold(true)
      onCommit(drag.width)
    },
    [containerRef, onCommit]
  )

  const finishDragRef = useRef(finishDrag)
  finishDragRef.current = finishDrag

  const applyDragPosition = useCallback(
    (clientX: number) => {
      const drag = dragRef.current
      if (drag === null || containerWidth <= 0) {
        return
      }
      const next = resolveDraggedSinglePaneWidth({
        startWidth: drag.startWidth,
        deltaX: clientX - drag.startX,
        direction: drag.direction,
        containerWidth
      })
      drag.width = next
      setDraftWidth(next)
      // Why direct: a store write per pointermove would republish to every
      // subscriber; the committed value re-enters through the normal path.
      containerRef.current?.style.setProperty(SINGLE_PANE_MAX_WIDTH_PROPERTY, `${next}px`)
    },
    [containerRef, containerWidth]
  )

  // Why window-level: Chromium can lose pointer capture mid-gesture, and without
  // these a transient loss would commit a width the user never released on.
  useEffect(() => {
    if (draftWidth === null) {
      return
    }
    const onMove = (event: PointerEvent): void => {
      if (matchesActiveDragPointer(dragRef.current, event)) {
        applyDragPosition(event.clientX)
      }
    }
    const onUp = (event: PointerEvent): void => {
      if (matchesActiveDragPointer(dragRef.current, event)) {
        finishDragRef.current(true)
      }
    }
    const onCancel = (event: PointerEvent): void => {
      if (matchesActiveDragPointer(dragRef.current, event)) {
        finishDragRef.current(false)
      }
    }
    const onBlur = (): void => finishDragRef.current(false)

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('blur', onBlur, true)
    return () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      window.removeEventListener('blur', onBlur, true)
    }
  }, [draftWidth, applyDragPosition])

  // Unmounting mid-drag (a remote split, a tab switch) must not strand the preview.
  useEffect(() => () => finishDragRef.current(false), [])

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, direction: 1 | -1) => {
      const container = containerRef.current
      if (event.button !== 0 || containerWidth <= 0 || container === null) {
        return
      }
      // A second press (second touch, or the press after a swallowed pointerup)
      // would otherwise orphan the previous drag's PTY hold, whose depth counter
      // then queues every later resize forever.
      finishDragRef.current(false)
      const startWidth = Math.min(maxWidth, containerWidth)
      const hold = holdPtyResizesForPaneSubtrees([container])
      dragRef.current = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startWidth,
        direction,
        width: startWidth,
        restore: container.style.getPropertyValue(SINGLE_PANE_MAX_WIDTH_PROPERTY),
        releasePtyHold: (commit) => (commit ? hold.flush() : hold.cancel())
      }
      handleRef.current = event.currentTarget
      setDraftWidth(startWidth)
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    [containerRef, containerWidth, maxWidth]
  )

  const nudge = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, direction: 1 | -1, current: number) => {
      const step = event.key === 'ArrowLeft' ? -KEYBOARD_STEP_PX : KEYBOARD_STEP_PX
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      event.preventDefault()
      const next = resolveDraggedSinglePaneWidth({
        startWidth: current,
        deltaX: event.shiftKey ? step * KEYBOARD_STEP_MULTIPLIER : step,
        direction,
        containerWidth
      })
      if (next !== current) {
        onCommit(next)
      }
    },
    [containerWidth, onCommit]
  )

  if (containerWidth <= 0 || !inCapHost) {
    return null
  }

  const width = Math.min(draftWidth ?? maxWidth, containerWidth)
  const offset = (containerWidth - width) / 2
  const isDragging = draftWidth !== null

  return (
    <div className="pane-single-width-handle-layer" style={dividerStyle}>
      {[
        { side: 'left', direction: -1, left: offset } as const,
        { side: 'right', direction: 1, left: offset + width } as const
      ].map((handle) => (
        <div
          key={handle.side}
          className={
            isDragging ? 'pane-single-width-handle is-dragging' : 'pane-single-width-handle'
          }
          style={{ left: `${handle.left}px` }}
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          aria-valuemin={MIN_SINGLE_PANE_WIDTH}
          aria-valuemax={Math.round(containerWidth)}
          aria-valuenow={Math.round(width)}
          aria-label={translate(
            'auto.components.terminal.pane.TerminalSinglePaneWidthHandles.75e1cb1f51',
            'Resize terminal width'
          )}
          onPointerDown={(event) => startDrag(event, handle.direction)}
          onKeyDown={(event) => nudge(event, handle.direction, width)}
        />
      ))}
    </div>
  )
}
