import { useCallback } from 'react'
import type React from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { PendingText } from './useMarkupKeyboardShortcuts'
import type { MarkupPoint, MarkupTool } from './markup-drawing-model'
import {
  beginDrawGesture,
  beginEraseGesture,
  cancelGesture,
  endGesture,
  moveGesture,
  type MarkupEditorState
} from './markup-gesture'
import type { TextInkBoxMeasurer } from './markup-shape-hit-test'

export type MarkupPointerParams = {
  busy: boolean
  tool: MarkupTool
  color: string
  width: number
  pendingText: PendingText | null
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  measureTextInkBox: TextInkBoxMeasurer
  setPendingText: (value: PendingText | null) => void
  setState: React.Dispatch<React.SetStateAction<MarkupEditorState>>
}

// Canvas pointer interactions: draw a new shape, erase touched ones, or place
// text. Split out of useMarkupEditor to keep that hook focused.
export function useMarkupPointerHandlers(params: MarkupPointerParams) {
  const {
    busy,
    tool,
    color,
    width,
    pendingText,
    canvasRef,
    measureTextInkBox,
    setPendingText,
    setState
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
      const { pointerId } = event
      if (tool === 'eraser') {
        setState((state) => beginEraseGesture(state, pointerId, point, measureTextInkBox))
        return
      }
      const id = createBrowserUuid()
      const shape =
        tool === 'pen' || tool === 'highlight'
          ? { id, kind: tool, color, width, points: [point] }
          : { id, kind: tool, color, width, from: point, to: point }
      setState((state) => beginDrawGesture(state, pointerId, shape))
    },
    [
      busy,
      color,
      measureTextInkBox,
      pendingText,
      pointFromEvent,
      setPendingText,
      setState,
      tool,
      width
    ]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = pointFromEvent(event)
      const { pointerId } = event
      setState((state) => moveGesture(state, pointerId, point, measureTextInkBox))
    },
    [measureTextInkBox, pointFromEvent, setState]
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { pointerId } = event
      setState((state) => endGesture(state, pointerId))
    },
    [setState]
  )

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const { pointerId } = event
      setState((state) => cancelGesture(state, pointerId))
    },
    [setState]
  )

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
