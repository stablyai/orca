import { describe, expect, it, vi } from 'vitest'
import { applyNativeTerminalGrid } from './native-terminal-grid'

function fakeTerminal(cols: number, rows: number) {
  const terminal = {
    cols,
    rows,
    resize: vi.fn((nextCols: number, nextRows: number) => {
      terminal.cols = nextCols
      terminal.rows = nextRows
    })
  }
  return terminal
}

describe('applyNativeTerminalGrid', () => {
  it('sizes the pane to a native grid above the fit floor', () => {
    const terminal = fakeTerminal(120, 40)
    const state = { grid: null }
    applyNativeTerminalGrid(terminal, state, { cols: 118, rows: 39 })
    expect(state.grid).toEqual({ cols: 118, rows: 39 })
    expect(terminal.resize).toHaveBeenCalledWith(118, 39)
  })

  it('leaves xterm fit in charge while Ghostty has only reported a near-zero box', () => {
    const terminal = fakeTerminal(120, 40)
    const state = { grid: null }
    applyNativeTerminalGrid(terminal, state, { cols: 2, rows: 1 })
    expect(state.grid).toBeNull()
    expect(terminal.resize).not.toHaveBeenCalled()
  })

  it('keeps the last sane native grid through a transient tiny one', () => {
    const terminal = fakeTerminal(120, 40)
    const state = { grid: null }
    applyNativeTerminalGrid(terminal, state, { cols: 118, rows: 39 })
    applyNativeTerminalGrid(terminal, state, { cols: 3, rows: 1 })
    expect(state.grid).toEqual({ cols: 118, rows: 39 })
    expect(terminal.resize).toHaveBeenCalledTimes(1)
    expect(terminal.cols).toBe(118)
  })

  it('does not resize when the grid already matches', () => {
    const terminal = fakeTerminal(118, 39)
    applyNativeTerminalGrid(terminal, { grid: null }, { cols: 118, rows: 39 })
    expect(terminal.resize).not.toHaveBeenCalled()
  })
})
