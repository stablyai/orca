import React, { useEffect, useEffectEvent, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { MIN_CSV_COLUMN_WIDTH } from './csv-column-widths'

type CsvColumnResizeHandleProps = {
  columnIndex: number
  currentWidth: number
  onResize: (columnIndex: number, width: number) => void
}

const KEYBOARD_STEP = 16

export default function CsvColumnResizeHandle({
  columnIndex,
  currentWidth,
  onResize
}: CsvColumnResizeHandleProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const notifyResize = useEffectEvent(onResize)

  useEffect(() => {
    if (!dragging) {
      return
    }
    const onMove = (event: MouseEvent): void => {
      const drag = dragRef.current
      if (drag) {
        notifyResize(
          columnIndex,
          Math.max(MIN_CSV_COLUMN_WIDTH, drag.startWidth + event.clientX - drag.startX)
        )
      }
    }
    const onUp = (): void => {
      dragRef.current = null
      setDragging(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [columnIndex, dragging])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={translate(
        'auto.components.editor.CsvColumnResizeHandle.resizeColumn',
        'Resize column'
      )}
      aria-valuemin={MIN_CSV_COLUMN_WIDTH}
      aria-valuenow={Math.round(currentWidth)}
      tabIndex={0}
      className="group absolute -right-1.5 top-0 z-30 flex h-full w-3 cursor-col-resize items-stretch justify-center outline-none"
      onMouseDown={(event) => {
        if (event.button !== 0) {
          return
        }
        event.preventDefault()
        dragRef.current = { startX: event.clientX, startWidth: currentWidth }
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
          Math.max(MIN_CSV_COLUMN_WIDTH, currentWidth + direction * KEYBOARD_STEP)
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
