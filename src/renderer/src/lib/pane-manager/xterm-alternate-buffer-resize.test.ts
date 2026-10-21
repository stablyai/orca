import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

describe('xterm alternate buffer resize', () => {
  it.each([47, 1047, 1049])(
    'keeps the alternate screen free of scrollback after shrinking before mode %i',
    async (mode) => {
      const terminal = new Terminal({ cols: 73, rows: 40, allowProposedApi: true })
      try {
        await write(terminal, 'shell history\r\n'.repeat(80))
        terminal.resize(73, 21)
        const normalBaseY = terminal.buffer.normal.baseY

        await write(terminal, `\x1b[?${mode}h${'long pasted text\r\n'.repeat(100)}`)

        expect(terminal.buffer.active.type).toBe('alternate')
        expect(terminal.buffer.active.length).toBe(21)
        expect(terminal.buffer.active.baseY).toBe(0)
        expect(terminal.buffer.active.viewportY).toBe(0)
        terminal.scrollLines(-10)
        expect(terminal.buffer.active.viewportY).toBe(0)

        await write(terminal, `\x1b[?${mode}l`)
        expect(terminal.buffer.active.type).toBe('normal')
        expect(terminal.buffer.active.baseY).toBe(normalBaseY)
      } finally {
        terminal.dispose()
      }
    }
  )

  it('resizes the cleared alternate buffer before the next fullscreen app', async () => {
    const terminal = new Terminal({ cols: 73, rows: 40, allowProposedApi: true })
    try {
      await write(terminal, '\x1b[?1049hfirst app\x1b[?1049l')
      terminal.resize(73, 30)
      terminal.resize(73, 16)
      terminal.resize(73, 21)

      await write(terminal, `\x1b[?1049h${'second app\r\n'.repeat(100)}`)

      expect(terminal.buffer.active.length).toBe(21)
      expect(terminal.buffer.active.baseY).toBe(0)
      expect(terminal.buffer.active.viewportY).toBe(0)
    } finally {
      terminal.dispose()
    }
  })
})
