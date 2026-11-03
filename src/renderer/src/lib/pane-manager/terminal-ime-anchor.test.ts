import { describe, expect, it } from 'vitest'
import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm'
import { resolveCursorAgentImeAnchor } from './terminal-ime-anchor'

type FakeCell = {
  chars: string
  width: number
}

function makeCell(cell: FakeCell): IBufferCell {
  return {
    getWidth: () => cell.width,
    getChars: () => cell.chars
  } as IBufferCell
}

function makeLine(text: string, cols = 80): IBufferLine {
  const cells: FakeCell[] = []
  for (const char of Array.from(text)) {
    const width = char === '你' ? 2 : 1
    cells.push({ chars: char, width })
    if (width === 2) {
      cells.push({ chars: '', width: 0 })
    }
  }
  while (cells.length < cols) {
    cells.push({ chars: '', width: 1 })
  }

  return {
    isWrapped: false,
    length: cells.length,
    getCell: (column: number) => {
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

function makeBuffer(lines: string[], cols = 80): IBuffer {
  const bufferLines = lines.map((line) => makeLine(line, cols))
  return {
    baseY: 0,
    cursorX: 0,
    cursorY: 0,
    length: bufferLines.length,
    getLine: (row: number) => bufferLines[row],
    getNullCell: () => makeCell({ chars: '', width: 1 })
  } as IBuffer
}

describe('resolveCursorAgentImeAnchor', () => {
  it('anchors the follow-up placeholder after the Cursor Agent header scrolls away', () => {
    const buffer = makeBuffer(['transcript', '', '  → Add a follow-up', '', ''])

    expect(
      resolveCursorAgentImeAnchor({
        buffer,
        rows: 5,
        cols: 80,
        cursorX: 0,
        cursorY: 4
      })
    ).toEqual({ row: 2, column: 4 })
  })

  it('anchors the input row, not a transcript line containing an arrow', () => {
    const buffer = makeBuffer([
      '',
      '  Cursor Agent',
      '',
      '  Renamed a.ts → b.ts',
      '',
      '  → Plan, search, build anything',
      ''
    ])

    expect(
      resolveCursorAgentImeAnchor({
        buffer,
        rows: 7,
        cols: 80,
        cursorX: 0,
        cursorY: 6
      })
    ).toEqual({ row: 5, column: 4 })
  })

  it('uses cell width when anchoring after typed Cursor Agent input', () => {
    const buffer = makeBuffer(['', '  Cursor Agent', '', '  → hi你', ''])

    expect(
      resolveCursorAgentImeAnchor({
        buffer,
        rows: 5,
        cols: 80,
        cursorX: 0,
        cursorY: 4
      })
    ).toEqual({ row: 3, column: 8 })
  })
})
