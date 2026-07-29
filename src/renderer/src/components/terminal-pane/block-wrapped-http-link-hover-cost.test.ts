import type { IBufferLine } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { buildBlockWrappedHttpLogicalLineCandidates } from './block-wrapped-terminal-http-links'

// Why: this runs on the renderer's hover path for every mouse move over a
// terminal, so its work must stay bounded no matter how adversarial the
// buffer. Counting row reads keeps the bound deterministic — a wall-clock
// budget would flake under parallel test load and would itself steal CPU from
// the timing-sensitive suites running alongside it.
const MAX_ROW_READS_PER_HOVER = 4_000

function makeBufferLine(content: string, cols: number): IBufferLine {
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

function countRowReadsForHover(rows: IBufferLine[], bufferLineNumber: number): number {
  let reads = 0
  const buffer = {
    getLine: (y: number) => {
      reads++
      return rows[y]
    }
  }
  buildBlockWrappedHttpLogicalLineCandidates(buffer, bufferLineNumber)
  return reads
}

describe('block-wrapped HTTP link hover cost', () => {
  it('bounds row reads on a screen made entirely of wrapped URL rows', () => {
    const cols = 200
    // Maximises start-row candidates, wrap-column scans, and join attempts:
    // every row is a full-width URL ending at a break opportunity.
    const url = `https://example.com/${'a'.repeat(cols - 21)}/`
    const rows = Array.from({ length: 200 }, () => makeBufferLine(url, cols))

    expect(countRowReadsForHover(rows, 150)).toBeLessThan(MAX_ROW_READS_PER_HOVER)
  })

  it('bounds row reads on a huge no-newline blob', () => {
    const rows = [makeBufferLine(`https://example.com/${'a'.repeat(20_000)}`, 400)]

    expect(countRowReadsForHover(rows, 1)).toBeLessThan(MAX_ROW_READS_PER_HOVER)
  })
})
