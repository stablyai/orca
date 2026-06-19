import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../shared/types'
import {
  markPRCommentThreadResolved,
  restorePRCommentThreadSnapshot
} from './pr-comment-thread-resolution'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: 1,
    author: 'alice',
    authorAvatarUrl: '',
    body: 'Please update this.',
    createdAt: '2026-05-14T00:00:00Z',
    url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
    ...overrides
  }
}

describe('PR comment thread resolution helpers', () => {
  it('rolls back only the failed thread snapshot', () => {
    const base = [
      comment({ id: 1, threadId: 'thread-a', isResolved: false }),
      comment({ id: 2, threadId: 'thread-b', isResolved: false }),
      comment({ id: 3, threadId: 'thread-b', isResolved: false })
    ]
    const afterFirstSuccess = markPRCommentThreadResolved(base, 'thread-a', true)
    const failedThreadSnapshot = afterFirstSuccess.filter((item) => item.threadId === 'thread-b')
    const afterSecondOptimisticUpdate = markPRCommentThreadResolved(
      afterFirstSuccess,
      'thread-b',
      true
    )

    const rolledBack = restorePRCommentThreadSnapshot(
      afterSecondOptimisticUpdate,
      failedThreadSnapshot
    )

    expect(rolledBack.map((item) => [item.threadId, item.isResolved])).toEqual([
      ['thread-a', true],
      ['thread-b', false],
      ['thread-b', false]
    ])
  })
})
