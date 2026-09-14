// @vitest-environment happy-dom

import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression for STA-2707: search highlights stayed painted after the find bar
 * closed, until the window was minimized and restored.
 *
 * Mechanism, in @xterm/xterm's SortedList (patched in
 * config/patches/@xterm__xterm@*.patch, generated from the source patch under
 * config/patches/xterm-src/):
 *
 *   - DecorationService keys its SortedList on `decoration.marker.line`.
 *   - `delete()` only records an index and defers the array compaction, while
 *     `Marker.dispose()` sets `line = -1` — mutating that very sort key.
 *   - So after the first disposal the array is no longer sorted, and the binary
 *     search inside `delete()` can miss a decoration that IS present. `delete()`
 *     returns false, `onDecorationRemoved` never fires, and the decoration keeps
 *     reporting itself at its cells forever.
 *
 * `clearDecorations()` disposes the active (top-layer) match first and the
 * match highlights after, which is exactly the order that trips this — so
 * closing search left one match highlighted. Repaints don't help: the leaked
 * decoration is still live, so every repaint faithfully re-paints it.
 *
 * These tests drive the REAL Terminal + SearchAddon and assert through
 * `forEachDecorationAtCell` — the same lookup both renderers use to decide a
 * cell's background — so a regression fails here regardless of renderer.
 */

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
  /** Cells whose background a renderer would still paint from a decoration. */
  highlightedCellCount: () => number
  /** Closes the find bar exactly the way TerminalSearch does. */
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

/**
 * Content shapes that produce different match/marker layouts. The leak only
 * showed up for some of them, so the regression has to sweep rather than pin
 * one lucky case.
 */
const CONTENT_SHAPES: readonly (readonly [string, string])[] = [
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

  it.each(CONTENT_SHAPES)(
    'leaves no highlighted cells after closing search (%s)',
    async (_name, content) => {
      // Sweeping the match-navigation count matters: which decoration is the
      // active one decides whether the stale sort key hides a later delete.
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

  it('leaves no highlighted cells after typing a query character by character', async () => {
    const harness = openTerminalWithSearch()
    await write(harness.terminal, 'needle one\r\nneedle two\r\nneedle three\r\n')

    // The find bar re-searches on every keystroke, so each character disposes
    // the previous run's decorations — the same path that leaked.
    for (const query of ['n', 'ne', 'nee', 'need', 'needl', 'needle']) {
      harness.search.findNext(query, { decorations: SEARCH_DECORATIONS, incremental: true })
      await settle(10)
    }
    await settle()

    harness.closeSearch()
    await settle()

    expect(harness.highlightedCellCount()).toBe(0)
  })

  it('does not accumulate highlights across repeated open/close cycles', async () => {
    const harness = openTerminalWithSearch()
    await write(harness.terminal, 'needle one\r\nneedle two\r\nneedle three\r\n')

    for (let cycle = 0; cycle < 5; cycle++) {
      harness.search.findNext('needle', { decorations: SEARCH_DECORATIONS })
      await settle(10)
      harness.closeSearch()
      await settle(10)
    }

    expect(harness.highlightedCellCount()).toBe(0)
  })

  it('keeps highlights painted while search is still open', async () => {
    const harness = openTerminalWithSearch()
    await write(harness.terminal, 'needle one\r\nneedle two\r\n')

    harness.search.findNext('needle', { decorations: SEARCH_DECORATIONS })
    await settle()

    expect(harness.highlightedCellCount()).toBeGreaterThan(0)
  })
})
