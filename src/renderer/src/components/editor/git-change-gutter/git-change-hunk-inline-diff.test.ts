import { describe, expect, it } from 'vitest'
import { computeGitChangeInlineDiff } from './git-change-hunk-inline-diff'

describe('computeGitChangeInlineDiff', () => {
  it('emphasises the replaced word and locates its replacement in the buffer', () => {
    expect(computeGitChangeInlineDiff(['const a = true'], ['const a = false'], 6)).toEqual({
      originalSegments: [
        { text: 'const a = ', removed: false },
        { text: 'true', removed: true }
      ],
      insertedRanges: [{ startLineNumber: 6, startColumn: 11, endLineNumber: 6, endColumn: 16 }]
    })
  })

  it('tracks buffer positions across lines', () => {
    expect(computeGitChangeInlineDiff(['a', 'b'], ['a', 'b c'], 3).insertedRanges).toEqual([
      { startLineNumber: 4, startColumn: 2, endLineNumber: 4, endColumn: 4 }
    ])
  })

  it('leaves a pure deletion unemphasised', () => {
    expect(computeGitChangeInlineDiff(['gone'], [], 2)).toEqual({
      originalSegments: [{ text: 'gone', removed: false }],
      insertedRanges: []
    })
  })
})
