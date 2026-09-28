// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE } from './browser-chrome-address-slot'
import {
  BROWSER_CHROME_ADDRESS_MIN_WIDTH_PX,
  BROWSER_CHROME_FOLD_ORDER,
  useBrowserChromeToolFold
} from './use-browser-chrome-tool-fold'

const FIXED_WIDTH = 100
const TOOL_WIDTH = 30

// A flex row where the address takes whatever the fixed controls and visible tools leave over.
const layout = { rowWidth: 600, visibleTools: BROWSER_CHROME_FOLD_ORDER.length }
let resizeCallbacks: (() => void)[] = []

function Host({
  onFolded,
  stages = BROWSER_CHROME_FOLD_ORDER
}: {
  onFolded: (count: number) => void
  stages?: readonly (typeof BROWSER_CHROME_FOLD_ORDER)[number][]
}): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const folded = useBrowserChromeToolFold(rowRef, stages)
  layout.visibleTools = stages.length - folded.size
  onFolded(folded.size)
  return (
    <div ref={rowRef} data-testid="row">
      <div {...{ [BROWSER_CHROME_ADDRESS_SLOT_ATTRIBUTE]: 'true' }} />
    </div>
  )
}

function contentWidth(): number {
  return FIXED_WIDTH + TOOL_WIDTH * layout.visibleTools
}

beforeEach(() => {
  resizeCallbacks = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback)
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => layout.rowWidth)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() =>
    Math.max(layout.rowWidth, contentWidth())
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    DOMRect.fromRect({ width: Math.max(0, layout.rowWidth - contentWidth()) })
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function resizeTo(width: number): void {
  layout.rowWidth = width
  act(() => resizeCallbacks.forEach((callback) => callback()))
}

function expectedFolded(width: number): number {
  const room = width - FIXED_WIDTH - BROWSER_CHROME_ADDRESS_MIN_WIDTH_PX
  const fits = Math.max(0, Math.floor(room / TOOL_WIDTH))
  return Math.max(0, BROWSER_CHROME_FOLD_ORDER.length - fits)
}

describe('useBrowserChromeToolFold', () => {
  it('keeps every tool inline when the address has its minimum width', () => {
    let folded = -1
    layout.rowWidth = 600
    render(<Host onFolded={(count) => (folded = count)} />)
    expect(folded).toBe(0)
  })

  it('folds just enough tools to give the address its minimum width', () => {
    let folded = -1
    layout.rowWidth = 300
    render(<Host onFolded={(count) => (folded = count)} />)
    expect(folded).toBe(expectedFolded(300))
    expect(folded).toBeGreaterThan(0)
  })

  it('unfolds as the row widens and refolds as it narrows', () => {
    let folded = -1
    layout.rowWidth = 600
    render(<Host onFolded={(count) => (folded = count)} />)

    resizeTo(260)
    expect(folded).toBe(expectedFolded(260))

    resizeTo(400)
    expect(folded).toBe(expectedFolded(400))

    resizeTo(700)
    expect(folded).toBe(0)
  })

  it('folds everything but lets the address shrink once no tool is left', () => {
    let folded = -1
    layout.rowWidth = 150
    render(<Host onFolded={(count) => (folded = count)} />)
    expect(folded).toBe(BROWSER_CHROME_FOLD_ORDER.length)
  })

  it('leaves a hidden (zero-width) row alone', () => {
    let folded = -1
    layout.rowWidth = 0
    render(<Host onFolded={(count) => (folded = count)} />)
    expect(folded).toBe(0)
  })

  it('measures when a hidden row becomes visible', () => {
    let folded = -1
    layout.rowWidth = 0
    render(<Host onFolded={(count) => (folded = count)} />)

    resizeTo(300)
    expect(folded).toBe(expectedFolded(300))
  })

  it('discards measurements when the available tools change', () => {
    let folded = -1
    layout.rowWidth = 300
    const view = render(<Host onFolded={(count) => (folded = count)} />)
    expect(folded).toBeGreaterThan(0)

    view.rerender(<Host onFolded={(count) => (folded = count)} stages={['grab', 'annotate']} />)
    expect(folded).toBe(0)

    resizeTo(150)
    expect(folded).toBe(2)
  })

  it('does not restore an obsolete fold level when a tool set returns', () => {
    let folded = -1
    layout.rowWidth = 300
    const view = render(<Host onFolded={(count) => (folded = count)} />)
    expect(folded).toBeGreaterThan(0)

    layout.rowWidth = 600
    view.rerender(<Host onFolded={(count) => (folded = count)} stages={['grab']} />)
    expect(folded).toBe(0)

    view.rerender(<Host onFolded={(count) => (folded = count)} />)
    expect(folded).toBe(0)
  })
})
