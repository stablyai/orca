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

async function writeAndFlush(terminal: Terminal, data: string): Promise<void> {
  terminal.write(data)
  await vi.advanceTimersByTimeAsync(1_000)
}

describe('terminal search refresh after output', () => {
  let terminal: Terminal
  let search: SearchAddon

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const context: CanvasRenderingContext2D = Object.create(null)
      context.measureText = () => Object.assign(Object.create(null), { width: 10 })
      return context
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    terminal = new Terminal()
    terminal.open(container)
    search = new SearchAddon()
    terminal.loadAddon(search)
    await writeAndFlush(terminal, 'needle one\r\nplain text\r\n')
    search.findNext('needle', { decorations: SEARCH_DECORATIONS })
  })

  afterEach(() => {
    terminal.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('keeps a selection the user made while search is open', async () => {
    expect(terminal.getSelection()).toBe('needle')

    terminal.select(0, 1, 5)
    await writeAndFlush(terminal, 'needle two\r\n')

    expect(terminal.getSelection()).toBe('plain')
  })

  it('counts matches that arrive while the user holds a selection', async () => {
    const resultCounts: number[] = []
    search.onDidChangeResults(({ resultCount }) => resultCounts.push(resultCount))
    terminal.select(0, 1, 5)

    await writeAndFlush(terminal, 'needle two\r\n')

    expect(resultCounts).toEqual([2])
    expect(terminal.getSelection()).toBe('plain')
  })

  it('leaves the selection empty after the user clears it', async () => {
    terminal.clearSelection()

    await writeAndFlush(terminal, 'needle two\r\n')

    expect(terminal.getSelection()).toBe('')
  })
})
