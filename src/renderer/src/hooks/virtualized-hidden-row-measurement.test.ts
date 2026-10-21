// @vitest-environment happy-dom
import {
  measureElement,
  observeElementOffset,
  observeElementRect,
  Virtualizer
} from '@tanstack/react-virtual'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureVirtualRowRetainingHiddenSize } from './virtualized-hidden-row-measurement'

const ROW_COUNT = 20
const MEASURED_ROW_HEIGHT = 1162
const UNMEASURED_ESTIMATE = 400
const SCROLL_TOP = 5250

type RowMeasurer = (
  element: Element,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLDivElement, Element>
) => number

function sizeEntry(target: Element, size: number): ResizeObserverEntry {
  const box = [{ blockSize: size, inlineSize: size }]
  return {
    target,
    borderBoxSize: box,
    contentBoxSize: box,
    devicePixelContentBoxSize: box,
    contentRect: new DOMRect(0, 0, size, size)
  }
}

function setHidden(element: HTMLElement): void {
  // Why: happy-dom always reports one client rect; a display:none subtree reports none.
  const empty = element.getClientRects()
  Array.prototype.splice.call(empty, 0, empty.length)
  vi.spyOn(element, 'getClientRects').mockReturnValue(empty)
}

function createViewport(measure: RowMeasurer): {
  rowElement: (index: number) => HTMLElement
  scrollElement: HTMLDivElement
  virtualizer: Virtualizer<HTMLDivElement, Element>
} {
  const scrollElement = document.createElement('div')
  document.body.appendChild(scrollElement)
  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count: ROW_COUNT,
    estimateSize: () => UNMEASURED_ESTIMATE,
    getScrollElement: () => scrollElement,
    initialOffset: SCROLL_TOP,
    measureElement: measure,
    observeElementOffset,
    observeElementRect,
    // Why: the browser keeps a hidden scroller's scrollTop; adjustments must not move it here either.
    scrollToFn: () => {}
  })
  virtualizer._willUpdate()
  const rowElement = (index: number): HTMLElement => {
    const row = document.createElement('div')
    row.setAttribute('data-index', String(index))
    scrollElement.appendChild(row)
    return row
  }
  // The user scrolled through rows 0-6, so each has a real measured height.
  for (let index = 0; index <= 6; index++) {
    const row = rowElement(index)
    virtualizer.resizeItem(index, measure(row, sizeEntry(row, MEASURED_ROW_HEIGHT), virtualizer))
  }
  return { rowElement, scrollElement, virtualizer }
}

/** Hides the scroller, delivers the 0px ResizeObserver reports for the mounted rows, and re-shows it. */
function runHideCycle(measure: RowMeasurer): { topKey: unknown; totalSize: number } {
  const { rowElement, scrollElement, virtualizer } = createViewport(measure)
  setHidden(scrollElement)
  for (const index of [4, 5]) {
    const row = rowElement(index)
    virtualizer.resizeItem(index, measure(row, sizeEntry(row, 0), virtualizer))
  }
  vi.restoreAllMocks()
  return {
    topKey: virtualizer.getVirtualItemForOffset(SCROLL_TOP)?.key,
    totalSize: virtualizer.getTotalSize()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('measureVirtualRowRetainingHiddenSize', () => {
  const visibleState = (): { topKey: unknown; totalSize: number } => {
    const { virtualizer } = createViewport(measureVirtualRowRetainingHiddenSize)
    return {
      topKey: virtualizer.getVirtualItemForOffset(SCROLL_TOP)?.key,
      totalSize: virtualizer.getTotalSize()
    }
  }

  it('reproduces the drift with the default TanStack measurement', () => {
    const before = visibleState()
    const after = runHideCycle(measureElement)

    expect(before.topKey).toBe(4)
    // Rows above the fold collapsed to 0px, so the same scrollTop now lands two files later.
    expect(after.topKey).toBe(6)
    expect(after.totalSize).toBe(before.totalSize - 2 * MEASURED_ROW_HEIGHT)
  })

  it('keeps the same row under the same scrollTop across a hide/re-show', () => {
    const before = visibleState()
    const after = runHideCycle(measureVirtualRowRetainingHiddenSize)

    expect(after).toEqual(before)
  })

  it('measures normally while the scroller is laid out', () => {
    const { rowElement, virtualizer } = createViewport(measureVirtualRowRetainingHiddenSize)
    const row = rowElement(4)

    expect(measureVirtualRowRetainingHiddenSize(row, sizeEntry(row, 560), virtualizer)).toBe(560)
  })

  it('falls back to the estimate for a row first seen while hidden', () => {
    const { rowElement, scrollElement, virtualizer } = createViewport(
      measureVirtualRowRetainingHiddenSize
    )
    setHidden(scrollElement)
    const row = rowElement(12)

    expect(measureVirtualRowRetainingHiddenSize(row, sizeEntry(row, 0), virtualizer)).toBe(
      UNMEASURED_ESTIMATE
    )
  })
})
