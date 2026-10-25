import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { readTerminalMouseEncoding } from './terminal-mouse-encoding'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()))
}

describe('readTerminalMouseEncoding', () => {
  it('reads the encoding from the real vendored renderer xterm build', async () => {
    // Pinned on purpose: if an upgrade moves the private service, this must fail
    // loudly — a silent 'default' would bring back X10 reports (#23818).
    const terminal = new Terminal({ allowProposedApi: true })
    expect(readTerminalMouseEncoding(terminal)).toBe('default')

    await write(terminal, '\x1b[?1003h\x1b[?1006h')
    expect(readTerminalMouseEncoding(terminal)).toBe('sgr')

    await write(terminal, '\x1b[?1016h')
    expect(readTerminalMouseEncoding(terminal)).toBe('sgr-pixels')

    await write(terminal, '\x1bc')
    expect(readTerminalMouseEncoding(terminal)).toBe('default')
    terminal.dispose()
  })

  it('answers default when the private internals are missing', () => {
    expect(readTerminalMouseEncoding({ cols: 80, rows: 24 })).toBe('default')
    expect(readTerminalMouseEncoding({ cols: 80, rows: 24, _core: {} })).toBe('default')
  })
})
