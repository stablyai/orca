import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../shared/github/comment-types'
import { restorePRCommentThreadSnapshot } from './pr-comment-thread-resolution'

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
  it('restores only resolution fields while preserving edits and current membership', () => {
    const previous = comment({ id: 1, threadId: 'thread-a', isResolved: false })
    const removed = comment({ id: 2, threadId: 'thread-a', isResolved: false })
    const edited = comment({
      ...previous,
      isResolved: true,
      body: 'Updated while resolution was pending.',
      reactions: [{ content: 'heart', count: 1, viewerHasReacted: true }]
    })
    const added = comment({ id: 3, threadId: 'thread-a', body: 'New reply.' })

    expect(restorePRCommentThreadSnapshot([edited, added], [previous, removed])).toEqual([
      { ...edited, isResolved: false },
      { ...added, isResolved: false }
    ])
  })
})
