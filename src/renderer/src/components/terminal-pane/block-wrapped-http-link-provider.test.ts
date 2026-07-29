import type { IBufferLine, ILink, Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { createBlockWrappedHttpLinkProvider } from './block-wrapped-http-link-provider'

const COLS = 110
const WRAP_WIDTH = 100
const openUrlMock = vi.fn()

// The reported grok output: a PR link wrapping after `orca/`.
const ROWS = [
  'pull/10257#issuecomment-5068240478) · 10349 (https://github.com/stablyai/orca/',
  'pull/10349#issuecomment-5068238223)',
  "These remaining ones match the thread's UI surface and are labeled as baselines now.".padEnd(
    WRAP_WIDTH
  )
]
const EXPECTED_URL = 'https://github.com/stablyai/orca/pull/10349#issuecomment-5068238223'

function makeBufferLine(content: string): IBufferLine {
  const text = content.padEnd(COLS)
  const columns = Array.from({ length: text.length + 1 }, (_value, index) => index)
  return {
    isWrapped: false,
    length: COLS,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      outColumns?.splice(0, outColumns.length, ...columns.slice(startColumn, endColumn + 1))
      return text.slice(startColumn, endColumn)
    }
  } as IBufferLine
}

function provideLinksAt(bufferLineNumber: number, linkTooltip: HTMLElement): ILink[] | undefined {
  const lines = ROWS.map((row) => makeBufferLine(row))
  const terminal = {
    buffer: { active: { getLine: (y: number) => lines[y] } },
    clearSelection: vi.fn()
  } as unknown as Terminal

  let provided: ILink[] | undefined
  createBlockWrappedHttpLinkProvider({
    getTerminal: () => terminal,
    worktreeId: 'wt-1',
    linkTooltip,
    openLinkHint: '⌘+click to open'
  }).provideLinks(bufferLineNumber, (links) => {
    provided = links
  })
  return provided
}

function makeTooltip(): HTMLElement {
  return { textContent: '', style: { display: 'none' } } as unknown as HTMLElement
}

describe('block-wrapped HTTP link provider', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInApp: false },
      setActiveWorktree: vi.fn(),
      createBrowserTab: vi.fn()
    }))
    openUrlMock.mockReset()
  })

  // Why: WebLinksAddon walks rows via xterm's `isWrapped` flag, which a TUI
  // that positions its own output never sets — so it reports no link at all on
  // the continuation row and hovering the tail showed no tooltip.
  it.each([
    ['scheme row', 1],
    ['continuation row', 2]
  ])('reports the whole wrapped URL when hovering the %s', (_label, bufferLineNumber) => {
    const links = provideLinksAt(bufferLineNumber, makeTooltip())

    expect(links).toHaveLength(1)
    expect(links?.[0].text).toBe(EXPECTED_URL)
  })

  it('spans a range covering both rows so either end hits the link', () => {
    const range = provideLinksAt(2, makeTooltip())?.[0].range

    expect(range?.start.y).toBe(1)
    expect(range?.end.y).toBe(2)
  })

  it('shows the full URL in the tooltip from the continuation row', () => {
    const linkTooltip = makeTooltip()
    provideLinksAt(2, linkTooltip)?.[0].hover?.({} as MouseEvent, EXPECTED_URL)

    expect(linkTooltip.textContent).toBe(`${EXPECTED_URL} (⌘+click to open)`)
    expect(linkTooltip.style.display).toBe('')
  })

  it('reports nothing on an unrelated row', () => {
    expect(provideLinksAt(3, makeTooltip())).toBeUndefined()
  })
})
