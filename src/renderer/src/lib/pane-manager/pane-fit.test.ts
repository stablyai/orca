import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ManagedPane, ScrollState } from './pane-manager-types'
import { safeFit, safeFitAndThen } from './pane-fit'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

let nextRafId = 1
let pendingRafs = new Map<number, FrameRequestCallback>()

type TestPane = ManagedPane & {
  setRect: (rect: { width: number; height: number }) => void
  setDisplay: (display: string) => void
}

function createPane(options: { rect: { width: number; height: number } }): TestPane {
  let rect = options.rect
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
        width: rect.width,
        height: rect.height
      }),
      parentElement: null,
      ownerDocument: { defaultView: { getComputedStyle: () => ({ display }) } }
    },
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 132, rows: 40 }))
    },
    serializeAddon: {},
    searchAddon: {},
    pendingSplitScrollState: null as ScrollState | null,
    setRect: (next: { width: number; height: number }) => {
      rect = next
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

  it('runs the continuation when the reveal fit arrives on a different pane object', async () => {
    // PTY connections use public wrappers while fitAllRevealedPanes uses internal panes; pane-identity keys lose deferred work (as in pane-metric-options-deferral).
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

  it('does not let a stale handle cancel its deferred replacement', () => {
    // A replacement can park before the superseded stream owner cancels.
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
})
