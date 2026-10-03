import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { TerminalIdleCursorReset } from './terminal-idle-cursor-reset'
import { RESET_TERMINAL_CURSOR_STYLE as RESET } from '../../../../shared/terminal-mode-reset-profiles'

const SGR = '\x1b[38;2;115;118;123;48;2;65;69;76m'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('TerminalIdleCursorReset', () => {
  it.each(Array.from({ length: SGR.length - 1 }, (_, index) => index + 1))(
    'preserves the color and glyph when SGR is split at %i',
    async (split) => {
      const reset = new TerminalIdleCursorReset()
      const terminal = new Terminal({ cols: 80, rows: 5, allowProposedApi: true })
      try {
        await write(terminal, reset.processOutput(SGR.slice(0, split)))
        expect(reset.request()).toBe('')
        await write(terminal, reset.processOutput(`${SGR.slice(split)}⠁`))
        const line = terminal.buffer.active.getLine(0)
        expect(line?.translateToString(true)).toBe('⠁')
        expect(line?.getCell(0)?.getBgColor()).toBe(0x41454c)
        expect(reset.processOutput('next')).toBe('next')
      } finally {
        terminal.dispose()
      }
    }
  )

  it.each([
    ['\x1b', '[31', 'm'],
    ['\x1b]0;pending title', '\x1b', '\\'],
    ['\x1b]0;pending title', ' more', '\x07'],
    ['\x1bP$q', 'm', '\x1b\\'],
    ['\x1b[38;2;', '1;2;', '\x18'],
    ['\x1b[38;2;', '1;2;', '\x1a'],
    ['\x1b\x00[31;', '1;', '2m'],
    ['\x1b\t]0;title', ' suffix', '\x07'],
    ['\x1b\x00 ', ' ', 'q']
  ])('waits through the incomplete sequence %j', (first, middle, last) => {
    const reset = new TerminalIdleCursorReset()
    expect(reset.processOutput(first)).toBe(first)
    expect(reset.request()).toBe('')
    expect(reset.request()).toBe('')
    expect(reset.processOutput(middle)).toBe(middle)
    expect(reset.processOutput(last)).toBe(`${last}${RESET}`)
    expect(reset.processOutput('plain')).toBe('plain')
  })

  it('waits if a chunk closes one sequence but opens another', () => {
    const reset = new TerminalIdleCursorReset()
    reset.processOutput('\x1b[38;2;')
    expect(reset.request()).toBe('')
    expect(reset.processOutput('1;2;3m⠁\x1b[')).toBe('1;2;3m⠁\x1b[')
    expect(reset.processOutput('0m')).toBe(`0m${RESET}`)
  })

  it('passes untouched output through when no reset was requested', () => {
    const reset = new TerminalIdleCursorReset()
    for (const data of ['plain', '\x1b[', '31mred', '\x1b[0m', '']) {
      expect(reset.processOutput(data)).toBe(data)
    }
  })

  it('resets immediately at a complete boundary', () => {
    const reset = new TerminalIdleCursorReset()
    expect(reset.request()).toBe(RESET)
    expect(reset.processOutput('')).toBe('')
  })

  it('does not share pending resets or parser tails between panes', () => {
    const first = new TerminalIdleCursorReset()
    const second = new TerminalIdleCursorReset()
    first.processOutput('\x1b[')
    expect(first.request()).toBe('')
    expect(second.request()).toBe(RESET)
    expect(first.processOutput('0m')).toBe(`0m${RESET}`)
  })

  it.each(['\x1b]52;c;', '\x1b_G'])('waits through a large control string %j', (prefix) => {
    const reset = new TerminalIdleCursorReset()
    reset.processOutput(prefix)
    expect(reset.request()).toBe('')
    const payload = 'a'.repeat(8192)
    for (let i = 0; i < 4; i += 1) {
      expect(reset.processOutput(payload)).toBe(payload)
    }
    expect(reset.processOutput('\x1b')).toBe('\x1b')
    expect(reset.processOutput('\\')).toBe(`\\${RESET}`)
  })
})
