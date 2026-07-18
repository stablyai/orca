import { describe, expect, it, vi } from 'vitest'
import { applyDesktopFitFallbackAfterReplay } from './desktop-fit-fallback'
import {
  beginTerminalScrollIntentBufferRebuild,
  endTerminalScrollIntentBufferRebuild
} from '@/lib/pane-manager/terminal-scroll-intent-rebuild'

function createPane() {
  const terminal = {
    cols: 49,
    rows: 20,
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0 } },
    resize: vi.fn((cols: number, rows: number) => {
      terminal.cols = cols
      terminal.rows = rows
    })
  }
  return {
    terminal,
    container: {
      dataset: {},
      getBoundingClientRect: () => ({ width: 800, height: 600 })
    },
    fitAddon: {
      proposeDimensions: vi.fn(() => null),
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
  })
})
