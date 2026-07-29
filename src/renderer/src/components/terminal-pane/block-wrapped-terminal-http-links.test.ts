import type { IBufferLine } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { openHttpLinkAtBufferPosition } from './terminal-url-link-hit-testing'

// Why: grok renders markdown at its own wrap width, well inside the terminal's
// right edge, so a wrapped URL row never reaches the last column.
const COLS = 110
const WRAP_WIDTH = 100

const openUrlMock = vi.fn()

function makeBufferLine(content: string, cols = COLS): IBufferLine {
  const text = content.padEnd(cols)
  const columns = Array.from({ length: text.length + 1 }, (_value, index) => index)
  return {
    isWrapped: false,
    length: cols,
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

// Mirrors the reported grok output: a PR list whose URLs wrap after `orca/`,
// plus prose rows that reveal the block's real wrap width.
const GROK_ROWS = [
  'issues/10033#issuecomment-5068237143)',
  '',
  'PRs:',
  'pull/10181#issuecomment-5068241002) · 10257 (https://github.com/stablyai/orca/',
  'pull/10257#issuecomment-5068240478) · 10349 (https://github.com/stablyai/orca/',
  'pull/10349#issuecomment-5068238223)',
  '',
  "These remaining ones match the thread's UI surface (sidebar layout, tab strip, SC panel, board".padEnd(
    WRAP_WIDTH
  ),
  'mock, docs product refs) and are labeled as baselines/references — not bug repros.'
]

const EXPECTED_URL = 'https://github.com/stablyai/orca/pull/10349#issuecomment-5068238223'

describe('block-wrapped terminal HTTP links', () => {
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

  function grokBuffer(): { getLine: (y: number) => IBufferLine | undefined } {
    const rows = GROK_ROWS.map((row) => makeBufferLine(row))
    return { getLine: (y: number) => rows[y] }
  }

  it('opens the whole URL when grok wraps it inside the terminal width', () => {
    const buffer = grokBuffer()
    const urlStartColumn = GROK_ROWS[4].indexOf('https://') + 1

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: urlStartColumn + 10, y: 5 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(EXPECTED_URL)
  })

  it('opens the whole URL from the wrapped continuation row', () => {
    const buffer = grokBuffer()

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 5, y: 6 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(EXPECTED_URL)
  })

  it('keeps the sibling URL on the row above intact', () => {
    const buffer = grokBuffer()
    const urlStartColumn = GROK_ROWS[3].indexOf('https://') + 1

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: urlStartColumn + 10, y: 4 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(
      'https://github.com/stablyai/orca/pull/10257#issuecomment-5068240478'
    )
  })

  // Shapes surfaced by adversarial review. Each glued unrelated text onto a
  // URL before the guard named beside it existed.
  describe('adversarial review regressions', () => {
    const fullUrl = `https://example.com/${'a'.repeat(WRAP_WIDTH - 21)}/`

    it.each([
      ['unspaced label row', 'Description:123'],
      ['POSIX path row', '/usr/local/bin/orca'],
      ['bare prose word', 'DescriptionWithoutColon continues here'],
      ['timestamped log row', '12:34:56 request complete'],
      ['git ref range', 'origin/main..HEAD is ahead'],
      ['date row', '2026/07/24 build finished'],
      ['markdown heading', '### Heading text goes here'],
      ['fraction prose', '1/2 of the tests passed ok'],
      ['CI date log', '2026/07/24 deploy finished without errors'],
      ['repo path sentence', 'src/main/index.ts was rebuilt after the change'],
      ['and/or prose', 'and/or the retry can be triggered manually later'],
      ['version note', 'v2.0/changelog notes were published separately'],
      // A fragment attaches to a resource, so a wrap never leaves `/` ending one
      // row and `#` opening the next — that row is a Markdown anchor.
      ['bare markdown anchor', '#next-steps'],
      ['bare hashtag', '#deploy']
    ])('does not glue a following %s', (_shape, nextRow) => {
      const rows = [fullUrl, nextRow, 'x'.repeat(WRAP_WIDTH)].map((row) => makeBufferLine(row))
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 15, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(fullUrl)
    })

    // A tail need not carry URL punctuation: requiring it truncated legal URLs.
    // Prose is excluded by the whole-row rule instead.
    it.each([
      [
        'bare commit SHA',
        'https://git.example.com/org/very-long-repository-name/branch/-/commit/',
        'e83bc27b12f04ad9e5f1'
      ],
      ['bare final path segment', `https://example.com/${'a'.repeat(WRAP_WIDTH - 25)}/`, 'archive']
    ])('reconstructs a wrapped URL ending in a %s', (_shape, prefix, tail) => {
      const urlRow = `${prefix}${'p'.repeat(WRAP_WIDTH - 3 - prefix.length)}/`
      const rows = [urlRow, tail, 'w'.repeat(WRAP_WIDTH)].map((row) => makeBufferLine(row))
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 20, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(`${urlRow}${tail}`)
    })

    it('infers the block width from the nearest wider row, not the widest', () => {
      // A single full-terminal-width line must not inflate the block width and
      // make a genuine wrap look like it had room to spare.
      const urlRow = `https://example.com/${'a'.repeat(69)}/`
      const rows = [urlRow, 'abcdefghijk/p', 'x'.repeat(WRAP_WIDTH), 'z'.repeat(COLS)].map((row) =>
        makeBufferLine(row)
      )
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 10, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(`${urlRow}abcdefghijk/p`)
    })

    it('does not join when the URL row ends far short of the block width', () => {
      // Nothing suggests a wrap: the URL ended with most of the row unused.
      const shortUrl = 'https://github.com/stablyai/orca/'
      const rows = [shortUrl, `src/${'deep/'.repeat(12)}index.ts`, 'x'.repeat(WRAP_WIDTH)].map(
        (row) => makeBufferLine(row)
      )
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 15, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(shortUrl)
    })

    it('wraps the last URL on a row that already holds a complete one', () => {
      const first = `Earlier https://one.test/path then ${'x'.repeat(30)} https://two.test/`
      const continuation = 'pull/10349#issuecomment-5068238223'
      const rows = [first, continuation, 'x'.repeat(WRAP_WIDTH)].map((row) => makeBufferLine(row))
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(buffer, { x: first.indexOf('https://two') + 5, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(`https://two.test/${continuation}`)
    })

    it('leaves the URL truncated when no row proves the block runs wider', () => {
      // Documented limitation: the URL row is itself the widest at its margin,
      // so nothing shows there was room to spare and the break stays ambiguous.
      // Accepting equal-width rows as evidence reopens #8832 for prose tails,
      // so this degrades to the pre-fix behaviour rather than guessing.
      const urlRow =
        '10181 (https://github.com/stablyai/orca/pull/10181) · 10349 (https://github.com/stablyai/orca/'
      const rows = [urlRow, 'pull/10349#issuecomment-5068238223)'].map((row) => makeBufferLine(row))
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(
          buffer,
          { x: urlRow.lastIndexOf('https://') + 10, y: 1 },
          COLS,
          { worktreeId: 'wt-1', forceSystemBrowser: true }
        )
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith('https://github.com/stablyai/orca/')
    })
  })

  // Regression guards for #8832 / PR #9100: that fix keyed on the URL row
  // stopping short of the *terminal* edge, which no longer discriminates once
  // block-width wrapping is reconstructed. These re-test its cases at a width
  // where the block wrap column is detectable.
  describe('#8832 shapes at block width', () => {
    it('does not glue a following label row onto a full-width URL row', () => {
      const rows = [
        `https://example.com/${'a'.repeat(WRAP_WIDTH - 21)}/`,
        'Description: 123',
        'x'.repeat(WRAP_WIDTH)
      ].map((row) => makeBufferLine(row))
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 15, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(
        `https://example.com/${'a'.repeat(WRAP_WIDTH - 21)}/`
      )
    })

    it('keeps the original #8832 rows unglued when a wide sibling row exists', () => {
      const rows = [
        'Repo: https://github.com/stablyai/orca/',
        'Description: 123',
        'x'.repeat(WRAP_WIDTH)
      ].map((row) => makeBufferLine(row))
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 15, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith('https://github.com/stablyai/orca/')
    })

    it.each([
      ['Chinese label', '说明: 中文路径/文件.ts'],
      ['Windows path', 'C:\\Users\\demo\\project\\README.md'],
      ['POSIX path', '/usr/local/bin/orca'],
      ['relative path', './src/main/index.ts']
    ])('does not glue a full-width URL row to a next-line %s', (_label, nextLine) => {
      const url = `https://example.com/${'a'.repeat(WRAP_WIDTH - 21)}/`
      const rows = [url, nextLine, 'x'.repeat(WRAP_WIDTH)].map((row) => makeBufferLine(row))
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 15, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(url)
    })

    it('does not join a row that ends mid-token rather than at a URL break', () => {
      // No `/`, `?`, `&`… at the break, so the wrapper never split here.
      const url = `https://example.com/${'a'.repeat(WRAP_WIDTH - 20)}`
      const rows = [url, 'continuedpathsegment', 'x'.repeat(WRAP_WIDTH)].map((row) =>
        makeBufferLine(row)
      )
      const buffer = { getLine: (y: number) => rows[y] }

      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 15, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(url)
    })
  })

  it('does not swallow the next row when the URL ends mid-row', () => {
    const rows = [
      'See https://example.com/short and then some more prose that continues well past it',
      'nextword continues the paragraph here'
    ].map((row) => makeBufferLine(row))
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 10, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/short')
  })

  it('does not join a following row whose first word would have fit', () => {
    // `tail` fits in the space left after the URL, so the break was authored.
    const rows = [
      `${'x'.repeat(20)} https://example.com/path`.padEnd(WRAP_WIDTH - 20),
      'tail and more words that make this row look like flowing prose'
    ].map((row) => makeBufferLine(row))
    rows.push(makeBufferLine('a'.repeat(WRAP_WIDTH)))
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 30, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/path')
  })

  it('does not join a following row at a different indent', () => {
    const url = 'https://example.com/very/long/path/that/reaches/the/block/wrap/column/exactly/x'
    const rows = [
      url.padEnd(WRAP_WIDTH),
      '    indented-continuation-token',
      'a'.repeat(WRAP_WIDTH)
    ].map((row) => makeBufferLine(row))
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 10, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith(url)
  })

  it('does not glue a wrapped URL to a following Windows path', () => {
    const rows = [
      'Repo: https://example.com/repo/'.padEnd(WRAP_WIDTH - 2),
      'C:\\Users\\demo\\project\\file.ts',
      'a'.repeat(WRAP_WIDTH)
    ].map((row) => makeBufferLine(row))
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 12, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/repo/')
  })

  it('does not join a following row that starts its own URL', () => {
    const first = `https://example.com/${'a'.repeat(WRAP_WIDTH - 25)}`
    const second = 'https://two.test/path'
    const rows = [first, second, 'a'.repeat(WRAP_WIDTH)].map((row) => makeBufferLine(row))
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 10, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith(first)

    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 10, y: 2 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledWith(second)
  })

  it('joins a URL wrapped across three block rows', () => {
    // Rows break after `/`, the way a URL-aware wrapper splits a long URL.
    const first = `https://example.com/${'a'.repeat(WRAP_WIDTH - 26)}/`
    const second = `${'b'.repeat(WRAP_WIDTH - 7)}/`
    const third = 'tail/end'
    const rows = [first, second, third, 'w'.repeat(WRAP_WIDTH)].map((row) => makeBufferLine(row))
    const buffer = { getLine: (y: number) => rows[y] }

    // Clicking any of the three rows must resolve the same joined URL.
    for (const [y, x] of [
      [1, 10],
      [2, 10],
      [3, 3]
    ]) {
      openUrlMock.mockReset()
      expect(
        openHttpLinkAtBufferPosition(buffer, { x, y }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledWith(`${first}${second}${third}`)
    }
  })
})
