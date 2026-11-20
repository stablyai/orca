import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  buildParityMainBufferSnapshot,
  createRendererParityTerminal,
  writeToTerminal
} from '../../../../../shared/terminal/replay/testing/terminal-restore-parity-fixture'
import { buildMainModelSnapshotReplayWrites } from './terminal-snapshot-replay-paint'

async function replayInto(
  terminal: Terminal,
  model: ReturnType<typeof createRendererParityTerminal>,
  paneOnAlternateScreen: boolean
): Promise<void> {
  const snapshot = buildParityMainBufferSnapshot(model, 1)
  for (const write of buildMainModelSnapshotReplayWrites(snapshot, { paneOnAlternateScreen })) {
    await writeToTerminal(terminal, write)
  }
}

function row(terminal: Terminal, index: number): string {
  return terminal.buffer.active.getLine(index)?.translateToString(true) ?? ''
}

describe('replay recovers from a stranded shift-out', () => {
  // Ground GL because replay renders through it, while preserving app-owned G-set designations.
  it('renders the restored frame as ASCII even if the gap stranded a shift-out', async () => {
    const model = createRendererParityTerminal({ cols: 20, rows: 4 })
    const pane = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, 'qqq plain text')
      await writeToTerminal(pane, '\x1b(B\x1b)0\x0e')

      await replayInto(pane, model, false)

      expect(row(pane, 0)).toBe('qqq plain text')
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })
})

describe('real TUI shapes survive a replay', () => {
  // Alt snapshot redeclares region/cursor state; restored model must replace the gap’s state.
  it('keeps an editor scroll region and status line after a replay', async () => {
    const model = createRendererParityTerminal({ cols: 20, rows: 6 })
    const pane = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, '\x1b[?1049h\x1b[1;5r\x1b[1;1Hline one')
      await writeToTerminal(model.terminal, '\x1b[6;1H-- INSERT --')
      // The gap left a different region and a stranded origin mode behind.
      await writeToTerminal(pane, '\x1b[?1049h\x1b[2;3r\x1b[?6h')

      await replayInto(pane, model, true)
      // Exercise restored margins by scrolling; painted rows alone cannot prove the region returned.
      await writeToTerminal(pane, '\x1b[5;1H\n\nscrolled')

      // Row 6 is outside the model's 1;5 region and must not have moved.
      expect(row(pane, 5)).toBe('-- INSERT --')
      expect(row(pane, 4)).toBe('scrolled')
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })

  // Stay on normal buffer so ?1049l cannot restore autowrap incidentally; only the baseline may fix it.
  it('keeps every column of a pager frame when the gap stranded autowrap off', async () => {
    const model = createRendererParityTerminal({ cols: 10, rows: 4 })
    const pane = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, 'ABCDEFGHIJKLMN')
      await writeToTerminal(pane, '\x1b[?7l')

      await replayInto(pane, model, false)

      expect([row(pane, 0), row(pane, 1)]).toEqual(['ABCDEFGHIJ', 'KLMN'])
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })

  // No buffer switch: only the baseline restores overwrite semantics instead of stranded insert mode.
  it('keeps a live repaint overwriting when the gap stranded insert mode', async () => {
    const model = createRendererParityTerminal({ cols: 12, rows: 3 })
    const pane = new Terminal({ cols: 12, rows: 3, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, 'OLDTEXT')
      await writeToTerminal(pane, '\x1b[4h')

      await replayInto(pane, model, false)
      await writeToTerminal(pane, '\x1b[1;1HNEW')

      expect(row(pane, 0)).toBe('NEWTEXT')
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })

  // And reverse wraparound, which only manifests through a later backspace.
  it('keeps a live backspace from chewing the row above after a replay', async () => {
    const model = createRendererParityTerminal({ cols: 8, rows: 3 })
    const pane = new Terminal({ cols: 8, rows: 3, allowProposedApi: true })
    try {
      await writeToTerminal(model.terminal, 'AAAAAAAABBBB')
      await writeToTerminal(pane, '\x1b[?45h')

      await replayInto(pane, model, false)
      await writeToTerminal(pane, '\b\b\b\b\bX')

      expect([row(pane, 0), row(pane, 1)]).toEqual(['AAAAAAAA', 'XBBB'])
    } finally {
      model.terminal.dispose()
      pane.dispose()
    }
  })
})
