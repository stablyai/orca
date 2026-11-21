import { describe, expect, it } from 'vitest'
import {
  buildHardWrappedPathLogicalLineCandidates,
  rangeForParsedFileLink
} from './wrapped-terminal-link-ranges'
import { findTerminalFileLinksAtBufferPosition } from './terminal-link-buffer-hit-testing'

type TestBufferLine = {
  isWrapped: boolean
  length: number
  getCell: (_index: number) => undefined
  translateToString: (
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
    outColumns?: number[]
  ) => string
}

function makeBufferLine(
  text: string,
  options: { isWrapped?: boolean; columns?: number[] } = {}
): TestBufferLine {
  const columns =
    options.columns ?? Array.from({ length: text.length + 1 }, (_value, index) => index)
  return {
    isWrapped: options.isWrapped ?? false,
    length: text.length,
    getCell: () => undefined,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      if (outColumns) {
        outColumns.length = 0
        for (let index = startColumn; index <= endColumn; index++) {
          outColumns.push(columns[index] ?? index)
        }
      }
      return text.slice(startColumn, endColumn)
    }
  }
}

describe('buildHardWrappedPathLogicalLineCandidates', () => {
  const firstPath = 'validation-screenshots/01-before-white-terminal-scrollbar-gutter.png'
  const middleStart = 'validation-screenshots/02-after-'
  const middleEnd = 'transparent-terminal-scrollbar-gutter.png'
  const thirdPath = 'validation-screenshots/03-after-light-theme.png'

  function makeThreeLinkRows(): TestBufferLine[] {
    return [
      makeBufferLine(`${firstPath} · ${middleStart}`),
      makeBufferLine(`${middleEnd} · ${thirdPath}`)
    ]
  }

  it('reconstructs one boundary path without merging its sibling links', () => {
    const rows = makeThreeLinkRows()
    const buffer = { getLine: (y: number) => rows[y] }
    const firstRowCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, 1)
    const secondRowCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, 2)
    const expectedText = middleStart + middleEnd
    const firstBoundary = firstRowCandidates.filter((candidate) => candidate.text === expectedText)
    const secondBoundary = secondRowCandidates.filter(
      (candidate) => candidate.text === expectedText
    )

    expect(firstBoundary).toHaveLength(1)
    expect(secondBoundary).toHaveLength(1)
    expect(firstRowCandidates.filter((candidate) => candidate.rows.length > 1)).toHaveLength(1)
    expect(secondBoundary[0].fingerprint).toBe(firstBoundary[0].fingerprint)
    expect(firstBoundary[0].rows.map((row) => row.text)).toEqual([middleStart, middleEnd])
    expect(firstBoundary[0].text).not.toContain(' · ')
    expect(rangeForParsedFileLink(firstBoundary[0], 0, expectedText.length)).toEqual({
      start: { x: firstPath.length + ' · '.length + 1, y: 1 },
      end: { x: middleEnd.length, y: 2 }
    })
  })

  it.each([
    {
      name: 'POSIX root',
      firstFragment: '/',
      secondFragment: 'home/alice/file.ts',
      expectedPath: '/home/alice/file.ts'
    },
    {
      name: 'Windows drive',
      firstFragment: 'C:',
      secondFragment: '\\Users\\Alice\\repo\\file.ts',
      expectedPath: 'C:\\Users\\Alice\\repo\\file.ts'
    },
    {
      name: 'UNC root',
      firstFragment: '\\',
      secondFragment: '\\server\\share\\file.ts',
      expectedPath: '\\\\server\\share\\file.ts'
    },
    {
      name: 'current-directory prefix',
      firstFragment: './',
      secondFragment: 'src/file.ts',
      expectedPath: './src/file.ts'
    },
    {
      name: 'parent-directory prefix',
      firstFragment: '../',
      secondFragment: 'src/file.ts',
      expectedPath: '../src/file.ts'
    },
    {
      name: 'home-directory prefix',
      firstFragment: '~/',
      secondFragment: 'src/file.ts',
      expectedPath: '~/src/file.ts'
    }
  ])(
    'reconstructs a boundary path split after its $name',
    ({ firstFragment, secondFragment, expectedPath }) => {
      const firstRow = `first.ts · ${firstFragment}`
      const rows = [makeBufferLine(firstRow), makeBufferLine(`${secondFragment} · third.ts`)]
      const buffer = { getLine: (y: number) => rows[y] }

      const firstRowCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, 1)
      const secondRowCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, 2)
      const firstBoundary = firstRowCandidates.filter(
        (candidate) => candidate.text === expectedPath
      )
      const secondBoundary = secondRowCandidates.filter(
        (candidate) => candidate.text === expectedPath
      )

      expect(firstBoundary).toHaveLength(1)
      expect(secondBoundary).toHaveLength(1)
      expect(secondBoundary[0].fingerprint).toBe(firstBoundary[0].fingerprint)
      expect(firstBoundary[0].rows.map((row) => row.text)).toEqual([firstFragment, secondFragment])
      expect(rangeForParsedFileLink(firstBoundary[0], 0, expectedPath.length)).toEqual({
        start: { x: firstRow.indexOf(firstFragment) + 1, y: 1 },
        end: { x: secondFragment.length, y: 2 }
      })
    }
  )

  it('rejects an incomplete drive prefix whose joined text is not a path start', () => {
    const rows = [makeBufferLine('first.ts · C:'), makeBufferLine('readme · third.ts')]

    const candidates = buildHardWrappedPathLogicalLineCandidates(
      { getLine: (y: number) => rows[y] },
      1
    )

    expect(candidates.some((candidate) => candidate.text === 'C:readme')).toBe(false)
    expect(candidates.filter((candidate) => candidate.rows.length > 1)).toEqual([])
  })

  it.each([
    {
      name: 'POSIX root',
      firstFragment: '/',
      secondFragment: 'home/alice/file.ts',
      expectedPath: '/home/alice/file.ts'
    },
    {
      name: 'Windows drive',
      firstFragment: 'C:',
      secondFragment: '\\Users\\Alice\\repo\\file.ts',
      expectedPath: 'C:\\Users\\Alice\\repo\\file.ts'
    },
    {
      name: 'UNC root',
      firstFragment: '\\',
      secondFragment: '\\server\\share\\file.ts',
      expectedPath: '\\\\server\\share\\file.ts'
    }
  ])(
    'reconstructs a boundary path after its $name at end of output',
    ({ firstFragment, secondFragment, expectedPath }) => {
      const rows = [makeBufferLine(`first.ts · ${firstFragment}`), makeBufferLine(secondFragment)]
      const buffer = { getLine: (y: number) => rows[y] }

      const firstRowCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, 1)
      const secondRowCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, 2)

      expect(
        firstRowCandidates.filter((candidate) => candidate.text === expectedPath)
      ).toHaveLength(1)
      expect(
        secondRowCandidates.filter((candidate) => candidate.text === expectedPath)
      ).toHaveLength(1)
    }
  )

  it('does not duplicate an end-of-output candidate emitted by whole-row reconstruction', () => {
    const rows = [makeBufferLine('/'), makeBufferLine('home/alice/file.ts')]

    const candidates = buildHardWrappedPathLogicalLineCandidates(
      { getLine: (y: number) => rows[y] },
      2
    )

    expect(candidates.filter((candidate) => candidate.text === '/home/alice/file.ts')).toHaveLength(
      1
    )
  })

  it('preserves Windows drive paths and original continuation columns', () => {
    const firstRow = 'result: C:\\Users\\Alice\\Project\\src\\very-'
    const firstFragment = 'C:\\Users\\Alice\\Project\\src\\very-'
    const secondFragment = 'long\\file.ts'
    const secondRow = `${secondFragment} · C:\\other.ts`
    const secondColumns = Array.from({ length: secondRow.length + 1 }, (_value, index) => index * 2)
    const rows = [makeBufferLine(firstRow), makeBufferLine(secondRow, { columns: secondColumns })]
    const candidates = buildHardWrappedPathLogicalLineCandidates(
      { getLine: (y: number) => rows[y] },
      2
    )
    const candidate = candidates.find((item) => item.text === `${firstFragment}${secondFragment}`)

    expect(candidate).toBeDefined()
    expect(rangeForParsedFileLink(candidate!, 0, candidate!.text.length)).toEqual({
      start: { x: firstRow.indexOf('C:') + 1, y: 1 },
      end: { x: secondFragment.length * 2, y: 2 }
    })
  })
})

describe('file links wrapped inside a table cell', () => {
  it('joins a path broken across rows of one cell without merging other cells or rows', () => {
    const cellWidth = 'docs/reports/generated-weekly-summary-of-open'.length
    const row = (file: string, about: string): string =>
      `│ ${file.padEnd(cellWidth)} │ ${about.padEnd(30)} │`
    const separator = `├${'─'.repeat(cellWidth + 2)}┼${'─'.repeat(32)}┤`
    const rows = [
      row('docs/reports/generated-weekly-summary-of-open', 'Items still open after review'),
      row('-items.md (draft)', 'and their current owners'),
      separator,
      row('see docs/one.md', 'x'),
      row('and docs/two.md', 'y')
    ].map((text) => makeBufferLine(text))
    const buffer = { getLine: (y: number) => rows[y] }
    const pathsAt = (x: number, y: number): string[] => {
      const { links, guesses } = findTerminalFileLinksAtBufferPosition(buffer, { x, y }, 90)
      return [...links, ...guesses].map((link) => link.pathText)
    }
    const fullPath = 'docs/reports/generated-weekly-summary-of-open-items.md'

    expect(pathsAt(10, 1)).toContain(fullPath)
    expect(pathsAt(6, 2)).toContain(fullPath)
    // Only the path's own cells take the click, not the next cell on the same row.
    expect(pathsAt(60, 1)).not.toContain(fullPath)
    // A row wrapped at a space keeps that space, so sibling paths stay apart.
    expect(pathsAt(8, 4)).toContain('docs/one.md')
    expect([...pathsAt(10, 1), ...pathsAt(8, 4)].join('\n')).not.toMatch(/│|anddocs|md-/)
  })
})
