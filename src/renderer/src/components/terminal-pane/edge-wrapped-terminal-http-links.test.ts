import type { IBufferLine } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { openHttpLinkAtBufferPosition } from './terminal-url-link-hit-testing'

const COLS = 40
const WIDE_GLYPH = '界'
const openUrlMock = vi.fn()

function makeBufferLine(content: string, cols = COLS): IBufferLine {
  return makeBufferLineFromCells(
    Array.from(content, (text) => ({ text, width: text === WIDE_GLYPH ? 2 : 1 })),
    cols
  )
}

function makeBufferLineFromCells(
  cells: { text: string; width: number }[],
  cols = COLS
): IBufferLine {
  const columns: number[] = []
  let column = 0
  let text = ''
  for (const cell of cells) {
    text += cell.text
    for (let index = 0; index < cell.text.length; index++) {
      columns.push(column)
    }
    column += cell.width
  }
  while (column < cols) {
    text += ' '
    columns.push(column)
    column++
  }
  columns.push(column)

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

describe('edge-wrapped terminal HTTP links', () => {
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

  it('opens a URL when a wide glyph starts the continuation row', () => {
    const prefix = 'https://example.com/wide/'
    const firstRow = `${prefix}${'c'.repeat(COLS - 1 - prefix.length)}`
    const continuationRow = `${WIDE_GLYPH}tail`
    const expectedUrl = new URL(`${firstRow}${continuationRow}`).toString()
    const rows = [makeBufferLine(firstRow), makeBufferLine(continuationRow)]
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 11, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(expectedUrl)

    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 3, y: 2 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(expectedUrl)
  })

  it('opens a URL when a multi-code-point wide cell starts the continuation row', () => {
    const wideCell = '👩‍💻'
    const prefix = 'https://example.com/wide/'
    const firstRow = `${prefix}${'c'.repeat(COLS - 1 - prefix.length)}`
    const continuationRow = `${wideCell}tail`
    const expectedUrl = new URL(`${firstRow}${continuationRow}`).toString()
    const rows = [
      makeBufferLine(firstRow),
      makeBufferLineFromCells([
        { text: wideCell, width: 2 },
        ...Array.from('tail', (text) => ({ text, width: 1 }))
      ])
    ]
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 11, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(expectedUrl)

    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 1, y: 2 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(expectedUrl)
  })

  it('does not use the wide-glyph tolerance for an ASCII continuation row', () => {
    const firstRow = `https://example.com/${'a'.repeat(COLS - 1 - 'https://example.com/'.length)}`
    const rows = [makeBufferLine(firstRow), makeBufferLine('next')]
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 11, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(firstRow)

    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 2, y: 2 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(false)
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it.each(['Description: 123', 'Description:', '404: Not Found', 'HTTP/2: 200', 'HTTP/2:200'])(
    'does not append a %s label when a complete URL ends at the terminal edge',
    (labelRow) => {
      const firstRow = `https://example.com/${'a'.repeat(COLS - 1 - 'https://example.com/'.length)}/`
      const rows = [makeBufferLine(firstRow), makeBufferLine(labelRow)]
      const buffer = { getLine: (y: number) => rows[y] }

      expect(firstRow).toHaveLength(COLS)
      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 11, y: 1 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(true)
      expect(openUrlMock).toHaveBeenCalledOnce()
      expect(openUrlMock).toHaveBeenCalledWith(firstRow)

      openUrlMock.mockReset()
      expect(
        openHttpLinkAtBufferPosition(buffer, { x: 2, y: 2 }, COLS, {
          worktreeId: 'wt-1',
          forceSystemBrowser: true
        })
      ).toBe(false)
      expect(openUrlMock).not.toHaveBeenCalled()
    }
  )

  it('does not append an adjacent URL that starts on the next row', () => {
    const firstRow = `https://example.com/${'a'.repeat(COLS - 'https://example.com/'.length)}`
    const secondRow = 'https://two.test/path'
    const rows = [makeBufferLine(firstRow), makeBufferLine(secondRow)]
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 11, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(firstRow)

    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 11, y: 2 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(secondRow)
  })

  it('keeps a full-width continuation row that ends in a colon', () => {
    const prefix = 'https://example.com/'
    const firstRow = `${prefix}${'a'.repeat(COLS - prefix.length)}`
    const secondRow = `${'b'.repeat(COLS - 1)}:`
    const thirdRow = 'tail'
    const expectedUrl = new URL(`${firstRow}${secondRow}${thirdRow}`).toString()
    const rows = [makeBufferLine(firstRow), makeBufferLine(secondRow), makeBufferLine(thirdRow)]
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 11, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(expectedUrl)

    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 20, y: 2 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(expectedUrl)
  })

  it('keeps a short colon-bearing URL continuation', () => {
    const firstRow = `https://example.com/${'a'.repeat(COLS - 'https://example.com/'.length)}`
    const secondRow = 'urn:abc'
    const expectedUrl = `${firstRow}${secondRow}`
    const rows = [makeBufferLine(firstRow), makeBufferLine(secondRow)]
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 4, y: 2 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(expectedUrl)
  })

  it('does not count text before the URL against the URL length limit', () => {
    const cols = 200
    const prefix = `${'P'.repeat(179)} `
    const url = `https://example.com/${'a'.repeat(1_880)}`
    const displayed = `${prefix}${url}`
    const rowTexts = Array.from({ length: Math.ceil(displayed.length / cols) }, (_value, index) =>
      displayed.slice(index * cols, (index + 1) * cols)
    )
    const rows = rowTexts.map((row) => makeBufferLine(row, cols))
    const buffer = { getLine: (y: number) => rows[y] }

    expect(url).toHaveLength(1_900)
    expect(displayed.length).toBeGreaterThan(2_048)
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 191, y: 1 }, cols, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(url)

    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 10, y: rows.length }, cols, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(url)
  })

  it('reconstructs a narrow-terminal URL spanning more than 20 rows from either end', () => {
    const url = `https://example.com/${'a'.repeat(1_000)}`
    const rowTexts = Array.from({ length: Math.ceil(url.length / COLS) }, (_value, index) =>
      url.slice(index * COLS, (index + 1) * COLS)
    )
    const rows = rowTexts.map((row) => makeBufferLine(row))
    const buffer = { getLine: (y: number) => rows[y] }

    expect(url.length).toBeLessThanOrEqual(2_048)
    expect(rowTexts.length).toBeGreaterThan(20)
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 11, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(url)

    openUrlMock.mockReset()
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 5, y: rowTexts.length }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(url)
  })

  it('reconstructs a wide-glyph URL whose row span exceeds the single-width column bound', () => {
    const wideCount = 1_100
    const url = `https://example.com/${WIDE_GLYPH.repeat(wideCount)}`
    const rowTexts: string[] = []
    let row = ''
    let width = 0
    for (const char of url) {
      const charWidth = char === WIDE_GLYPH ? 2 : 1
      if (width + charWidth > COLS) {
        rowTexts.push(row)
        row = ''
        width = 0
      }
      row += char
      width += charWidth
    }
    if (row.length > 0) {
      rowTexts.push(row)
    }
    const rows = rowTexts.map((rowText) => makeBufferLine(rowText))
    const buffer = { getLine: (y: number) => rows[y] }

    expect(url.length).toBeLessThanOrEqual(2_048)
    expect(rowTexts.length).toBeGreaterThan(Math.ceil(2_048 / COLS) + 1)
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 5, y: rowTexts.length }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(new URL(url).toString())
  })

  it('joins a real multi-line URL whose continuation is a Chinese path segment', () => {
    const prefix = 'https://example.com/'
    const firstRow = `${prefix}${'a'.repeat(COLS - prefix.length)}`
    const continuation = `${WIDE_GLYPH}文档/路径`
    const expectedUrl = new URL(`${firstRow}${continuation}`).toString()
    const rows = [makeBufferLine(firstRow), makeBufferLine(continuation)]
    const buffer = { getLine: (y: number) => rows[y] }

    expect(firstRow).toHaveLength(COLS)
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 11, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(expectedUrl)
  })

  it('does not glue a mid-row URL to a next-line Windows path', () => {
    const firstRow = 'Repo: https://example.com/repo/'
    const secondRow = 'C:\\Users\\demo\\project\\file.ts'
    const rows = [makeBufferLine(firstRow), makeBufferLine(secondRow)]
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: firstRow.indexOf('https') + 8, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/repo/')
  })

  it('does not create an edge candidate for a scheme embedded in a word', () => {
    const embeddedUrl = `abchttps://example.com/${'a'.repeat(
      COLS - 'abchttps://example.com/'.length
    )}`
    const rows = [makeBufferLine(embeddedUrl), makeBufferLine('tail')]
    const buffer = { getLine: (y: number) => rows[y] }

    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 10, y: 1 }, COLS, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(false)
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('keeps a URL under the length limit when its final row also contains a label', () => {
    const cols = 200
    const url = `https://example.com/${'a'.repeat(2_020)}`
    const displayed = `${url} ${'L'.repeat(159)}`
    const rowTexts = Array.from({ length: Math.ceil(displayed.length / cols) }, (_value, index) =>
      displayed.slice(index * cols, (index + 1) * cols)
    )
    const rows = rowTexts.map((row) => makeBufferLine(row, cols))
    const buffer = { getLine: (y: number) => rows[y] }

    expect(url).toHaveLength(2_040)
    expect(rowTexts).toHaveLength(11)
    expect(rowTexts.at(-1)).toHaveLength(cols)
    expect(
      openHttpLinkAtBufferPosition(buffer, { x: 10, y: 1 }, cols, {
        worktreeId: 'wt-1',
        forceSystemBrowser: true
      })
    ).toBe(true)
    expect(openUrlMock).toHaveBeenCalledOnce()
    expect(openUrlMock).toHaveBeenCalledWith(url)
  })
})
