// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ColumnResizeHandle from './ColumnResizeHandle'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

/** Fakes a laid-out width, since happy-dom reports offsetWidth as 0. */
function stagePixelWidth(element: Element | null, px: number | undefined): void {
  if (element && px !== undefined) {
    Object.defineProperty(element, 'offsetWidth', { configurable: true, value: px })
  }
}

type OnResize = (field: string, width: number, nextField: string, nextWidth: number) => void

/** Renders the handle between two cells, optionally staging their pixel widths. */
function renderHandle(
  widths: { current: number; next: number; currentPx?: number; nextPx?: number } = {
    current: 200,
    next: 200
  }
): { onResize: ReturnType<typeof vi.fn<OnResize>>; handle: HTMLElement } {
  const onResize = vi.fn<OnResize>()
  const { container } = render(
    <div>
      <div data-testid="cell">
        <ColumnResizeHandle
          fieldId="title"
          nextFieldId="status"
          currentWidth={widths.current}
          nextWidth={widths.next}
          onResize={onResize}
        />
      </div>
      <div data-testid="next-cell" />
    </div>
  )
  // happy-dom lays nothing out, so stage the rendered pixel widths the handle measures.
  stagePixelWidth(container.querySelector('[data-testid="cell"]'), widths.currentPx)
  stagePixelWidth(container.querySelector('[data-testid="next-cell"]'), widths.nextPx)
  return { onResize, handle: screen.getByRole('separator', { name: 'Resize column' }) }
}

describe('ColumnResizeHandle keyboard resizing', () => {
  it('is reachable by keyboard focus', () => {
    const { handle } = renderHandle()

    expect(handle.tabIndex).toBe(0)
  })

  it('reports the split between the column pair', () => {
    const { handle } = renderHandle()

    expect(handle.getAttribute('aria-valuenow')).toBe('50')
  })

  it.each([
    ['ArrowRight', 220],
    ['ArrowLeft', 180]
  ])('resizes the column pair on %s with the pair total held constant', (key, expected) => {
    const { onResize, handle } = renderHandle()

    fireEvent.keyDown(handle, { key })

    expect(onResize).toHaveBeenCalledTimes(1)
    const [field, width, nextField, nextWidth] = onResize.mock.calls[0]
    expect([field, nextField]).toEqual(['title', 'status'])
    expect(width).toBeCloseTo(expected, 6)
    expect(width + nextWidth).toBeCloseTo(400, 6)
  })

  it('floors the shrinking column at the measured pixel minimum', () => {
    // 1px per fr: the 60px floor is 60fr, so a 10fr step from 65 stops at 60.
    const { onResize, handle } = renderHandle({
      current: 65,
      next: 135,
      currentPx: 65,
      nextPx: 135
    })

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })

    expect(onResize).toHaveBeenCalledWith('title', 60, 'status', 140)
  })

  it('stops at the stored fr floor even when the pixel floor is lower', () => {
    // 2px per fr: the 60px floor is 30fr, but the store never keeps a weight under 60fr.
    const { onResize, handle } = renderHandle({
      current: 140,
      next: 60,
      currentPx: 280,
      nextPx: 120
    })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    expect(onResize).not.toHaveBeenCalled()
  })

  it('exposes the same limits the keyboard clamp enforces', () => {
    const { handle } = renderHandle({ current: 140, next: 60, currentPx: 280, nextPx: 120 })

    fireEvent.focus(handle)

    expect(handle.getAttribute('aria-valuemin')).toBe('30')
    expect(handle.getAttribute('aria-valuemax')).toBe('70')
    expect(handle.getAttribute('aria-valuenow')).toBe('70')
  })

  it.each([
    // 280fr at 200px: the 60px floor is 84fr, so 220fr (79%) renders capped at 70%.
    ['a layout narrower than the stored split', 220, 60, 100, '30', '70', '70'],
    // 160fr at 100px: both 60px floors cannot fit, so the pair is pinned at 50%.
    ['a pair too narrow to resize', 100, 60, 50, '50', '50', '50']
  ])(
    'keeps aria-valuenow inside the announced range for %s',
    (_case, current, next, cellPx, min, max, now) => {
      const { handle } = renderHandle({ current, next, currentPx: cellPx, nextPx: cellPx })

      fireEvent.focus(handle)

      expect(handle.getAttribute('aria-valuemin')).toBe(min)
      expect(handle.getAttribute('aria-valuemax')).toBe(max)
      expect(handle.getAttribute('aria-valuenow')).toBe(now)
    }
  )

  it('does not move against the pressed arrow when the stored split exceeds the live clamp', () => {
    // 280fr at 200px: the clamp is 84–196fr, so 220fr sits past the right edge.
    const { onResize, handle } = renderHandle({
      current: 220,
      next: 60,
      currentPx: 100,
      nextPx: 100
    })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onResize).not.toHaveBeenCalled()

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(onResize).toHaveBeenCalledWith('title', 196, 'status', 84)
  })

  it('updates the announced range when the pair is relaid out while focused', () => {
    const observers = new Set<MockResizeObserver>()
    /** Records observed cells so the test can fire a relayout by hand. */
    class MockResizeObserver implements ResizeObserver {
      readonly elements = new Set<Element>()
      constructor(readonly callback: ResizeObserverCallback) {
        observers.add(this)
      }
      observe(element: Element): void {
        this.elements.add(element)
      }
      unobserve(element: Element): void {
        this.elements.delete(element)
      }
      disconnect(): void {
        this.elements.clear()
        observers.delete(this)
      }
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    try {
      // 200fr at 400px: the 60fr stored floor wins, so the range is 30–70%.
      const { handle } = renderHandle({ current: 140, next: 60, currentPx: 280, nextPx: 120 })
      fireEvent.focus(handle)
      expect(handle.getAttribute('aria-valuemin')).toBe('30')

      // Relaid out at 150px: the 60px floor is 80fr, so the range narrows to 40–60%.
      stagePixelWidth(screen.getByTestId('cell'), 100)
      stagePixelWidth(screen.getByTestId('next-cell'), 50)
      act(() => {
        for (const observer of observers) {
          observer.callback([], observer)
        }
      })

      expect(handle.getAttribute('aria-valuemin')).toBe('40')
      expect(handle.getAttribute('aria-valuemax')).toBe('60')

      fireEvent.blur(handle)
      expect(observers.size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ignores keys that are not a resize gesture', () => {
    const { onResize, handle } = renderHandle()

    fireEvent.keyDown(handle, { key: 'Enter' })

    expect(onResize).not.toHaveBeenCalled()
  })
})
