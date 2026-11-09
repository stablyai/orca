// @vitest-environment happy-dom
import { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import { StableCellFitAddon } from './terminal-stable-cell-fit-addon'

// A DejaVu Sans Mono 14px advance on a 1x display, as measured on a Linux DOM-renderer pane.
const CHAR_WIDTH = 8.4287109375
const CELL_HEIGHT = 16

type FakeTerminal = { element: HTMLElement; cols: number; rows: number }

// Mirrors DomRenderer: the css cell is the rounded canvas width divided by the current cols.
function domRendererTerminal(cols: number, rows: number): Terminal {
  const parent = document.createElement('div')
  parent.style.width = '445px'
  parent.style.height = '796px'
  const element = document.createElement('div')
  parent.appendChild(element)
  document.body.appendChild(parent)
  const terminal: FakeTerminal & Record<string, unknown> = {
    element,
    cols,
    rows,
    options: { scrollback: 5000, scrollbar: { width: 7 } },
    get dimensions() {
      return {
        device: { cell: { width: CHAR_WIDTH, height: CELL_HEIGHT } },
        css: {
          cell: {
            width: Math.round(CHAR_WIDTH * terminal.cols) / terminal.cols,
            height: Math.round(CELL_HEIGHT * terminal.rows) / terminal.rows
          }
        }
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the addons read only element, dimensions and options, all set above.
  return terminal as unknown as Terminal
}

function propose(addon: FitAddon, cols: number): { cols: number; rows: number } | undefined {
  addon.activate(domRendererTerminal(cols, 49))
  return addon.proposeDimensions()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('StableCellFitAddon', () => {
  it('proposes the same grid for the same box whatever grid it fits from', () => {
    // The bug: xterm's own proposal depends on the grid it starts from.
    expect(propose(new FitAddon(), 52)?.cols).toBe(52)
    expect(propose(new FitAddon(), 75)?.cols).toBe(51)

    for (const from of [52, 75, 51, 80, 120]) {
      expect(propose(new StableCellFitAddon(), from)).toEqual({ cols: 51, rows: 49 })
    }
  })
})
