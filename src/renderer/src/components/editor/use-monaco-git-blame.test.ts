import { describe, expect, it } from 'vitest'
import type { GitBlameRange } from '../../../../shared/git-blame'
import { findGitBlameRangeForLine, formatGitBlameInlineLabel } from './git-blame-current-line'

const range: GitBlameRange = {
  startLine: 4,
  endLine: 8,
  commitId: 'a'.repeat(40),
  author: 'Rafa Alguthami',
  authorEmail: 'rafa@example.com',
  authoredAt: 1_725_235_200,
  summary: 'Add schema'
}

describe('current-line Git blame', () => {
  it('finds only the range containing the caret line', () => {
    expect(findGitBlameRangeForLine([range], 6)).toBe(range)
    expect(findGitBlameRangeForLine([range], 3)).toBeNull()
    expect(findGitBlameRangeForLine([range], 9)).toBeNull()
  })

  it('formats committed and uncommitted annotations', () => {
    expect(formatGitBlameInlineLabel(range)).toContain('Rafa Alguthami')
    expect(formatGitBlameInlineLabel(range)).toContain('Add schema')
    expect(formatGitBlameInlineLabel({ ...range, commitId: null })).toBe('Uncommitted')
  })
})
