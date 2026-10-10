import type { Terminal } from '@xterm/xterm'
import { isAbovePaneFitGridFloor } from '../pane-fit-measurability'

type NativeGridState = { grid: { cols: number; rows: number } | null }

// A native grid sizes the pane like xterm's own fit, under the same floor: a grid below it came
// from a near-zero box, so the pane keeps its last sane grid (xterm's fit until Ghostty has one).
export function applyNativeTerminalGrid(
  terminal: Pick<Terminal, 'cols' | 'rows' | 'resize'>,
  state: NativeGridState,
  grid: { cols: number; rows: number }
): void {
  if (!isAbovePaneFitGridFloor(grid.cols, grid.rows)) {
    return
  }
  state.grid = { cols: grid.cols, rows: grid.rows }
  // xterm's onResize forwards the grid to the PTY through the usual resize gates.
  if (terminal.cols !== grid.cols || terminal.rows !== grid.rows) {
    terminal.resize(grid.cols, grid.rows)
  }
}
