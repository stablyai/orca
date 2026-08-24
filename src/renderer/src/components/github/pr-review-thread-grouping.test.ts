import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import { buildOutdatedReviewThreadItems, buildReviewThreadItems } from './pr-review-thread-grouping'

function comment(overrides: Partial<PRComment> & { id: number }): PRComment {
  return {
    author: 'alice',
    authorAvatarUrl: '',
    body: `body ${overrides.id}`,
    createdAt: new Date(2026, 0, overrides.id).toISOString(),
    url: `https://github.com/o/r/pull/7#discussion_r${overrides.id}`,
    path: 'a.ts',
    isResolved: false,
    line: 5,
    ...overrides
  }
}

describe('buildReviewThreadItems', () => {
  it('groups a thread into one item with ordered replies', () => {
    const items = buildReviewThreadItems(
      [
        comment({ id: 2, threadId: 'T1' }),
        comment({ id: 1, threadId: 'T1' }),
        comment({ id: 3, threadId: 'T2', line: 9 })
      ],
      'repo',
      7
    )
    expect(items).toHaveLength(2)
    const first = items.find((item) => item.id === 'github-pr-thread:T1')
    expect(first).toMatchObject({ body: 'body 1', lineNumber: 5 })
    expect(first?.reviewThread?.replies.map((reply) => reply.id)).toEqual(['2'])
  })

  it('treats ungrouped comments as single-comment threads', () => {
    const items = buildReviewThreadItems([comment({ id: 4, threadId: undefined })], 'repo', 7)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('github-pr-thread:4')
    expect(items[0]?.reviewThread?.replies).toHaveLength(0)
  })

  it('excludes outdated and pathless comments from inline items', () => {
    const items = buildReviewThreadItems(
      [
        comment({ id: 1, threadId: 'T1', isOutdated: true }),
        comment({ id: 2, threadId: 'T2', path: undefined }),
        comment({ id: 3, threadId: 'T3', line: undefined })
      ],
      'repo',
      7
    )
    expect(items).toHaveLength(0)
  })

  it('routes file-level threads (no line) into the outdated group instead of dropping them', () => {
    const items = buildOutdatedReviewThreadItems(
      [comment({ id: 4, threadId: 'T4', line: undefined })],
      'repo',
      7
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.lineNumber).toBe(0)
  })

  it('carries reactions and pending state onto threads and replies', () => {
    const items = buildReviewThreadItems(
      [
        comment({ id: 1, threadId: 'T1', reactions: [{ content: '+1', count: 2 }] }),
        comment({ id: 2, threadId: 'T1', isPending: true })
      ],
      'repo',
      7
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.reactions).toEqual([{ content: '+1', count: 2 }])
    expect(items[0]?.reviewThread?.replies[0]).toMatchObject({ id: '2', isPending: true })
  })
})

describe('buildOutdatedReviewThreadItems', () => {
  it('groups only outdated threads, keeping original line anchors', () => {
    const items = buildOutdatedReviewThreadItems(
      [
        comment({ id: 1, threadId: 'T1', isOutdated: true }),
        comment({ id: 2, threadId: 'T1', isOutdated: true }),
        comment({ id: 3, threadId: 'T2', line: 9 })
      ],
      'repo',
      7
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'github-pr-thread:T1', lineNumber: 5 })
    expect(items[0]?.reviewThread?.isOutdated).toBe(true)
    expect(items[0]?.reviewThread?.replies).toHaveLength(1)
  })
})
