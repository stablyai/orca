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
})
