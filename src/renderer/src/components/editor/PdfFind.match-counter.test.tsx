// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import PdfFind from './PdfFind'

type MatchesCount = { current: number; total: number }
type Listener = (evt: { matchesCount: MatchesCount }) => void

// Why: the real EventBus lives in pdf_viewer.mjs, which pulls in the whole
// viewer (canvas, workers). PdfFind only needs on/off/dispatch.
function createEventBusStub(): {
  bus: InstanceType<typeof EventBus>
  emit: (name: string, matchesCount: MatchesCount) => void
  listenerCount: (name: string) => number
} {
  const listeners = new Map<string, Set<Listener>>()
  const bus = {
    on: (name: string, listener: Listener) => {
      if (!listeners.has(name)) {
        listeners.set(name, new Set())
      }
      listeners.get(name)?.add(listener)
    },
    off: (name: string, listener: Listener) => {
      listeners.get(name)?.delete(listener)
    },
    dispatch: vi.fn()
  }
  return {
    bus: bus as unknown as InstanceType<typeof EventBus>,
    emit: (name, matchesCount) => {
      act(() => {
        for (const listener of listeners.get(name) ?? []) {
          listener({ matchesCount })
        }
      })
    },
    listenerCount: (name) => listeners.get(name)?.size ?? 0
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
})

function renderFind(bus: InstanceType<typeof EventBus>): { input: HTMLInputElement } {
  const eventBusRef = { current: bus }
  act(() => {
    root.render(<PdfFind isOpen onClose={vi.fn()} eventBusRef={eventBusRef} />)
  })
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('find input not rendered')
  }
  return { input }
}

function typeQuery(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('PdfFind match counter', () => {
  it('advances the counter when pdf.js reports a new selection', () => {
    const { bus, emit } = createEventBusStub()
    const { input } = renderFind(bus)
    typeQuery(input, 'orca')

    // The initial scan reports the totals through updatefindmatchescount.
    emit('updatefindmatchescount', { current: 1, total: 5 })
    expect(container.textContent).toContain('1 of 5')

    // Why: stepping to the next match does not rescan any page, so pdf.js
    // reports the new position through updatefindcontrolstate only.
    emit('updatefindcontrolstate', { current: 2, total: 5 })
    expect(container.textContent).toContain('2 of 5')
    expect(container.textContent).not.toContain('1 of 5')

    emit('updatefindcontrolstate', { current: 3, total: 5 })
    expect(container.textContent).toContain('3 of 5')
  })

  it('keeps following the totals reported while pages are still being scanned', () => {
    const { bus, emit } = createEventBusStub()
    const { input } = renderFind(bus)
    typeQuery(input, 'orca')

    emit('updatefindmatchescount', { current: 1, total: 2 })
    expect(container.textContent).toContain('1 of 2')

    emit('updatefindmatchescount', { current: 1, total: 7 })
    expect(container.textContent).toContain('1 of 7')
    expect(container.textContent).not.toContain('1 of 2')
  })

  it('clears a stale count when the next query finds nothing', () => {
    const { bus, emit } = createEventBusStub()
    const { input } = renderFind(bus)
    typeQuery(input, 'orca')
    emit('updatefindmatchescount', { current: 1, total: 5 })

    // Why: a query with no hits never re-enters the page-scan path, so its only
    // signal is the NOT_FOUND control state. Without it the bar keeps showing
    // the previous query's count.
    typeQuery(input, 'zzzz')
    emit('updatefindcontrolstate', { current: 0, total: 0 })

    expect(container.textContent).toContain('No matches')
    expect(container.textContent).not.toContain('1 of 5')
  })

  it('unregisters both listeners on unmount', () => {
    const { bus, listenerCount } = createEventBusStub()
    renderFind(bus)
    expect(listenerCount('updatefindmatchescount')).toBe(1)
    expect(listenerCount('updatefindcontrolstate')).toBe(1)

    act(() => {
      root.unmount()
    })

    expect(listenerCount('updatefindmatchescount')).toBe(0)
    expect(listenerCount('updatefindcontrolstate')).toBe(0)
  })
})
