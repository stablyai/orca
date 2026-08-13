import { describe, expect, it } from 'vitest'
import type { IRange } from 'monaco-editor'
import { getMonacoSelectionStats } from './monaco-selection-stats'

function range(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number
): IRange {
  return { startLineNumber, startColumn, endLineNumber, endColumn }
}

function modelReturning(textByRange: Map<string, string>): {
  getValueInRange: (r: IRange) => string
} {
  const key = (r: IRange): string =>
    `${r.startLineNumber}:${r.startColumn}-${r.endLineNumber}:${r.endColumn}`
  return {
    getValueInRange: (r) => textByRange.get(key(r)) ?? ''
  }
}

describe('getMonacoSelectionStats', () => {
  it('returns null when there is no model', () => {
    expect(getMonacoSelectionStats(null, [range(1, 1, 1, 5)])).toBeNull()
  })

  it('returns null when there are no selections', () => {
    const model = modelReturning(new Map())
    expect(getMonacoSelectionStats(model, null)).toBeNull()
    expect(getMonacoSelectionStats(model, [])).toBeNull()
  })

  it('returns null for an empty (caret-only) selection', () => {
    const model = modelReturning(new Map())
    expect(getMonacoSelectionStats(model, [range(3, 2, 3, 2)])).toBeNull()
  })

  it('counts characters and whitespace-delimited words for a single selection', () => {
    const model = modelReturning(new Map([['1:1-1:12', 'hello world!']]))
    expect(getMonacoSelectionStats(model, [range(1, 1, 1, 12)])).toEqual({
      chars: 12,
      words: 2
    })
  })

  it('treats runs of whitespace and newlines as single word separators', () => {
    const model = modelReturning(new Map([['1:1-3:1', 'one   two\n\tthree ']]))
    const stats = getMonacoSelectionStats(model, [range(1, 1, 3, 1)])
    expect(stats?.words).toBe(3)
  })

  it('reports characters but zero words for a whitespace-only selection', () => {
    const model = modelReturning(new Map([['1:1-1:4', '   ']]))
    expect(getMonacoSelectionStats(model, [range(1, 1, 1, 4)])).toEqual({
      chars: 3,
      words: 0
    })
  })

  it('counts an emoji as a single character (code points, not UTF-16 units)', () => {
    const model = modelReturning(new Map([['1:1-1:3', '👍a']]))
    const stats = getMonacoSelectionStats(model, [range(1, 1, 1, 3)])
    expect(stats?.chars).toBe(2)
  })

  it('sums characters and words across multiple non-empty selections', () => {
    const model = modelReturning(
      new Map([
        ['1:1-1:6', 'alpha'],
        ['2:1-2:9', 'beta gamma']
      ])
    )
    const stats = getMonacoSelectionStats(model, [range(1, 1, 1, 6), range(2, 1, 2, 9)])
    expect(stats).toEqual({ chars: 15, words: 3 })
  })

  it('ignores empty selections when other selections have content', () => {
    const model = modelReturning(new Map([['1:1-1:5', 'quux']]))
    const stats = getMonacoSelectionStats(model, [range(3, 1, 3, 1), range(1, 1, 1, 5)])
    expect(stats).toEqual({ chars: 4, words: 1 })
  })
})
