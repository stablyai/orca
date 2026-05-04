import { describe, expect, it } from 'vitest'

import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  groupPRComments,
  isResolvedPRCommentGroup
} from './pr-comment-groups'
import type { PRComment } from '../../../shared/types'

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
    const groups = groupPRComments([
      comment({ id: 1 }),
      comment({ id: 2, threadId: 'thread-a', isResolved: true }),
      comment({ id: 3, threadId: 'thread-a', isResolved: true }),
      comment({ id: 4 })
    ])

    expect(groups.map(getPRCommentGroupId)).toEqual(['comment:1', 'thread:thread-a', 'comment:4'])
    expect(getPRCommentGroupCount(groups[1])).toBe(2)
    expect(isResolvedPRCommentGroup(groups[1])).toBe(true)
  })
})
