import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { cellToPixelPosition } from './terminal-autosuggest-cell-position'

function makeFakeTerminal(rect: { width: number; height: number; left: number; top: number }) {
  const screenEl = { getBoundingClientRect: () => rect }
  return {
    cols: 80,
    rows: 24,
    element: { querySelector: (sel: string) => (sel === '.xterm-screen' ? screenEl : null) },
    buffer: { active: { viewportY: 0 } }
  } as unknown as Terminal
}

describe('cellToPixelPosition', () => {
  it('returns null when the xterm screen element is not mounted', () => {
    const terminal = {
      cols: 80,
      rows: 24,
      element: { querySelector: () => null }
    } as unknown as Terminal
    expect(cellToPixelPosition(terminal, 0, 0)).toBeNull()
  })

  it('computes pixel offset from row/col using uniform cell size', () => {
    const terminal = makeFakeTerminal({ width: 800, height: 480, left: 10, top: 20 })
    // cellWidth = 800/80 = 10, cellHeight = 480/24 = 20
    expect(cellToPixelPosition(terminal, 2, 5)).toEqual({ top: 20 + 2 * 20, left: 10 + 5 * 10 })
  })
})
