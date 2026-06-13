import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  holdPtyResizesForPaneSubtrees,
  PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
  queuePanePtyResizeIfHeld
} from './pane-pty-resize-hold'

class MockCustomEvent<T> extends Event {
  detail: T

  constructor(type: string, init: { detail: T }) {
    super(type)
    this.detail = init.detail
  }
}

class MockElement {
  classList: { contains: (className: string) => boolean }
  dispatched: Event[] = []

  constructor(
    private readonly classNames: string[],
    private readonly descendants: MockElement[] = []
  ) {
    this.classList = {
      contains: (className: string) => this.classNames.includes(className)
    }
  }

  querySelectorAll(): MockElement[] {
    return this.descendants
  }

  dispatchEvent(event: Event): boolean {
    this.dispatched.push(event)
    return true
  }
}

describe('pane PTY resize hold', () => {
  const originalCustomEvent = globalThis.CustomEvent

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.CustomEvent = originalCustomEvent
  })

  it('queues drag-frame pane resizes and flushes only the final size', () => {
    globalThis.CustomEvent = MockCustomEvent as unknown as typeof CustomEvent
    const leftPane = new MockElement(['pane'])
    const rightPane = new MockElement(['pane'])
    const split = new MockElement(['pane-split'], [leftPane, rightPane])

    const release = holdPtyResizesForPaneSubtrees([split as unknown as HTMLElement])

    expect(queuePanePtyResizeIfHeld(leftPane as unknown as HTMLElement, 100, 30)).toBe(true)
    expect(queuePanePtyResizeIfHeld(leftPane as unknown as HTMLElement, 120, 32)).toBe(true)
    expect(queuePanePtyResizeIfHeld(rightPane as unknown as HTMLElement, 80, 30)).toBe(true)

    release.flush()

    expect(leftPane.dispatched).toHaveLength(1)
    expect(rightPane.dispatched).toHaveLength(1)
    expect(leftPane.dispatched[0]?.type).toBe(PANE_PTY_RESIZE_HOLD_FLUSH_EVENT)
    expect((leftPane.dispatched[0] as CustomEvent).detail).toEqual({ cols: 120, rows: 32 })
    expect((rightPane.dispatched[0] as CustomEvent).detail).toEqual({ cols: 80, rows: 30 })
    expect(queuePanePtyResizeIfHeld(leftPane as unknown as HTMLElement, 130, 32)).toBe(false)
  })

  it('cancels queued resizes without forwarding a stale PTY size', () => {
    globalThis.CustomEvent = MockCustomEvent as unknown as typeof CustomEvent
    const pane = new MockElement(['pane'])

    const release = holdPtyResizesForPaneSubtrees([pane as unknown as HTMLElement])
    expect(queuePanePtyResizeIfHeld(pane as unknown as HTMLElement, 100, 30)).toBe(true)

    release.cancel()

    expect(pane.dispatched).toHaveLength(0)
    expect(queuePanePtyResizeIfHeld(pane as unknown as HTMLElement, 120, 30)).toBe(false)
  })

  it('keeps an outer hold active when an overlapping hold is cancelled', () => {
    globalThis.CustomEvent = MockCustomEvent as unknown as typeof CustomEvent
    const pane = new MockElement(['pane'])

    const outer = holdPtyResizesForPaneSubtrees([pane as unknown as HTMLElement])
    const inner = holdPtyResizesForPaneSubtrees([pane as unknown as HTMLElement])
    expect(queuePanePtyResizeIfHeld(pane as unknown as HTMLElement, 100, 30)).toBe(true)

    inner.cancel()

    expect(pane.dispatched).toHaveLength(0)
    expect(queuePanePtyResizeIfHeld(pane as unknown as HTMLElement, 120, 32)).toBe(true)

    outer.flush()

    expect(pane.dispatched).toHaveLength(1)
    expect((pane.dispatched[0] as CustomEvent).detail).toEqual({ cols: 120, rows: 32 })
    expect(queuePanePtyResizeIfHeld(pane as unknown as HTMLElement, 130, 32)).toBe(false)
  })
})
