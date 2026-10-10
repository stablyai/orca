import { describe, expect, it, vi } from 'vitest'
import {
  applyDesktopFitFallbackAfterReplay,
  fitAndRefreshDesktopPane,
  refreshDesktopPaneContents
} from './desktop-fit-fallback'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild
} from '@/lib/pane-manager/terminal-scroll-intent-rebuild'

function createPane(
  options: { rows?: number; proposed?: { cols: number; rows: number } | null } = {}
) {
  const terminal = {
    cols: 49,
    rows: options.rows ?? 20,
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0 } },
    resize: vi.fn((cols: number, rows: number) => {
      terminal.cols = cols
      terminal.rows = rows
    }),
    refresh: vi.fn()
  }
  return {
    terminal,
    container: {
      dataset: {},
      getBoundingClientRect: () => ({ width: 800, height: 600 })
    },
    fitAddon: {
      proposeDimensions: vi.fn(() => (options.proposed === undefined ? null : options.proposed)),
      fit: vi.fn()
    }
  }
}

describe('desktop fit fallback', () => {
  it('waits until structural replay completes before direct resize', async () => {
    const pane = createPane()
    beginTerminalScrollIntentBufferRebuild(pane.terminal)

    applyDesktopFitFallbackAfterReplay(pane as never, {
      cols: 120,
      rows: 40,
      priorCols: 49,
      priorRows: 20
    })
    expect(pane.terminal.resize).not.toHaveBeenCalled()

    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await Promise.resolve()
    expect(pane.terminal.resize).toHaveBeenCalledWith(120, 40)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 39)
  })

  it('drops deferred dimensions when the pane binding becomes stale', async () => {
    const pane = createPane()
    let isCurrent = true
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    applyDesktopFitFallbackAfterReplay(pane as never, {
      cols: 120,
      rows: 40,
      priorCols: 49,
      priorRows: 20,
      shouldApply: () => isCurrent
    })

    isCurrent = false
    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await Promise.resolve()
    expect(pane.terminal.resize).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('refreshes the canvas after a stuck-grid fallback resize', async () => {
    const pane = createPane({ proposed: null })
    applyDesktopFitFallbackAfterReplay(pane as never, {
      cols: 120,
      rows: 40,
      priorCols: 49,
      priorRows: 20
    })

    expect(pane.terminal.resize).toHaveBeenCalledWith(120, 40)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 39)
  })
})

describe('fitAndRefreshDesktopPane', () => {
  it('fits and refreshes after mobile-fit ends, not only resize bookkeeping', () => {
    const pane = createPane({ proposed: { cols: 120, rows: 40 } })

    fitAndRefreshDesktopPane(pane as never)

    expect(pane.fitAddon.fit).toHaveBeenCalledTimes(1)
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 19)
    expect(pane.terminal.resize).not.toHaveBeenCalled()
  })

  it('still refreshes when fit is a no-op because the grid already matches', () => {
    const pane = createPane({ proposed: { cols: 49, rows: 20 } })

    fitAndRefreshDesktopPane(pane as never)

    expect(pane.fitAddon.fit).not.toHaveBeenCalled()
    expect(pane.terminal.refresh).toHaveBeenCalledWith(0, 19)
  })

  it('skips refresh when the terminal has no rows', () => {
    const pane = createPane({ rows: 0, proposed: { cols: 120, rows: 40 } })

    refreshDesktopPaneContents(pane as never)

    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })

  it('forces a paused renderer through instead of a swallowed refresh', () => {
    const refreshRows = vi.fn()
    const pane = createPane()
    Object.assign(pane.terminal, {
      _core: {
        _renderService: {
          _isPaused: true,
          _needsFullRefresh: true,
          refreshRows
        }
      }
    })

    refreshDesktopPaneContents(pane as never)

    expect(refreshRows).toHaveBeenCalledWith(0, 19, true)
    expect(pane.terminal.refresh).not.toHaveBeenCalled()
  })
})
