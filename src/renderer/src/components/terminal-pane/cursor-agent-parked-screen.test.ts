import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { viewportShowsParkedCursorAgentScreen } from './cursor-agent-parked-screen'

type FakeCell = {
  chars: string
  width: number
}

type Screen = {
  lines: (string | IBufferLine)[]
  cols?: number
  cursorX?: number
  cursorY?: number
}

function makeCell(cell: FakeCell): IBufferCell {
  return {
    getChars: () => cell.chars,
    getWidth: () => cell.width
  } as IBufferCell
}

function makeCellsLine(cells: FakeCell[], onGetCell?: (column: number) => void): IBufferLine {
  return {
    length: cells.length,
    getCell: (column: number) => {
      onGetCell?.(column)
      const cell = cells[column]
      return cell ? makeCell(cell) : undefined
    },
    translateToString: (trimRight = false, startColumn = 0, endColumn = cells.length) => {
      let result = ''
      for (let column = startColumn; column < endColumn; column++) {
        const cell = cells[column]
        if (!cell || cell.width === 0) {
          continue
        }
        result += cell.chars || ' '
      }
      return trimRight ? result.replace(/\s+$/, '') : result
    }
  } as IBufferLine
}

function makeLine(text: string, minimumColumns = 80): IBufferLine {
  const cells: FakeCell[] = []
  for (const char of Array.from(text)) {
    const width = char === '你' ? 2 : 1
    cells.push({ chars: char, width })
    if (width === 2) {
      cells.push({ chars: '', width: 0 })
    }
  }
  while (cells.length < minimumColumns) {
    cells.push({ chars: '', width: 1 })
  }

  return makeCellsLine(cells)
}

function classify({ lines, cols = 80, cursorX = 0, cursorY = lines.length - 1 }: Screen) {
  const bufferLines = lines.map((line) => (typeof line === 'string' ? makeLine(line, cols) : line))
  const buffer = {
    baseY: 0,
    getLine: (row: number) => bufferLines[row]
  } as IBuffer

  return viewportShowsParkedCursorAgentScreen({
    buffer,
    rows: lines.length,
    cols,
    cursorX,
    cursorY
  })
}

const parkedCursorAgentLines = [
  '',
  '  Cursor Agent',
  '  v2026.06.29-2ad2186',
  '  Tip: Use /config to customize Cursor settings and behavior.',
  '',
  '',
  '',
  '',
  '  → Plan, search, build anything',
  '',
  '',
  '  Composer 2.5',
  '  ~/development/code/xinyue/app_android · develop/app6.5.1',
  ''
]

describe('viewportShowsParkedCursorAgentScreen', () => {
  it('recognizes a parked Cursor Agent screen', () => {
    expect(classify({ lines: parkedCursorAgentLines })).toBe(true)
  })

  it.each([1, 4])('short-circuits when cursorX is %i', (cursorX) => {
    expect(classify({ lines: parkedCursorAgentLines, cursorX })).toBe(false)
  })

  it('rejects a plain shell', () => {
    expect(classify({ lines: ['Last login: Tue Aug 4', 'user@host project %', ''] })).toBe(false)
  })

  it('requires the cursor to be parked on a blank line', () => {
    expect(
      classify({
        lines: ['', '  Cursor Agent', '  → Plan, search, build anything', 'shell prompt']
      })
    ).toBe(false)
  })

  it('rejects a pager whose header only contains Cursor Agent', () => {
    expect(
      classify({
        lines: ['README', 'Cursor Agent setup', '→ next section', '--More--', ''],
        cursorY: 4
      })
    ).toBe(false)
  })

  it('only scans the first six rows for the exact header', () => {
    expect(
      classify({
        lines: ['', '', '', '', '', '', 'Cursor Agent', '→ Plan, search, build anything', '']
      })
    ).toBe(false)
  })

  it('does not inspect the final column for a two-cell marker', () => {
    const scannedColumns: number[] = []
    const finalColumnMarker = makeCellsLine(
      [
        { chars: '', width: 1 },
        { chars: '→', width: 1 }
      ],
      (column) => scannedColumns.push(column)
    )

    expect(classify({ lines: ['Cursor Agent', finalColumnMarker, ''], cols: 2 })).toBe(false)
    expect(scannedColumns).toEqual([0])
  })

  it('advances by the marker cell width', () => {
    const wideMarker = makeCellsLine([
      { chars: '→', width: 2 },
      { chars: '', width: 0 },
      { chars: '', width: 1 }
    ])

    expect(classify({ lines: ['Cursor Agent', wideMarker, ''], cols: 3 })).toBe(true)
  })

  it('does not accept a zero-width continuation cell as the trailing space', () => {
    const markerWithoutSpace = makeCellsLine([
      { chars: '→', width: 1 },
      { chars: '', width: 0 }
    ])

    expect(classify({ lines: ['Cursor Agent', markerWithoutSpace, ''], cols: 2 })).toBe(false)
  })

  it('recognizes an input marker after wide cells', () => {
    expect(
      classify({ lines: ['', '  Cursor Agent', '', '  你 → Plan, search, build anything', ''] })
    ).toBe(true)
  })

  it('scans a line whose length is shorter than the terminal columns', () => {
    expect(
      classify({
        lines: ['', '  Cursor Agent', makeLine('→ ', 0), ''],
        cols: 80
      })
    ).toBe(true)
  })

  it('rejects an input marker without a trailing space', () => {
    expect(
      classify({ lines: ['', '  Cursor Agent', '', '  →Plan, search, build anything', ''] })
    ).toBe(false)
  })
})
