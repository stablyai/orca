import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeFit } from './pane-tree-ops'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { setFitOverride, hydrateOverrides } from './mobile-fit-overrides'

afterEach(() => {
  hydrateOverrides([])
})

function createPane({
  proposedCols,
  proposedRows,
  terminalCols,
  terminalRows,
  paneId = 1
}: {
  proposedCols: number
  proposedRows: number
  terminalCols: number
  terminalRows: number
  paneId?: number
}): ManagedPaneInternal {
  const fit = vi.fn()
  const proposeDimensions = vi.fn(() => ({ cols: proposedCols, rows: proposedRows }))
  const terminal = {
    cols: terminalCols,
    rows: terminalRows,
    resize: vi.fn((cols: number, rows: number) => {
      terminal.cols = cols
      terminal.rows = rows
    }),
    refresh: vi.fn(),
    buffer: {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: vi.fn(() => ({ translateToString: () => '' }))
      }
    },
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    scrollLines: vi.fn()
  }

  return {
    id: paneId,
    terminal: terminal as never,
    container: { dataset: {} } as never,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    fitAddon: {
      fit,
      proposeDimensions
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
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('safeFit', () => {
  it('skips drag-frame refits when the pane grid dimensions did not change', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })

    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
  })

  it('still refits when the proposed grid dimensions changed', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('still refits when a split-scroll lock is active and the grid changed', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    pane.pendingSplitScrollState = {
      bufferType: 'normal',
      wasAtBottom: true,
      firstVisibleLineContent: '',
      viewportY: 0,
      totalLines: 32
    } satisfies ScrollState

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('resizes terminal to override dimensions when mobile-fit override is active', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 40,
      terminalCols: 120,
      terminalRows: 40
    })
    pane.container.dataset.ptyId = 'pty-phone'
    setFitOverride('pty-phone', 'mobile-fit', 49, 20)

    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.terminal.resize).toHaveBeenCalledWith(49, 20)
  })

  it('skips resize when terminal already matches override dimensions', () => {
    const pane = createPane({
      proposedCols: 120,
      proposedRows: 40,
      terminalCols: 49,
      terminalRows: 20
    })
    pane.container.dataset.ptyId = 'pty-phone'
    setFitOverride('pty-phone', 'mobile-fit', 49, 20)

    safeFit(pane)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.terminal.resize).not.toHaveBeenCalled()
  })

  it('does not apply override when pane has no data-pty-id', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 32
    })
    setFitOverride('pty-phone', 'mobile-fit', 49, 20)

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.resize).not.toHaveBeenCalled()
  })

  it('falls through to normal fit when override is cleared', () => {
    const pane = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 49,
      terminalRows: 20
    })
    pane.container.dataset.ptyId = 'pty-phone'
    setFitOverride('pty-phone', 'mobile-fit', 49, 20)
    setFitOverride('pty-phone', 'desktop-fit', 120, 40)

    safeFit(pane)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
  })

  it('does not cross-contaminate overrides between different ptyIds', () => {
    const paneA = createPane({
      proposedCols: 120,
      proposedRows: 40,
      terminalCols: 120,
      terminalRows: 40,
      paneId: 1
    })
    paneA.container.dataset.ptyId = 'pty-A'

    const paneB = createPane({
      proposedCols: 100,
      proposedRows: 32,
      terminalCols: 120,
      terminalRows: 40,
      paneId: 2
    })
    paneB.container.dataset.ptyId = 'pty-B'

    setFitOverride('pty-A', 'mobile-fit', 49, 20)

    safeFit(paneA)
    safeFit(paneB)

    expect(paneA.terminal.resize).toHaveBeenCalledWith(49, 20)
    expect(paneA.fitAddon.fit).not.toHaveBeenCalled()
    expect(paneB.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(paneB.terminal.resize).not.toHaveBeenCalled()
  })
})
