// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IMAGE_VIEWER_PAN_DRAG_THRESHOLD } from './image-viewer-pan'
import { useImageViewerPanSurface } from './use-image-viewer-pan'

function createSurface(): HTMLDivElement {
  const capturedPointerIds = new Set<number>()
  const surface = document.createElement('div')
  surface.setPointerCapture = vi.fn((pointerId: number) => capturedPointerIds.add(pointerId))
  surface.hasPointerCapture = vi.fn((pointerId: number) => capturedPointerIds.has(pointerId))
  surface.releasePointerCapture = vi.fn((pointerId: number) => capturedPointerIds.delete(pointerId))
  return surface
}

function pointerDownEvent(
  surface: HTMLDivElement,
  button: number,
  pointerId = 1
): React.PointerEvent<HTMLDivElement> {
  return {
    button,
    clientX: 40,
    clientY: 40,
    currentTarget: surface,
    pointerId,
    preventDefault: vi.fn()
  } as unknown as React.PointerEvent<HTMLDivElement>
}

function firePointer(type: string, pointerId: number, clientX = 40, clientY = 40): void {
  act(() => {
    window.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY, pointerId }))
  })
}

function fireSpace(type: 'keydown' | 'keyup', target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, code: 'Space' })
  act(() => target.dispatchEvent(event))
  return event
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useImageViewerPanSurface', () => {
  it('uses grab cursors and suppresses the click after a Space-left drag', () => {
    const surface = createSurface()
    const { result } = renderHook(() => useImageViewerPanSurface())

    act(() => result.current.onPointerEnter({} as React.PointerEvent<HTMLDivElement>))
    fireSpace('keydown')
    expect(result.current.cursorClassName).toBe('cursor-grab')

    const pointerDown = pointerDownEvent(surface, 0)
    act(() => result.current.onPointerDown(pointerDown))
    expect(pointerDown.preventDefault).toHaveBeenCalledTimes(1)
    expect(result.current.cursorClassName).toBe('cursor-grabbing')

    firePointer('pointermove', 1, 40 + IMAGE_VIEWER_PAN_DRAG_THRESHOLD, 40)
    firePointer('pointerup', 1)

    const clickEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    act(() =>
      result.current.onClickCapture(clickEvent as unknown as React.MouseEvent<HTMLDivElement>)
    )
    expect(clickEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(clickEvent.stopPropagation).toHaveBeenCalledTimes(1)

    fireSpace('keyup')
    expect(result.current.cursorClassName).toBeUndefined()
  })

  it('keeps a plain left click available to open the popup', () => {
    const surface = createSurface()
    const { result } = renderHook(() => useImageViewerPanSurface())
    const pointerDown = pointerDownEvent(surface, 0)

    act(() => result.current.onPointerDown(pointerDown))
    const clickEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    act(() =>
      result.current.onClickCapture(clickEvent as unknown as React.MouseEvent<HTMLDivElement>)
    )

    expect(pointerDown.preventDefault).not.toHaveBeenCalled()
    expect(clickEvent.preventDefault).not.toHaveBeenCalled()
    expect(clickEvent.stopPropagation).not.toHaveBeenCalled()
  })

  it('ends a Space-left pan when Space is released', () => {
    const surface = createSurface()
    const { result } = renderHook(() => useImageViewerPanSurface())

    act(() => result.current.onPointerEnter({} as React.PointerEvent<HTMLDivElement>))
    fireSpace('keydown')
    act(() => result.current.onPointerDown(pointerDownEvent(surface, 0, 9)))
    firePointer('pointermove', 9, 80, 40)
    fireSpace('keyup')

    expect(surface.releasePointerCapture).toHaveBeenCalledWith(9)
    expect(result.current.cursorClassName).toBeUndefined()
  })

  it('cleans up a middle-button pan when the window loses focus', () => {
    const surface = createSurface()
    const { result } = renderHook(() => useImageViewerPanSurface())

    act(() => result.current.onPointerDown(pointerDownEvent(surface, 1, 12)))
    expect(result.current.cursorClassName).toBe('cursor-grabbing')
    act(() => window.dispatchEvent(new Event('blur')))

    expect(surface.releasePointerCapture).toHaveBeenCalledWith(12)
    expect(result.current.cursorClassName).toBeUndefined()
  })

  it('does not claim Space from another control unless the pointer is over the surface', () => {
    const button = document.createElement('button')
    document.body.append(button)
    const { result } = renderHook(() => useImageViewerPanSurface())

    fireSpace('keydown')
    fireSpace('keydown', button)
    expect(result.current.cursorClassName).toBeUndefined()

    act(() => result.current.onPointerEnter({} as React.PointerEvent<HTMLDivElement>))
    const handledSpace = fireSpace('keydown', button)
    expect(handledSpace.defaultPrevented).toBe(true)
    expect(result.current.cursorClassName).toBe('cursor-grab')

    button.remove()
  })
})
