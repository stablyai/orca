// @vitest-environment happy-dom

import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  measureSourceControlScrollMargin,
  observeSourceControlScrollMargin,
  SOURCE_CONTROL_FILE_ROW_HEIGHT_PX,
  SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS,
  SourceControlVirtualFileList
} from './source-control-virtual-file-list'

const VIEWPORT_HEIGHT_PX = 600

type ResizeObserverBoxSize = {
  blockSize: number
  inlineSize: number
}

type TrackedResizeObserver = {
  callback: ResizeObserverCallback
  elements: Set<Element>
}

const activeResizeObservers = new Set<TrackedResizeObserver>()

class MockResizeObserver implements ResizeObserver {
  readonly elements = new Set<Element>()
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    activeResizeObservers.add(this)
  }

  observe(element: Element): void {
    this.elements.add(element)
  }

  unobserve(element: Element): void {
    this.elements.delete(element)
  }

  disconnect(): void {
    this.elements.clear()
    activeResizeObservers.delete(this)
  }
}

function fireResizeObservers(target?: Element): void {
  for (const observer of activeResizeObservers) {
    const targets = target
      ? observer.elements.has(target)
        ? [target]
        : []
      : Array.from(observer.elements)
    if (targets.length === 0) {
      continue
    }
    const entries = targets.map((element) => {
      const rect = element.getBoundingClientRect()
      const size: ResizeObserverBoxSize = {
        blockSize: rect.height,
        inlineSize: rect.width
      }
      return {
        target: element,
        contentRect: rect,
        borderBoxSize: [size],
        contentBoxSize: [size],
        devicePixelContentBoxSize: [size]
      } satisfies ResizeObserverEntry
    })
    observer.callback(entries, observer as unknown as ResizeObserver)
  }
}

function manyRows(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `row-${String(index).padStart(3, '0')}`)
}

let host: HTMLDivElement
let root: Root
/** Synthetic layout tops for getBoundingClientRect (happy-dom has no layout). */
let topsByElement: WeakMap<Element, number>

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  activeResizeObservers.clear()
  topsByElement = new WeakMap()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('overflow-auto')
        ? VIEWPORT_HEIGHT_PX
        : SOURCE_CONTROL_FILE_ROW_HEIGHT_PX
    }
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = topsByElement.get(this) ?? 0
    const height = this.classList.contains('overflow-auto')
      ? VIEWPORT_HEIGHT_PX
      : SOURCE_CONTROL_FILE_ROW_HEIGHT_PX
    return {
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 240,
      width: 240,
      x: 0,
      y: top,
      toJSON: () => ({})
    } as DOMRect
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  activeResizeObservers.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setTop(element: Element, top: number): void {
  topsByElement.set(element, top)
}

function SharedScrollerHarness({
  aboveHeight,
  rows,
  rowTestId = 'virtual-row'
}: {
  aboveHeight: number
  rows: readonly string[]
  rowTestId?: string
}): ReactElement {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)

  return (
    <div
      className="overflow-auto"
      ref={(node) => {
        if (node) {
          setTop(node, 0)
          Object.defineProperty(node, 'scrollTop', {
            configurable: true,
            writable: true,
            value: node.scrollTop
          })
          setScroller(node)
        } else {
          setScroller(null)
        }
      }}
    >
      <div
        data-testid="content-above"
        ref={(node) => {
          if (node) {
            setTop(node, 0)
          }
        }}
        style={{ height: aboveHeight }}
      />
      <div
        data-testid="section-host"
        ref={(node) => {
          if (node) {
            setTop(node, aboveHeight)
          }
        }}
      >
        <SourceControlVirtualFileList
          rows={rows}
          scrollElement={scroller}
          getRowKey={(row) => row}
          renderRow={(row) => (
            <div key={row} data-testid={rowTestId}>
              {row}
            </div>
          )}
        />
      </div>
    </div>
  )
}

function MultiSectionHarness({
  firstRows,
  secondRows
}: {
  firstRows: readonly string[]
  secondRows: readonly string[]
}): ReactElement {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)

  return (
    <div
      className="overflow-auto"
      ref={(node) => {
        if (node) {
          setTop(node, 0)
          Object.defineProperty(node, 'scrollTop', {
            configurable: true,
            writable: true,
            value: node.scrollTop
          })
        }
        setScroller(node)
      }}
    >
      <div data-testid="first-section">
        <SourceControlVirtualFileList
          rows={firstRows}
          scrollElement={scroller}
          getRowKey={(row) => row}
          renderRow={(row) => <div data-testid="first-row">{row}</div>}
        />
      </div>
      <div data-testid="second-section">
        <SourceControlVirtualFileList
          rows={secondRows}
          scrollElement={scroller}
          getRowKey={(row) => row}
          renderRow={(row) => <div data-testid="second-row">{row}</div>}
        />
      </div>
    </div>
  )
}

function syncListTop(aboveHeight: number): HTMLDivElement | null {
  const list = host.querySelector<HTMLDivElement>('[data-testid="source-control-virtual-list"]')
  if (list) {
    setTop(list, aboveHeight)
  }
  const scroller = host.querySelector<HTMLDivElement>('.overflow-auto')
  if (scroller) {
    setTop(scroller, 0)
  }
  return list
}

function syncMultiSectionListTops(firstRowCount: number): void {
  const lists = host.querySelectorAll<HTMLElement>('[data-testid="source-control-virtual-list"]')
  if (lists[0]) {
    setTop(lists[0], 0)
  }
  if (lists[1]) {
    setTop(lists[1], firstRowCount * SOURCE_CONTROL_FILE_ROW_HEIGHT_PX)
  }
}

describe('measureSourceControlScrollMargin', () => {
  it('returns the list offset inside the scroller independent of scrollTop', () => {
    const scroller = document.createElement('div')
    const list = document.createElement('div')
    setTop(scroller, 100)
    setTop(list, 250)
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 40 })

    expect(measureSourceControlScrollMargin(list, scroller)).toBe(190)

    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 120 })
    setTop(list, 170)
    // list.top dropped by the same amount scrollTop rose → margin unchanged.
    expect(measureSourceControlScrollMargin(list, scroller)).toBe(190)
  })
})

describe('observeSourceControlScrollMargin', () => {
  it('notifies on resize and disconnects cleanly', () => {
    const scroller = document.createElement('div')
    const child = document.createElement('div')
    const list = document.createElement('div')
    scroller.append(child, list)
    const onLayout = vi.fn()

    const cleanup = observeSourceControlScrollMargin(list, scroller, onLayout)
    expect(activeResizeObservers.size).toBe(1)

    fireResizeObservers()
    expect(onLayout).toHaveBeenCalled()

    onLayout.mockClear()
    cleanup()
    expect(activeResizeObservers.size).toBe(0)

    fireResizeObservers()
    expect(onLayout).not.toHaveBeenCalled()
  })

  it('tracks current direct scroller children without retaining removed siblings', async () => {
    const scroller = document.createElement('div')
    const list = document.createElement('div')
    const removedSibling = document.createElement('div')
    scroller.append(removedSibling, list)
    const onLayout = vi.fn()

    const cleanup = observeSourceControlScrollMargin(list, scroller, onLayout)
    const observer = Array.from(activeResizeObservers)[0]
    expect(observer?.elements.has(removedSibling)).toBe(true)
    onLayout.mockClear()

    const sibling = document.createElement('div')
    scroller.insertBefore(sibling, list)
    removedSibling.remove()
    // happy-dom delivers MutationObserver callbacks asynchronously.
    await vi.waitFor(() => {
      expect(onLayout).toHaveBeenCalled()
      expect(observer?.elements.has(sibling)).toBe(true)
      expect(observer?.elements.has(removedSibling)).toBe(false)
    })

    cleanup()
  })
})

describe('SourceControlVirtualFileList scroll-margin lifecycle', () => {
  it('does not read layout during ordinary re-renders after the initial measure', () => {
    const aboveHeight = 160
    const baseRows = manyRows(SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS)

    act(() => {
      root.render(
        <SharedScrollerHarness aboveHeight={aboveHeight} rows={baseRows.map((row) => `${row}@0`)} />
      )
    })
    syncListTop(aboveHeight)
    act(() => {
      fireResizeObservers()
    })

    const rectSpy = vi.mocked(Element.prototype.getBoundingClientRect)
    rectSpy.mockClear()

    // Status-poll style re-render: new row identities, unchanged layout.
    act(() => {
      root.render(
        <SharedScrollerHarness aboveHeight={aboveHeight} rows={baseRows.map((row) => `${row}@1`)} />
      )
    })

    expect(rectSpy).not.toHaveBeenCalled()
    expect(host.textContent).toContain('row-000@1')
  })

  it('keeps multi-section windowing correct when content above resizes', () => {
    const rows = manyRows(SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS + 20)
    let aboveHeight = 200

    act(() => {
      root.render(
        <SharedScrollerHarness aboveHeight={aboveHeight} rows={rows} rowTestId="section-row" />
      )
    })
    syncListTop(aboveHeight)
    act(() => {
      fireResizeObservers()
    })

    expect(host.querySelector<HTMLElement>('[data-index="0"]')?.style.transform).toBe(
      'translateY(0px)'
    )

    // Content above grows (sibling section / commit area).
    aboveHeight = 420
    act(() => {
      root.render(
        <SharedScrollerHarness aboveHeight={aboveHeight} rows={rows} rowTestId="section-row" />
      )
    })
    syncListTop(aboveHeight)
    act(() => {
      fireResizeObservers()
    })

    // Local row positioning stays container-relative after margin update.
    expect(host.querySelector<HTMLElement>('[data-index="0"]')?.style.transform).toBe(
      'translateY(0px)'
    )

    const scroller = host.querySelector<HTMLDivElement>('.overflow-auto')
    expect(scroller).toBeTruthy()
    if (!scroller) {
      return
    }

    // Scroll to the section origin; window should still show this section's head.
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      writable: true,
      value: aboveHeight
    })
    act(() => {
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(host.querySelector('[data-testid="section-row"]')?.textContent).toBe('row-000')
    expect(host.querySelectorAll('[data-testid="section-row"]').length).toBeLessThan(rows.length)
  })

  it('updates a later virtual section when an earlier virtual section resizes', () => {
    let firstRows = manyRows(SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS + 10).map((row) => `first-${row}`)
    const secondRows = manyRows(SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS + 20).map(
      (row) => `second-${row}`
    )

    act(() => {
      root.render(<MultiSectionHarness firstRows={firstRows} secondRows={secondRows} />)
    })
    syncMultiSectionListTops(firstRows.length)
    act(() => fireResizeObservers())

    firstRows = manyRows(SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS + 80).map((row) => `first-${row}`)
    act(() => {
      root.render(<MultiSectionHarness firstRows={firstRows} secondRows={secondRows} />)
    })
    syncMultiSectionListTops(firstRows.length)

    const firstSection = host.querySelector('[data-testid="first-section"]')
    expect(firstSection).toBeTruthy()
    act(() => {
      if (firstSection) {
        fireResizeObservers(firstSection)
      }
    })

    const scroller = host.querySelector<HTMLDivElement>('.overflow-auto')
    expect(scroller).toBeTruthy()
    if (!scroller) {
      return
    }
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      writable: true,
      value: firstRows.length * SOURCE_CONTROL_FILE_ROW_HEIGHT_PX
    })
    act(() => scroller.dispatchEvent(new Event('scroll')))

    expect(host.querySelector('[data-testid="second-row"]')?.textContent).toBe('second-row-000')
    expect(host.querySelectorAll('[data-testid="second-row"]').length).toBeLessThan(
      secondRows.length
    )
  })

  it('renders small lists without the virtualization shell or observers', () => {
    const rows = ['a', 'b', 'c']
    expect(rows.length).toBeLessThan(SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS)

    act(() => {
      root.render(<SharedScrollerHarness aboveHeight={80} rows={rows} rowTestId="plain" />)
    })

    expect(host.querySelector('[data-testid="source-control-virtual-list"]')).toBeNull()
    expect(host.querySelectorAll('[data-testid="plain"]').length).toBe(3)
    expect(activeResizeObservers.size).toBe(0)
  })
})
