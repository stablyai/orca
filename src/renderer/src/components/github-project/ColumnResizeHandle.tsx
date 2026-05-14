import React, { useEffect, useRef, useState } from 'react'
import { MIN_COLUMN_WIDTH } from './column-widths'

type Props = {
  fieldId: string
  nextFieldId: string
  currentWidth: number
  nextWidth: number
  onResize: (fieldId: string, width: number, nextFieldId: string, nextWidth: number) => void
}

// Why: stored widths are `fr` weights, not pixels — that's what keeps the
// grid fitting its container exactly. Drag math has to happen in pixels (the
// mouse moves in pixels), so we measure the rendered widths of the two
// adjacent cells at drag start, compute the new pixel split, then convert
// back to fr weights with the pair's total weight held constant. Net effect:
// dragging redistributes width between the pair without changing the grid's
// total — the table never grows.
export default function ColumnResizeHandle({
  fieldId,
  nextFieldId,
  currentWidth,
  nextWidth,
  onResize
}: Props): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
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

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
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
