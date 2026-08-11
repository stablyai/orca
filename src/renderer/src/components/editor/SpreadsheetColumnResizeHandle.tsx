import { useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import {
  resolveSpreadsheetResizeKeyStep,
  type SpreadsheetColumnResize
} from './use-spreadsheet-column-resize'

type SpreadsheetColumnResizeHandleProps = {
  columnIndex: number
  /** The column's current rendered width, which the drag starts from. */
  renderedWidthPx: number
  resize: SpreadsheetColumnResize
  /** Column label, so the control announces which column it sizes. */
  label: string
}

/**
 * The grip on a column heading's right edge that sizes the column.
 *
 * Pointer capture rather than window listeners: the pointer routinely leaves the
 * 6px grip mid-drag, and capture keeps the move and up events coming to this
 * element without a listener that could outlive the component.
 */
export function SpreadsheetColumnResizeHandle({
  columnIndex,
  renderedWidthPx,
  resize,
  label
}: SpreadsheetColumnResizeHandleProps): React.JSX.Element {
  const dragStartXRef = useRef(0)
  const isResizing = resize.resizingColumnIndex === columnIndex

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Why: a drag on the grip must not also select the heading text or start the
    // scroll container's own drag.
    event.preventDefault()
    event.stopPropagation()
    dragStartXRef.current = event.clientX
    event.currentTarget.setPointerCapture(event.pointerId)
    resize.startResize(columnIndex, renderedWidthPx)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!isResizing) {
      return
    }
    resize.updateResize(event.clientX - dragStartXRef.current)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    resize.endResize()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = resolveSpreadsheetResizeKeyStep(event.key, event.shiftKey)
    if (step !== null) {
      event.preventDefault()
      resize.nudgeResize(columnIndex, renderedWidthPx, step)
      return
    }
    // Why: the same gesture as double-click, for a reader who cannot drag.
    if (event.key === 'Enter' || event.key === 'Backspace') {
      event.preventDefault()
      resize.resetColumn(columnIndex)
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize column ${label}`}
      tabIndex={0}
      className={cn(
        'absolute inset-y-0 right-0 z-10 w-[6px] cursor-col-resize touch-none select-none',
        'hover:bg-spreadsheet-gridline-strong focus-visible:bg-spreadsheet-gridline-strong focus-visible:outline-none',
        isResizing && 'bg-spreadsheet-gridline-strong'
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => resize.resetColumn(columnIndex)}
    />
  )
}
