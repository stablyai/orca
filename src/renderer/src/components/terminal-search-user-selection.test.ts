// @vitest-environment happy-dom

import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SEARCH_DECORATIONS = {
  matchBackground: '#5c4a00',
  matchBorder: '#5c4a00',
  matchOverviewRuler: '#ffcc00',
  activeMatchBackground: '#c4580e',
  activeMatchBorder: '#ffcf6b',
  activeMatchColorOverviewRuler: '#ff9900'
} as const

const REFRESH_SETTLE_MS = 300

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

async function openTerminalWithSearch(
  query = 'needle'
): Promise<{ terminal: Terminal; search: SearchAddon }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const search = new SearchAddon()
  terminal.loadAddon(search)
  await write(terminal, 'needle one\r\nplain text\r\n')
  search.findNext(query, { decorations: SEARCH_DECORATIONS })
  return { terminal, search }
}

function dragSelectWithoutSelectionEvent(terminal: Terminal, start: number[], end: number[]): void {
  const selectionModel = Reflect.get(
    Reflect.get(Reflect.get(terminal, '_core'), '_selectionService'),
    '_model'
  )
  selectionModel.selectionStart = start
  selectionModel.selectionEnd = end
}

describe('terminal search refresh after output', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() =>
      Object.assign(Object.create(null), { measureText: () => ({ width: 10 }) })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('keeps a selection the user made while search is open', async () => {
    const { terminal } = await openTerminalWithSearch()
    expect(terminal.getSelection()).toBe('needle')

    terminal.select(0, 1, 5)
    await write(terminal, 'needle two\r\n')
    await settle(REFRESH_SETTLE_MS)

    expect(terminal.getSelection()).toBe('plain')
  })

  it('keeps a selection the user is still dragging while search has no match', async () => {
    const { terminal } = await openTerminalWithSearch('absent')
    expect(terminal.hasSelection()).toBe(false)

    dragSelectWithoutSelectionEvent(terminal, [0, 1], [5, 1])
    await write(terminal, 'absent now\r\n')
    await settle(REFRESH_SETTLE_MS)

    expect(terminal.getSelection()).toBe('plain')
  })

  it('still selects the active match when the user has not selected anything else', async () => {
    const { terminal } = await openTerminalWithSearch()

    await write(terminal, 'needle two\r\n')
    await settle(REFRESH_SETTLE_MS)

    expect(terminal.getSelection()).toBe('needle')
  })

  it('resumes refreshing matches once the user clears their selection', async () => {
    const { terminal, search } = await openTerminalWithSearch()
    const resultCounts: number[] = []
    search.onDidChangeResults(({ resultCount }) => resultCounts.push(resultCount))

    terminal.select(0, 1, 5)
    await write(terminal, 'needle two\r\n')
    await settle(REFRESH_SETTLE_MS)
    terminal.clearSelection()
    await write(terminal, 'needle three\r\n')
    await settle(REFRESH_SETTLE_MS)

    expect(resultCounts.at(-1)).toBe(3)
    expect(terminal.getSelection()).toBe('needle')
  })
})
