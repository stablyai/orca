import React, { useEffect, useRef, useState } from 'react'
import { keyboardResizeFloor, MIN_COLUMN_WIDTH } from './column-widths'
import { translate } from '@/i18n/i18n'

// One arrow-key press moves 5% of the adjacent pair's combined weight.
const KEYBOARD_RESIZE_STEP_FRACTION = 0.05

type Props = {
  fieldId: string
  nextFieldId: string
  currentWidth: number
  nextWidth: number
  onResize: (fieldId: string, width: number, nextFieldId: string, nextWidth: number) => void
}

/** Rendered pixel width of the handle's cell plus the next cell. */
function measurePairPxOf(handle: HTMLElement | null): number {
  const cell = handle?.parentElement
  const nextCell = cell?.nextElementSibling as HTMLElement | null
  return (cell?.offsetWidth ?? 0) + (nextCell?.offsetWidth ?? 0)
}

/**
 * Stored widths are `fr` weights, not pixels — that's what keeps the
 * grid fitting its container exactly. Drag math has to happen in pixels (the
 * mouse moves in pixels), so we measure the rendered widths of the two
 * adjacent cells at drag start, compute the new pixel split, then convert
 * back to fr weights with the pair's total weight held constant. Net effect:
 * dragging redistributes width between the pair without changing the grid's
 * total — the table never grows.
 */
export default function ColumnResizeHandle({
  fieldId,
  nextFieldId,
  currentWidth,
  nextWidth,
  onResize
}: Props): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [focused, setFocused] = useState(false)
  // Pair pixel width tracked while focused so the ARIA limits match the keyboard clamp.
  const [focusPairPx, setFocusPairPx] = useState(0)
  const handleRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    startX: number
    startPxA: number
    startPxB: number
    totalFr: number
  } | null>(null)

  useEffect(() => {
    if (!dragging) {
      return
    }
    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) {
        return
      }
      const totalPx = drag.startPxA + drag.startPxB
      if (totalPx <= 0) {
        return
      }
      const proposedPxA = drag.startPxA + (e.clientX - drag.startX)
      const newPxA = Math.max(MIN_COLUMN_WIDTH, Math.min(totalPx - MIN_COLUMN_WIDTH, proposedPxA))
      const newFrA = (drag.totalFr * newPxA) / totalPx
      const newFrB = drag.totalFr - newFrA
      onResize(fieldId, newFrA, nextFieldId, newFrB)
    }
    const onUp = (): void => {
      dragRef.current = null
      setDragging(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
  }, [dragging, fieldId, nextFieldId, onResize])

  useEffect(() => {
    const cell = handleRef.current?.parentElement
    if (!focused || !cell || typeof ResizeObserver === 'undefined') {
      return
    }
    // Why: observe only while focused; the range is announced only then.
    const observer = new ResizeObserver(() => setFocusPairPx(measurePairPxOf(handleRef.current)))
    observer.observe(cell)
    if (cell.nextElementSibling) {
      observer.observe(cell.nextElementSibling)
    }
    return () => observer.disconnect()
  }, [focused])

  const totalFr = currentWidth + nextWidth

  /** Arrow-key step in `fr` directly; the pixel floor converts to `fr` only once laid out. */
  const nudgeWidth = (direction: -1 | 1): void => {
    if (totalFr <= 0) {
      return
    }
    const minFr = keyboardResizeFloor(
      totalFr,
      measurePairPxOf(handleRef.current),
      KEYBOARD_RESIZE_STEP_FRACTION
    )
    if (minFr * 2 >= totalFr) {
      return
    }
    const proposedFrA = currentWidth + direction * totalFr * KEYBOARD_RESIZE_STEP_FRACTION
    const newFrA = Math.max(minFr, Math.min(totalFr - minFr, proposedFrA))
    // Why: a stored split past the live clamp would otherwise snap back against the pressed arrow.
    if ((newFrA - currentWidth) * direction <= 0) {
      return
    }
    onResize(fieldId, newFrA, nextFieldId, totalFr - newFrA)
  }

  const ariaMinPercent =
    totalFr > 0
      ? Math.min(
          50,
          Math.round(
            (keyboardResizeFloor(totalFr, focusPairPx, KEYBOARD_RESIZE_STEP_FRACTION) / totalFr) *
              100
          )
        )
      : 0
  // Why: minmax(60px, …) keeps the rendered share inside this range even when the stored weight is not.
  const ariaNowPercent =
    totalFr > 0
      ? Math.max(
          ariaMinPercent,
          Math.min(100 - ariaMinPercent, Math.round((currentWidth / totalFr) * 100))
        )
      : 50

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuenow={ariaNowPercent}
      aria-valuemin={ariaMinPercent}
      aria-valuemax={100 - ariaMinPercent}
      aria-label={translate(
        'auto.components.github.project.ColumnResizeHandle.1304289353',
        'Resize column'
      )}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        nudgeWidth(e.key === 'ArrowLeft' ? -1 : 1)
      }}
      onFocus={(e) => {
        setFocusPairPx(measurePairPxOf(handleRef.current))
        setFocused(true)
        e.currentTarget.style.background = 'rgba(59,130,246,0.25)'
      }}
      onBlur={(e) => {
        setFocused(false)
        if (!dragging) {
          e.currentTarget.style.background = 'transparent'
        }
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) {
          return
        }
        const cell = handleRef.current?.parentElement
        const nextCell = cell?.nextElementSibling as HTMLElement | null
        if (!cell || !nextCell) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        dragRef.current = {
          startX: e.clientX,
          startPxA: cell.offsetWidth,
          startPxB: nextCell.offsetWidth,
          totalFr: currentWidth + nextWidth
        }
        setDragging(true)
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      style={{
        position: 'absolute',
        right: '-6px',
        top: 0,
        height: '100%',
        width: '12px',
        cursor: 'col-resize',
        userSelect: 'none',
        zIndex: 30,
        background: dragging ? 'rgba(59,130,246,0.25)' : 'transparent'
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.background = 'rgba(59,130,246,0.25)'
      }}
      onMouseLeave={(e) => {
        if (!dragging) {
          ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
        }
      }}
    />
  )
}
