import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'

import { buildFreshShellViewportBlankingSequence } from './terminal-restored-viewport'

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function visibleLines(term: Terminal): string[] {
  const buffer = term.buffer.active
  return Array.from(
    { length: term.rows },
    (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
  )
}

describe('buildFreshShellViewportBlankingSequence', () => {
  it('preserves restored rows in scrollback even after a stale TUI scroll region', async () => {
    const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true })
    try {
      await writeTerminal(term, 'row1\r\nrow2\r\nrow3\r\nrow4\r\nrow5\x1b[2;4r\x1b[?6h\x1b[H')
      await writeTerminal(term, buildFreshShellViewportBlankingSequence(term.rows))

      expect(term.buffer.active.baseY).toBeGreaterThan(0)
      expect(visibleLines(term)).toEqual(['', '', '', '', ''])
      expect(
        Array.from(
          { length: term.buffer.active.length },
          (_, row) => term.buffer.active.getLine(row)?.translateToString(true) ?? ''
        )
      ).toEqual(expect.arrayContaining(['row1', 'row2', 'row3', 'row4', 'row5']))
    } finally {
      term.dispose()
    }
  })
})
