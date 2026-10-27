import { Terminal } from '@xterm/headless'
import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { createWrappedTerminalHttpLinkProvider } from './wrapped-terminal-http-link-provider'
import { openHttpLinkAtBufferPosition } from './terminal-url-link-hit-testing'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'

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
  it('keeps click fallback out of both margins while opening the complete text', async () => {
    const url = `https://example.com/${'a'.repeat(30)}`
    const { terminal } = await terminalWithRows([` ${url.slice(0, 38)} `, ` ${url.slice(38)} `], 40)
    const openUrl = vi.fn()
    vi.stubGlobal('window', { api: { shell: { openUrl } } })
    registerHttpLinkStoreAccessor(() => ({
      repos: [],
      endpointProjects: [],
      endpointProjectHostSetups: [],
      settings: { openLinksInApp: false },
      setActiveWorktree: vi.fn(),
      createBrowserTab: vi.fn()
    }))
    try {
      const deps = { worktreeId: 'test', modifierHeld: true }
      for (const position of [
        { x: 1, y: 1 },
        { x: 40, y: 1 },
        { x: 1, y: 2 },
        { x: 39, y: 2 }
      ]) {
        expect(openHttpLinkAtBufferPosition(terminal.buffer.active, position, 40, deps)).toBe(false)
      }
      for (const y of [1, 2]) {
        expect(openHttpLinkAtBufferPosition(terminal.buffer.active, { x: 2, y }, 40, deps)).toBe(
          true
        )
      }
      expect(openUrl.mock.calls).toEqual([[url], [url]])
    } finally {
      terminal.dispose()
      vi.unstubAllGlobals()
    }
  })

  it.each([0, 1, 3])(
    'reconstructs long links with %i columns of left padding only',
    async (padding) => {
      const url = `https://example.com/path?query=${'segment%20value&'.repeat(7)}end=1#anchor`
      const width = 40 - padding
      const rows = Array.from(
        { length: Math.ceil(url.length / width) },
        (_, index) => ' '.repeat(padding) + url.slice(index * width, (index + 1) * width)
      )
      const { terminal, linksAt } = await terminalWithRows(rows, 40)
      try {
        for (let row = 1; row <= rows.length; row++) {
          expect((await linksAt(row))?.[0]).toMatchObject({
            text: url,
            range: { start: { x: padding + 1, y: row }, end: { y: row } }
          })
        }
      } finally {
        terminal.dispose()
      }
    }
  )

  it.each(['https://example.org/ ', 'Reference: '])(
    'reconstructs the final URL after %s on its start row',
    async (prefix) => {
      const url = `https://example.com/${'a'.repeat(45)}`
      const leading = ` ${prefix}`
      const width = 59 - leading.length
      const { terminal, linksAt } = await terminalWithRows(
        [`${leading}${url.slice(0, width)} `, ` ${url.slice(width)} `],
        60
      )
      try {
        for (const row of [1, 2]) {
          expect((await linksAt(row))?.[0]?.text).toBe(url)
        }
      } finally {
        terminal.dispose()
      }
    }
  )

  it.each(['HTTPS://', 'HTTP://'])(
    'reconstructs an uppercase %s URL without leaving the continuation dead',
    async (scheme) => {
      const visible = `${scheme}EXAMPLE.COM/${'a'.repeat(45)}`
      const { terminal, linksAt } = await terminalWithRows(
        [` ${visible.slice(0, 38)} `, ` ${visible.slice(38)} `],
        40
      )
      try {
        for (const row of [1, 2]) {
          expect((await linksAt(row))?.[0]?.text).toBe(new URL(visible).toString())
        }
      } finally {
        terminal.dispose()
      }
    }
  )

  it('keeps an embedded scheme inside the reconstructed URL', async () => {
    const url = `https://example.com/redirect/https://example.org/${'a'.repeat(45)}`
    const { terminal, linksAt } = await terminalWithRows(
      [` ${url.slice(0, 58)} `, ` ${url.slice(58)} `],
      60
    )
    try {
      for (const row of [1, 2]) {
        expect((await linksAt(row))?.[0]?.text).toBe(url)
      }
    } finally {
      terminal.dispose()
    }
  })

  it('keeps cold clicks consistent with hover across mixed soft and hard wraps', async () => {
    const url = `https://example.com/${'a'.repeat(90)}`
    const { terminal, linksAt } = await terminalWithRows([url.slice(0, 80), url.slice(80)], 40)
    const openUrl = vi.fn()
    vi.stubGlobal('window', { api: { shell: { openUrl } } })
    registerHttpLinkStoreAccessor(() => ({
      repos: [],
      endpointProjects: [],
      endpointProjectHostSetups: [],
      settings: { openLinksInApp: false },
      setActiveWorktree: vi.fn(),
      createBrowserTab: vi.fn()
    }))
    try {
      expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true)
      expect(terminal.buffer.active.getLine(2)?.isWrapped).toBe(false)
      for (const y of [1, 2, 3]) {
        expect((await linksAt(y))?.[0]?.text).toBe(url)
        openUrl.mockClear()
        expect(
          openHttpLinkAtBufferPosition(terminal.buffer.active, { x: 3, y }, 40, {
            worktreeId: 'test',
            modifierHeld: true
          })
        ).toBe(true)
        expect(openUrl).toHaveBeenCalledExactlyOnceWith(url)
      }
    } finally {
      terminal.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('does not infer a right margin from unwritten cells after a complete URL', async () => {
    const url = 'https://example.com/docs/pages'
    const firstRow = `  Docs: ${url}`
    expect(firstRow.length).toBe(38)
    const { terminal, linksAt } = await terminalWithRows([firstRow, '  and more prose here'], 40)
    try {
      expect(await linksAt(1)).toBeUndefined()
      expect(await linksAt(2)).toBeUndefined()
    } finally {
      terminal.dispose()
    }
  })

  it.each([0, 1])(
    'reconstructs hanging list indentation with %i-column margins',
    async (padding) => {
      const url = `https://example.com/${'a'.repeat(40)}`
      const margin = ' '.repeat(padding)
      const prefix = `${margin}* See `
      const width = 40 - padding - prefix.length
      const { terminal, linksAt } = await terminalWithRows(
        [`${prefix}${url.slice(0, width)}${margin}`, `${margin}  ${url.slice(width)}${margin}`],
        40
      )
      try {
        for (const row of [1, 2]) {
          expect((await linksAt(row))?.[0]?.text).toBe(url)
        }
      } finally {
        terminal.dispose()
      }
    }
  )

  it('preserves a soft-wrapped sibling after a hard-wrapped URL tail', async () => {
    const first = `https://example.com/${'a'.repeat(50)}`
    const sibling = `https://other.test/${'b'.repeat(40)}`
    const { terminal } = await terminalWithRows(
      [first.slice(0, 40), `${first.slice(40)} ${sibling}`],
      40
    )
    const openUrl = vi.fn()
    vi.stubGlobal('window', { api: { shell: { openUrl } } })
    registerHttpLinkStoreAccessor(() => ({
      repos: [],
      endpointProjects: [],
      endpointProjectHostSetups: [],
      settings: { openLinksInApp: false },
      setActiveWorktree: vi.fn(),
      createBrowserTab: vi.fn()
    }))
    try {
      for (const position of [
        { x: 34, y: 2 },
        { x: 3, y: 3 },
        { x: 3, y: 4 }
      ]) {
        openUrl.mockClear()
        expect(
          openHttpLinkAtBufferPosition(terminal.buffer.active, position, 40, {
            worktreeId: 'test',
            modifierHeld: true
          })
        ).toBe(true)
        expect(openUrl).toHaveBeenCalledExactlyOnceWith(sibling)
      }
    } finally {
      terminal.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('keeps a sibling URL outside the continued link range', async () => {
    const first = `https://example.com/${'a'.repeat(26)}`
    const sibling = 'https://other.test/'
    const { terminal, linksAt } = await terminalWithRows(
      [` ${first.slice(0, 38)} `, ` ${first.slice(38)} ${sibling} `],
      40
    )
    try {
      const links = await linksAt(2)
      expect(links).toHaveLength(1)
      expect(links?.[0]).toMatchObject({
        text: first,
        range: { start: { x: 2, y: 2 }, end: { x: first.length - 38 + 1, y: 2 } }
      })
    } finally {
      terminal.dispose()
    }
  })

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

  it('keeps alternate-screen detection separate from the restored normal buffer', async () => {
    const url = `https://example.com/${'a'.repeat(30)}`
    const { terminal, linksAt } = await terminalWithRows(['ordinary output'], 40)
    try {
      await new Promise<void>((resolve) =>
        terminal.write(`\x1b[?1049h\x1b[H ${url.slice(0, 38)} \r\n ${url.slice(38)} `, resolve)
      )
      expect((await linksAt(2))?.[0]?.text).toBe(url)
      await new Promise<void>((resolve) => terminal.write('\x1b[?1049l', resolve))
      expect(await linksAt(1)).toBeUndefined()
      expect(await linksAt(2)).toBeUndefined()
    } finally {
      terminal.dispose()
    }
  })

  it('does not treat an explicit hyperlink in the margin as part of the URL', async () => {
    const url = `https://example.com/${'a'.repeat(30)}`
    const margin = '\x1b]8;;https://margin.test/\x07 \x1b]8;;\x07'
    const { terminal, linksAt } = await terminalWithRows(
      [` ${url.slice(0, 38)}${margin}`, ` ${url.slice(38)} `],
      40
    )
    try {
      expect((await linksAt(1))?.[0]?.text).toBe(url)
      expect((await linksAt(2))?.[0]?.text).toBe(url)
    } finally {
      terminal.dispose()
    }
  })

  it('preserves a full-width indented start followed by an unindented hard continuation', async () => {
    const url = `https://example.com/${'a'.repeat(40)}`
    const { terminal, linksAt } = await terminalWithRows(
      [`   ${url.slice(0, 37)}`, url.slice(37)],
      40
    )
    try {
      expect((await linksAt(2))?.[0]?.text).toBe(url)
    } finally {
      terminal.dispose()
    }
  })

  it.each(['a(b)c', "a'b", 'a!b', 'a*b', 'a%20b', '界文档'])(
    'leaves native soft wraps containing %s to the existing provider',
    async (suffix) => {
      const url = `https://example.com/${'a'.repeat(30)}/${suffix}`
      const { terminal, linksAt } = await terminalWithRows([url], 40)
      try {
        expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true)
        expect(await linksAt(1)).toBeUndefined()
        expect(await linksAt(2)).toBeUndefined()
      } finally {
        terminal.dispose()
      }
    }
  )

  it.each(['\x07', '\x1b\\'])(
    'does not reconstruct across an explicit hyperlink (%j)',
    async (end) => {
      const visible = `https://example.com/${'a'.repeat(18)}`
      const explicit = `\x1b]8;id=destination;https://target.example/hidden?query=1${end}${visible}\x1b]8;;${end}`
      const { terminal, linksAt } = await terminalWithRows([` ${explicit} `, ' plain-tail '], 40)
      try {
        expect(await linksAt(1)).toBeUndefined()
        expect(await linksAt(2)).toBeUndefined()
        expect(
          openHttpLinkAtBufferPosition(terminal.buffer.active, { x: 4, y: 1 }, 40, {
            worktreeId: 'test'
          })
        ).toBe(false)
        expect(
          openHttpLinkAtBufferPosition(terminal.buffer.active, { x: 4, y: 2 }, 40, {
            worktreeId: 'test'
          })
        ).toBe(false)
      } finally {
        terminal.dispose()
      }
    }
  )

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

  it.each([' next-token', ' Description: 123', ' https://other.example/path', '  misaligned'])(
    'leaves a short URL separate from the following padded row %s',
    async (nextRow) => {
      const { terminal, linksAt } = await terminalWithRows([' https://example.com/ ', nextRow], 40)
      try {
        expect(await linksAt(1)).toBeUndefined()
        expect(await linksAt(2)).toBeUndefined()
      } finally {
        terminal.dispose()
      }
    }
  )

  it.each([' Description: 123', ' HTTP/2: 200', ' https://other.example/path', '  misaligned', ''])(
    'does not append %s after a URL fills the padded row',
    async (nextRow) => {
      const url = `https://example.com/${'a'.repeat(18)}`
      const { terminal, linksAt } = await terminalWithRows([` ${url} `, nextRow], 40)
      try {
        expect(await linksAt(1)).toBeUndefined()
        expect(await linksAt(2)).toBeUndefined()
      } finally {
        terminal.dispose()
      }
    }
  )

  it('joins an inline URL across three padded rows without including the preceding text', async () => {
    const url = `https://example.com/${'a'.repeat(70)}`
    const { terminal, linksAt } = await terminalWithRows(
      [` Open: ${url.slice(0, 32)} `, ` ${url.slice(32, 70)} `, ` ${url.slice(70)} `],
      40
    )
    try {
      for (const row of [1, 2, 3]) {
        expect((await linksAt(row))?.[0]).toMatchObject({
          text: url,
          range: {
            start: { x: row === 1 ? 8 : 2, y: row },
            end: { x: row < 3 ? 39 : url.length - 70 + 1, y: row }
          }
        })
      }
    } finally {
      terminal.dispose()
    }
  })

  it('maps a padded wide-character continuation to its terminal cells', async () => {
    const firstRow = `https://example.com/${'a'.repeat(18)}`
    const continuation = '界文档/路径'
    const { terminal, linksAt } = await terminalWithRows([` ${firstRow} `, ` ${continuation} `], 40)
    try {
      const links = await linksAt(2)
      expect(links?.[0]).toMatchObject({
        text: new URL(firstRow + continuation).toString(),
        range: { start: { x: 2, y: 2 }, end: { x: 12, y: 2 } }
      })
    } finally {
      terminal.dispose()
    }
  })
})
