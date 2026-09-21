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

/**
 * Regression for crash report 012eb5be (Orca 1.4.194, win32): searching a pane
 * that held one un-newlined line — base64, a minified bundle, a single huge log
 * record — threw `RangeError: Maximum call stack size exceeded` out of
 * TerminalSearch's effect and tripped the `terminal.workbench` error boundary.
 *
 * Mechanism, in @xterm/addon-search's SearchEngine (patched in
 * config/patches/@xterm__addon-search@*.patch, generated from the source patch
 * under config/patches/xterm-src/; submitted upstream as
 * https://github.com/xtermjs/xterm.js/pull/6149): `_findInLine` rewound to the first row of a
 * wrapped line by calling itself once per wrapped row, so recursion depth equals
 * the number of screen rows the logical line occupies. Scrollback reaches
 * DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX rows, which is far past V8's stack.
 *
 * The rewind is reached on every re-entry into the middle of a wrapped line —
 * `_highlightAllMatches` restarting at the row after a match, and `findNext`
 * resuming from the current selection — so this drives the real Terminal +
 * SearchAddon through Orca's own `safeFind`, which deliberately rethrows
 * anything that is not the decoration error.
 */

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
/**
 * Rows of one wrapped line per match, and how many matches that line holds. Enough matches to make
 * the highlight-all pass — which re-enters the line once per match — the dominant cost, and enough
 * rows that a per-match walk of the line is a freeze rather than a slow search. Kept under the
 * addon's 1 000-decoration limit so the match count is exact.
 */
const MATCH_ROW_STRIDE = 40
const MATCHES_IN_LINE = 750
/**
 * A full-buffer scan runs on the renderer's main thread on every keystroke in
 * the find bar, so anything near this is a visible freeze rather than a slow
 * search. Unfixed it is ~18s for a default-scrollback buffer; fixed, ~6ms.
 */
const FULL_SCAN_BUDGET_MS = 5_000

// Matches the decoration options TerminalSearch passes, so the highlight-all
// pass (the crash's entry point) actually runs.
const SEARCH_DECORATIONS = {
  matchBackground: '#5c4a00',
  matchBorder: '#5c4a00',
  matchOverviewRuler: '#ffcc00',
  activeMatchBackground: '#c4580e',
  activeMatchBorder: '#ffcf6b',
  activeMatchColorOverviewRuler: '#ff9900'
} as const

/**
 * Every mode the find bar can put the engine in. Regex and whole word used to be
 * excluded from the wrapped-row skip, which left them on the O(rows^2) walk after
 * the recursion that used to abort it was gone: a 12 000-row line took 5.4 minutes
 * of blocked main thread instead of throwing after 48 seconds.
 */
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
      // One line of WRAPPED_ROWS screen rows whose only match ends on the
      // second-to-last row, so the highlight pass resumes one row further on and
      // has to rewind the whole chain to reach the line start. Space-delimited so
      // the whole-word mode has something to find.
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
      // `_highlightAllMatches` calls `SearchEngine.find` once per match, and each call resumes
      // deep inside the line. Converting the resume column to a string offset walked every cell
      // before it, O(line) per match, so this shape stayed quadratic after the no-match scan was
      // bounded: ~11s for a line this long, a renderer freeze rather than a RangeError the
      // boundary recovered from. The per-match rewind and case fold are O(rows) and O(chars)
      // but measured at well under 1s combined, so they stay simple.
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
    // One logical line wrapping over three rows with a match in each, then a
    // separate unwrapped line.
    const paddedNeedle = NEEDLE + 'x'.repeat(COLS - NEEDLE.length)
    await write(terminal, `${paddedNeedle.repeat(3)}\r\nplain ${NEEDLE}\r\n`)

    safeFind((term, options) => search.findNext(term, options), NEEDLE, {
      decorations: SEARCH_DECORATIONS
    })

    expect(resultCount).toBe(4)
  })

  it('keeps reaching matches in a wrapped line whose first row was trimmed away', async () => {
    const { terminal, search } = openTerminalWithSearch(TRIMMED_HEAD_SCROLLBACK)
    // One long line whose head is evicted, so the surviving chain begins on a
    // row marked isWrapped and no line start is left in the buffer to cover it.
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

    // Cycle far enough to come back round in both directions: the surviving rows must stay
    // reachable, not be visited once and then stranded. Reverse search used to return for any
    // wrapped row including row 0, so a trimmed-head line was never searched backwards at all.
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
    // Every row of the buffer is then a continuation, and the ring answers an out-of-range row by
    // cycling back to row 0, so walking forward for the end of the line never terminates.
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
    // Narrowing a pane reflows the buffer, which leaves the ring holding entries at negative
    // indices, so `getLine(-1)` answers with a stale wrapped line instead of undefined. The rewind
    // has to stop at row 0 or it walks backwards forever and hangs the renderer.
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
    // Upstream stopped at the first `indexOf` hit, so `aneedlea` hid the real word
    // nine columns later and the find bar reported no match at all. Scanning on is
    // also what makes the wrapped-row skip sound for wholeWord.
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
    // The first hit on the line is `aneedlea`; the real word is on the second
    // wrapped row, which the skip removes from the walk.
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

    // `^` matches empty at offset 0, which upstream took as the line's only answer.
    const found = safeFind((term, options) => search.findNext(term, options), `^|${NEEDLE}`, {
      regex: true,
      decorations: SEARCH_DECORATIONS
    })

    expect(found).toBe(true)
    expect(terminal.getSelectionPosition()?.start).toEqual({ x: 4, y: 0 })
  })

  it('anchors a regex to the logical line, not to every wrapped row', async () => {
    const { terminal, search } = openTerminalWithSearch()
    // The needle starts the second row of one wrapped line. A wrap column is a
    // rendering artifact, so `^` must not match there.
    await write(terminal, 'x'.repeat(COLS) + NEEDLE + 'x'.repeat(COLS - NEEDLE.length))

    const found = safeFind((term, options) => search.findNext(term, options), `^${NEEDLE}`, {
      regex: true,
      decorations: SEARCH_DECORATIONS
    })

    expect(found).toBe(false)
  })
})
