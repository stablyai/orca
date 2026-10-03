// @vitest-environment happy-dom

import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMarkupEditor } from './useMarkupEditor'

const realCrypto = globalThis.crypto

function pointerEvent(clientX: number, clientY: number): React.PointerEvent<HTMLCanvasElement> {
  return {
    button: 0,
    clientX,
    clientY,
    currentTarget: { setPointerCapture: vi.fn() },
    pointerId: 1,
    preventDefault: vi.fn()
  } as unknown as React.PointerEvent<HTMLCanvasElement>
}

function secondPointerEvent(
  clientX: number,
  clientY: number
): React.PointerEvent<HTMLCanvasElement> {
  return { ...pointerEvent(clientX, clientY), pointerId: 2 }
}

describe('useMarkupEditor.commitPendingText in a non-secure browser context', () => {
  beforeEach(() => {
    // Match a non-secure browser context (LAN web client over plain HTTP):
    // getRandomValues stays, randomUUID is undefined.
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) }
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto })
  })

  it('commits a text shape with a valid id instead of throwing', () => {
    const { result } = renderHook(() => useMarkupEditor(false, vi.fn()))

    act(() => result.current.setTool('text'))
    act(() => result.current.onPointerDown(pointerEvent(5, 5)))
    expect(result.current.pendingText).not.toBeNull()

    expect(() => act(() => result.current.commitPendingText('hello'))).not.toThrow()

    const shape = result.current.shapes.at(-1)
    expect(shape?.kind).toBe('text')
    expect(shape?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe('useMarkupEditor gestures', () => {
  type Editor = ReturnType<typeof useMarkupEditor>

  // A horizontal pen stroke from (0, y) to (100, y).
  function drawLine(editor: { current: Editor }, y: number): void {
    act(() => editor.current.onPointerDown(pointerEvent(0, y)))
    act(() => editor.current.onPointerMove(pointerEvent(100, y)))
    act(() => editor.current.onPointerUp(pointerEvent(100, y)))
  }

  // Pointer positions are read relative to the canvas, so the editor needs one.
  function renderEditor(options?: { wrapper: typeof StrictMode }): { current: Editor } {
    const { result } = renderHook(() => useMarkupEditor(false, vi.fn()), options)
    result.current.canvasRef.current = document.createElement('canvas')
    return result
  }

  it('commits a drawn stroke exactly once under StrictMode', () => {
    const result = renderEditor({ wrapper: StrictMode })

    drawLine(result, 0)

    expect(result.current.shapes).toHaveLength(1)
  })

  it('erases the touched mark, hiding it from the export before release, and undo restores it', () => {
    const result = renderEditor({ wrapper: StrictMode })
    drawLine(result, 0)
    drawLine(result, 200)
    const [first, second] = result.current.shapes

    act(() => result.current.setTool('eraser'))
    act(() => result.current.onPointerDown(pointerEvent(50, 0)))
    expect(result.current.shapes).toEqual([second])

    act(() => result.current.onPointerUp(pointerEvent(50, 0)))
    expect(result.current.shapes).toEqual([second])

    act(() => result.current.undo())
    expect(result.current.shapes).toEqual([first, second])
  })

  it('lets only the finger that started an erase steer and end it', () => {
    const result = renderEditor()
    drawLine(result, 0)
    drawLine(result, 200)
    const [first, second] = result.current.shapes

    act(() => result.current.setTool('eraser'))
    act(() => result.current.onPointerDown(pointerEvent(50, 0)))
    act(() => result.current.onPointerMove(secondPointerEvent(50, 200)))
    expect(result.current.shapes).toEqual([second])

    act(() => result.current.onPointerUp(secondPointerEvent(50, 200)))
    act(() => result.current.onPointerMove(pointerEvent(50, 200)))
    act(() => result.current.onPointerUp(pointerEvent(50, 200)))
    expect(result.current.shapes).toEqual([])

    // Both marks went in one gesture, so one undo brings both back.
    act(() => result.current.undo())
    expect(result.current.shapes).toEqual([first, second])
  })

  it('abandons an in-flight erase when undo is pressed, leaving redo intact', () => {
    const result = renderEditor()
    drawLine(result, 0)
    drawLine(result, 200)
    const [first, second] = result.current.shapes

    act(() => result.current.setTool('eraser'))
    act(() => result.current.onPointerDown(pointerEvent(50, 0)))
    act(() => result.current.undo())
    expect(result.current.shapes).toEqual([first])

    act(() => result.current.onPointerUp(pointerEvent(50, 0)))
    expect(result.current.shapes).toEqual([first])

    act(() => result.current.redo())
    expect(result.current.shapes).toEqual([first, second])
  })

  it('drops an in-flight stroke when everything is cleared', () => {
    const result = renderEditor()

    act(() => result.current.onPointerDown(pointerEvent(0, 0)))
    act(() => result.current.onPointerMove(pointerEvent(100, 0)))
    act(() => result.current.clear())
    act(() => result.current.onPointerUp(pointerEvent(100, 0)))

    expect(result.current.shapes).toEqual([])
  })
})
