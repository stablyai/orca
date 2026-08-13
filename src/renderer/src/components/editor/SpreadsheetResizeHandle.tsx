import { useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { resolveSpreadsheetResizeKeyStep, type SpreadsheetResize } from './use-spreadsheet-resize'

type SpreadsheetResizeHandleProps = {
  index: number
  /** The track's current rendered size, which the drag starts from. */
  renderedSizePx: number
  resize: SpreadsheetResize
  /** Track label, so the control announces which column or row it sizes. */
  label: string
  /**
   * `vertical` for the bar between two columns, `horizontal` for the one between
   * two rows. It picks the axis the drag reads and the keys that size it.
   */
  orientation: 'vertical' | 'horizontal'
}

/**
 * The grip on a heading's trailing edge that sizes its column or row.
 *
 * Pointer capture rather than window listeners: the pointer routinely leaves the
 * 6px grip mid-drag, and capture keeps the move and up events coming to this
 * element without a listener that could outlive the component.
 */
export function SpreadsheetResizeHandle({
  index,
  renderedSizePx,
  resize,
  label,
  orientation
}: SpreadsheetResizeHandleProps): React.JSX.Element {
  const dragStartRef = useRef(0)
  const isResizing = resize.resizingColumnIndex === index
  const isVertical = orientation === 'vertical'
  const coordinateOf = (event: ReactPointerEvent<HTMLDivElement>): number =>
    isVertical ? event.clientX : event.clientY

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Why: a drag on the grip must not also select the heading text or start the
    // scroll container's own drag.
    event.preventDefault()
    event.stopPropagation()
    dragStartRef.current = coordinateOf(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    resize.startResize(index, renderedSizePx)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!isResizing) {
      return
    }
    resize.updateResize(coordinateOf(event) - dragStartRef.current)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    resize.endResize()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = resolveSpreadsheetResizeKeyStep(event.key, event.shiftKey, orientation)
    if (step !== null) {
      event.preventDefault()
      resize.nudgeResize(index, renderedSizePx, step)
      return
    }
    // Why: the same gesture as double-click, for a reader who cannot drag.
    if (event.key === 'Enter' || event.key === 'Backspace') {
      event.preventDefault()
      resize.resetColumn(index)
    }
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={isVertical ? `Resize column ${label}` : `Resize row ${label}`}
      tabIndex={0}
      className={cn(
        'absolute z-10 touch-none select-none',
        isVertical
          ? 'inset-y-0 right-0 w-[6px] cursor-col-resize'
          : 'inset-x-0 bottom-0 h-[6px] cursor-row-resize',
        'hover:bg-spreadsheet-gridline-strong focus-visible:bg-spreadsheet-gridline-strong focus-visible:outline-none',
        isResizing && 'bg-spreadsheet-gridline-strong'
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => resize.resetColumn(index)}
    />
  )
}
