import { Terminal } from '@xterm/headless'
import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { createWrappedTerminalHttpLinkProvider } from './wrapped-terminal-http-link-provider'

async function terminalWithRows(rows: string[], cols: number) {
  const terminal = new Terminal({ cols, rows: rows.length + 1, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(rows.join('\r\n'), resolve))
  const provider = createWrappedTerminalHttpLinkProvider(terminal, { activate: vi.fn() })
  return {
    terminal,
    linksAt: (row: number) =>
      new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(row, resolve))
  }
}

describe('wrapped terminal HTTP link provider', () => {
  it('uses current cells after a streaming rewrite replaces a link with plain text', async () => {
    const url = `https://example.com/${'a'.repeat(30)}`
    const { terminal, linksAt } = await terminalWithRows(
      [` ${url.slice(0, 38)} `, ` ${url.slice(38)} `],
      40
    )
    try {
      expect((await linksAt(2))?.[0]?.text).toBe(url)
      const link = (await linksAt(1))?.[0]
      if (!link || !('isBufferValid' in link) || typeof link.isBufferValid !== 'function') {
        throw new Error('Wrapped links must validate their source rows')
      }
      expect(link.isBufferValid()).toBe(true)
      await new Promise<void>((resolve) => terminal.write('\x1b[3;1Hunrelated', resolve))
      expect(link.isBufferValid()).toBe(true)
      await new Promise<void>((resolve) =>
        terminal.write('\x1b[H\x1b[2Kdone\x1b[2;1H\x1b[2K', resolve)
      )
      expect(link.isBufferValid()).toBe(false)
      expect(await linksAt(1)).toBeUndefined()
      expect(await linksAt(2)).toBeUndefined()
    } finally {
      terminal.dispose()
    }
  })

  it('provides the complete URL and cell range on both independently written padded rows', async () => {
    const url = 'https://example.com/example-project/pull/1234567890'
    const width = 38
    const { terminal, linksAt } = await terminalWithRows(
      [` ${url.slice(0, width)} `, ` ${url.slice(width)} `],
      width + 2
    )
    try {
      expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false)
      for (const row of [1, 2]) {
        const links = await linksAt(row)
        expect(links).toHaveLength(1)
        expect(links?.[0]).toMatchObject({
          text: url,
          range: {
            start: { x: 2, y: row },
            end: { x: row === 1 ? width + 1 : url.length - width + 1, y: row }
          }
        })
      }
    } finally {
      terminal.dispose()
    }
  })
})
