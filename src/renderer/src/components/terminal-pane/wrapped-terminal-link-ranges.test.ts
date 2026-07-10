import { describe, expect, it } from 'vitest'
import { buildWrappedLogicalLine } from './wrapped-terminal-link-ranges'

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

function makeBufferLine(text: string, isWrapped = false): TestBufferLine {
  return {
    isWrapped,
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
          outColumns.push(index)
        }
      }
      return text.slice(startColumn, endColumn)
    }
  }
}

describe('buildWrappedLogicalLine', () => {
  it('joins ordinary soft-wrapped terminal rows', () => {
    const rows = [makeBufferLine('src/'), makeBufferLine('file.ts', true)]

    const logicalLine = buildWrappedLogicalLine({ getLine: (y) => rows[y] }, 2)

    expect(logicalLine?.text).toBe('src/file.ts')
    expect(logicalLine?.rows.map((row) => row.y)).toEqual([0, 1])
  })

  it('caps pathological soft-wrapped lines before scanning the whole run', () => {
    const rows = Array.from({ length: 1_000 }, (_value, index) =>
      makeBufferLine('b'.repeat(80), index > 0)
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
