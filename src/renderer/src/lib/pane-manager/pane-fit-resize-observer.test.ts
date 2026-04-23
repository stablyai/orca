import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import {
  attachPaneFitResizeObserver,
  detachPaneFitResizeObserver
} from './pane-fit-resize-observer'

type ResizeObserverCallbackLike = ConstructorParameters<typeof ResizeObserver>[0]

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallbackLike) {
    mockResizeObservers.push(this)
  }

  trigger(): void {
    this.callback([], this as never)
  }
}

let mockResizeObservers: MockResizeObserver[] = []
let nextRafId = 1
let pendingRafs = new Map<number, FrameRequestCallback>()

function flushAnimationFrames(timestamp = 16): void {
  const callbacks = Array.from(pendingRafs.entries())
  pendingRafs = new Map()
  for (const [, callback] of callbacks) {
    callback(timestamp)
  }
}

function createPane(): ManagedPaneInternal {
  return {
    id: 1,
    terminal: {
      cols: 79,
      rows: 24
    } as never,
    container: {} as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    gpuRenderingEnabled: true,
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 }))
    } as never,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    webglAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: {
      wasAtBottom: true,
      firstVisibleLineContent: '',
      viewportY: 0,
      totalLines: 24
    } satisfies ScrollState,
    pendingDragScrollState: null
  }
}

describe('attachPaneFitResizeObserver', () => {
  beforeEach(() => {
    mockResizeObservers = []
    nextRafId = 1
    pendingRafs = new Map()

    vi.stubGlobal('ResizeObserver', MockResizeObserver as never)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextRafId++
        pendingRafs.set(id, callback)
        return id
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        pendingRafs.delete(id)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('coalesces repeated observer callbacks into a single fit per frame', () => {
    const pane = createPane()

    attachPaneFitResizeObserver(pane)
    mockResizeObservers[0]?.trigger()
    mockResizeObservers[0]?.trigger()

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()

    flushAnimationFrames()

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('disconnects the observer and cancels any queued fit', () => {
    const pane = createPane()

    attachPaneFitResizeObserver(pane)
    mockResizeObservers[0]?.trigger()
    const scheduledRafId = pane.pendingObservedFitRafId

    detachPaneFitResizeObserver(pane)
    flushAnimationFrames()

    expect(mockResizeObservers[0]?.disconnect).toHaveBeenCalledTimes(1)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(scheduledRafId)
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.pendingObservedFitRafId).toBeNull()
  })
})
