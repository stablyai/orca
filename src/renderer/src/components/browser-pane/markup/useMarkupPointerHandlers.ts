import { useCallback } from 'react'
import type React from 'react'
import type { PendingText } from './useMarkupKeyboardShortcuts'
import {
  commitShape,
  type MarkupDocument,
  type MarkupPoint,
  type MarkupShape,
  type MarkupTool
} from './markup-drawing-model'

export type MarkupPointerParams = {
  busy: boolean
  tool: MarkupTool
  color: string
  width: number
  pendingText: PendingText | null
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  setInProgress: React.Dispatch<React.SetStateAction<MarkupShape | null>>
  setPendingText: (value: PendingText | null) => void
  setDoc: React.Dispatch<React.SetStateAction<MarkupDocument>>
}

// Canvas pointer interactions: draw a new shape, or place text. Split out of
// useMarkupEditor to keep that hook focused.
export function useMarkupPointerHandlers(params: MarkupPointerParams) {
  const { busy, tool, color, width, pendingText, canvasRef, setInProgress, setPendingText, setDoc } =
    params

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
      if (tool === 'text') {
        // Why: a box is already open — this click's job is only to commit it (the
        // input's blur fires), not to open a second box at the click point.
        if (pendingText) {
          return
        }
        // Why: keep focus off the canvas so the mounting text input keeps it.
        event.preventDefault()
        setPendingText({ x: point.x, y: point.y, initial: '' })
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      const id = crypto.randomUUID()
      if (tool === 'pen' || tool === 'highlight') {
        setInProgress({ id, kind: tool, color, width, points: [point] })
      } else {
        setInProgress({ id, kind: tool, color, width, from: point, to: point })
      }
    },
    [busy, color, pendingText, pointFromEvent, setInProgress, setPendingText, tool, width]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
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
    [pointFromEvent, setInProgress]
  )

  const onPointerUp = useCallback(() => {
    setInProgress((current) => {
      if (current) {
        setDoc((document) => commitShape(document, current))
      }
      return null
    })
  }, [setDoc, setInProgress])

  return { onPointerDown, onPointerMove, onPointerUp }
}
