import { describe, expect, it } from 'vitest'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine,
  rangeForParsedFileLink
} from './wrapped-terminal-link-ranges'
import {
  extractTerminalFileLinkCandidates,
  resolveTerminalFileLink
} from '../../lib/terminal-links'

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

function makeCjkCellColumns(text: string): number[] {
  const columns = [0]
  let terminalColumn = 0
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) {
      break
    }
    const codeUnitLength = codePoint > 0xffff ? 2 : 1
    if (codeUnitLength === 2) {
      columns.push(terminalColumn)
    }
    terminalColumn += codePoint > 0xff ? 2 : 1
    columns.push(terminalColumn)
    index += codeUnitLength
  }
  return columns
}

describe('buildWrappedLogicalLine', () => {
  it('joins ordinary soft-wrapped terminal rows', () => {
    const rows = [makeBufferLine('src/'), makeBufferLine('file.ts', { isWrapped: true })]

    const logicalLine = buildWrappedLogicalLine({ getLine: (y) => rows[y] }, 2)

    expect(logicalLine?.text).toBe('src/file.ts')
    expect(logicalLine?.rows.map((row) => row.y)).toEqual([0, 1])
  })

  it('caps pathological soft-wrapped lines before scanning the whole run', () => {
    const rows = Array.from({ length: 1_000 }, (_value, index) =>
      makeBufferLine('b'.repeat(80), { isWrapped: index > 0 })
    )
    const observedRows: number[] = []

    const logicalLine = buildWrappedLogicalLine(
      {
        getLine: (y) => {
          observedRows.push(y)
          return rows[y]
        }
      },
      1
    )

    expect(logicalLine).toBeNull()
    expect(Math.max(...observedRows)).toBeLessThan(250)
  })
})

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
      name: 'CJK directory',
      directory: '产物',
      filename: 'final-article.html'
    },
    {
      name: 'CJK filename',
      directory: 'ascii',
      filename: 'final-排版.html'
    },
    {
      name: 'CJK-only filename',
      directory: 'ascii',
      filename: 'final-排版'
    },
    {
      name: 'supplementary CJK filename',
      directory: 'ascii',
      filename: 'final-𠮷.html'
    },
    {
      name: 'parentheses filename',
      directory: 'ascii',
      filename: 'final-(olive-journal).html'
    }
  ])(
    'reconstructs a $name hard-wrapped path from either physical row',
    ({ directory, filename }) => {
      const expectedPath = `/tmp/orca-link-fixture/${directory}/${filename}`
      const splitIndex = expectedPath.indexOf('final-') + 'final-'.length
      const firstFragment = expectedPath.slice(0, splitIndex)
      const secondFragment = expectedPath.slice(splitIndex)
      const firstRow = `Rendered target: ${firstFragment}`
      const secondRow = `  ${secondFragment} · /tmp/orca-link-fixture/neighbor/next.txt`
      const firstRowColumns = makeCjkCellColumns(firstRow)
      const secondRowColumns = makeCjkCellColumns(secondRow)
      const secondRowStartIndex = secondRow.length - secondRow.trimStart().length
      const rows = [
        makeBufferLine(firstRow, { columns: firstRowColumns }),
        makeBufferLine(secondRow, { columns: secondRowColumns })
      ]
      const buffer = { getLine: (y: number) => rows[y] }
      const expectedRange = {
        start: { x: firstRowColumns[firstRow.indexOf(firstFragment)] + 1, y: 1 },
        end: { x: secondRowColumns[secondRowStartIndex + secondFragment.length], y: 2 }
      }

      for (const physicalRow of [1, 2]) {
        const candidate = buildHardWrappedPathLogicalLineCandidates(buffer, physicalRow).find(
          (item) => item.text === expectedPath
        )

        expect(candidate?.rows.map((row) => row.text)).toEqual([firstFragment, secondFragment])
        expect(candidate?.text).not.toContain(' · ')

        const parsedLink = extractTerminalFileLinkCandidates(candidate!.text).find(
          (link) => link.pathText === expectedPath
        )
        expect(parsedLink?.pathText).toBe(expectedPath)
        expect(resolveTerminalFileLink(parsedLink!, '/workspace')?.absolutePath).toBe(expectedPath)
        expect(
          rangeForParsedFileLink(candidate!, parsedLink!.startIndex, parsedLink!.endIndex)
        ).toEqual(expectedRange)
      }
    }
  )

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

  it('fingerprints full source rows outside the selected boundary fragments', () => {
    const rows = makeThreeLinkRows()
    const buffer = { getLine: (y: number) => rows[y] }
    const expectedText = middleStart + middleEnd
    const before = buildHardWrappedPathLogicalLineCandidates(buffer, 1).find(
      (candidate) => candidate.text === expectedText
    )

    rows[1] = makeBufferLine(`${middleEnd} · validation-screenshots/03-after-dark-theme.png`)
    const after = buildHardWrappedPathLogicalLineCandidates(buffer, 1).find(
      (candidate) => candidate.text === expectedText
    )

    expect(before).toBeDefined()
    expect(after).toBeDefined()
    expect(after!.rows.map((row) => row.text)).toEqual(before!.rows.map((row) => row.text))
    expect(after!.fingerprint).not.toBe(before!.fingerprint)
  })

  it('rejects non-path starts before scanning their possible continuations', () => {
    const rows = Array.from({ length: 20 }, () => makeBufferLine('a'.repeat(80)))
    const observedRows: number[] = []

    const candidates = buildHardWrappedPathLogicalLineCandidates(
      {
        getLine: (y: number) => {
          observedRows.push(y)
          return rows[y]
        }
      },
      20
    )

    expect(candidates).toEqual([])
    expect(observedRows).toHaveLength(21)
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
