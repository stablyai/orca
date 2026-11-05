// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { expect, it } from 'vitest'

it('keeps OSC 8 links undecorated unless the application explicitly underlines them', async () => {
  const terminal = new Terminal({ cols: 80, rows: 5, allowProposedApi: true })
  try {
    const link = '\x1b]8;;https://example.com\x1b\\'
    const end = '\x1b]8;;\x1b\\'
    await new Promise<void>((resolve) => {
      terminal.write(`${link}PLAIN${end}\r\n\x1b[4m${link}EXPLICIT${end}\x1b[0m`, resolve)
    })
    expect(terminal.buffer.active.getLine(0)!.getCell(0)!.isUnderline()).toBe(0)
    expect(terminal.buffer.active.getLine(1)!.getCell(0)!.isUnderline()).not.toBe(0)
    terminal.options.linkUnderlines = true
    expect(terminal.buffer.active.getLine(0)!.getCell(0)!.isUnderline()).not.toBe(0)
    terminal.options.linkUnderlines = false
    expect(terminal.buffer.active.getLine(0)!.getCell(0)!.isUnderline()).toBe(0)
    expect(terminal.buffer.active.getLine(1)!.getCell(0)!.isUnderline()).not.toBe(0)
  } finally {
    terminal.dispose()
  }
})
