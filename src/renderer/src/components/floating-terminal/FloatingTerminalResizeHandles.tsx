import { useRef } from 'react'
import {
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  type FloatingTerminalPanelBounds
} from './floating-terminal-panel-bounds'

const RESIZE_HANDLES = [
  ['n', 'top-0 left-2 right-2 h-2 cursor-n-resize'],
  ['s', 'bottom-0 left-2 right-2 h-2 cursor-s-resize'],
  ['w', 'left-0 top-2 bottom-2 w-2 cursor-w-resize'],
  ['e', 'right-0 top-2 bottom-2 w-2 cursor-e-resize'],
  ['nw', 'left-0 top-0 size-3 cursor-nw-resize'],
  ['ne', 'right-0 top-0 size-3 cursor-ne-resize'],
  ['sw', 'left-0 bottom-0 size-3 cursor-sw-resize'],
  ['se', 'right-0 bottom-0 size-3 cursor-se-resize']
] as const

type ResizeEdge = (typeof RESIZE_HANDLES)[number][0]

type FloatingTerminalResizeHandlesProps = {
  bounds: FloatingTerminalPanelBounds
  onPreviewBounds: (bounds: FloatingTerminalPanelBounds) => void
  onCommitBounds: () => void
}

export function FloatingTerminalResizeHandles({
  bounds,
  onPreviewBounds,
  onCommitBounds
}: FloatingTerminalResizeHandlesProps): React.JSX.Element {
  const resizeRef = useRef<{
    pointerId: number
    edge: ResizeEdge
    startX: number
    startY: number
    bounds: FloatingTerminalPanelBounds
    moved: boolean
  } | null>(null)

  const handleResizeStart =
    (edge: ResizeEdge) =>
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      resizeRef.current = {
        pointerId: event.pointerId,
        edge,
        startX: event.clientX,
        startY: event.clientY,
        bounds,
        moved: false
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    }

  const handleResizeMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) {
      return
    }
    const dx = event.clientX - resize.startX
    const dy = event.clientY - resize.startY
    if (dx === 0 && dy === 0) {
      return
    }
    const next = { ...resize.bounds }
    if (resize.edge.includes('e')) {
      next.width = resize.bounds.width + dx
    }
    if (resize.edge.includes('s')) {
      next.height = resize.bounds.height + dy
    }
    if (resize.edge.includes('w')) {
      next.left = resize.bounds.left + dx
      next.width = resize.bounds.width - dx
    }
    if (resize.edge.includes('n')) {
      next.top = resize.bounds.top + dy
      next.height = resize.bounds.height - dy
    }
    if (next.width < MIN_PANEL_WIDTH && resize.edge.includes('w')) {
      next.left = resize.bounds.left + resize.bounds.width - MIN_PANEL_WIDTH
    }
    if (next.height < MIN_PANEL_HEIGHT && resize.edge.includes('n')) {
      next.top = resize.bounds.top + resize.bounds.height - MIN_PANEL_HEIGHT
    }
    resize.moved = true
    onPreviewBounds(next)
  }

  const handleResizeEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) {
      return
    }
    if (resize.moved) {
      onCommitBounds()
    }
    resizeRef.current = null
  }

  return (
    <>
      {RESIZE_HANDLES.map(([edge, className]) => (
        <div
          key={edge}
          className={`absolute z-10 ${className}`}
          data-floating-terminal-no-drag
          onPointerDown={handleResizeStart(edge)}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        />
      ))}
    </>
  )
}
