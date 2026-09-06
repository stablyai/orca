import { describe, expect, it } from 'vitest'
import {
  buildChangedLineDecorations,
  buildChangedLineRanges
} from './monaco-changed-line-decorations'

describe('buildChangedLineRanges', () => {
  it('returns no ranges for identical content', () => {
    expect(buildChangedLineRanges('one\ntwo', 'one\ntwo')).toEqual([])
  })

  it('highlights a changed line in the modified content', () => {
    expect(buildChangedLineRanges('one\ntwo\nthree', 'one\nTWO\nthree')).toEqual([
      { startLineNumber: 2, endLineNumber: 2 }
    ])
  })

  it('keeps separated changes as separated ranges', () => {
    expect(buildChangedLineRanges('one\ntwo\nthree\nfour', 'ONE\ntwo\nthree\nFOUR')).toEqual([
      { startLineNumber: 1, endLineNumber: 1 },
      { startLineNumber: 4, endLineNumber: 4 }
    ])
  })

  it('highlights inserted lines', () => {
    expect(buildChangedLineRanges('one\nfour', 'one\ntwo\nthree\nfour')).toEqual([
      { startLineNumber: 2, endLineNumber: 3 }
    ])
  })

  it('anchors a mid-file deletion on the line that now sits where it was removed', () => {
    expect(buildChangedLineRanges('one\ntwo\nthree', 'one\nthree')).toEqual([
      { startLineNumber: 2, endLineNumber: 2 }
    ])
  })

  it('anchors a trailing-line deletion on the last remaining line', () => {
    expect(buildChangedLineRanges('one\ntwo', 'one')).toEqual([
      { startLineNumber: 1, endLineNumber: 1 }
    ])
  })

  it('anchors on line 1 when the whole file was cleared', () => {
    expect(buildChangedLineRanges('one\ntwo', '')).toEqual([
      { startLineNumber: 1, endLineNumber: 1 }
    ])
  })

  it('anchors a deletion-only change on the nearest surviving line via the large-input fallback', () => {
    const originalLines = Array.from({ length: 1000 }, (_, i) => `line${i}`)
    const modifiedLines = [...originalLines.slice(0, 500), ...originalLines.slice(501)]

    expect(buildChangedLineRanges(originalLines.join('\n'), modifiedLines.join('\n'))).toEqual([
      { startLineNumber: 501, endLineNumber: 501 }
    ])
  })

  it('does not decorate binary or limited diffs', () => {
    expect(
      buildChangedLineDecorations(
        {
          kind: 'text',
          originalContent: 'one',
          modifiedContent: 'two',
          originalIsBinary: false,
          modifiedIsBinary: false,
          largeDiffRenderLimit: {
            limited: true,
            reason: 'character-count',
            lineCounts: { original: 1, modified: 1 },
            characterCount: 200,
            limits: { maxLinesPerSide: 120_000, maxCombinedCharacters: 100 }
          }
        },
        'two'
      )
    ).toEqual([])
  })
})
