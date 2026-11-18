import { Terminal } from '@xterm/headless'
import type { ILink } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { createWrappedTerminalHttpLinkProvider } from './wrapped-terminal-http-link-provider'

describe('wrapped terminal HTTP link limits', () => {
  it.each([2_048, 2_049, 2_200])(
    'never advertises a truncated %i-character URL',
    async (length) => {
      const url = `https://example.com/${'a'.repeat(length - 'https://example.com/'.length)}`
      const width = 38
      const rows = Array.from(
        { length: Math.ceil(url.length / width) },
        (_, index) => ` ${url.slice(index * width, (index + 1) * width)} `
      )
      const terminal = new Terminal({ cols: 40, rows: rows.length + 1, allowProposedApi: true })
      try {
        await new Promise<void>((resolve) => terminal.write(rows.join('\r\n'), resolve))
        const provider = createWrappedTerminalHttpLinkProvider(terminal, {
          activate: () => undefined
        })
        for (const row of [1, 2, rows.length]) {
          const links = await new Promise<ILink[] | undefined>((resolve) =>
            provider.provideLinks(row, resolve)
          )
          if (length > 2_048) {
            expect(links).toBeUndefined()
          } else {
            expect(links).toHaveLength(1)
            expect(links?.[0]?.text).toBe(url)
          }
        }
      } finally {
        terminal.dispose()
      }
    }
  )
})
