// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type {
  SessionGridScrollMode,
  SessionGridWheelTarget
} from '../../../../shared/session-grid-types'
import { useSessionGridScroll } from './use-session-grid-scroll'

const CONTAINER_HEIGHT = 600
// 600 - 2*12 padding - 1*12 gap, halved: what a 2-row viewport leaves per row.
const ROW_STEP = 282 + 12

let scrollToCalls: ScrollToOptions[] = []

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({ matches: reduce && query.includes('prefers-reduced-motion') }) as never
  )
}

function makeContainer(): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientHeight', { value: CONTAINER_HEIGHT })
  let scrollTop = 0
  Object.defineProperty(el, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next
    }
  })
  el.scrollTo = ((options: ScrollToOptions) => {
    scrollToCalls.push(options)
    el.scrollTop = options.top ?? 0
  }) as HTMLDivElement['scrollTo']
  el.scrollBy = ((options: ScrollToOptions) => {
    el.scrollTop += options.top ?? 0
  }) as HTMLDivElement['scrollBy']
  return el
}

function wheel(target: Element, deltaY: number, init: { shiftKey?: boolean } = {}): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
  if (init.shiftKey) {
    // happy-dom's WheelEvent init drops modifier keys.
    Object.defineProperty(event, 'shiftKey', { value: true })
  }
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function addTerminal(container: HTMLElement): HTMLElement {
  const xterm = document.createElement('div')
  xterm.className = 'xterm'
  container.appendChild(xterm)
  return xterm
}

function mount(mode: SessionGridScrollMode, wheelTarget: SessionGridWheelTarget = 'auto') {
  const container = makeContainer()
  const view = renderHook(
    ({ mode }: { mode: SessionGridScrollMode }) => {
      const scroll = useSessionGridScroll({
        mode,
        wheelTarget,
        rowsPerView: 2,
        totalRowCount: 10,
        totalPageCount: 5
      })
      // Stands in for the layout component that owns the scroll element.
      ;(scroll.scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current =
        container
      return scroll
    },
    { initialProps: { mode } }
  )
  return { container, ...view }
}

describe('useSessionGridScroll', () => {
  beforeEach(() => {
    scrollToCalls = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('steps one row height per position in row mode', () => {
    const { container, result } = mount('row')
    act(() => result.current.scrollToPosition(3))
    expect(container.scrollTop).toBe(3 * ROW_STEP)
    expect(result.current.currentPosition).toBe(3)
  })

  it('steps one full container per page, which is taller than its rows', () => {
    const { container, result } = mount('page')
    act(() => result.current.scrollToPosition(2))
    expect(container.scrollTop).toBe(2 * CONTAINER_HEIGHT)
    expect(2 * ROW_STEP * 2).not.toBe(2 * CONTAINER_HEIGHT)

    container.scrollTop = 3 * CONTAINER_HEIGHT
    act(() => result.current.handleScroll())
    expect(result.current.currentPosition).toBe(3)
  })

  /**
   * The offscreen-attention pill asks the hook which row is on top, and it must be the truth
   * in every mode — including free, where scrolling is continuous and `currentPosition` is a
   * ROUNDED page. Deriving the window from that position drifts by up to half a viewport.
   */
  it('reports the top row exactly, including between pages in free mode', () => {
    const row = mount('row')
    row.container.scrollTop = 3 * ROW_STEP
    act(() => row.result.current.handleScroll())
    expect(row.result.current.firstVisibleRow).toBe(3)
    cleanup()

    const page = mount('page')
    page.container.scrollTop = 2 * CONTAINER_HEIGHT
    act(() => page.result.current.handleScroll())
    // A page is a viewport of rows, so page 2 starts at row 4.
    expect(page.result.current.currentPosition).toBe(2)
    expect(page.result.current.firstVisibleRow).toBe(4)
    cleanup()

    const free = mount('free')
    // Three rows down: page 1.5, which the position rounds to 2 — i.e. row 4, two rows off.
    free.container.scrollTop = 3 * ROW_STEP
    act(() => free.result.current.handleScroll())
    expect(free.result.current.currentPosition).toBe(2)
    expect(free.result.current.firstVisibleRow).toBe(3)

    // And it moves a row at a time, not a page at a time.
    free.container.scrollTop = 5 * ROW_STEP
    act(() => free.result.current.handleScroll())
    expect(free.result.current.firstVisibleRow).toBe(5)
  })

  // Why it matters beyond taste: the offscreen-attention pill drives this, and a smooth
  // scroll never lands where nothing ticks the animation.
  it('jumps instead of animating when the user asked for less motion', () => {
    stubReducedMotion(true)
    const { container, result } = mount('row')

    act(() => result.current.scrollToPosition(3))

    expect(scrollToCalls.at(-1)?.behavior).toBe('auto')
    expect(container.scrollTop).toBe(3 * ROW_STEP)
  })

  it('animates by default', () => {
    stubReducedMotion(false)
    const { result } = mount('row')

    act(() => result.current.scrollToPosition(3))

    expect(scrollToCalls.at(-1)?.behavior).toBe('smooth')
  })

  it('re-derives the position when the mode changes under it', () => {
    const { container, result, rerender } = mount('row')
    container.scrollTop = 4 * ROW_STEP
    act(() => result.current.handleScroll())
    expect(result.current.currentPosition).toBe(4)

    // Free mode counts viewports of 2 rows, so the same offset is page 2.
    act(() => rerender({ mode: 'free' }))
    expect(result.current.currentPosition).toBe(2)
    expect(container.scrollTop).toBe(4 * ROW_STEP)
  })

  describe('wheel', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(10_000)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('leaves the wheel over a terminal to the card, unless Shift forces the grid', () => {
      const { container, result } = mount('row')
      const xterm = addTerminal(container)

      const plain = wheel(xterm, 40)
      expect(plain.defaultPrevented).toBe(false)
      expect(result.current.currentPosition).toBe(0)

      const forced = wheel(xterm, 40, { shiftKey: true })
      expect(forced.defaultPrevented).toBe(true)
      expect(result.current.currentPosition).toBe(1)
    })

    it('steps one row for a flick and never drifts the element under it', () => {
      const { container, result } = mount('row')
      const flick = [4, 9, 16, 24, 30, 34, 32, 29, 25, 21, 17, 13, 10, 8, 6, 4, 3, 2, 1, 1]
      for (const deltaY of flick) {
        wheel(container, deltaY)
        vi.advanceTimersByTime(16)
      }
      expect(result.current.currentPosition).toBe(1)
      expect(container.scrollTop).toBe(ROW_STEP)
    })

    it('anchors the next gesture on the row already commanded, not the one still scrolling', () => {
      const { container, result } = mount('row')
      // A smooth scroll in flight: scrollTop still reads as row 0 after the first step.
      container.scrollTo = (() => {}) as HTMLDivElement['scrollTo']
      wheel(container, 40)
      expect(result.current.currentPosition).toBe(1)
      act(() => result.current.handleScroll())
      expect(result.current.currentPosition).toBe(0)

      vi.advanceTimersByTime(400)
      wheel(container, 40)
      expect(result.current.currentPosition).toBe(2)
    })

    it('takes a handed-off wheel, and keeps the gesture even over a terminal it slid under the pointer', () => {
      const { container, result } = mount('row')
      const xterm = addTerminal(container)
      act(() => {
        container.dispatchEvent(
          new CustomEvent('session-grid-wheel', { detail: { deltaY: 40, discrete: false } })
        )
      })
      expect(result.current.currentPosition).toBe(1)

      vi.advanceTimersByTime(100)
      const tail = wheel(xterm, 300)
      expect(tail.defaultPrevented).toBe(true)
      expect(result.current.currentPosition).toBe(2)

      vi.advanceTimersByTime(400)
      const fresh = wheel(xterm, 40)
      expect(fresh.defaultPrevented).toBe(false)
      expect(result.current.currentPosition).toBe(2)
    })

    it('claims a plain wheel over a terminal under the grid target, and leaves Shift to the card', () => {
      const { container, result } = mount('row', 'grid')
      const xterm = addTerminal(container)

      const plain = wheel(xterm, 40)
      expect(plain.defaultPrevented).toBe(true)
      expect(result.current.currentPosition).toBe(1)

      vi.advanceTimersByTime(400)
      const shifted = wheel(xterm, 40, { shiftKey: true })
      expect(shifted.defaultPrevented).toBe(false)
      expect(result.current.currentPosition).toBe(1)
    })

    it('leaves every plain wheel over a terminal to the card under the terminal target', () => {
      const { container, result } = mount('row', 'terminal')
      const xterm = addTerminal(container)

      expect(wheel(xterm, 40).defaultPrevented).toBe(false)
      expect(result.current.currentPosition).toBe(0)
      expect(wheel(xterm, 40, { shiftKey: true }).defaultPrevented).toBe(true)
      expect(result.current.currentPosition).toBe(1)
    })

    it('scrolls the element by the raw delta in free mode', () => {
      const { container, result } = mount('free')
      wheel(container, 25)
      wheel(container, 25)
      expect(container.scrollTop).toBe(50)
      expect(result.current.currentPosition).toBe(0)
    })
  })
})
