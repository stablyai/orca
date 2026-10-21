import { describe, expect, it, vi } from 'vitest'
import {
  createRendererParityTerminal,
  cursorPosition,
  normalBufferRowsTrimmed,
  normalBufferStylesTrimmed,
  visibleRowStyles,
  visibleRowWraps,
  visibleRows,
  writeChunksToTerminal
} from './terminal-restore-parity-fixture'

type AsyncOscParser = {
  registerOscHandler(
    identifier: number,
    callback: (data: string) => boolean | Promise<boolean>
  ): { dispose(): void }
}

describe('terminal parity fixture writes', () => {
  it('queues every original chunk and resolves only after the last callback', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 8, rows: 2 })
    const writes: { data: string | Uint8Array; callback?: () => void }[] = []
    try {
      vi.spyOn(terminal, 'write').mockImplementation((data, callback) => {
        writes.push({ data, callback })
      })
      const chunks = ['A\x1b[', '', '31mB', '\x1b[0mC']
      let completed = false
      const pending = writeChunksToTerminal(terminal, chunks).then(() => {
        completed = true
      })
      expect(writes.map(({ data }) => data)).toEqual(chunks)
      expect(writes.slice(0, -1).every(({ callback }) => callback === undefined)).toBe(true)
      await Promise.resolve()
      expect(completed).toBe(false)
      writes.at(-1)?.callback?.()
      await pending
      expect(completed).toBe(true)
    } finally {
      terminal.dispose()
      vi.restoreAllMocks()
    }
  })

  it('completes an empty batch without writing or scheduling work', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 8, rows: 2 })
    try {
      const write = vi.spyOn(terminal, 'write')
      await writeChunksToTerminal(terminal, [])
      expect(write).not.toHaveBeenCalled()
    } finally {
      terminal.dispose()
      vi.restoreAllMocks()
    }
  })

  it('waits for an asynchronous parser barrier before exposing later chunks', async () => {
    const { terminal } = createRendererParityTerminal({ cols: 8, rows: 2 })
    let signalEntered = (): void => {}
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    let releaseParser = (): void => {}
    const barrier = new Promise<boolean>((resolve) => {
      releaseParser = () => resolve(true)
    })
    // xterm supports async handlers; its shipped public typings still say boolean.
    const parser: AsyncOscParser = terminal.parser
    const registration = parser.registerOscHandler(777, () => {
      signalEntered()
      return barrier
    })
    try {
      let completed = false
      const pending = writeChunksToTerminal(terminal, [
        'A\x1b]777;pause',
        '\x07B',
        '\x1b[31mC',
        'D'
      ]).then(() => {
        completed = true
      })
      await entered
      expect(visibleRows(terminal)[0]).toBe('A')
      expect(completed).toBe(false)
      releaseParser()
      await pending
      expect(visibleRows(terminal)[0]).toBe('ABCD')
      expect(terminal.buffer.active.getLine(0)?.getCell(3)?.getFgColor()).toBe(1)
    } finally {
      releaseParser()
      registration.dispose()
      terminal.dispose()
    }
  })

  it.each([
    ['A\x1b[', '38;2;11;22;33m界', 'é👩‍💻', '\x1b[0m\r\nnext'],
    ['history\r\n'.repeat(8), '\x1b[?1049h\x1b[2J\x1b[H', '\x1b[48;5;2m ALT ', '\x1b[0m'],
    ['\x1b[?1049hALT', '\x1b[?1049l', '\x1b[7;4;9;53m ', '\x1b[0mnormal'],
    ['\x1b]8;;https://example.com\x07', 'link', '\x1b]8;;', '\x07 tail'],
    ['0123456789ABCDEFGHIJKLMN', '\x1b[2A\x1b[2K', '\x1b[3;5H', 'end\x1b[?2004h']
  ])(
    'matches serial callbacks for split controls, styles and buffer transitions: %j',
    async (...chunks) => {
      const batched = createRendererParityTerminal({ cols: 12, rows: 4 })
      const serial = createRendererParityTerminal({ cols: 12, rows: 4 })
      try {
        for (const chunk of chunks) {
          await new Promise<void>((resolve) => serial.terminal.write(chunk, resolve))
        }
        await writeChunksToTerminal(batched.terminal, chunks)
        expect(visibleRows(batched.terminal)).toEqual(visibleRows(serial.terminal))
        expect(visibleRowStyles(batched.terminal)).toEqual(visibleRowStyles(serial.terminal))
        expect(visibleRowWraps(batched.terminal)).toEqual(visibleRowWraps(serial.terminal))
        expect(normalBufferRowsTrimmed(batched.terminal)).toEqual(
          normalBufferRowsTrimmed(serial.terminal)
        )
        expect(normalBufferStylesTrimmed(batched.terminal)).toEqual(
          normalBufferStylesTrimmed(serial.terminal)
        )
        expect(cursorPosition(batched.terminal)).toEqual(cursorPosition(serial.terminal))
        expect(batched.terminal.modes).toEqual(serial.terminal.modes)
        expect(batched.serializeAddon.serialize()).toBe(serial.serializeAddon.serialize())
      } finally {
        batched.terminal.dispose()
        serial.terminal.dispose()
      }
    }
  )
})
