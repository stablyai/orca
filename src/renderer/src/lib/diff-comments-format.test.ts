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
  it('emits the fixed four-line structure', () => {
    const out = formatDiffComment(makeComment())
    expect(out).toBe(
      [
        'File: src/app.ts',
        'Line: 10',
        'User comment: "Needs validation"',
        'Comment metadata: This comment was left on the modified branch.'
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

  it('escapes newlines so the body cannot break out of the fixed 4-line structure', () => {
    const out = formatDiffComment(makeComment({ body: 'first\nsecond' }))
    expect(out).toContain('User comment: "first\\nsecond"')
    expect(out.split('\n')).toHaveLength(4)
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
        'Comment metadata: This comment was left on the modified branch.',
        '',
        'File: src/app.ts',
        'Line: 2',
        'User comment: "second"',
        'Comment metadata: This comment was left on the modified branch.'
      ].join('\n')
    )
  })

  it('returns an empty string for an empty input', () => {
    expect(formatDiffComments([])).toBe('')
  })
})
