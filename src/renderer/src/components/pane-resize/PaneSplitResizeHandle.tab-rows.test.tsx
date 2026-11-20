// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizeHandle } from './PaneSplitResizeHandle'

// happy-dom has no layout or ResizeObserver: tests set element bounds and report resizes themselves.
const boxes = new Map<Element, { top: number; bottom: number; left: number; right: number }>()
const observers: { callback: () => void; targets: Set<Element> }[] = []

class FakeResizeObserver {
  private entry: { callback: () => void; targets: Set<Element> }
  constructor(callback: () => void) {
    this.entry = { callback, targets: new Set() }
    observers.push(this.entry)
  }
  observe(target: Element): void {
    this.entry.targets.add(target)
  }
  unobserve(target: Element): void {
    this.entry.targets.delete(target)
  }
  disconnect(): void {
    this.entry.targets.clear()
  }
}

function place(element: Element, top: number, bottom: number, left: number, right: number): void {
  boxes.set(element, { top, bottom, left, right })
}

/** Reports a size change of `element` to whoever observes it, as the browser would. */
function resized(element: Element): void {
  act(() => {
    for (const observer of observers) {
      if (observer.targets.has(element)) {
        observer.callback()
      }
    }
  })
}

/** Whether a press `y` px below the seam's top, inside its reach, lands on a grab segment. */
function grabsAt(handle: Element, y: number): boolean {
  return Array.from(handle.querySelectorAll<HTMLElement>('.tab-group-split-grab')).some(
    (segment) => {
      const top = Number.parseFloat(segment.style.top)
      return y >= top && y < top + Number.parseFloat(segment.style.height)
    }
  )
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = boxes.get(this) ?? { top: 0, bottom: 0, left: 0, right: 0 }
    return DOMRect.fromRect({
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top
    })
  })
})

afterEach(() => {
  cleanup()
  boxes.clear()
  observers.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ResizeHandle tab-row gaps', () => {
  it('follows a row that an inner split moves while it is dragged', () => {
    // Left group | (upper group / lower group): the outer seam sits at x=400.
    const { container } = render(
      <div>
        <div />
        <ResizeHandle
          direction="horizontal"
          thin
          avoidTabRows
          onResizeStart={() => {}}
          onRatioChange={() => {}}
        />
        <div>
          <div data-group="upper">
            <div data-tab-group-strip-id="upper" />
          </div>
          <div data-group="lower">
            <div data-tab-group-strip-id="lower" />
          </div>
        </div>
      </div>
    )
    const handle = container.querySelector('.tab-group-split-resize-handle')!
    const upper = container.querySelector('[data-group="upper"]')!
    const lower = container.querySelector('[data-group="lower"]')!
    const lowerRow = container.querySelector('[data-tab-group-strip-id="lower"]')!
    place(handle, 0, 900, 400, 401)
    place(container.querySelector('[data-tab-group-strip-id="upper"]')!, 0, 32, 401, 900)
    place(upper, 0, 450, 401, 900)
    place(lower, 451, 900, 401, 900)
    place(lowerRow, 451, 483, 401, 900)
    resized(handle)
    expect(grabsAt(handle, 465)).toBe(false)

    // Holding the inner divider 120px lower resizes both groups and moves the lower row with it.
    place(upper, 0, 570, 401, 900)
    place(lower, 571, 900, 401, 900)
    place(lowerRow, 571, 603, 401, 900)
    resized(upper)
    resized(lower)

    expect(grabsAt(handle, 585)).toBe(false)
    expect(grabsAt(handle, 465)).toBe(true)
    expect(grabsAt(handle, 640)).toBe(true)
  })
})
