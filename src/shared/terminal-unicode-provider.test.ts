import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/headless'
import { createRendererParityTerminal, writeToTerminal } from './terminal-restore-parity-fixture'

// Why these oracles: a country flag is two regional indicators with no ZWJ, so the
// ZWJ-only join rule left each indicator in its own cell. Chromium then shapes each
// one alone and paints a lettered tile instead of the flag. Cell contents (not just
// row text) are asserted because the row string looks identical either way.
type Cell = { chars: string; width: number }

function readCells(terminal: Terminal, count: number): Cell[] {
  const line = terminal.buffer.active.getLine(0)
  const cells: Cell[] = []
  for (let x = 0; x < count; x++) {
    const cell = line?.getCell(x)
    cells.push({ chars: cell?.getChars() ?? '', width: cell?.getWidth() ?? 0 })
  }
  return cells
}

const US = '\u{1F1FA}\u{1F1F8}'
const DE = '\u{1F1E9}\u{1F1EA}'

describe('orca terminal unicode provider', () => {
  it('folds a regional indicator pair into one wide flag cluster', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 40, rows: 4 })

    await writeToTerminal(terminal, US)

    expect(readCells(terminal, 2)).toEqual([
      { chars: US, width: 2 },
      { chars: '', width: 0 }
    ])
    terminal.dispose()
  })

  it('starts a new flag on the next pair instead of chaining indicators', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 40, rows: 4 })

    await writeToTerminal(terminal, US + DE)

    expect(readCells(terminal, 4)).toEqual([
      { chars: US, width: 2 },
      { chars: '', width: 0 },
      { chars: DE, width: 2 },
      { chars: '', width: 0 }
    ])
    terminal.dispose()
  })

  it('leaves a trailing unpaired indicator on its own', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 40, rows: 4 })

    await writeToTerminal(terminal, `${US}\u{1F1E9}`)

    expect(readCells(terminal, 3)).toEqual([
      { chars: US, width: 2 },
      { chars: '', width: 0 },
      { chars: '\u{1F1E9}', width: 1 }
    ])
    terminal.dispose()
  })

  it('budgets a flag as two cells so positioned writes land past it', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 40, rows: 4 })

    // A flag totals two cells in wcwidth (each indicator is East_Asian_Width
    // Neutral), so an agent TUI addressing column 3 must clear the flag.
    await writeToTerminal(terminal, `\x1b[H${US}AB`)
    await writeToTerminal(terminal, '\x1b[1;3HZ')

    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(`${US}ZB`)
    terminal.dispose()
  })

  it('keeps ZWJ joining and plain wide glyphs unchanged', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 40, rows: 4 })

    const family = '\u{1F469}\u{200D}\u{1F4BB}'
    await writeToTerminal(terminal, `${family}\u{1F600}你`)

    expect(readCells(terminal, 6)).toEqual([
      { chars: family, width: 2 },
      { chars: '', width: 0 },
      { chars: '\u{1F600}', width: 2 },
      { chars: '', width: 0 },
      { chars: '你', width: 2 },
      { chars: '', width: 0 }
    ])
    terminal.dispose()
  })
})
