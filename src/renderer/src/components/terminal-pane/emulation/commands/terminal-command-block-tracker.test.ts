import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  createTerminalCommandBlockTracker,
  readTerminalBlockTextFromTerminal,
  type TerminalCommandBlockTracker
} from './terminal-command-block-tracker'
import {
  readTerminalCommandBlockText,
  type TerminalBlockLineReader
} from './terminal-command-block-text'

const OSC = '\x1b]133;'
const BEL = '\x07'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function trackedTerminal(options?: ConstructorParameters<typeof Terminal>[0]): {
  terminal: Terminal
  tracker: TerminalCommandBlockTracker
  dispose: () => void
} {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, ...options })
  const tracker = createTerminalCommandBlockTracker(terminal)
  terminal.parser.registerOscHandler(133, (payload) => {
    tracker.handleOsc133Payload(payload)
    return true
  })
  return {
    terminal,
    tracker,
    dispose: () => {
      tracker.dispose()
      terminal.dispose()
    }
  }
}

function stubReader(rows: { text: string; wrapped: boolean }[]): TerminalBlockLineReader {
  return {
    getLine: (row: number) => rows[row] ?? null
  }
}

describe('terminal-command-block-tracker', () => {
  it('tracks a finished command and extracts command, output, and both', async () => {
    const { terminal, tracker, dispose } = trackedTerminal()
    try {
      await write(
        terminal,
        `${OSC}A${BEL}$ ${OSC}B${BEL}echo hi\r\n${OSC}C${BEL}hi\r\n${OSC}D;0${BEL}`
      )
      // Prompt row, output row, and the gap past the block.
      expect(tracker.resolveBlockAtRow(0)).not.toBeNull()
      const block = tracker.resolveBlockAtRow(1)
      expect(block).not.toBeNull()
      if (!block) {
        return
      }
      expect(
        readTerminalBlockTextFromTerminal(terminal, block, 'command', { trimGutter: false })
      ).toBe('echo hi')
      expect(
        readTerminalBlockTextFromTerminal(terminal, block, 'output', { trimGutter: false })
      ).toBe('hi')
      expect(
        readTerminalBlockTextFromTerminal(terminal, block, 'both', { trimGutter: false })
      ).toBe('echo hi\nhi')
      expect(tracker.resolveBlockAtRow(5)).toBeNull()
    } finally {
      dispose()
    }
  })

  it('includes the D row when output has no trailing newline', async () => {
    const { terminal, tracker, dispose } = trackedTerminal()
    try {
      await write(
        terminal,
        `${OSC}A${BEL}$ ${OSC}B${BEL}printf hi\r\n${OSC}C${BEL}hi${OSC}D;0${BEL}$ `
      )
      // The follow-up prompt repainted the D row; extraction still reads 'hi'.
      const block = tracker.resolveBlockAtRow(1)
      expect(block).not.toBeNull()
      if (!block) {
        return
      }
      expect(
        readTerminalBlockTextFromTerminal(terminal, block, 'output', { trimGutter: false })
      ).toBe('hi')
    } finally {
      dispose()
    }
  })

  it('ignores OMP self-closed zones', async () => {
    const { terminal, tracker, dispose } = trackedTerminal()
    try {
      await write(terminal, `${OSC}B${BEL}${OSC}C${BEL}${OSC}D;0${BEL}`)
      expect(tracker.resolveBlockAtRow(0)).toBeNull()
    } finally {
      dispose()
    }
  })

  it('keeps real boundaries when an OMP zone interrupts a command', async () => {
    const { terminal, tracker, dispose } = trackedTerminal()
    try {
      await write(
        terminal,
        `${OSC}A${BEL}$ ${OSC}B${BEL}echo hi\r\n${OSC}C${BEL}hi\r\n` +
          `${OSC}B${BEL}${OSC}C${BEL}${OSC}D;0${BEL}${OSC}D;0${BEL}`
      )
      // OMP zone at the cursor row must not steal the real command's C.
      const block = tracker.resolveBlockAtRow(1)
      expect(block).not.toBeNull()
      if (!block) {
        return
      }
      expect(
        readTerminalBlockTextFromTerminal(terminal, block, 'command', { trimGutter: false })
      ).toBe('echo hi')
    } finally {
      dispose()
    }
  })

  it('drops pending state on unmatched sequences', async () => {
    const { terminal, tracker, dispose } = trackedTerminal()
    try {
      // A without D: nothing resolvable.
      await write(terminal, `${OSC}A${BEL}$ `)
      expect(tracker.resolveBlockAtRow(0)).toBeNull()
      // Stray D clears the stale prompt so a later C cannot pair with it.
      await write(terminal, `${OSC}D;0${BEL}`)
      await write(terminal, `more\r\n${OSC}C${BEL}out\r\n${OSC}D;0${BEL}`)
      expect(tracker.resolveBlockAtRow(0)).toBeNull()
      expect(tracker.resolveBlockAtRow(1)).toBeNull()
    } finally {
      dispose()
    }
  })

  it('returns null while the alt buffer is active', async () => {
    const { terminal, tracker, dispose } = trackedTerminal()
    try {
      await write(
        terminal,
        `${OSC}A${BEL}$ ${OSC}B${BEL}echo hi\r\n${OSC}C${BEL}hi\r\n${OSC}D;0${BEL}`
      )
      expect(tracker.resolveBlockAtRow(1)).not.toBeNull()
      // Switch to the fullscreen buffer: same numeric rows, different content.
      await write(terminal, '\x1b[?1049h')
      expect(terminal.buffer.active.type).toBe('alternate')
      expect(tracker.resolveBlockAtRow(1)).toBeNull()
      await write(terminal, '\x1b[?1049l')
      expect(tracker.resolveBlockAtRow(1)).not.toBeNull()
    } finally {
      dispose()
    }
  })

  it('drops all blocks on resize', async () => {
    const { terminal, tracker, dispose } = trackedTerminal()
    try {
      await write(
        terminal,
        `${OSC}A${BEL}$ ${OSC}B${BEL}echo hi\r\n${OSC}C${BEL}hi\r\n${OSC}D;0${BEL}`
      )
      expect(tracker.resolveBlockAtRow(1)).not.toBeNull()
      terminal.resize(100, 30)
      expect(tracker.resolveBlockAtRow(1)).toBeNull()
    } finally {
      dispose()
    }
  })

  it('forgets blocks scrolled out of the buffer', async () => {
    const { terminal, tracker, dispose } = trackedTerminal({ cols: 80, rows: 4, scrollback: 0 })
    try {
      await write(
        terminal,
        `${OSC}A${BEL}$ ${OSC}B${BEL}echo hi\r\n${OSC}C${BEL}hi\r\n${OSC}D;0${BEL}`
      )
      expect(tracker.resolveBlockAtRow(1)).not.toBeNull()
      await write(terminal, 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\n')
      expect(tracker.resolveBlockAtRow(0)).toBeNull()
      expect(tracker.resolveBlockAtRow(1)).toBeNull()
    } finally {
      dispose()
    }
  })

  it('reads wrapped rows without newlines via the pure reader', () => {
    const reader = stubReader([
      { text: '$ echo a-very-long-command-that-', wrapped: false },
      { text: 'wraps-here', wrapped: true },
      { text: 'out1', wrapped: false },
      { text: 'out2', wrapped: false }
    ])
    const lines = {
      promptLine: 0,
      outputStartLine: 2,
      outputEndLine: 4,
      inputStart: { row: 0, col: 2 },
      outputEndRowSnapshot: null
    }
    expect(readTerminalCommandBlockText(reader, lines, 'command')).toBe(
      'echo a-very-long-command-that-wraps-here'
    )
    expect(readTerminalCommandBlockText(reader, lines, 'output')).toBe('out1\nout2')
    expect(readTerminalCommandBlockText(reader, lines, 'both')).toBe(
      'echo a-very-long-command-that-wraps-here\nout1\nout2'
    )
  })

  it('returns command-only when output is empty', () => {
    const reader = stubReader([{ text: '$ true', wrapped: false }])
    const lines = {
      promptLine: 0,
      outputStartLine: 1,
      outputEndLine: 1,
      inputStart: { row: 0, col: 2 },
      outputEndRowSnapshot: null
    }
    expect(readTerminalCommandBlockText(reader, lines, 'output')).toBe('')
    expect(readTerminalCommandBlockText(reader, lines, 'both')).toBe('true')
  })

  it('skips prompt rows above a multiline B', () => {
    const reader = stubReader([
      { text: '╭─dev', wrapped: false },
      { text: '╰─$ make all', wrapped: false },
      { text: 'done', wrapped: false }
    ])
    const lines = {
      promptLine: 0,
      outputStartLine: 2,
      outputEndLine: 3,
      inputStart: { row: 1, col: 4 },
      outputEndRowSnapshot: null
    }
    expect(readTerminalCommandBlockText(reader, lines, 'command')).toBe('make all')
  })
})
