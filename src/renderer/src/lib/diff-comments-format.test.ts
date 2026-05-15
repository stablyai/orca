import { describe, it, expect } from 'vitest'
import type { DiffComment } from '../../../shared/types'
import { formatDiffComment, formatDiffComments } from './diff-comments-format'

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: 'id-1',
    worktreeId: 'wt-1',
    filePath: 'src/app.ts',
    lineNumber: 10,
    body: 'Needs validation',
    createdAt: 0,
    side: 'modified',
    ...overrides
  }
}

describe('formatDiffComment', () => {
  it('emits the fixed three-line structure', () => {
    const out = formatDiffComment(makeComment())
    expect(out).toBe(
      ['File: src/app.ts', 'Line: 10', 'User comment: "Needs validation"'].join('\n')
    )
  })

  it('keeps explicit diff comments without ranges in the legacy format', () => {
    const out = formatDiffComment(makeComment({ source: 'diff' }))
    expect(out).toBe(
      ['File: src/app.ts', 'Line: 10', 'User comment: "Needs validation"'].join('\n')
    )
  })

  it('formats persisted ranges when startLine is present', () => {
    const out = formatDiffComment(makeComment({ source: 'diff', startLine: 7 }))
    expect(out).toBe(
      ['File: src/app.ts', 'Lines: 7-10', 'User comment: "Needs validation"'].join('\n')
    )
  })

  it('adds markdown source metadata for markdown notes', () => {
    const out = formatDiffComment(makeComment({ source: 'markdown', startLine: 8 }))
    expect(out).toBe(
      [
        'File: src/app.ts',
        'Source: markdown',
        'Lines: 8-10',
        'User comment: "Needs validation"'
      ].join('\n')
    )
  })

  it('escapes embedded quotes in the body', () => {
    const out = formatDiffComment(makeComment({ body: 'why "this" path?' }))
    expect(out).toContain('User comment: "why \\"this\\" path?"')
  })

  it('escapes backslashes before quotes so the body cannot break out of the literal', () => {
    const out = formatDiffComment(makeComment({ body: 'path\\to\\"thing"' }))
    expect(out).toContain('User comment: "path\\\\to\\\\\\"thing\\""')
  })

  it('escapes newlines so the body cannot break out of the fixed 3-line structure', () => {
    const out = formatDiffComment(makeComment({ body: 'first\nsecond' }))
    expect(out).toContain('User comment: "first\\nsecond"')
    expect(out.split('\n')).toHaveLength(3)
  })
})

describe('formatDiffComments', () => {
  it('joins multiple comments with a blank line', () => {
    const out = formatDiffComments([
      makeComment({ id: 'a', lineNumber: 1, body: 'first' }),
      makeComment({ id: 'b', lineNumber: 2, body: 'second' })
    ])
    expect(out).toBe(
      [
        'File: src/app.ts',
        'Line: 1',
        'User comment: "first"',
        '',
        'File: src/app.ts',
        'Line: 2',
        'User comment: "second"'
      ].join('\n')
    )
  })

  it('returns an empty string for an empty input', () => {
    expect(formatDiffComments([])).toBe('')
  })
})
