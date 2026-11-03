// @vitest-environment happy-dom

import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** SortedList keys mutate to -1 on marker disposal, so deferred deletion can miss live decorations (STA-2707). Real Terminal/SearchAddon cell lookups prove closing search removes every highlight. */

type LeakProbeDecoration = { marker: { line: number } }

type DecorationServiceInternals = {
  decorations: Iterable<LeakProbeDecoration>
  forEachDecorationAtCell: (
    x: number,
    line: number,
    layer: string | undefined,
    callback: (decoration: LeakProbeDecoration) => void
  ) => void
}

const SEARCH_DECORATIONS = {
  matchBackground: '#5c4a00',
  matchBorder: '#5c4a00',
  matchOverviewRuler: '#ffcc00',
  activeMatchBackground: '#c4580e',
  activeMatchBorder: '#ffcf6b',
  activeMatchColorOverviewRuler: '#ff9900'
} as const

const PROBE_ROWS = 30
const PROBE_COLS = 80

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

type SearchHarness = {
  terminal: Terminal
  search: SearchAddon
  highlightedCellCount: () => number
  closeSearch: () => void
}

function openTerminalWithSearch(): SearchHarness {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const search = new SearchAddon()
  terminal.loadAddon(search)

  const decorationService = (
    terminal as never as { _core: { _decorationService: DecorationServiceInternals } }
  )._core._decorationService

  return {
    terminal,
    search,
    highlightedCellCount: () => {
      let count = 0
      for (let line = 0; line < PROBE_ROWS; line++) {
        for (let x = 0; x < PROBE_COLS; x++) {
          decorationService.forEachDecorationAtCell(x, line, undefined, () => count++)
        }
      }
      return count
    },
    closeSearch: () => {
      search.clearDecorations()
      search.findNext('')
    }
  }
}

/** Vary marker layouts: the mutated sort-key leak depends on disposal order. */
const CONTENT_LAYOUTS: readonly (readonly [string, string])[] = [
  ['matches on two lines', 'needle one\r\nneedle two\r\n'],
  ['matches on three lines', 'needle one\r\nneedle two\r\nneedle three\r\n'],
  ['matches on four lines', 'needle a\r\nneedle b\r\nneedle c\r\nneedle d\r\n'],
  ['matches separated by gaps', 'needle a\r\nplain\r\nneedle b\r\nplain\r\nneedle c\r\n'],
  ['two matches on one line', 'needle needle\r\nplain\r\n']
]

describe('terminal search decoration cleanup (STA-2707)', () => {
  beforeEach(() => {
    // happy-dom has no canvas text metrics; xterm measures glyphs on open().
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it.each(CONTENT_LAYOUTS)(
    'leaves no highlighted cells after closing search (%s)',
    async (_name, content) => {
      // Navigation changes the active decoration and hence the stale-key deletion order.
      for (const navigations of [0, 1, 2, 3]) {
        const harness = openTerminalWithSearch()
        await write(harness.terminal, content)

        harness.search.findNext('needle', { decorations: SEARCH_DECORATIONS })
        await settle()
        for (let i = 0; i < navigations; i++) {
          harness.search.findNext('needle', { decorations: SEARCH_DECORATIONS })
          await settle(5)
        }
        await settle()
        expect(
          harness.highlightedCellCount(),
          `search should highlight matches while open (navigations=${navigations})`
        ).toBeGreaterThan(0)

        harness.closeSearch()
        await settle()

        expect(
          harness.highlightedCellCount(),
          `closing search must leave no highlighted cells (navigations=${navigations})`
        ).toBe(0)

        document.body.replaceChildren()
      }
    }
  )
})
