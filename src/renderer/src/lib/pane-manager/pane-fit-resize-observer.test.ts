import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import {
  attachPaneFitResizeObserver,
  detachPaneFitResizeObserver,
  requestStablePaneFit
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

function createPane(
  proposeDimensions: () => { cols: number; rows: number } = () => ({ cols: 80, rows: 24 }),
  options: { rect?: { width: number; height: number } } = {}
): ManagedPaneInternal {
  const leafId = '11111111-1111-4111-8111-111111111111' as never
  return {
    id: 1,
    leafId,
    stablePaneId: leafId,
    terminal: {
      cols: 79,
      rows: 24
    } as never,
    container: { dataset: {} } as never,
    xtermContainer: {
      getBoundingClientRect: () => options.rect ?? ({ width: 800, height: 600 } as DOMRect)
    } as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(proposeDimensions)
    } as never,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    webglAddon: null,
    ligaturesAddon: null,
    compositionHandler: null,
    debugLabel: null,
    pendingSplitScrollState: {
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 0,
      baseY: 0
    } satisfies ScrollState
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

  it('coalesces repeated observer callbacks and fits once the grid is stable', () => {
    const pane = createPane()

    attachPaneFitResizeObserver(pane)
    mockResizeObservers[0]?.trigger()
    mockResizeObservers[0]?.trigger()

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()

    flushAnimationFrames()

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('waits through a transient grid wobble before fitting', () => {
    const proposed = [
      { cols: 80, rows: 24 },
      { cols: 81, rows: 24 },
      { cols: 81, rows: 24 }
    ]
    const pane = createPane(() => proposed.shift() ?? { cols: 81, rows: 24 })

    attachPaneFitResizeObserver(pane)
    mockResizeObservers[0]?.trigger()

    flushAnimationFrames()

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()

    flushAnimationFrames()

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('waits through a transient grid wobble before notifying settled callbacks', () => {
    const proposed = [
      { cols: 80, rows: 24 },
      { cols: 81, rows: 24 },
      { cols: 81, rows: 24 }
    ]
    const onSettled = vi.fn()
    const pane = createPane(() => proposed.shift() ?? { cols: 81, rows: 24 })

    requestStablePaneFit(pane, onSettled)
    flushAnimationFrames()

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()

    flushAnimationFrames()

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('notifies settled callbacks when the terminal already matches the stable grid', () => {
    const onSettled = vi.fn()
    const pane = createPane(() => ({ cols: 79, rows: 24 }))

    requestStablePaneFit(pane, onSettled)
    flushAnimationFrames()

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('skips observer fits while the terminal has no visible geometry', () => {
    const pane = createPane(() => ({ cols: 80, rows: 24 }), {
      rect: { width: 0, height: 0 }
    })

    attachPaneFitResizeObserver(pane)
    mockResizeObservers[0]?.trigger()
    flushAnimationFrames()

    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('throttles an endlessly unstable grid instead of fitting every frame', () => {
    let cols = 80
    const pane = createPane(() => {
      cols = cols === 80 ? 81 : 80
      return { cols, rows: 24 }
    })

    attachPaneFitResizeObserver(pane)
    mockResizeObservers[0]?.trigger()

    for (let i = 0; i < 10; i += 1) {
      flushAnimationFrames()
    }

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.pendingObservedFitRafId).toBeNull()
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
