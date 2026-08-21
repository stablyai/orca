import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from './pane-manager-types'
import { fitRevealedPane } from './pane-reveal-fit'

const mocks = vi.hoisted(() => ({
  safeFit: vi.fn(),
  canMeasurePaneForFit: vi.fn(() => true),
  flushPendingSafeFitContinuations: vi.fn(),
  readFitClientSize: vi.fn<(pane: ManagedPane) => { width: number; height: number } | null>(),
  requestStablePaneFit: vi.fn(),
  clearPaneFitContinuationRetry: vi.fn(),
  resumePendingFitScrollRestoreAfterFit: vi.fn(),
  flushDeferredPaneMetricOptionsIfMeasurable: vi.fn(() => false)
}))

vi.mock('./pane-fit', () => ({
  safeFit: mocks.safeFit,
  canMeasurePaneForFit: mocks.canMeasurePaneForFit,
  flushPendingSafeFitContinuations: mocks.flushPendingSafeFitContinuations,
  readFitClientSize: mocks.readFitClientSize,
  flushDeferredPaneMetricOptionsIfMeasurable: mocks.flushDeferredPaneMetricOptionsIfMeasurable
}))
vi.mock('./pane-fit-resize-observer', () => ({
  requestStablePaneFit: mocks.requestStablePaneFit
}))
vi.mock('./pane-fit-continuation-retry', () => ({
  clearPaneFitContinuationRetry: mocks.clearPaneFitContinuationRetry
}))
vi.mock('./pane-scroll', () => ({
  resumePendingFitScrollRestoreAfterFit: mocks.resumePendingFitScrollRestoreAfterFit
}))

type RevealTestPane = ManagedPane & { lastFitClientSize?: { width: number; height: number } }

function createPane(options: {
  lastFitClientSize?: { width: number; height: number }
  currentSize: { width: number; height: number } | null
  terminal: { cols: number; rows: number }
  proposed: { cols: number; rows: number } | null
}): RevealTestPane {
  const pane = {
    id: 3,
    lastFitClientSize: options.lastFitClientSize,
    terminal: options.terminal,
    fitAddon: { proposeDimensions: vi.fn(() => options.proposed ?? undefined) }
  } as unknown as RevealTestPane
  mocks.readFitClientSize.mockImplementation(() => options.currentSize)
  return pane
}

describe('fitRevealedPane routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canMeasurePaneForFit.mockReturnValue(true)
    mocks.flushDeferredPaneMetricOptionsIfMeasurable.mockReturnValue(false)
  })

  it('repairs on a steady grid when a deferred metric flush lands on a pane the size checks would skip', () => {
    // Without the flush branch the checks below both say "nothing to do" and the
    // parked font change never reaches the grid. It must route through the stable
    // path, not a raw fit: pixels are unchanged and the grid diverged, so a
    // synchronous fit would reflow on the WebGL/DOM metric wobble and corrupt a
    // diff-painting inline TUI.
    mocks.flushDeferredPaneMetricOptionsIfMeasurable.mockReturnValue(true)
    const pane = createPane({
      lastFitClientSize: { width: 800, height: 600 },
      currentSize: { width: 800, height: 600 },
      terminal: { cols: 80, rows: 24 },
      proposed: { cols: 80, rows: 24 }
    })

    fitRevealedPane(pane)

    expect(mocks.flushDeferredPaneMetricOptionsIfMeasurable).toHaveBeenCalledWith(pane)
    expect(mocks.requestStablePaneFit).toHaveBeenCalledWith(pane)
    expect(mocks.safeFit).not.toHaveBeenCalled()
  })

  it('still flushes parked metric options when the pane also resized while hidden', () => {
    mocks.flushDeferredPaneMetricOptionsIfMeasurable.mockReturnValue(true)
    const pane = createPane({
      lastFitClientSize: { width: 800, height: 600 },
      currentSize: { width: 640, height: 480 },
      terminal: { cols: 80, rows: 24 },
      proposed: { cols: 64, rows: 20 }
    })

    fitRevealedPane(pane)

    expect(mocks.flushDeferredPaneMetricOptionsIfMeasurable).toHaveBeenCalledWith(pane)
    // A real resize still takes the synchronous path, and the flush already landed.
    expect(mocks.safeFit).toHaveBeenCalledWith(pane)
  })

  it('fits synchronously when the fit element resized while hidden', () => {
    const pane = createPane({
      lastFitClientSize: { width: 800, height: 600 },
      currentSize: { width: 640, height: 480 },
      terminal: { cols: 80, rows: 24 },
      proposed: { cols: 64, rows: 20 }
    })

    fitRevealedPane(pane)

    expect(mocks.safeFit).toHaveBeenCalledTimes(1)
    expect(mocks.requestStablePaneFit).not.toHaveBeenCalled()
    expect(mocks.flushPendingSafeFitContinuations).not.toHaveBeenCalled()
  })

  it('fits with no baseline (first reveal) rather than skipping', () => {
    const pane = createPane({
      lastFitClientSize: undefined,
      currentSize: { width: 800, height: 600 },
      terminal: { cols: 80, rows: 24 },
      proposed: { cols: 132, rows: 40 }
    })

    fitRevealedPane(pane)

    expect(mocks.safeFit).toHaveBeenCalledTimes(1)
  })

  it('skips the fit (no reflow) when pixels are unchanged and the grid already matches', () => {
    // A metric wobble would move proposed cols WITHOUT moving the element pixels;
    // here the grid matches, so reveal must not reflow a diff-painting inline TUI.
    const pane = createPane({
      lastFitClientSize: { width: 800, height: 600 },
      currentSize: { width: 800, height: 600 },
      terminal: { cols: 80, rows: 24 },
      proposed: { cols: 80, rows: 24 }
    })

    fitRevealedPane(pane)

    expect(mocks.safeFit).not.toHaveBeenCalled()
    expect(mocks.requestStablePaneFit).not.toHaveBeenCalled()
    // Parked replay/reattach continuations still get released.
    expect(mocks.flushPendingSafeFitContinuations).toHaveBeenCalledTimes(1)
    expect(mocks.clearPaneFitContinuationRetry).toHaveBeenCalledTimes(1)
  })

  it('repairs on a steady grid when pixels are unchanged but the grid diverged while hidden', () => {
    // e.g. a hidden snapshot/SSH-reattach did a direct terminal.resize to dims
    // that differ from the container-fit grid; reveal must refit, not skip.
    const pane = createPane({
      lastFitClientSize: { width: 800, height: 600 },
      currentSize: { width: 800, height: 600 },
      terminal: { cols: 100, rows: 30 },
      proposed: { cols: 80, rows: 24 }
    })

    fitRevealedPane(pane)

    expect(mocks.requestStablePaneFit).toHaveBeenCalledTimes(1)
    expect(mocks.safeFit).not.toHaveBeenCalled()
    // Not the plain-release path — the stable fit owns continuation release here.
    expect(mocks.flushPendingSafeFitContinuations).not.toHaveBeenCalled()
  })

  it('does not release continuations when an unchanged pane is unmeasurable', () => {
    mocks.canMeasurePaneForFit.mockReturnValue(false)
    const pane = createPane({
      lastFitClientSize: { width: 800, height: 600 },
      currentSize: { width: 800, height: 600 },
      terminal: { cols: 80, rows: 24 },
      proposed: { cols: 80, rows: 24 }
    })

    fitRevealedPane(pane)

    expect(mocks.flushPendingSafeFitContinuations).not.toHaveBeenCalled()
  })
})
