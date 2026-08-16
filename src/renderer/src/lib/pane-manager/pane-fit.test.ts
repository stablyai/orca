import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import type { ManagedPane, ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { readProposedPaneFitDimensions, safeFit, safeFitAndThen } from './pane-fit'
import { applyOrDeferPaneMetricOptions } from './pane-metric-options-deferral'
import { paneFitClientSizeChanged } from './pane-reveal-fit'
import { setFitOverride } from './mobile-fit-overrides'

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
  setDisplay: (display: string) => void
}

function createPane(options: {
  rect: { width: number; height: number }
  proposed?: () => { cols: number; rows: number } | undefined
}): TestPane {
  let rect = options.rect
  // Why: the reveal gate measures the inner xterm host, which can differ from the outer .pane.
  let xtermRect: { width: number; height: number } | null = null
  let display = 'block'
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
      }),
      parentElement: null,
      ownerDocument: { defaultView: { getComputedStyle: () => ({ display }) } }
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
    },
    setDisplay: (next: string) => {
      display = next
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

  it('cancels a throttled animation frame when the timer wins', async () => {
    const pane = createPane({ rect: { width: 0, height: 0 } })
    const continuation = vi.fn()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true
    })
    pane.setRect({ width: 800, height: 600 })
    vi.advanceTimersByTime(32)

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(pendingRafs.size).toBe(0)
    expect(continuation).toHaveBeenCalledOnce()
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
    // Why census fields: main coalesces this crumb by name, so the pane count
    // must ride on the payload — the burst multiplicity no longer carries it.
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_safe_fit_retry_exhausted',
      {
        paneId: 7,
        leafId: '22222222-2222-4222-8222-222222222222',
        livePanes: 0,
        livePaneManagers: 0
      }
    )
    await expect(handle.completion).resolves.toBe(false)

    pane.setRect({ width: 800, height: 600 })
    safeFit(pane)
    expect(continuation).not.toHaveBeenCalled()
  })

  it('runs a display:none pane continuation on the first fit after it is revealed', async () => {
    // Why: a restored floating-workspace pane is display:none for its whole reattach, so the
    // reattach grid push has to survive to the reveal — dropping it strands the PTY at the
    // replay grid with nothing left to correct it.
    const pane = createPane({ rect: { width: 0, height: 0 } })
    pane.setDisplay('none')
    const continuation = vi.fn()
    vi.mocked(recordRendererCrashBreadcrumb).mockClear()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true,
      deferIfHidden: true
    })

    // Completion resolves immediately so reattach never holds live output behind a hidden pane.
    await expect(handle.completion).resolves.toBe(false)
    expect(continuation).not.toHaveBeenCalled()
    expect(recordRendererCrashBreadcrumb).not.toHaveBeenCalled()

    pane.setDisplay('block')
    pane.setRect({ width: 800, height: 600 })
    safeFit(pane)
    expect(continuation).toHaveBeenCalledTimes(1)

    // One-shot: a later fit must not re-send the reattach grid.
    safeFit(pane)
    expect(continuation).toHaveBeenCalledTimes(1)
  })

  it('runs the continuation when the reveal fit arrives on a different pane object', async () => {
    // Why: PTY connections hold a toPublicPane() wrapper while PaneManager.fitAllRevealedPanes
    // iterates the internal panes, so park and drain are never the same object. Anything keyed
    // on the pane identity is silently unreachable — see the same trap in
    // pane-metric-options-deferral.
    const pane = createPane({ rect: { width: 0, height: 0 } })
    pane.setDisplay('none')
    const continuation = vi.fn()

    safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true,
      deferIfHidden: true
    })

    pane.setDisplay('block')
    pane.setRect({ width: 800, height: 600 })
    const revealedPane = { ...pane } as typeof pane
    safeFit(revealedPane)
    expect(continuation).toHaveBeenCalledTimes(1)
  })

  it('stops a deferred continuation when its handle is cancelled before reveal', async () => {
    // Why: callers cancel to invalidate stale work (a new stream generation must not inherit an
    // old replay's grid push). A deferred entry is that same work waiting for a box.
    const pane = createPane({ rect: { width: 0, height: 0 } })
    pane.setDisplay('none')
    const continuation = vi.fn()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true,
      deferIfHidden: true
    })
    handle.cancel()

    pane.setDisplay('block')
    pane.setRect({ width: 800, height: 600 })
    safeFit(pane)
    expect(continuation).not.toHaveBeenCalled()
  })

  it('does not fire an older deferred continuation alongside its replacement', async () => {
    // Why: re-registering the key hands ownership to the new continuation; leaving the old
    // deferred twin armed would double-send the grid and its SIGWINCH in one tick.
    const pane = createPane({ rect: { width: 0, height: 0 } })
    pane.setDisplay('none')
    const first = vi.fn()
    const second = vi.fn()

    safeFitAndThen(pane, 'reattach-pty-resize', first, {
      retryIfUnmeasurable: true,
      deferIfHidden: true
    })
    pane.setDisplay('block')
    pane.setRect({ width: 800, height: 600 })
    safeFitAndThen(pane, 'reattach-pty-resize', second, {
      retryIfUnmeasurable: true,
      deferIfHidden: true
    })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale handle cancel its deferred replacement', () => {
    // Why: stream replacement can park under the same key before the superseded owner cancels.
    const pane = createPane({ rect: { width: 0, height: 0 } })
    pane.setDisplay('none')
    const first = vi.fn()
    const second = vi.fn()

    const staleHandle = safeFitAndThen(pane, 'reattach-pty-resize', first, {
      retryIfUnmeasurable: true,
      deferIfHidden: true
    })
    safeFitAndThen(pane, 'reattach-pty-resize', second, {
      retryIfUnmeasurable: true,
      deferIfHidden: true
    })
    staleHandle.cancel()

    pane.setDisplay('block')
    pane.setRect({ width: 800, height: 600 })
    safeFit(pane)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('drops a display:none pane continuation when the pane is torn down before reveal', async () => {
    const { cancelPendingSafeFitContinuations } = await import('./pane-fit')
    const pane = createPane({ rect: { width: 0, height: 0 } })
    pane.setDisplay('none')
    const continuation = vi.fn()

    safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true,
      deferIfHidden: true
    })
    cancelPendingSafeFitContinuations(pane)

    pane.setDisplay('block')
    pane.setRect({ width: 800, height: 600 })
    safeFit(pane)
    expect(continuation).not.toHaveBeenCalled()
  })

  it('resolves failure when hidden-window animation frames are withheld', async () => {
    const pane = createPane({ rect: { width: 0, height: 0 } })
    const continuation = vi.fn()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true
    })
    await vi.advanceTimersByTimeAsync(40 * 32)

    expect(continuation).not.toHaveBeenCalled()
    await expect(handle.completion).resolves.toBe(false)
  })

  it('does not retry a pane explicitly hidden with display none', async () => {
    vi.mocked(recordRendererCrashBreadcrumb).mockClear()
    const pane = createPane({ rect: { width: 0, height: 0 } })
    const container = (pane as unknown as ManagedPaneInternal).xtermContainer
    Object.assign(container, {
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: 'none' }) }
      },
      parentElement: null
    })
    const continuation = vi.fn()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true
    })

    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(continuation).not.toHaveBeenCalled()
    expect(recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
    await expect(handle.completion).resolves.toBe(false)
  })

  it('stops retrying when a pane becomes display none', async () => {
    vi.mocked(recordRendererCrashBreadcrumb).mockClear()
    const pane = createPane({ rect: { width: 0, height: 0 } })
    const container = (pane as unknown as ManagedPaneInternal).xtermContainer
    let display = 'block'
    Object.assign(container, {
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display }) }
      },
      parentElement: null
    })
    const continuation = vi.fn()

    const handle = safeFitAndThen(pane, 'reattach-pty-resize', continuation, {
      retryIfUnmeasurable: true
    })
    display = 'none'
    flushAnimationFrames()
    vi.advanceTimersByTime(16)

    expect(requestAnimationFrame).toHaveBeenCalledOnce()
    expect(continuation).not.toHaveBeenCalled()
    expect(recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
    await expect(handle.completion).resolves.toBe(false)
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

describe('deferred metric flush inside safeFit', () => {
  function createMetricPane(): ManagedPane & { fitAddon: { fit: ReturnType<typeof vi.fn> } } {
    const terminal = { cols: 80, rows: 24, options: {} as Record<string, unknown> }
    // Grid shrinks once the parked large font lands — the case the min-dimension
    // gate exists to reject, but which it can only see after the flush.
    const proposeDimensions = (): { cols: number; rows: number } =>
      Number(terminal.options.fontSize ?? 10) >= 24 ? { cols: 5, rows: 2 } : { cols: 40, rows: 20 }
    return {
      id: 11,
      terminal,
      container: {
        dataset: {},
        getBoundingClientRect: () => ({ width: 340, height: 240 })
      },
      fitAddon: { fit: vi.fn(), proposeDimensions: vi.fn(proposeDimensions) }
    } as unknown as ManagedPane & { fitAddon: { fit: ReturnType<typeof vi.fn> } }
  }

  it('does not fit when the flushed font drops the pane under the minimum grid', () => {
    const pane = createMetricPane()
    applyOrDeferPaneMetricOptions(pane, { fontSize: 24 }, false)

    expect(safeFit(pane)).toBe(false)
    // The parked value still lands so the pane is not stuck on stale metrics.
    expect(pane.terminal.options.fontSize).toBe(24)
    // But the PTY must not be pinned to the 5x2 grid the floor rejects.
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('still fits when the flushed font keeps the pane above the minimum grid', () => {
    const pane = createMetricPane()
    applyOrDeferPaneMetricOptions(pane, { fontSize: 12 }, false)

    expect(safeFit(pane)).toBe(true)
    expect(pane.terminal.options.fontSize).toBe(12)
    expect(pane.fitAddon.fit).toHaveBeenCalled()
  })

  it('reports the post-metric grid used by the next safe fit', () => {
    const terminal = { cols: 80, rows: 24, options: {} as Record<string, unknown> }
    const pane = {
      id: 12,
      terminal,
      container: {
        dataset: {},
        getBoundingClientRect: () => ({ width: 500, height: 300 })
      },
      fitAddon: {
        fit: vi.fn(),
        proposeDimensions: vi.fn(() =>
          Number(terminal.options.fontSize ?? 10) >= 18
            ? { cols: 20, rows: 10 }
            : { cols: 40, rows: 20 }
        )
      }
    } as unknown as ManagedPane
    applyOrDeferPaneMetricOptions(pane, { fontSize: 18 }, false)

    expect(readProposedPaneFitDimensions(pane)).toEqual({ cols: 20, rows: 10 })
    expect(pane.terminal.options.fontSize).toBe(18)
  })

  it('reports an owner override even while the pane is unmeasurable', () => {
    const resize = vi.fn()
    const pane = {
      terminal: { cols: 80, rows: 24, options: {}, resize },
      container: {
        dataset: { ptyId: 'pty-override' },
        getBoundingClientRect: () => ({ width: 0, height: 0 })
      },
      fitAddon: { proposeDimensions: vi.fn() }
    } as unknown as ManagedPane
    setFitOverride('pty-override', 'mobile-fit', 49, 20)

    try {
      expect(readProposedPaneFitDimensions(pane)).toEqual({ cols: 49, rows: 20 })
      expect(pane.fitAddon.proposeDimensions).not.toHaveBeenCalled()
      expect(safeFit(pane)).toBe(false)
      expect(resize).not.toHaveBeenCalled()
    } finally {
      setFitOverride('pty-override', 'desktop-fit', 0, 0)
    }
  })

  it('flushes deferred metrics before reporting a measurable owner override', () => {
    const pane = createMetricPane()
    pane.container.dataset.ptyId = 'pty-metric-override'
    applyOrDeferPaneMetricOptions(pane, { fontSize: 12 }, false)
    setFitOverride('pty-metric-override', 'mobile-fit', 49, 20)

    try {
      expect(readProposedPaneFitDimensions(pane)).toEqual({ cols: 49, rows: 20 })
      expect(pane.terminal.options.fontSize).toBe(12)
    } finally {
      setFitOverride('pty-metric-override', 'desktop-fit', 0, 0)
    }
  })
})
