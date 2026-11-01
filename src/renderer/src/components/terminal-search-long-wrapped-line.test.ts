// @vitest-environment happy-dom

import type { ISearchOptions } from '@xterm/addon-search'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX
} from '../../../shared/terminal-scrollback-policy'
import { safeFind } from './terminal-search-safe-find'

/** Wrapped-line rewind once recursed per row, overflowing V8 and killing the terminal surface (crash 012eb5be; xtermjs/xterm.js#6149). Drive real Terminal/SearchAddon through safeFind, which must rethrow non-decoration failures. */

/** Reaches the ring behind the public buffer API to pin the negative-index state reflow leaves. */
type RingBufferProbe = {
  _core: { buffer: { lines: { _array: unknown[] } } }
}

const COLS = 80
const ROWS = 24
/** Long enough that the wrap chain outruns V8's stack on any host. */
const WRAPPED_ROWS = 12_000
/** A line longer than this scrollback loses its first rows: the bug is eviction, not size. */
const TRIMMED_HEAD_SCROLLBACK = 100
const TRIMMED_HEAD_LINE_ROWS = 200
const NEEDLE = 'needle'
/** Enough wrapped rows and matches expose quadratic per-match scans; stay below the addon’s 1,000-decoration cap for exact counts. */
const MATCH_ROW_STRIDE = 40
const MATCHES_IN_LINE = 750
/** Search runs on every keystroke on the renderer thread; this bound rejects visible freezes. */
const FULL_SCAN_BUDGET_MS = 5_000

// Use Orca’s decoration options to exercise highlight-all, the original crash entry point.
const SEARCH_DECORATIONS = {
  matchBackground: '#5c4a00',
  matchBorder: '#5c4a00',
  matchOverviewRuler: '#ffcc00',
  activeMatchBackground: '#c4580e',
  activeMatchBorder: '#ffcf6b',
  activeMatchColorOverviewRuler: '#ff9900'
} as const

/** Regex/whole-word searches must share wrapped-row skipping or removing recursion leaves a quadratic renderer freeze. */
const SEARCH_MODES = [
  ['plain', {}],
  ['regex', { regex: true }],
  ['whole word', { wholeWord: true }]
] as const satisfies readonly (readonly [string, ISearchOptions])[]

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function openTerminalWithSearch(scrollback: number = DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX): {
  terminal: Terminal
  search: SearchAddon
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback })
  terminal.open(container)
  const search = new SearchAddon()
  terminal.loadAddon(search)
  return { terminal, search }
}

describe('terminal search inside one very long wrapped line', () => {
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

  it.each(SEARCH_MODES)(
    'rewinds to the start of the line without overflowing the stack (%s)',
    async (_mode, options) => {
      const { terminal, search } = openTerminalWithSearch()
      // Put the match near the wrapped tail so highlight-all must rewind; spaces also exercise whole-word mode.
      await write(
        terminal,
        `${'x'.repeat(COLS * (WRAPPED_ROWS - 1) - NEEDLE.length - 1)} ${NEEDLE} ${'x'.repeat(COLS - 1)}`
      )

      const find = (): boolean =>
        safeFind((term, searchOptions) => search.findNext(term, searchOptions), NEEDLE, {
          ...options,
          decorations: SEARCH_DECORATIONS
        })

      let found: boolean | undefined
      expect(() => {
        found = find()
      }).not.toThrow()
      expect(found).toBe(true)

      // Second find resumes from the selection, deep inside the wrapped line.
      expect(() => {
        found = find()
      }).not.toThrow()
      expect(found).toBe(true)
    }
  )

  it.each(SEARCH_MODES)(
    'scans a long wrapped line once, not once per wrapped row (%s)',
    async (_mode, options) => {
      const { terminal, search } = openTerminalWithSearch()
      await write(terminal, 'x'.repeat(COLS * DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT))

      // No match, so the scan visits every row: the shape that froze the pane.
      const startedAt = performance.now()
      safeFind((term, searchOptions) => search.findNext(term, searchOptions), NEEDLE, {
        ...options,
        decorations: SEARCH_DECORATIONS
      })

      expect(performance.now() - startedAt).toBeLessThan(FULL_SCAN_BUDGET_MS)
    }
  )

  it.each(SEARCH_MODES)(
    'highlights many matches in one wrapped line without re-walking it per match (%s)',
    async (_mode, options) => {
      const { terminal, search } = openTerminalWithSearch()
      // Repeated matches resume deep in one line; per-match cell-to-string offset walks previously kept this path quadratic.
      const block = ` ${NEEDLE} ${'x'.repeat(COLS * MATCH_ROW_STRIDE - NEEDLE.length - 2)}`
      await write(terminal, block.repeat(MATCHES_IN_LINE))

      let resultCount = -1
      search.onDidChangeResults((event) => {
        resultCount = event.resultCount
      })
      const startedAt = performance.now()
      const found = safeFind(
        (term, searchOptions) => search.findNext(term, searchOptions),
        NEEDLE,
        {
          ...options,
          decorations: SEARCH_DECORATIONS
        }
      )

      expect(performance.now() - startedAt).toBeLessThan(FULL_SCAN_BUDGET_MS)
      expect(found).toBe(true)
      expect(resultCount).toBe(MATCHES_IN_LINE)
    }
  )

  it('reports every match inside a wrapped line', async () => {
    const { terminal, search } = openTerminalWithSearch()
    let resultCount = -1
    search.onDidChangeResults((event) => {
      resultCount = event.resultCount
    })
    const paddedNeedle = NEEDLE + 'x'.repeat(COLS - NEEDLE.length)
    await write(terminal, `${paddedNeedle.repeat(3)}\r\nplain ${NEEDLE}\r\n`)

    safeFind((term, options) => search.findNext(term, options), NEEDLE, {
      decorations: SEARCH_DECORATIONS
    })

    expect(resultCount).toBe(4)
  })

  it('keeps reaching matches in a wrapped line whose first row was trimmed away', async () => {
    const { terminal, search } = openTerminalWithSearch(TRIMMED_HEAD_SCROLLBACK)
    // Evict the logical line’s head so the surviving first row is still marked wrapped.
    const paddedNeedle = NEEDLE + 'x'.repeat(COLS - NEEDLE.length)
    const lead = 'x'.repeat(COLS * (TRIMMED_HEAD_LINE_ROWS - 3))
    await write(terminal, `${lead}${paddedNeedle.repeat(2)}${'x'.repeat(COLS)}\r\n`)
    for (let i = 0; i < 60; i++) {
      await write(terminal, `line ${i}\r\n`)
    }
    const buffer = terminal.buffer.active
    expect(buffer.getLine(0)?.isWrapped).toBe(true)

    const matchRows: number[] = []
    for (let y = 0; y < buffer.length; y++) {
      if (buffer.getLine(y)?.translateToString().includes(NEEDLE)) {
        matchRows.push(y)
      }
    }
    expect(matchRows.length).toBe(2)

    // Cycle both directions past a full turn; reverse search previously skipped every surviving row of a trimmed-head line.
    for (const direction of ['findNext', 'findPrevious'] as const) {
      const visits = new Map<number, number>()
      for (let i = 0; i < 12; i++) {
        safeFind((term, options) => search[direction](term, options), NEEDLE, {
          decorations: SEARCH_DECORATIONS
        })
        const row = terminal.getSelectionPosition()?.start.y
        if (row !== undefined) {
          visits.set(row, (visits.get(row) ?? 0) + 1)
        }
      }

      for (const row of matchRows) {
        expect(visits.get(row) ?? 0, direction).toBeGreaterThan(1)
      }
    }
  })

  it('searches a line that is longer than the whole scrollback', async () => {
    const { terminal, search } = openTerminalWithSearch(TRIMMED_HEAD_SCROLLBACK)
    // An all-continuation buffer wraps out-of-range ring reads to row zero; forward scans must stop at the buffer bound.
    const paddedNeedle = NEEDLE + 'x'.repeat(COLS - NEEDLE.length)
    await write(terminal, `${'x'.repeat(COLS * TRIMMED_HEAD_LINE_ROWS)}${paddedNeedle.repeat(3)}`)
    const buffer = terminal.buffer.active
    expect(buffer.getLine(0)?.isWrapped).toBe(true)
    expect(buffer.getLine(buffer.length - 1)?.isWrapped).toBe(true)

    const startedAt = performance.now()
    const found = safeFind((term, options) => search.findNext(term, options), NEEDLE, {
      decorations: SEARCH_DECORATIONS
    })

    expect(found).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(FULL_SCAN_BUDGET_MS)
  })

  it('stops rewinding at row 0 when a reflow trims a wrapped line head', async () => {
    const { terminal, search } = openTerminalWithSearch(TRIMMED_HEAD_SCROLLBACK)
    const paddedNeedle = NEEDLE + 'x'.repeat(COLS - NEEDLE.length)
    await write(terminal, `${'x'.repeat(COLS * TRIMMED_HEAD_LINE_ROWS)}${paddedNeedle.repeat(4)}`)
    for (let i = 0; i < 20; i++) {
      await write(terminal, `line ${i}\r\n`)
    }
    // Reflow leaves stale negative ring indices; rewind must stop at zero instead of walking backward forever.
    terminal.resize(15, 5)
    await write(terminal, '')
    expect(terminal.buffer.active.getLine(0)?.isWrapped).toBe(true)
    expect(
      Object.keys((terminal as unknown as RingBufferProbe)._core.buffer.lines._array)
    ).toContain('-1')

    const startedAt = performance.now()
    const found = safeFind((term, options) => search.findNext(term, options), NEEDLE, {
      decorations: SEARCH_DECORATIONS
    })

    expect(found).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(FULL_SCAN_BUDGET_MS)
  })

  it('keeps scanning a line past a hit whole word rejects', async () => {
    const { terminal, search } = openTerminalWithSearch()
    // Skip non-word substring hits and keep scanning for a real word; wrapped-row skipping relies on finding it.
    await write(terminal, `a${NEEDLE}a ${NEEDLE} done\r\n`)

    const found = safeFind((term, options) => search.findNext(term, options), NEEDLE, {
      wholeWord: true,
      decorations: SEARCH_DECORATIONS
    })

    expect(found).toBe(true)
    expect(terminal.getSelectionPosition()?.start).toEqual({ x: 9, y: 0 })
  })

  it('finds a whole-word match that only matches from a later wrapped row', async () => {
    const { terminal, search } = openTerminalWithSearch()
    const filler = 'x'.repeat(COLS - NEEDLE.length - 2)
    await write(terminal, `a${NEEDLE}a${filler} ${NEEDLE} ${filler}`)

    const found = safeFind((term, options) => search.findNext(term, options), NEEDLE, {
      wholeWord: true,
      decorations: SEARCH_DECORATIONS
    })

    expect(found).toBe(true)
  })

  it('steps past a zero-length regex match instead of abandoning the line', async () => {
    const { terminal, search } = openTerminalWithSearch()
    await write(terminal, `abc ${NEEDLE} def\r\n`)

    const found = safeFind((term, options) => search.findNext(term, options), `^|${NEEDLE}`, {
      regex: true,
      decorations: SEARCH_DECORATIONS
    })

    expect(found).toBe(true)
    expect(terminal.getSelectionPosition()?.start).toEqual({ x: 4, y: 0 })
  })

  it('anchors a regex to the logical line, not to every wrapped row', async () => {
    const { terminal, search } = openTerminalWithSearch()
    // A visual wrap is not a logical line start, so ^ must not match there.
    await write(terminal, 'x'.repeat(COLS) + NEEDLE + 'x'.repeat(COLS - NEEDLE.length))

    const found = safeFind((term, options) => search.findNext(term, options), `^${NEEDLE}`, {
      regex: true,
      decorations: SEARCH_DECORATIONS
    })

    expect(found).toBe(false)
  })
})
