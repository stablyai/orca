import { describe, expect, it } from 'vitest'
import type { PRComment } from './github/comment-types'
import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  groupPRComments,
  isResolvedPRCommentGroup
} from './pr-comment-groups'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: overrides.id ?? 1,
    author: 'user',
    authorAvatarUrl: '',
    body: '',
    createdAt: '',
    url: '',
    ...overrides
  }
}

describe('pr comment groups', () => {
  it('groups review thread replies while preserving first-comment order', () => {
    const comments = [
      comment({ id: 1 }),
      comment({ id: 2, threadId: 'thread-a', isResolved: true }),
      comment({ id: 3, threadId: 'thread-a' }),
      comment({ id: 4 })
    ]
    const groups = groupPRComments(comments)

    expect(groups.map(getPRCommentGroupId)).toEqual(['comment:1', 'thread:thread-a', 'comment:4'])
    expect(groups[0]).toEqual({ kind: 'standalone', comment: comments[0] })
    expect(groups[1]).toMatchObject({ root: { id: 2 }, replies: [{ id: 3 }] })
    expect(getPRCommentGroupCount(groups[1])).toBe(2)
    expect(isResolvedPRCommentGroup(groups[1])).toBe(true)
  })
})
