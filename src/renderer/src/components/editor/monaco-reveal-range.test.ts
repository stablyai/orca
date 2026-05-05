import { describe, expect, it } from 'vitest'
import { computeMonacoRevealRange } from './monaco-reveal-range'

describe('computeMonacoRevealRange', () => {
  it('returns the requested single-line match range when it is already valid', () => {
    expect(
      computeMonacoRevealRange({
        line: 4,
        column: 7,
        matchLength: 5,
        maxLine: 20,
        lineMaxColumn: 80
      })
    ).toEqual({
      startLineNumber: 4,
      startColumn: 7,
      endLineNumber: 4,
      endColumn: 12
    })
  })

  it('clamps the line and columns to the model bounds', () => {
    expect(
      computeMonacoRevealRange({
        line: 999,
        column: 200,
        matchLength: 10,
        maxLine: 6,
        lineMaxColumn: 14
      })
    ).toEqual({
      startLineNumber: 6,
      startColumn: 14,
      endLineNumber: 6,
      endColumn: 15
    })
  })

  it('falls back to a one-column range when match length is zero', () => {
    expect(
      computeMonacoRevealRange({
        line: 2,
        column: 3,
        matchLength: 0,
        maxLine: 10,
        lineMaxColumn: 9
      })
    ).toEqual({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 4
    })
  })
})
