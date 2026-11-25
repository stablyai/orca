// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotatePalettePosition } from './annotate-palette-position-store'
import { usePaletteDrag } from './use-palette-drag'

// Where the palette rests and what it saves, through the real pointer and key handlers.
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
  setMinTop: (top: number) => void
  saved: AnnotatePalettePosition
  top: number
  shownY: number
} = { setMinTop: () => {}, saved: { x: 0, y: 0 }, top: 0, shownY: 0 }

function Harness({
  initial,
  initialMinTop
}: {
  initial: AnnotatePalettePosition
  initialMinTop: number
}): React.JSX.Element {
  const [bounds, setBounds] = useState<HTMLDivElement | null>(null)
  const paletteRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState(initial)
  const [minTop, setMinTop] = useState(initialMinTop)
  const drag = usePaletteDrag({
    bounds,
    paletteRef,
    position,
    minTop,
    onPositionChange: setPosition
  })
  controls.setMinTop = setMinTop
  controls.saved = position
  controls.top = drag.top
  controls.shownY = drag.shownPosition.y
  return (
    <div ref={setBounds}>
      <div ref={paletteRef}>
        <span data-testid="grip" {...drag.gripProps} />
      </div>
    </div>
  )
}

function mount(initial: AnnotatePalettePosition, minTop: number): HTMLElement {
  return render(<Harness initial={initial} initialMinTop={minTop} />).getByTestId('grip')
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
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('annotate palette resting place', () => {
  it('clamps a drag against the find bar limit current at release, not the one during the last move', () => {
    // Saved height .2 under a find bar limit of 52: top 52 + 302 * .2 = 112.4.
    const grip = mount({ x: 0.5, y: 0.2 }, 52)
    expect(controls.top).toBeCloseTo(112.4)
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 100 })
    // The last held move ends 90px up (22.4), shown clamped at the find bar's 52…
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 300, clientY: 10, buttons: 1 })
    // …then the find bar stops overlapping and the limit drops to the inset before a stationary release.
    act(() => controls.setMinTop(8))
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 300, clientY: 10 })

    expect.soft(controls.top).toBeCloseTo(22.4)
    // (22.4 - 8) / (400 - 38 - 16)
    expect.soft(controls.saved.y).toBeCloseTo(0.04162, 5)
    expect.soft(controls.saved.x).toBe(0.5)
    expect.soft(controls.shownY).toBeCloseTo(0.04162, 5)
  })

  it('keeps a saved height behind an anchored edge when the key against the edge moves nothing', () => {
    // A 76px palette fits exactly under a 52px limit in a 136px page: saved bottom (1) sits at 52.
    sizes.boundsHeight = 136
    sizes.paletteHeight = 76
    const grip = mount({ x: 0.5, y: 1 }, 52)
    // The content shrinks to 38px: the edge stays at 52, which now shows as the top of 38px of travel.
    sizes.paletteHeight = 38
    act(() => notifyResize?.())
    expect(controls.top).toBe(52)
    expect(controls.shownY).toBe(0)
    expect(controls.saved.y).toBe(1)

    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect.soft(controls.top).toBe(52)
    expect.soft(controls.saved.y).toBe(1)
    // Closing find shows the saved bottom: 8 + (136 - 38 - 16) * 1.
    act(() => controls.setMinTop(8))
    expect.soft(controls.top).toBe(90)
  })

  it('saves the top when a key does move the palette up to it', () => {
    const grip = mount({ x: 0.5, y: 0.05 }, 8)
    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect.soft(controls.saved.y).toBe(0)
    expect.soft(controls.top).toBe(8)
  })

  it('leaves the height where it rests on a sideways drag that snaps back to the saved centre', () => {
    // Saved centre, halfway down, with a 76px palette: top 8 + 308 * .5 = 162.
    sizes.paletteHeight = 76
    const grip = mount({ x: 0.5, y: 0.5 }, 8)
    sizes.paletteHeight = 38
    act(() => notifyResize?.())
    // The edge stays at 162 after the content shrinks, so it shows (162 - 8) / 346 while the saved height is .5.
    expect(controls.top).toBe(162)
    const shownY = controls.shownY
    expect(shownY).toBeCloseTo(0.44509, 5)

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 300, clientY: 50 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 305, clientY: 50, buttons: 1 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 305, clientY: 50 })

    expect.soft(controls.saved).toEqual({ x: 0.5, y: 0.5 })
    expect.soft(controls.top).toBe(162)
    expect.soft(controls.shownY).toBe(shownY)
  })
})
