import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { stackRichMarkdownReviewNotePositions } from './rich-markdown-review-note-layout'

function makeComment(overrides: Partial<DiffComment>): DiffComment {
  return {
    id: 'note',
    worktreeId: 'wt1',
    filePath: 'AGENTS.md',
    source: 'markdown',
    lineNumber: 45,
    body: 'note',
    createdAt: 1,
    side: 'modified',
    ...overrides
  }
}

describe('stackRichMarkdownReviewNotePositions', () => {
  it('keeps overlapping range notes in source-line order when they share an anchor', () => {
    const stacked = stackRichMarkdownReviewNotePositions([
      {
        comment: makeComment({ id: 'later-start', startLine: 43, createdAt: 1 }),
        top: 100
      },
      {
        comment: makeComment({ id: 'earlier-start', startLine: 41, createdAt: 2 }),
        top: 100
      }
    ])

    expect(stacked.map((position) => position.comment.id)).toEqual(['earlier-start', 'later-start'])
    expect(stacked[0].top).toBe(100)
    expect(stacked[1].top).toBeGreaterThan(stacked[0].top)
  })
})
