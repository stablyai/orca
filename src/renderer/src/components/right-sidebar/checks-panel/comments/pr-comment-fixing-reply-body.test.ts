import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../../../shared/github/comment-types'
import { buildPRCommentBatchConversationReplyBody } from './pr-comment-fixing-reply-body'

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

describe('buildPRCommentBatchConversationReplyBody', () => {
  it('neutralizes mentions and issue references echoed from the source comment', () => {
    const body = buildPRCommentBatchConversationReplyBody([
      comment({ author: 'alice', body: '@greptileai please re-review, see #123' }),
      comment({ author: 'bob', body: 'Off by one.', path: 'src/a.ts', line: 12 })
    ])

    expect(body).toContain('- @alice: comment — `@greptileai` please re-review, see `#123`')
    // Why: a bare @handle in the snippet re-pings that bot and burns a review credit.
    expect(body).not.toMatch(/[^`]@greptileai/)
    expect(body).not.toMatch(/[^`]#123/)
  })

  it('leaves tokens that are already inside an inline-code span untouched', () => {
    const body = buildPRCommentBatchConversationReplyBody([
      comment({ author: 'alice', body: 'See `text @greptileai` and `see #123` here' }),
      comment({ author: 'bob', body: 'Off by one.', path: 'src/a.ts', line: 12 })
    ])

    // Why: wrapping an already-inert token closes the span early and makes it a live mention again.
    expect(body).toContain('- @alice: comment — See `text @greptileai` and `see #123` here')
  })

  it('leaves a numeric prefix inside a longer token alone', () => {
    const body = buildPRCommentBatchConversationReplyBody([
      comment({ author: 'alice', body: 'Use #123abc for the border, tracked in #123-followup' }),
      comment({ author: 'bob', body: 'Off by one.', path: 'src/a.ts', line: 12 })
    ])

    // Why: GitHub does not linkify `#123abc`; `#123-followup` is linkified, so it stays wrapped.
    expect(body).toContain(
      '- @alice: comment — Use #123abc for the border, tracked in `#123`-followup'
    )
  })
})
