import { describe, expect, it } from 'vitest'
import { Terminal, type IBufferCell } from '@xterm/xterm'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

type StoredCell = IBufferCell & {
  content: number
  fg: number
  bg: number
  combinedData: string
  extended: { _ext: number; _urlId: number }
}

type StoredLine = {
  compactStorage(): void
  _rawData: Uint32Array
  _packedData?: Uint32Array
}

function internalBuffers(terminal: Terminal): {
  normal: { lines: { length: number; get(row: number): StoredLine } }
  alt: { lines: { length: number; get(row: number): StoredLine } }
} {
  return (
    terminal as unknown as {
      _core: { _bufferService: { buffers: ReturnType<typeof internalBuffers> } }
    }
  )._core._bufferService.buffers
}

function write(terminal: Terminal | HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function cellValues(cell: IBufferCell): (string | number)[] {
  const stored = cell as StoredCell
  return [
    stored.content,
    stored.fg,
    stored.bg,
    stored.combinedData,
    stored.extended._ext,
    stored.extended._urlId
  ]
}

describe('compact desktop scrollback', () => {
  it.each([1, 4173, 19368, 7, 42, 65535, 104729, 2147483647, 4294967295])(
    'survives seeded mutation and eviction (seed %i)',
    async (seed) => {
      let state = seed
      const random = (max: number): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state % max
      }
      const options = { cols: 100, rows: 12, scrollback: 300, allowProposedApi: true }
      const actual = new Terminal(options)
      const expected = new HeadlessTerminal(options)
      const a = new SerializeAddon()
      const b = new SerializeAddon()
      actual.loadAddon(a)
      expected.loadAddon(b)
      try {
        for (let step = 0; step < 180; step++) {
          const mode = random(9)
          const operations = [
            `\x1b[${1 + random(12)};${1 + random(80)}H`,
            `\x1b[${1 + random(9)}@insert`,
            `\x1b[${1 + random(9)}P`,
            `\x1b[${random(3)}K`,
            '\x1b[41mcolored\x1b[0m',
            'e\u0301 漢字 🙂\r\n',
            Array.from({ length: 90 }, (_, i) => `batch-${step}-${i}\r\n`).join(''),
            `\x1b[${1 + random(4)}L\x1b[${1 + random(4)}M`,
            '\x1b[?1049halt\x1b[?1049l'
          ]
          for (const terminal of [actual, expected]) {
            await write(terminal, operations[mode])
          }
          if (step % 9 === 0) {
            const cols = 20 + random(180)
            actual.resize(cols, 12)
            expected.resize(cols, 12)
          }
          if (step % 7 === 0) {
            const lines = internalBuffers(actual).normal.lines
            for (let row = 0; row < lines.length; row++) {
              lines.get(row).compactStorage()
            }
          }
          expect(a.serialize(), `seed ${seed}, step ${step}`).toBe(b.serialize())
        }
      } finally {
        actual.dispose()
        expected.dispose()
      }
    },
    20000
  )

  it('retains short rows without a full-width allocation per row', async () => {
    const terminal = new Terminal({ cols: 200, rows: 24, scrollback: 1000, allowProposedApi: true })
    try {
      await write(terminal, Array.from({ length: 900 }, (_, i) => `row-${i}\r\n`).join(''))
      const lines = internalBuffers(terminal).normal.lines
      let bytes = 0
      for (let row = 0; row < lines.length; row++) {
        const line = lines.get(row)
        bytes += (line._packedData ?? line._rawData).byteLength
      }
      expect(bytes).toBeLessThan((lines.length * terminal.cols * 12) / 2)
      expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('row-0')
    } finally {
      terminal.dispose()
    }
  })

  it('matches depth reduction, clear, reset and subsequent output after compaction', async () => {
    const options = { cols: 200, rows: 24, scrollback: 1000, allowProposedApi: true }
    const actual = new Terminal(options)
    const expected = new HeadlessTerminal(options)
    const a = new SerializeAddon()
    const b = new SerializeAddon()
    actual.loadAddon(a)
    expected.loadAddon(b)
    try {
      for (const operation of ['shrink', 'clear', 'reset'] as const) {
        const output = Array.from({ length: 1200 }, (_, i) => `${operation}-${i} 漢字\r\n`).join('')
        for (const terminal of [actual, expected]) {
          terminal.options.scrollback = 1000
          await write(terminal, output)
          if (operation === 'shrink') {
            terminal.options.scrollback = 50
          } else if (operation === 'clear') {
            terminal.clear()
          } else {
            terminal.reset()
          }
          await write(terminal, 'after-operation\r\n')
        }
        expect(actual.buffer.normal.length).toBe(expected.buffer.normal.length)
        expect(a.serialize()).toBe(b.serialize())
        expect(a.serialize()).not.toContain(`${operation}-0 `)
      }
    } finally {
      actual.dispose()
      expected.dispose()
    }
  })

  it('matches the unmodified headless grid through reads, mutation and reflow', async () => {
    const options = { cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true }
    const actual = new Terminal(options)
    const expected = new HeadlessTerminal(options)
    const actualSerializer = new SerializeAddon()
    const expectedSerializer = new SerializeAddon()
    actual.loadAddon(actualSerializer)
    expected.loadAddon(expectedSerializer)
    const operations: (string | [number, number])[] = [
      Array.from({ length: 900 }, (_, i) => `row-${i}: e\u0301 漢字 🙂\r\n`).join(''),
      '\x1b[41m\x1b[2Kred background\x1b[0m\r\n',
      '\x1b]8;;https://example.com\x07linked\x1b]8;;\x07\r\n',
      '\x1b[4:3;58:2::4:5:6munderlined\x1b[0m\r\n',
      '\x1b[5;12H\x1b[3@insert\x1b[2P\x1b[4X',
      '\x1b[3;20r\x1b[20;1H\n\n\x1b[2T\x1b[r',
      [40, 24],
      [200, 24],
      [12, 10],
      [80, 24],
      '\x1b[?1049halt 漢字\x1b[41m\x1b[2K\x1b[0m',
      [132, 40],
      '\x1b[?1049l',
      `\x1b[?7l${'z'.repeat(300)}\x1b[?7h\r\n`,
      '\x1b[1"qprotected\x1b[0"q\x1b[?2K\r\n',
      '\x1b[2J\x1b[Hafter-clear-screen\r\n',
      '\x1b[3J',
      [200, 24]
    ]
    try {
      for (const operation of operations) {
        for (const terminal of [actual, expected]) {
          if (typeof operation === 'string') {
            await write(terminal, operation)
          } else {
            terminal.resize(...operation)
          }
        }
        // Compact even visible rows to exercise mutation of the packed representation.
        const buffers = internalBuffers(actual)
        for (const buffer of [buffers.normal, buffers.alt]) {
          for (let row = 0; row < buffer.lines.length; row++) {
            buffer.lines.get(row).compactStorage()
          }
        }
        for (const name of ['normal', 'alternate'] as const) {
          const actualBuffer = actual.buffer[name]
          const expectedBuffer = expected.buffer[name]
          expect(actualBuffer.length).toBe(expectedBuffer.length)
          const actualCell = actual.buffer.active.getLine(0)!.getCell(0)!
          const expectedCell = expected.buffer.active.getLine(0)!.getCell(0)!
          for (let row = 0; row < expectedBuffer.length; row++) {
            const actualLine = actualBuffer.getLine(row)!
            const expectedLine = expectedBuffer.getLine(row)!
            expect(actualLine.isWrapped).toBe(expectedLine.isWrapped)
            const actualCells: (string | number)[] = []
            const expectedCells: (string | number)[] = []
            for (let col = 0; col < expectedLine.length; col++) {
              actualCells.push(...cellValues(actualLine.getCell(col, actualCell)!))
              expectedCells.push(...cellValues(expectedLine.getCell(col, expectedCell)!))
            }
            expect(actualCells, `${name} row ${row}`).toEqual(expectedCells)
          }
        }
        expect(actualSerializer.serialize()).toBe(expectedSerializer.serialize())
      }
    } finally {
      actual.dispose()
      expected.dispose()
    }
  }, 20000)
})
