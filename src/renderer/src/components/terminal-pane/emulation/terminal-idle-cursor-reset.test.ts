import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { TerminalIdleCursorReset } from './terminal-idle-cursor-reset'

const SGR = '\x1b[38;2;115;118;123;48;2;65;69;76m'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('TerminalIdleCursorReset', () => {
  it.each(Array.from({ length: SGR.length - 1 }, (_, index) => index + 1))(
    'preserves the color and glyph when SGR is split at %i',
    async (split) => {
      const reset = new TerminalIdleCursorReset()
      const terminal = new Terminal({
        cols: 80,
        rows: 5,
        allowProposedApi: true
      })
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
})
