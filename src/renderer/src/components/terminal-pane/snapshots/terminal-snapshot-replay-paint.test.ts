import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  buildMainModelSnapshotReplayWrites,
  shouldSkipAltFrameForWidthMismatch
} from './terminal-snapshot-replay-paint'

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('replay baseline grounding', () => {
  // Exercise production split-alt snapshot output, the reported STA-4042 branch.
  it('replays a split alt-screen snapshot clean when the TUI entered alt with a pen set', async () => {
    const terminal = new Terminal({ cols: 24, rows: 4, allowProposedApi: true })
    try {
      await writeTerminal(terminal, '\x1b[1m\x1b(0')
      // ?1049h saves that pen and charset into the register ?1049l restores from.
      await writeTerminal(terminal, '\x1b[?1049hTUI FRAME')

      for (const write of buildMainModelSnapshotReplayWrites(
        { data: 'alt-frame', alternateScreen: true, scrollbackAnsi: 'qqq scrollback' },
        { paneOnAlternateScreen: true }
      )) {
        await writeTerminal(terminal, write)
      }

      // The alt frame is what shows; the rebuilt normal history must be clean too.
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('alt-frame')
      expect(terminal.buffer.active.getLine(0)?.getCell(0)?.isBold()).toBe(0)
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('qqq scrollback')
      expect(terminal.buffer.normal.getLine(0)?.getCell(0)?.isBold()).toBe(0)
    } finally {
      terminal.dispose()
    }
  })
})

describe('buildMainModelSnapshotReplayWrites alt-frame skip', () => {
  it('restores the exact capture-grid alt frame while the target grid is unknown', async () => {
    const terminal = new Terminal({ cols: 12, rows: 5, scrollback: 20 })
    const snapshot = {
      data: '\x1b[1;1HTOP---------\x1b[2;1HMIDDLE------\x1b[3;1HBOTTOM------',
      frameRestoreAnsi: '\x1b[?25l',
      alternateScreen: true,
      scrollbackAnsi: 'history'
    }

    try {
      const skipAltFrame = shouldSkipAltFrameForWidthMismatch(12, undefined)
      for (const chunk of buildMainModelSnapshotReplayWrites(snapshot, {
        skipAltFrame,
        paneOnAlternateScreen: false
      })) {
        await writeTerminal(terminal, chunk)
      }

      expect(
        Array.from({ length: 3 }, (_, row) =>
          terminal.buffer.active.getLine(row)?.translateToString(true)
        )
      ).toEqual(['TOP---------', 'MIDDLE------', 'BOTTOM------'])
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('history')
    } finally {
      terminal.dispose()
    }
  })

  it('keeps normal history and a clean alt grid through the real resize path', async () => {
    const terminal = new Terminal({ cols: 12, rows: 5, scrollback: 20 })
    const snapshot = {
      data: '\x1b[1;1HWIDE-FRAME',
      frameRestoreAnsi: '\x1b[?25l',
      alternateScreen: true,
      scrollbackAnsi: 'log'
    }

    try {
      for (const chunk of buildMainModelSnapshotReplayWrites(snapshot, {
        skipAltFrame: true,
        paneOnAlternateScreen: false
      })) {
        await writeTerminal(terminal, chunk)
      }
      terminal.resize(4, 5)

      expect(terminal.buffer.active.type).toBe('alternate')
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('')
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('log')
    } finally {
      terminal.dispose()
    }
  })
})
