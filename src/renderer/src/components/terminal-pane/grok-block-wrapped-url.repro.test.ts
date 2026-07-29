import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { openHttpLinkAtBufferPosition } from './terminal-url-link-hit-testing'

// Geometry measured from the reported grok pane: the markdown block wraps near
// column 100 while the terminal itself is 110 columns wide.
const COLS = 110
const ROWS = 30
const WRAP_WIDTH = 100

const GROK_OUTPUT = [
  'PRs:',
  'pull/10181#issuecomment-5068241002) · 10257 (https://github.com/stablyai/orca/',
  'pull/10257#issuecomment-5068240478) · 10349 (https://github.com/stablyai/orca/',
  'pull/10349#issuecomment-5068238223)',
  '',
  "These remaining ones match the thread's UI surface (sidebar layout, tab strip, SC panel,",
  'board tour mock, docs product refs) and are labeled as baselines/references.'
]

const EXPECTED_URL = 'https://github.com/stablyai/orca/pull/10349#issuecomment-5068238223'
const openUrlMock = vi.fn()

async function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve))
}

describe('grok block-wrapped URL repro', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInApp: false },
      setActiveWorktree: vi.fn(),
      createBrowserTab: vi.fn()
    }))
    openUrlMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the full URL grok wrapped at its own block width', async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
    // Grok pads each markdown row to its block width, so no row soft-wraps.
    await writeTerminal(terminal, GROK_OUTPUT.map((row) => row.padEnd(WRAP_WIDTH)).join('\r\n'))

    const buffer = terminal.buffer.active
    const urlRow = GROK_OUTPUT[2]
    const schemeColumn = urlRow.indexOf('https://') + 1
    expect(buffer.getLine(2)?.isWrapped).toBe(false)
    expect(buffer.getLine(3)?.isWrapped).toBe(false)

    // Hovering the URL row resolves the joined target...
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: schemeColumn + 10, y: 3 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith(EXPECTED_URL)

    // ...and so does the wrapped continuation row.
    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 6, y: 4 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith(EXPECTED_URL)

    // The sibling URL one row up keeps its own target.
    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: schemeColumn + 10, y: 2 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith(
      'https://github.com/stablyai/orca/pull/10257#issuecomment-5068240478'
    )

    terminal.dispose()
  })

  it('leaves genuinely terminated URLs alone in the same block', async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
    await writeTerminal(
      terminal,
      ['Docs at https://example.com/guide for details.', 'Next paragraph continues here.']
        .map((row) => row.padEnd(WRAP_WIDTH))
        .join('\r\n')
    )

    expect(
      openHttpLinkAtBufferPosition(terminal.buffer.active, { x: 12, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/guide')

    terminal.dispose()
  })
})
