import { describe, expect, it } from 'vitest'
import {
  computeGitGutterHunks,
  GIT_GUTTER_MAX_EDIT_DISTANCE,
  splitGitGutterLines
} from './git-gutter-line-diff'

function hunksFor(base: string, current: string) {
  return computeGitGutterHunks(splitGitGutterLines(base), splitGitGutterLines(current))
}

describe('splitGitGutterLines', () => {
  it('splits LF and CRLF the same way Monaco does', () => {
    expect(splitGitGutterLines('a\nb')).toEqual(['a', 'b'])
    expect(splitGitGutterLines('a\r\nb')).toEqual(['a', 'b'])
  })

  it('keeps the empty trailing element for a trailing newline', () => {
    expect(splitGitGutterLines('a\n')).toEqual(['a', ''])
  })

  it('treats empty text as a single empty line', () => {
    expect(splitGitGutterLines('')).toEqual([''])
  })
})

describe('computeGitGutterHunks', () => {
  it('reports nothing for identical content', () => {
    expect(hunksFor('a\nb\nc', 'a\nb\nc')).toEqual([])
  })

  it('reports nothing when only line endings differ', () => {
    expect(hunksFor('a\r\nb', 'a\nb')).toEqual([])
  })

  it('marks appended lines as added', () => {
    expect(hunksFor('a\nb', 'a\nb\nc\nd')).toEqual([{ kind: 'added', startLine: 3, endLine: 4 }])
  })

  it('marks inserted lines in the middle as added', () => {
    expect(hunksFor('a\nd', 'a\nb\nc\nd')).toEqual([{ kind: 'added', startLine: 2, endLine: 3 }])
  })

  it('marks a replaced line as modified', () => {
    expect(hunksFor('a\nb\nc', 'a\nB\nc')).toEqual([{ kind: 'modified', startLine: 2, endLine: 2 }])
  })

  it('marks a replacement that grows as modified over the new lines', () => {
    expect(hunksFor('a\nb\nc', 'a\nB1\nB2\nc')).toEqual([
      { kind: 'modified', startLine: 2, endLine: 3 }
    ])
  })

  it('marks a deletion in the middle at the preceding line', () => {
    expect(hunksFor('a\nb\nc', 'a\nc')).toEqual([{ kind: 'deleted', afterLine: 1 }])
  })

  it('marks a deletion at the start of the file with afterLine 0', () => {
    expect(hunksFor('a\nb\nc', 'b\nc')).toEqual([{ kind: 'deleted', afterLine: 0 }])
  })

  it('marks a deletion at the end of the file', () => {
    expect(hunksFor('a\nb\nc', 'a\nb')).toEqual([{ kind: 'deleted', afterLine: 2 }])
  })

  it('reports separate hunks for changes far apart', () => {
    expect(hunksFor('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')).toEqual([
      { kind: 'modified', startLine: 1, endLine: 1 },
      { kind: 'modified', startLine: 5, endLine: 5 }
    ])
  })

  it('marks a whole new file as added', () => {
    expect(computeGitGutterHunks([], splitGitGutterLines('a\nb'))).toEqual([
      { kind: 'added', startLine: 1, endLine: 2 }
    ])
  })

  it('marks a fully emptied file as deleted before the first line', () => {
    expect(computeGitGutterHunks(splitGitGutterLines('a\nb'), [''])).toEqual([
      { kind: 'deleted', afterLine: 0 }
    ])
  })

  it('gives up rather than guessing when the edit distance is enormous', () => {
    const base = Array.from({ length: GIT_GUTTER_MAX_EDIT_DISTANCE + 50 }, (_, i) => `base-${i}`)
    const current = Array.from(
      { length: GIT_GUTTER_MAX_EDIT_DISTANCE + 50 },
      (_, i) => `current-${i}`
    )
    expect(computeGitGutterHunks(base, current)).toEqual([])
  })
})
