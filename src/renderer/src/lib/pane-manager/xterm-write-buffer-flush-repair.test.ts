import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { installXtermWriteBufferFlushRepair } from './xterm-write-buffer-flush-repair'

function rows(terminal: Terminal, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? ''
  )
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** Make each parsed chunk look like it blew xterm's 12ms slice budget. */
function sliceAfterEveryChunk(): () => void {
  let now = 0
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => (now += 7))
  return () => spy.mockRestore()
}

async function resizeBetweenSlices(
  repair: boolean
): Promise<{ completed: string[]; screen: string[] }> {
  const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
  if (repair) {
    expect(installXtermWriteBufferFlushRepair(terminal)).toBe(true)
  }
  const completed: string[] = []
  for (const line of ['a', 'b', 'c']) {
    terminal.write(`${line}\r\n`, () => completed.push(line))
  }
  const restore = sliceAfterEveryChunk()
  await new Promise((resolve) => setTimeout(resolve, 0))
  terminal.resize(19, 6)
  restore()
  await settle()
  const screen = rows(terminal, 4)
  terminal.dispose()
  return { completed, screen }
}

describe('installXtermWriteBufferFlushRepair', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pins the vendored hazard: a resize between write slices re-parses parsed chunks', async () => {
    const { completed, screen } = await resizeBetweenSlices(false)

    // If this starts failing, xterm fixed flushSync and the repair can be deleted.
    expect(completed).toEqual(['a', 'b', 'a', 'b', 'c'])
    expect(screen).toEqual(['a', 'b', 'a', 'b'])
  })

  it('flushes only the unparsed tail when a resize lands between slices', async () => {
    const { completed, screen } = await resizeBetweenSlices(true)

    expect(completed).toEqual(['a', 'b', 'c'])
    expect(screen).toEqual(['a', 'b', 'c', ''])
  })

  it('does not re-parse the chunk whose completion callback resizes the terminal', async () => {
    const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    installXtermWriteBufferFlushRepair(terminal)
    const completed: string[] = []
    terminal.write('a\r\n', () => {
      completed.push('a')
      terminal.resize(19, 6)
    })
    terminal.write('b\r\n', () => completed.push('b'))
    terminal.write('c\r\n', () => completed.push('c'))
    await settle()

    expect(completed).toEqual(['a', 'b', 'c'])
    expect(rows(terminal, 4)).toEqual(['a', 'b', 'c', ''])
    terminal.dispose()
  })

  it('keeps a write made after a resize from inside a write callback', async () => {
    const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    installXtermWriteBufferFlushRepair(terminal)
    const completed: string[] = []
    terminal.write('a\r\n', () => {
      completed.push('a')
      terminal.resize(19, 6)
      terminal.write('x\r\n', () => completed.push('x'))
    })
    await settle()

    expect(completed).toEqual(['a', 'x'])
    expect(rows(terminal, 3)).toEqual(['a', 'x', ''])
    terminal.dispose()
  })

  it('keeps the next unparsed chunk when a resize lands after a slice yields', async () => {
    const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
    installXtermWriteBufferFlushRepair(terminal)
    const completed: string[] = []
    let resized = false
    terminal.onWriteParsed(() => {
      if (!resized) {
        resized = true
        terminal.resize(19, 6)
      }
    })
    for (const line of ['a', 'b', 'c']) {
      terminal.write(`${line}\r\n`, () => completed.push(line))
    }
    const restore = sliceAfterEveryChunk()
    await new Promise((resolve) => setTimeout(resolve, 0))
    restore()
    await settle()

    expect(completed).toEqual(['a', 'b', 'c'])
    expect(rows(terminal, 4)).toEqual(['a', 'b', 'c', ''])
    terminal.dispose()
  })

  it('declines terminals without the expected internals', () => {
    expect(installXtermWriteBufferFlushRepair({})).toBe(false)
    expect(installXtermWriteBufferFlushRepair(null)).toBe(false)
  })
})
