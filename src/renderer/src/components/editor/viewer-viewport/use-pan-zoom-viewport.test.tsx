// @vitest-environment happy-dom
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePanZoomViewport } from './use-pan-zoom-viewport'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('pans ordinary mouse drags only when enabled, without turning a drag into a zoom click', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe(): void {
        this.callback()
      }
      disconnect(): void {}
    }
  )
  function Viewer({ dragToPan }: { dragToPan: boolean }) {
    const view = usePanZoomViewport({ content: { width: 800, height: 600 }, dragToPan })
    return (
      <div
        ref={view.setCanvas}
        {...view.canvasHandlers}
        data-x={view.offset?.x}
        data-y={view.offset?.y}
        data-scale={view.scale}
      />
    )
  }
  const rendered = render(<Viewer dragToPan={false} />)
  const canvas = rendered.container.querySelector('div')
  if (!canvas) {
    throw new Error('Viewer canvas did not mount')
  }
  canvas.setPointerCapture = () => {}
  const pointer = (type: string, x: number, y: number, altKey = false) => {
    act(() =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          clientX: x,
          clientY: y,
          altKey
        })
      )
    )
  }
  const drag = () => {
    pointer('pointerdown', 200, 150)
    pointer('pointermove', 260, 180)
    pointer('pointerup', 260, 180)
  }
  try {
    // A click still selects actual size, making a pan easy to observe.
    pointer('pointerdown', 200, 150)
    pointer('pointerup', 200, 150)
    expect(canvas.dataset.scale).toBe('1')
    expect(canvas.dataset.x).toBe('-200')
    drag()
    expect(canvas.dataset.x).toBe('-200')
    rendered.rerender(<Viewer dragToPan />)
    drag()
    expect(canvas.dataset.x).toBe('-140')
    expect(canvas.dataset.y).toBe('-120')
    expect(canvas.dataset.scale).toBe('1')
    // Returning to the start of a drag is not a click.
    pointer('pointerdown', 200, 150)
    pointer('pointermove', 230, 150)
    pointer('pointermove', 200, 150)
    pointer('pointerup', 200, 150)
    expect(canvas.dataset.scale).toBe('1')
    pointer('pointerdown', 200, 150)
    fireEvent.pointerCancel(canvas, { pointerId: 1, pointerType: 'mouse' })
    pointer('pointermove', 260, 180)
    expect(canvas.dataset.x).toBe('-140')
    pointer('pointerdown', 200, 150)
    pointer('pointerup', 200, 150)
    expect(canvas.dataset.scale).toBe('0.44666666666666666')
  } finally {
    rendered.unmount()
  }
})
