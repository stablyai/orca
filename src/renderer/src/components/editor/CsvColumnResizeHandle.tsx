import { useEffect, useRef } from 'react'
import { translate } from '@/i18n/i18n'

export const CSV_MIN_COLUMN_WIDTH = 48
export const CSV_MAX_COLUMN_WIDTH = 1200

export function CsvColumnResizeHandle({
  index,
  width,
  onResize,
  onReset
}: {
  index: number
  width: number
  onResize: (index: number, width: number) => void
  onReset: (index: number) => void
}): React.JSX.Element {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const frame = useRef<number | null>(null)
  const pendingWidth = useRef(width)
  const resize = (next: number): void =>
    onResize(index, Math.max(CSV_MIN_COLUMN_WIDTH, Math.min(CSV_MAX_COLUMN_WIDTH, next)))
  useEffect(
    () => () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
      }
    },
    []
  )
  const finish = (): void => {
    if (!drag.current) {
      return
    }
    drag.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
      resize(pendingWidth.current)
    }
  }
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={translate('csv.resizeColumn', 'Resize column {{column}}', { column: index + 1 })}
      aria-valuemin={CSV_MIN_COLUMN_WIDTH}
      aria-valuemax={CSV_MAX_COLUMN_WIDTH}
      aria-valuenow={width}
      className="absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none select-none hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return
        }
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width }
        pendingWidth.current = width
      }}
      onPointerMove={(event) => {
        if (!drag.current) {
          return
        }
        pendingWidth.current = drag.current.width + event.clientX - drag.current.x
        if (frame.current === null) {
          frame.current = requestAnimationFrame(() => {
            frame.current = null
            resize(pendingWidth.current)
          })
        }
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onBlur={finish}
      onDoubleClick={() => onReset(index)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          resize(width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 8))
        } else if (event.key === 'Home') {
          event.preventDefault()
          onReset(index)
        }
      }}
    />
  )
}
