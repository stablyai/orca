import { useCallback } from 'react'
import type React from 'react'
import { findTopShape } from './markup-hit-test'
import { moveShapeInDocument } from './markup-editor-document'
import type { PendingText } from './useMarkupKeyboardShortcuts'
import {
  commitShape,
  type MarkupDocument,
  type MarkupPoint,
  type MarkupShape,
  type MarkupTool
} from './markup-drawing-model'

// Hit-test slop in CSS px so thin strokes are still easy to grab.
const SELECT_TOLERANCE = 6

export type MarkupPointerParams = {
  busy: boolean
  tool: MarkupTool
  color: string
  width: number
  shapes: readonly MarkupShape[]
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  dragRef: React.MutableRefObject<{ id: string; startX: number; startY: number } | null>
  dragOffsetRef: React.MutableRefObject<{ dx: number; dy: number }>
  select: (id: string | null) => void
  setInProgress: React.Dispatch<React.SetStateAction<MarkupShape | null>>
  setPendingText: (value: PendingText | null) => void
  setEditingTextId: (value: string | null) => void
  setColor: (value: string) => void
  setFontSize: (value: number) => void
  setDragOffset: (value: { dx: number; dy: number } | null) => void
  setDoc: React.Dispatch<React.SetStateAction<MarkupDocument>>
}

// Canvas pointer interactions: draw new shapes, select + drag-move an existing
// shape, and place / double-click-to-edit text. Split out of useMarkupEditor to
// keep that hook focused.
export function useMarkupPointerHandlers(params: MarkupPointerParams) {
  const {
    busy,
    tool,
    color,
    width,
    shapes,
    canvasRef,
    dragRef,
    dragOffsetRef,
    select,
    setInProgress,
    setPendingText,
    setEditingTextId,
    setColor,
    setFontSize,
    setDragOffset,
    setDoc
  } = params

  const pointFromEvent = useCallback(
    (event: { clientX: number; clientY: number }): MarkupPoint => {
      const canvas = canvasRef.current
      if (!canvas) {
        return { x: 0, y: 0 }
      }
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    },
    [canvasRef]
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (busy || event.button !== 0) {
        return
      }
      const point = pointFromEvent(event)
      if (tool === 'select') {
        const hit = findTopShape(shapes, point, SELECT_TOLERANCE)
        select(hit ? hit.id : null)
        if (hit) {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = { id: hit.id, startX: point.x, startY: point.y }
          dragOffsetRef.current = { dx: 0, dy: 0 }
          setDragOffset({ dx: 0, dy: 0 })
        }
        return
      }
      if (tool === 'text') {
        // Why: keep focus off the canvas so the mounting text input keeps it.
        event.preventDefault()
        setPendingText({ x: point.x, y: point.y, initial: '' })
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      const id = crypto.randomUUID()
      if (tool === 'pen' || tool === 'highlight') {
        setInProgress({ id, kind: tool, color, width, points: [point] })
      } else if (tool === 'arrow' || tool === 'rect' || tool === 'ellipse') {
        setInProgress({ id, kind: tool, color, width, from: point, to: point })
      }
    },
    [
      busy,
      color,
      dragRef,
      dragOffsetRef,
      pointFromEvent,
      select,
      setDragOffset,
      setInProgress,
      setPendingText,
      shapes,
      tool,
      width
    ]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (dragRef.current) {
        const point = pointFromEvent(event)
        const offset = {
          dx: point.x - dragRef.current.startX,
          dy: point.y - dragRef.current.startY
        }
        dragOffsetRef.current = offset
        setDragOffset(offset)
        return
      }
      setInProgress((current) => {
        if (!current) {
          return current
        }
        const point = pointFromEvent(event)
        if (current.kind === 'pen' || current.kind === 'highlight') {
          return { ...current, points: [...current.points, point] }
        }
        if (current.kind === 'text') {
          return current
        }
        return { ...current, to: point }
      })
    },
    [dragRef, dragOffsetRef, pointFromEvent, setDragOffset, setInProgress]
  )

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current
    if (drag) {
      dragRef.current = null
      const offset = dragOffsetRef.current
      setDragOffset(null)
      if (offset.dx !== 0 || offset.dy !== 0) {
        setDoc((document) => moveShapeInDocument(document, drag.id, offset.dx, offset.dy))
      }
      return
    }
    setInProgress((current) => {
      if (current) {
        setDoc((document) => commitShape(document, current))
      }
      return null
    })
  }, [dragRef, dragOffsetRef, setDoc, setDragOffset, setInProgress])

  const onDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      if (tool !== 'select') {
        return
      }
      const point = pointFromEvent(event)
      const hit = findTopShape(shapes, point, SELECT_TOLERANCE)
      if (hit && hit.kind === 'text') {
        select(hit.id)
        setColor(hit.color)
        setFontSize(hit.fontSize)
        setEditingTextId(hit.id)
        setPendingText({ x: hit.at.x, y: hit.at.y, initial: hit.text })
      }
    },
    [pointFromEvent, select, setColor, setEditingTextId, setFontSize, setPendingText, shapes, tool]
  )

  return { onPointerDown, onPointerMove, onPointerUp, onDoubleClick }
}
