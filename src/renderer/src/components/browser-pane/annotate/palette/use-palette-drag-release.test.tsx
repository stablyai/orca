// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWebviewDragPassthroughActive } from '../../host-guest/drag/webview-drag-passthrough'
import type { AnnotatePalettePosition } from './annotate-palette-position-store'
import { usePaletteDrag } from './use-palette-drag'

// What a drag saves when it is let go: the release's own point, and the page and palette sizes at that moment.
let notifyResize: (() => void) | null = null
class FakeResizeObserver {
  constructor(callback: () => void) {
    notifyResize = callback
  }
  observe(): void {}
  disconnect(): void {}
}

const sizes = { bounds: 600, palette: 200, boundsHeight: 400, paletteHeight: 38 }
const controls: {
  saved: AnnotatePalettePosition
  left: number | null
  top: number
  saves: number
} = { saved: { x: 0, y: 0 }, left: null, top: 0, saves: 0 }

function Harness({ initial }: { initial: AnnotatePalettePosition }): React.JSX.Element {
  const [bounds, setBounds] = useState<HTMLDivElement | null>(null)
  const paletteRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState(initial)
  const drag = usePaletteDrag({
    bounds,
    paletteRef,
    position,
    minTop: 8,
    onPositionChange: (next) => {
      controls.saves += 1
      setPosition(next)
    }
  })
  controls.saved = position
  controls.left = drag.left
  controls.top = drag.top
  return (
    <div ref={setBounds}>
      <div ref={paletteRef}>
        <span data-testid="grip" {...drag.gripProps} />
      </div>
    </div>
  )
}

function mount(initial: AnnotatePalettePosition): HTMLElement {
  return render(<Harness initial={initial} />).getByTestId('grip')
}

function resizeObserved(): void {
  act(() => notifyResize?.())
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  const size = (name: string, get: () => number): void => {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get })
  }
  size('clientWidth', () => sizes.bounds)
  size('offsetWidth', () => sizes.palette)
  size('clientHeight', () => sizes.boundsHeight)
  size('offsetHeight', () => sizes.paletteHeight)
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: () => {}
  })
  Object.assign(sizes, { bounds: 600, palette: 200, boundsHeight: 400, paletteHeight: 38 })
  controls.saves = 0
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('annotate palette release endpoint', () => {
  it('rests and saves where the pointer is released, not at the last move', () => {
    // Saved centre: 8 + (600 - 200 - 16) * .5 = 200.
    const grip = mount({ x: 0.5, y: 0 })
    expect(controls.left).toBe(200)
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 50 })
    // The last move is within the centre snap; the release is 70px right of the start.
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 305, clientY: 50, buttons: 1 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 370, clientY: 50 })

    expect.soft(controls.left).toBe(270)
    expect.soft(controls.saved.x).toBeCloseTo(262 / 384, 10)
    // The height wasn't dragged: its saved place stays.
    expect.soft(controls.saved.y).toBe(0)
    expect.soft(controls.top).toBe(8)
  })

  it('saves the released height and keeps a pinned horizontal place in a narrow pane', () => {
    // A 200px palette fills a 216px page across; the saved .53 is kept for a wider page.
    sizes.bounds = 216
    const grip = mount({ x: 0.53, y: 0 })
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 100, clientY: 50 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 140, clientY: 110, buttons: 1 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 140, clientY: 130 })

    // 80px down of 346, not the last move's 60.
    expect.soft(controls.top).toBe(88)
    expect.soft(controls.saved.y).toBeCloseTo(80 / 346, 10)
    expect.soft(controls.saved.x).toBe(0.53)
    expect.soft(controls.left).toBe(8)
  })

  it('takes the last held move, not a later hover, when the release was missed', () => {
    const grip = mount({ x: 0.5, y: 0 })
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 50 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 370, clientY: 50, buttons: 1 })
    // No pointer-up arrived; the next move has no button held and is far away.
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 500, clientY: 200, buttons: 0 })

    expect.soft(controls.left).toBe(270)
    expect.soft(controls.saved.x).toBeCloseTo(262 / 384, 10)
    expect.soft(controls.saved.y).toBe(0)
    expect.soft(isWebviewDragPassthroughActive()).toBe(false)
    // The drag is over: a stray release afterwards changes nothing.
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 100, clientY: 50 })
    expect.soft(controls.left).toBe(270)
    expect.soft(controls.saves).toBe(1)
  })

  it('ignores another pointer’s release and ends on its own', () => {
    const grip = mount({ x: 0.5, y: 0 })
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 50 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 305, clientY: 50, buttons: 1 })
    fireEvent.pointerUp(grip, { pointerId: 2, clientX: 500, clientY: 50 })
    expect.soft(isWebviewDragPassthroughActive()).toBe(true)
    expect.soft(controls.saves).toBe(0)

    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 370, clientY: 50 })
    expect.soft(controls.left).toBe(270)
    expect.soft(controls.saved.x).toBeCloseTo(262 / 384, 10)
  })

  it('saves nothing when cancelled, wherever the pointer is', () => {
    const grip = mount({ x: 0.5, y: 0 })
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 50 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 370, clientY: 90, buttons: 1 })
    fireEvent.pointerCancel(grip, { pointerId: 1, clientX: 400, clientY: 120 })

    expect.soft(controls.saves).toBe(0)
    expect.soft(controls.left).toBe(200)
    expect.soft(controls.top).toBe(8)
  })
})

describe('annotate palette release after an unreported resize', () => {
  it('saves neither axis when the page narrowed before the observer reported it', () => {
    // 8 + 384 * .53 = 211.52 across; 8 + 346 * .2 = 77.2 down.
    const grip = mount({ x: 0.53, y: 0.2 })
    expect(controls.left).toBeCloseTo(211.52, 10)
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 340, clientY: 130, buttons: 1 })
    // The page is already 216px wide when the release comes; the observer hasn't run yet.
    sizes.bounds = 216
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 340, clientY: 130 })

    expect.soft(controls.saves).toBe(0)
    expect.soft(controls.saved).toEqual({ x: 0.53, y: 0.2 })
    // Laid out for the page as it is now: no room across, the height where it was.
    expect.soft(controls.left).toBe(8)
    expect.soft(controls.top).toBeCloseTo(77.2, 10)
    expect.soft(isWebviewDragPassthroughActive()).toBe(false)

    // The late notification changes nothing…
    resizeObserved()
    expect.soft(controls.saved).toEqual({ x: 0.53, y: 0.2 })
    expect.soft(controls.left).toBe(8)
    // …and widening again shows the saved place.
    sizes.bounds = 600
    resizeObserved()
    expect.soft(controls.left).toBeCloseTo(211.52, 10)
    expect.soft(controls.top).toBeCloseTo(77.2, 10)
    expect.soft(controls.saves).toBe(0)
  })

  it('saves neither axis when the page got shorter before the observer reported it', () => {
    const grip = mount({ x: 0.53, y: 0.2 })
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 340, clientY: 130, buttons: 1 })
    sizes.boundsHeight = 200
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 340, clientY: 130 })

    expect.soft(controls.saves).toBe(0)
    expect.soft(controls.saved).toEqual({ x: 0.53, y: 0.2 })
    // 8 + (200 - 38 - 16) * .2 = 37.2.
    expect.soft(controls.top).toBeCloseTo(37.2, 10)
    expect.soft(controls.left).toBeCloseTo(211.52, 10)
    resizeObserved()
    expect.soft(controls.top).toBeCloseTo(37.2, 10)
    sizes.boundsHeight = 400
    resizeObserved()
    expect.soft(controls.top).toBeCloseTo(77.2, 10)
    expect.soft(controls.saves).toBe(0)
  })

  it('still ends the drag when the observer reports the resize first', () => {
    const grip = mount({ x: 0.53, y: 0.2 })
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 340, clientY: 130, buttons: 1 })
    sizes.bounds = 216
    resizeObserved()
    expect.soft(isWebviewDragPassthroughActive()).toBe(false)
    expect.soft(controls.left).toBe(8)

    // The release after it belongs to no drag.
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 340, clientY: 130 })
    expect.soft(controls.saves).toBe(0)
    sizes.bounds = 600
    resizeObserved()
    expect.soft(controls.left).toBeCloseTo(211.52, 10)
    expect.soft(controls.top).toBeCloseTo(77.2, 10)
  })

  it('saves a drag released at unchanged sizes', () => {
    // Control for the two above: the same drag with no resize saves both axes.
    const grip = mount({ x: 0.53, y: 0.2 })
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 340, clientY: 130, buttons: 1 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 340, clientY: 130 })

    expect.soft(controls.saves).toBe(1)
    expect.soft(controls.left).toBeCloseTo(251.52, 10)
    expect.soft(controls.saved.x).toBeCloseTo(243.52 / 384, 10)
    expect.soft(controls.saved.y).toBeCloseTo(99.2 / 346, 10)
  })
})
