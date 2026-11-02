import { describe, expect, it, vi } from 'vitest'
import {
  applyDesktopFitFallbackAfterReplay,
  fitAndRefreshDesktopPane
} from './desktop-fit-fallback'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild
} from '@/lib/pane-manager/terminal-scroll-intent-rebuild'

function createPane(options: { proposed?: { cols: number; rows: number }; paused?: boolean } = {}) {
  let paintedGrid: { cols: number; rows: number } | null = null
  const renderService = {
    _isPaused: options.paused ?? false,
    _needsFullRefresh: options.paused ?? false,
    refreshRows: () => {
      if (!renderService._isPaused) {
        paintedGrid = { cols: terminal.cols, rows: terminal.rows }
      }
    }
  }
  const terminal = {
    cols: 49,
    rows: 20,
    _core: { _renderService: renderService },
    refresh: () => renderService.refreshRows(),
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0 } },
    resize: vi.fn((cols: number, rows: number) => {
      terminal.cols = cols
      terminal.rows = rows
    })
  }
  return {
    get paintedGrid() {
      return paintedGrid
    },
    terminal,
    container: {
      dataset: {},
      getBoundingClientRect: vi.fn(() => ({ width: 800, height: 600 }))
    },
    fitAddon: {
      proposeDimensions: vi.fn(() => options.proposed ?? null),
      fit: vi.fn(() => {
        if (options.proposed) {
          terminal.resize(options.proposed.cols, options.proposed.rows)
        }
      })
    }
  }
}

describe('desktop fit fallback', () => {
  it('waits until structural replay completes before direct resize', async () => {
    const pane = createPane()
    beginTerminalScrollIntentBufferRebuild(pane.terminal)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the pane members read by safeFit and repaint.
    applyDesktopFitFallbackAfterReplay(pane as never, {
      cols: 120,
      rows: 40,
      priorCols: 49,
      priorRows: 20
    })
    expect(pane.terminal.resize).not.toHaveBeenCalled()
    expect(pane.paintedGrid).toBeNull()

    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await Promise.resolve()
    expect(pane.terminal.resize).toHaveBeenCalledWith(120, 40)
    expect(pane.paintedGrid).toEqual({ cols: 120, rows: 40 })
  })

  it('drops deferred dimensions when the pane binding becomes stale', async () => {
    const pane = createPane()
    let isCurrent = true
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the pane members read by safeFit and repaint.
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
    expect(pane.paintedGrid).toBeNull()
  })

  it('does not apply deferred desktop geometry after the pane becomes hidden', async () => {
    const pane = createPane({ paused: true })
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the pane members read by safeFit and repaint.
    applyDesktopFitFallbackAfterReplay(pane as never, {
      cols: 120,
      rows: 40,
      priorCols: 49,
      priorRows: 20
    })
    pane.container.getBoundingClientRect.mockReturnValue({ width: 0, height: 0 })
    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await Promise.resolve()
    expect(pane.terminal.resize).not.toHaveBeenCalled()
    expect(pane.paintedGrid).toBeNull()
    expect(pane.terminal._core._renderService._isPaused).toBe(true)
  })
})

describe('desktop fit presentation', () => {
  it('presents unchanged geometry through a paused renderer without waiting for scroll', () => {
    const pane = createPane({ proposed: { cols: 49, rows: 20 }, paused: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the pane members read by safeFit and repaint.
    fitAndRefreshDesktopPane(pane as never, () => true)
    expect(pane.terminal.resize).not.toHaveBeenCalled()
    expect(pane.paintedGrid).toEqual({ cols: 49, rows: 20 })
    expect(pane.terminal._core._renderService._isPaused).toBe(false)
  })

  it('presents only the final desktop grid after structural replay', async () => {
    const pane = createPane({ proposed: { cols: 120, rows: 40 }, paused: true })
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the pane members read by safeFit and repaint.
    fitAndRefreshDesktopPane(pane as never, () => true)
    expect(pane.paintedGrid).toBeNull()
    expect(pane.terminal.cols).toBe(49)
    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await Promise.resolve()
    expect(pane.paintedGrid).toEqual({ cols: 120, rows: 40 })
  })

  it('does not present a restore retired during replay', async () => {
    const pane = createPane({ proposed: { cols: 120, rows: 40 }, paused: true })
    let current = true
    beginTerminalScrollIntentBufferRebuild(pane.terminal)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the pane members read by safeFit and repaint.
    fitAndRefreshDesktopPane(pane as never, () => current)
    current = false
    endTerminalScrollIntentBufferRebuild(pane.terminal)
    await Promise.resolve()
    expect(pane.paintedGrid).toBeNull()
    expect(pane.terminal.cols).toBe(49)
  })
})
