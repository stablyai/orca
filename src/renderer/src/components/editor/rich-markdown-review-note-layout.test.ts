import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../../shared/types'
import {
  shouldExpandRichMarkdownReviewRail,
  stackRichMarkdownReviewNotePositions
} from './rich-markdown-review-note-layout'

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

  it('reserves quote height for fallback source-line excerpts', () => {
    const stacked = stackRichMarkdownReviewNotePositions([
      {
        comment: makeComment({ id: 'first', body: 'note' }),
        top: 100
      },
      {
        comment: makeComment({ id: 'second', body: 'note' }),
        top: 100
      }
    ])

    expect(stacked[1].top).toBe(210)
  })
})

describe('shouldExpandRichMarkdownReviewRail', () => {
  it('expands while a markdown note draft is open even before the note is saved', () => {
    expect(
      shouldExpandRichMarkdownReviewRail({
        hasReviewNotes: false,
        reviewRailOpen: false,
        hasDraftNote: true
      })
    ).toBe(true)
  })

  it('keeps saved notes collapsed until the user opens the rail', () => {
    expect(
      shouldExpandRichMarkdownReviewRail({
        hasReviewNotes: true,
        reviewRailOpen: false,
        hasDraftNote: false
      })
    ).toBe(false)
  })
})
