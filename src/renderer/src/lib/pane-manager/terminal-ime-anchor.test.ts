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
  it('anchors an empty Cursor Agent prompt at the visible prompt caret', () => {
    const buffer = makeBuffer([
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
    ])

    expect(
      resolveCursorAgentImeAnchor({
        buffer,
        rows: 14,
        cols: 80,
        cursorX: 0,
        cursorY: 13
      })
    ).toEqual({ row: 8, column: 4 })
  })

  it('does not override normal terminal cursor positioning', () => {
    const buffer = makeBuffer(['', '  → Plan, search, build anything', '', ''])

    expect(
      resolveCursorAgentImeAnchor({
        buffer,
        rows: 4,
        cols: 80,
        cursorX: 0,
        cursorY: 3
      })
    ).toBeNull()
  })

  it('does not override when xterm already exposes a non-stale cursor position', () => {
    const buffer = makeBuffer(['', '  Cursor Agent', '', '  → Plan, search, build anything'])

    expect(
      resolveCursorAgentImeAnchor({
        buffer,
        rows: 4,
        cols: 80,
        cursorX: 4,
        cursorY: 3
      })
    ).toBeNull()
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
