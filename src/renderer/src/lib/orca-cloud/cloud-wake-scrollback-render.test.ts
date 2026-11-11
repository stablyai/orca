import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { renderBufferRows, sanitizeRestoredText } from './cloud-wake-scrollback-render'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('sanitizeRestoredText (WAKE-SCROLLBACK)', () => {
  it('keeps text and SGR, and drops every other escape', () => {
    const dirty = [
      'plain ',
      '\x1b[1;31mred\x1b[0m ',
      '\x1b]52;c;ZXZpbA==\x07', // OSC 52 clipboard write (BEL)
      '\x1b]52;c;ZXZpbA==\x1b\\', // OSC 52 (ST)
      '\x1b]0;window title\x07', // OSC 0 title
      '\x1b[200~pasted\x1b[201~', // bracketed paste markers
      '\x1b[5A\x1b[10;3H\x1b[2C\x1b[K\x1b[2J', // cursor moves and erases
      '\x1b[?1049h\x1b[?2004h\x1b[?25l', // DECSET
      '\x1b(0\x1b=\x1b7\x1bc', // charset, keypad, DECSC, RIS
      '\x1bPq#0;2;0;0;0\x1b\\', // DCS (sixel)
      '\x9b31m\x9d0;t\x07', // C1 CSI / OSC
      'end\x07\x08\r\n'
    ].join('')
    expect(sanitizeRestoredText(dirty)).toBe('plain \x1b[1;31mred\x1b[0m pastedend\r\n')
  })

  it('keeps 256-colour and truecolour SGR', () => {
    expect(sanitizeRestoredText('\x1b[38;5;208mo\x1b[48;2;1;2;3mb\x1b[m')).toBe(
      '\x1b[38;5;208mo\x1b[48;2;1;2;3mb\x1b[m'
    )
  })
})

describe('renderBufferRows (WAKE-SCROLLBACK)', () => {
  it('renders text with its colours and attributes, joins wrapped rows, trims padding', async () => {
    const terminal = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
    await write(terminal, '\x1b[1;31mbold red\x1b[0m\r\nabcdefghijKLM\r\nplain   ')
    const out = renderBufferRows(terminal.buffer.normal, 0, 4)
    expect(out).toBe('\x1b[0;1;31mbold red\x1b[0m\r\nabcdefghijKLM\r\nplain')
    expect(sanitizeRestoredText(out)).toBe(out)
  })

  it('round-trips through a fresh terminal with the same cells', async () => {
    const source = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    await write(source, 'a \x1b[38;5;208mo\x1b[48;2;1;2;3mx\x1b[0m \x1b[7mi\x1b[0m')
    const target = new Terminal({ cols: 20, rows: 3, allowProposedApi: true })
    await write(target, renderBufferRows(source.buffer.normal, 0, 1))
    const cell = (terminal: Terminal, x: number) => terminal.buffer.normal.getLine(0)!.getCell(x)!
    for (const x of [2, 3, 5]) {
      expect(cell(target, x).getFgColor()).toBe(cell(source, x).getFgColor())
      expect(cell(target, x).getBgColor()).toBe(cell(source, x).getBgColor())
      expect(cell(target, x).isInverse()).toBe(cell(source, x).isInverse())
    }
  })
})
