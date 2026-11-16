import { describe, expect, it } from 'vitest'
import { computeGitChangeHunks } from './git-change-hunks'

describe('computeGitChangeHunks', () => {
  it('reports no hunks for identical content', () => {
    expect(computeGitChangeHunks(['a', 'b', ''], ['a', 'b', ''])).toEqual([])
  })

  it('marks inserted lines as added', () => {
    expect(computeGitChangeHunks(['a', 'd'], ['a', 'b', 'c', 'd'])).toEqual([
      { kind: 'added', startLine: 2, endLine: 3, originalStartLine: 2, originalLineCount: 0 }
    ])
  })

  it('marks replaced lines as modified across the whole new range', () => {
    expect(computeGitChangeHunks(['a', 'b', 'c'], ['a', 'x', 'y', 'c'])).toEqual([
      { kind: 'modified', startLine: 2, endLine: 3, originalStartLine: 2, originalLineCount: 1 }
    ])
  })

  it('anchors a mid-file deletion to the line it follows', () => {
    expect(computeGitChangeHunks(['a', 'b', 'c', 'd'], ['a', 'd'])).toEqual([
      { kind: 'deleted', startLine: 1, endLine: 1, originalStartLine: 2, originalLineCount: 2 }
    ])
  })

  it('anchors a deletion at the top of the file to line 0', () => {
    expect(computeGitChangeHunks(['a', 'b', 'c'], ['b', 'c'])).toEqual([
      { kind: 'deleted', startLine: 0, endLine: 0, originalStartLine: 1, originalLineCount: 1 }
    ])
  })

  it('anchors a deletion at the end of the file to the last line', () => {
    expect(computeGitChangeHunks(['a', 'b', 'c'], ['a'])).toEqual([
      { kind: 'deleted', startLine: 1, endLine: 1, originalStartLine: 2, originalLineCount: 2 }
    ])
  })

  it('keeps separate hunks apart', () => {
    expect(computeGitChangeHunks(['a', 'b', 'c', 'd', 'e'], ['a', 'B', 'c', 'e', 'f'])).toEqual([
      { kind: 'modified', startLine: 2, endLine: 2, originalStartLine: 2, originalLineCount: 1 },
      { kind: 'deleted', startLine: 3, endLine: 3, originalStartLine: 4, originalLineCount: 1 },
      { kind: 'added', startLine: 5, endLine: 5, originalStartLine: 6, originalLineCount: 0 }
    ])
  })

  it('ignores a BOM kept on only one side', () => {
    expect(computeGitChangeHunks(['a', 'b'], ['\uFEFFa', 'b'])).toEqual([])
  })

  it('marks a paste larger than the edit budget next to earlier edits', () => {
    const baseline = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
    const buffer = [...baseline, ...Array.from({ length: 2500 }, (_, i) => `pasted ${i}`)]
    buffer[10] = 'edited'
    expect(computeGitChangeHunks(baseline, buffer)).toEqual([
      { kind: 'modified', startLine: 11, endLine: 11, originalStartLine: 11, originalLineCount: 1 },
      {
        kind: 'added',
        startLine: 3001,
        endLine: 5500,
        originalStartLine: 3001,
        originalLineCount: 0
      }
    ])
  })
})
