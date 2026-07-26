import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import type { ManagedPane, ScrollState } from './pane-manager-types'
import { safeFit, safeFitAndThen } from './pane-fit'
import { paneFitClientSizeChanged } from './pane-reveal-fit'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

let nextRafId = 1
let pendingRafs = new Map<number, FrameRequestCallback>()

function flushAnimationFrames(timestamp = 16): void {
  const callbacks = Array.from(pendingRafs.values())
  pendingRafs = new Map()
  for (const callback of callbacks) {
    callback(timestamp)
  }
}

type TestPane = ManagedPane & {
  setRect: (rect: { width: number; height: number }) => void
  setXtermRect: (rect: { width: number; height: number }) => void
}

function createPane(options: {
  rect: { width: number; height: number }
  proposed?: () => { cols: number; rows: number } | undefined
}): TestPane {
  let rect = options.rect
  // Why: the reveal gate measures the inner xterm host, which can differ from the outer .pane.
  let xtermRect: { width: number; height: number } | null = null
  const leafId = '22222222-2222-4222-8222-222222222222'
  const pane = {
    id: 7,
    leafId,
    stablePaneId: leafId,
    terminal: { cols: 80, rows: 24 },
    container: {
      dataset: {},
      getBoundingClientRect: () => ({ width: rect.width, height: rect.height })
    },
    xtermContainer: {
      getBoundingClientRect: () => ({
        width: (xtermRect ?? rect).width,
        height: (xtermRect ?? rect).height
      })
    },
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(options.proposed ?? (() => ({ cols: 132, rows: 40 })))
    },
    serializeAddon: {},
    searchAddon: {},
    pendingSplitScrollState: null as ScrollState | null,
    setRect: (next: { width: number; height: number }) => {
      rect = next
    },
    setXtermRect: (next: { width: number; height: number }) => {
      xtermRect = next
    }
  }
  return pane as unknown as TestPane
}

describe('safeFitAndThen unmeasurable-pane retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    nextRafId = 1
    pendingRafs = new Map()
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
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs the continuation once reveal layout becomes measurable', async () => {
    const pane = createPane({ rect: { width: 0, height: 0 } })
    const continuation = vi.fn()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true
    })
    pane.setRect({ width: 800, height: 600 })
    flushAnimationFrames()
    vi.advanceTimersByTime(16)

    expect(continuation).toHaveBeenCalledTimes(1)
    await expect(handle.completion).resolves.toBe(true)
  })

  it('cancels its scheduled frame with the continuation', async () => {
    const pane = createPane({ rect: { width: 0, height: 0 } })
    const continuation = vi.fn()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true
    })
    handle.cancel()
    pane.setRect({ width: 800, height: 600 })
    flushAnimationFrames()

    expect(continuation).not.toHaveBeenCalled()
    await expect(handle.completion).resolves.toBe(false)
  })

  it('does not retry a stale restore', async () => {
    const pane = createPane({ rect: { width: 0, height: 0 } })
    const continuation = vi.fn()
    let current = true

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      shouldContinue: () => current,
      retryIfUnmeasurable: true
    })
    current = false
    pane.setRect({ width: 800, height: 600 })
    flushAnimationFrames()
    vi.advanceTimersByTime(16)

    expect(continuation).not.toHaveBeenCalled()
    await expect(handle.completion).resolves.toBe(false)
  })

  it('still flushes through an ordinary external fit', async () => {
    const pane = createPane({ rect: { width: 0, height: 0 } })
    const continuation = vi.fn()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation)
    pane.setRect({ width: 800, height: 600 })
    flushAnimationFrames()
    vi.advanceTimersByTime(16)
    expect(continuation).not.toHaveBeenCalled()

    safeFit(pane)

    expect(continuation).toHaveBeenCalledTimes(1)
    await expect(handle.completion).resolves.toBe(true)
  })

  it('resolves failure after the bounded frame budget instead of hanging reattach', async () => {
    const pane = createPane({ rect: { width: 0, height: 0 } })
    const continuation = vi.fn()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true
    })
    for (let frame = 0; frame < 40; frame += 1) {
      flushAnimationFrames(frame * 16)
      vi.advanceTimersByTime(16)
    }

    expect(continuation).not.toHaveBeenCalled()
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_safe_fit_retry_exhausted',
      { paneId: 7 }
    )
    await expect(handle.completion).resolves.toBe(false)

    pane.setRect({ width: 800, height: 600 })
    safeFit(pane)
    expect(continuation).not.toHaveBeenCalled()
  })
})

describe('paneFitClientSizeChanged (reveal fit gate)', () => {
  it('treats a pane with no recorded fit size as changed', () => {
    const pane = createPane({ rect: { width: 800, height: 600 } })
    expect(paneFitClientSizeChanged(pane)).toBe(true)
  })

  it('is unchanged after a fit when the container size is the same', () => {
    const pane = createPane({
      rect: { width: 800, height: 600 },
      proposed: () => ({ cols: 80, rows: 24 })
    })
    safeFit(pane)
    expect(paneFitClientSizeChanged(pane)).toBe(false)
  })

  it('reports changed when the container resized since the last fit', () => {
    const pane = createPane({
      rect: { width: 800, height: 600 },
      proposed: () => ({ cols: 80, rows: 24 })
    })
    safeFit(pane)
    pane.setRect({ width: 640, height: 480 })
    expect(paneFitClientSizeChanged(pane)).toBe(true)
  })

  it('ignores sub-pixel jitter at the same rounded size (no reflow on reveal)', () => {
    const pane = createPane({
      rect: { width: 800, height: 600 },
      proposed: () => ({ cols: 80, rows: 24 })
    })
    safeFit(pane)
    pane.setRect({ width: 800.4, height: 599.6 })
    expect(paneFitClientSizeChanged(pane)).toBe(false)
  })

  it('counts an unmeasurable (hidden) pane as changed rather than a false no-op', () => {
    const pane = createPane({
      rect: { width: 800, height: 600 },
      proposed: () => ({ cols: 80, rows: 24 })
    })
    safeFit(pane)
    pane.setRect({ width: 0, height: 0 })
    expect(paneFitClientSizeChanged(pane)).toBe(true)
  })

  it('reports changed when the inner xterm host shrank but the outer pane did not', () => {
    // A title bar / restored-session banner reduces the fittable area while the
    // outer .pane pixels stay constant; the reveal must fit, not skip.
    const pane = createPane({
      rect: { width: 800, height: 600 },
      proposed: () => ({ cols: 80, rows: 24 })
    })
    safeFit(pane)
    pane.setXtermRect({ width: 800, height: 560 })
    expect(paneFitClientSizeChanged(pane)).toBe(true)
  })
})
