import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { createWrappedTerminalHttpLinkProvider } from './wrapped-terminal-http-link-provider'
import { openHttpLinkAtBufferPosition } from './terminal-url-link-hit-testing'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'

const URL_TEXT = `https://example.com/docs/public-overlay?${'part%20value&'.repeat(7)}view=full#details`
const CONTENT_WIDTH = 42

function overlayRows(gutters: string[]) {
  return Array.from(
    { length: Math.ceil(URL_TEXT.length / CONTENT_WIDTH) },
    (_, index) =>
      `${gutters[index]}│ ${URL_TEXT.slice(index * CONTENT_WIDTH, (index + 1) * CONTENT_WIDTH).padEnd(CONTENT_WIDTH)} │`
  )
}

async function terminalWithRows(rows: string[]) {
  const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  await new Promise<void>((resolve) => terminal.write(rows.join('\r\n'), resolve))
  const provider = createWrappedTerminalHttpLinkProvider(terminal, { activate: vi.fn() })
  return {
    terminal,
    linksAt: (row: number) =>
      new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(row, resolve))
  }
}

describe('framed overlay terminal HTTP links', () => {
  it.each([
    { name: 'ASCII', gutters: ['      ', 'todo  ', '  in  ', 'Final '] },
    { name: 'wide', gutters: ['      ', '你你你', '  in  ', 'Final '] },
    { name: 'surrogate', gutters: ['      ', '😀😀😀', '  in  ', 'Final '] },
    { name: 'combining', gutters: ['      ', 'ééé   ', '  in  ', 'Final '] }
  ])('hovers and cold-opens the full URL over a changing $name gutter', async ({ gutters }) => {
    const { terminal, linksAt } = await terminalWithRows(overlayRows(gutters))
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
      const rowCount = Math.ceil(URL_TEXT.length / CONTENT_WIDTH)
      const deps = { worktreeId: 'test', modifierHeld: true }
      for (let y = 1; y <= rowCount; y++) {
        const endX = 8 + Math.min(CONTENT_WIDTH, URL_TEXT.length - (y - 1) * CONTENT_WIDTH)
        expect((await linksAt(y))?.[0], `row ${y}`).toMatchObject({
          text: URL_TEXT,
          range: { start: { x: 9, y }, end: { x: endX, y } }
        })
        for (const x of [1, 7, 8, endX + 1, 52]) {
          expect(openHttpLinkAtBufferPosition(terminal.buffer.active, { x, y }, 80, deps)).toBe(
            false
          )
        }
        expect(openHttpLinkAtBufferPosition(terminal.buffer.active, { x: 9, y }, 80, deps)).toBe(
          true
        )
      }
      expect(openUrl.mock.calls).toEqual(Array.from({ length: rowCount }, () => [URL_TEXT]))
    } finally {
      terminal.dispose()
      vi.unstubAllGlobals()
    }
  })

  it.each(['\x07', '\x1b\\'])(
    'preserves explicit OSC 8 targets terminated with %j',
    async (end) => {
      const target = 'https://example.org/explicit-destination'
      const rows = overlayRows(['      ', 'todo  ', '  in  ', 'Final ']).map(
        (row) =>
          `${row.slice(0, 8)}\x1b]8;;${target}${end}${row.slice(8, -2)}\x1b]8;;${end}${row.slice(-2)}`
      )
      const { terminal, linksAt } = await terminalWithRows(rows)
      try {
        for (let y = 1; y <= rows.length; y++) {
          expect(await linksAt(y)).toBeUndefined()
          expect(
            openHttpLinkAtBufferPosition(terminal.buffer.active, { x: 9, y }, 80, {
              worktreeId: 'test',
              modifierHeld: true
            })
          ).toBe(false)
        }
      } finally {
        terminal.dispose()
      }
    }
  )

  it('does not join URLs to subsequent cells of a table with changing labels', async () => {
    const rows = overlayRows(['│ One ', '│ Two ', '│ Red ', '│ End '])
    const { terminal, linksAt } = await terminalWithRows(rows)
    try {
      for (let y = 1; y <= rows.length; y++) {
        expect(await linksAt(y)).toBeUndefined()
      }
    } finally {
      terminal.dispose()
    }
  })
})
