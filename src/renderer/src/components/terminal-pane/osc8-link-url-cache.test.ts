import { Terminal } from '@xterm/headless'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { createOsc8LinkUrlCache } from './osc8-link-url-cache'

type ExtendedCell = { hasExtendedAttrs(): boolean; extended?: { urlId?: number } }

function urlIdAt(terminal: Terminal, y: number, x: number): number | undefined {
  const cell = terminal.buffer.active.getLine(y)?.getCell(x) as unknown as ExtendedCell | undefined
  return cell?.extended?.urlId
}

function link(url: string, id?: string): string {
  const params = id === undefined ? '' : `id=${id}`
  return `]8;${params};${url}`
}

const CLOSE = ']8;;'

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, () => resolve()))
}

describe('OSC 8 link URL cache', () => {
  it('matches the ids xterm actually assigned, including reuse and repeats', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    const cache = createOsc8LinkUrlCache(terminal as unknown as XtermTerminal)
    const a = 'https://example.com/a'
    const b = 'https://example.com/b'

    await write(
      terminal,
      // Same id on two rows (one logical link), then a different link, then the
      // same URL with no id at all (a distinct link as far as xterm cares).
      `${link(a, '1')}AAA${CLOSE}\r\n` +
        `${link(a, '1')}AAA${CLOSE}\r\n` +
        `${link(b, '2')}BBB${CLOSE}\r\n` +
        `${link(a)}AAA${CLOSE}`
    )

    // The cache is only useful if it agrees with the ids xterm wrote into cells.
    for (const [row, url] of [
      [0, a],
      [1, a],
      [2, b],
      [3, a]
    ] as const) {
      const urlId = urlIdAt(terminal, row, 0)
      expect(urlId).toBeTruthy()
      expect(cache.get(urlId!)).toBe(url)
    }
    // Rows sharing an id share one link; the id-less repeat is its own.
    expect(urlIdAt(terminal, 0, 0)).toBe(urlIdAt(terminal, 1, 0))
    expect(urlIdAt(terminal, 3, 0)).not.toBe(urlIdAt(terminal, 0, 0))

    cache.dispose()
    terminal.dispose()
  })

  it('learns links written before anything was hovered', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    const cache = createOsc8LinkUrlCache(terminal as unknown as XtermTerminal)
    const url = 'https://example.com/cold'

    await write(terminal, `${link(url, '9')}COLD${CLOSE}`)

    expect(cache.get(urlIdAt(terminal, 0, 0)!)).toBe(url)
    cache.dispose()
    terminal.dispose()
  })

  it('leaves xterm’s own OSC 8 handling intact', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    const cache = createOsc8LinkUrlCache(terminal as unknown as XtermTerminal)

    await write(terminal, `${link('https://example.com/x', '3')}XXX${CLOSE}`)

    // xterm still records the link itself, so its own provider keeps working.
    expect(urlIdAt(terminal, 0, 0)).toBeTruthy()
    cache.dispose()
    terminal.dispose()
  })

  it('stops observing once disposed', async () => {
    const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    const cache = createOsc8LinkUrlCache(terminal as unknown as XtermTerminal)
    cache.dispose()

    await write(terminal, `${link('https://example.com/after', '4')}AFTER${CLOSE}`)

    expect(cache.get(urlIdAt(terminal, 0, 0)!)).toBeUndefined()
    terminal.dispose()
  })
})
