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
  it('provides row ranges until a streaming rewrite replaces the URL with text', async () => {
    const url = 'https://example.com/example-project/pull/1234567890'
    const width = 38
    const { terminal, linksAt } = await terminalWithRows(
      [` ${url.slice(0, width)} `, ` ${url.slice(width)} `],
      width + 2
    )
    try {
      expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false)
      const first = await linksAt(1)
      const second = await linksAt(2)
      expect(first).toMatchObject([
        { text: url, range: { start: { x: 2, y: 1 }, end: { x: 39, y: 1 } } }
      ])
      expect(second).toMatchObject([
        { text: url, range: { start: { x: 2, y: 2 }, end: { x: 14, y: 2 } } }
      ])
      const link = first?.[0]
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
})
