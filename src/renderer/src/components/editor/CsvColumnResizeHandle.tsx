import React, { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { MAX_CSV_COLUMN_WIDTH, MIN_CSV_COLUMN_WIDTH } from './csv-column-widths'

type CsvColumnResizeHandleProps = {
  columnIndex: number
  columnLabel: string
  currentWidth: number
  onResize: (columnIndex: number, width: number) => void
}

const KEYBOARD_STEP = 16

export default function CsvColumnResizeHandle({
  columnIndex,
  columnLabel,
  currentWidth,
  onResize
}: CsvColumnResizeHandleProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    previousCursor: string
    previousUserSelect: string
  } | null>(null)
  const notifyResize = useEffectEvent(onResize)

  const stopResize = useCallback((): void => {
    const drag = dragRef.current
    if (!drag) {
      return
    }
    dragRef.current = null
    document.body.style.cursor = drag.previousCursor
    document.body.style.userSelect = drag.previousUserSelect
    setDragging(false)
  }, [])

  useEffect(() => {
    if (!dragging) {
      return
    }
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag?.pointerId === event.pointerId) {
        notifyResize(
          columnIndex,
          Math.min(
            MAX_CSV_COLUMN_WIDTH,
            Math.max(MIN_CSV_COLUMN_WIDTH, drag.startWidth + event.clientX - drag.startX)
          )
        )
      }
    }
    const onEnd = (event: PointerEvent): void => {
      if (dragRef.current?.pointerId === event.pointerId) {
        stopResize()
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    window.addEventListener('blur', stopResize)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      window.removeEventListener('blur', stopResize)
      stopResize()
    }
  }, [columnIndex, dragging, stopResize])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={translate(
        'auto.components.editor.CsvColumnResizeHandle.resizeColumn',
        'Resize column {{value0}}',
        { value0: columnLabel }
      )}
      aria-valuemin={MIN_CSV_COLUMN_WIDTH}
      aria-valuemax={MAX_CSV_COLUMN_WIDTH}
      aria-valuenow={Math.round(currentWidth)}
      tabIndex={0}
      className="group absolute -right-1.5 top-0 z-30 flex h-full w-3 cursor-col-resize items-stretch justify-center outline-none"
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return
        }
        event.preventDefault()
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: currentWidth,
          previousCursor: document.body.style.cursor,
          previousUserSelect: document.body.style.userSelect
        }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        setDragging(true)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
          return
        }
        event.preventDefault()
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        onResize(
          columnIndex,
          Math.min(
            MAX_CSV_COLUMN_WIDTH,
            Math.max(MIN_CSV_COLUMN_WIDTH, currentWidth + direction * KEYBOARD_STEP)
          )
        )
      }}
    >
      <span
        className={`h-full w-px transition-colors ${
          dragging ? 'bg-ring' : 'bg-transparent group-hover:bg-ring/50 group-focus-visible:bg-ring'
        }`}
      />
    </div>
  )
}
