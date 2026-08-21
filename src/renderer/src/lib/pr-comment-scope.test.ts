import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../shared/types'
import {
  filterPRCommentsByScope,
  getPRCommentScopeCounts,
  isReviewFeedbackPRComment
} from './pr-comment-scope'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: 1,
    author: 'alice',
    authorAvatarUrl: '',
    body: 'body',
    createdAt: '2026-07-07T00:00:00.000Z',
    url: '',
    ...overrides
  }
}

describe('pr-comment-scope', () => {
  it('classifies review threads as feedback and top-level comments as conversation', () => {
    expect(isReviewFeedbackPRComment(comment({ threadId: 'thread-1' }))).toBe(true)
    expect(isReviewFeedbackPRComment(comment({ threadId: undefined }))).toBe(false)
  })

  it('counts and filters review feedback separately from all comments', () => {
    const comments = [
      comment({ id: 1, threadId: 'thread-1' }),
      comment({ id: 2 }),
      comment({ id: 3, threadId: 'thread-2' })
    ]

    expect(getPRCommentScopeCounts(comments)).toEqual({ feedback: 2, all: 3 })
    expect(filterPRCommentsByScope(comments, 'feedback').map((item) => item.id)).toEqual([1, 3])
    expect(filterPRCommentsByScope(comments, 'all')).toEqual(comments)
  })
})
