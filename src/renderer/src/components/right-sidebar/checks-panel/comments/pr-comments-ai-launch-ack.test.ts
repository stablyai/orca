import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../../../shared/github/comment-types'
import {
  canPostPRReviewThreadReply,
  resolvePRReviewReplyThreadId
} from './pr-comments-ai-launch-ack'

function comment(overrides: Partial<PRComment> = {}): PRComment {
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

describe('canPostPRReviewThreadReply', () => {
  // Review-summary anchors override thread metadata; their IDs would 404 on the nested replies endpoint.
  it('rejects review summaries even when thread metadata is present', () => {
    expect(
      canPostPRReviewThreadReply(
        comment({
          id: 5,
          threadId: 'T1',
          path: 'src/a.ts',
          url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-999'
        })
      )
    ).toBe(false)
  })
})

describe('resolvePRReviewReplyThreadId', () => {
  it('refuses a path-only match when the file holds several threads', () => {
    const existing = [
      comment({ id: 1, threadId: 'T_one', path: 'src/a.ts', line: 3 }),
      comment({ id: 2, threadId: 'T_two', path: 'src/a.ts', line: 40 })
    ]
    expect(
      resolvePRReviewReplyThreadId({
        parent: comment({ id: 50, path: 'src/a.ts', line: undefined }),
        existingComments: existing
      })
    ).toBeUndefined()
    // A line-scoped parent still matches its own thread.
    expect(
      resolvePRReviewReplyThreadId({
        parent: comment({ id: 50, path: 'src/a.ts', line: 40 }),
        existingComments: existing
      })
    ).toBe('T_two')
  })
})
