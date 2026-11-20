// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWebviewDragPassthroughActive } from '../../host-guest/drag/webview-drag-passthrough'
import { usePaletteHorizontalDrag } from './use-palette-horizontal-drag'

// One observer per test: the hook observes the bounds and the palette with it.
let notifyResize: (() => void) | null = null
class FakeResizeObserver {
  constructor(callback: () => void) {
    notifyResize = callback
  }
  observe(): void {}
  disconnect(): void {}
}

const sizes = { bounds: 600, palette: 200 }

function Harness(): React.JSX.Element {
  const [bounds, setBounds] = useState<HTMLDivElement | null>(null)
  const paletteRef = useRef<HTMLDivElement | null>(null)
  const [ratio, setRatio] = useState(0.5)
  const drag = usePaletteHorizontalDrag({ bounds, paletteRef, ratio, onRatioChange: setRatio })
  return (
    <div ref={setBounds}>
      <div ref={paletteRef} data-testid="palette" data-dragging={drag.dragging}>
        <span data-testid="grip" {...drag.gripProps} />
      </div>
    </div>
  )
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => sizes.bounds
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => sizes.palette
  })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: () => {}
  })
  sizes.bounds = 600
  sizes.palette = 200
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function startDrag(): { palette: HTMLElement; grip: HTMLElement } {
  const view = render(<Harness />)
  const palette = view.getByTestId('palette')
  const grip = view.getByTestId('grip')
  fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300 })
  expect(isWebviewDragPassthroughActive()).toBe(true)
  fireEvent.pointerMove(grip, { pointerId: 1, clientX: 250, buttons: 1 })
  return { palette, grip }
}

describe('annotate palette drag lifecycle', () => {
  it('ends the drag and puts the palette back when its width changes mid-drag', () => {
    startDrag()

    // A tool switch (or the picker's capability changing) reshapes the palette under the pointer.
    sizes.palette = 320
    act(() => notifyResize?.())

    expect(isWebviewDragPassthroughActive()).toBe(false)
  })

  it('ends the drag when the page area resizes mid-drag', () => {
    startDrag()

    sizes.bounds = 480
    act(() => notifyResize?.())

    expect(isWebviewDragPassthroughActive()).toBe(false)
  })

  it('keeps dragging when nothing changed size', () => {
    const { grip } = startDrag()

    act(() => notifyResize?.())

    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 250 })
    expect(isWebviewDragPassthroughActive()).toBe(false)
  })
})
