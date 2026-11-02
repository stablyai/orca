import { describe, expect, it } from 'vitest'
import type { PRComment } from './comment-types'
import { getPRInlineCommentPlacement } from './pr-inline-comment-placement'

const comment = (overrides: Partial<PRComment>): PRComment => ({
  id: 1,
  author: 'octocat',
  authorAvatarUrl: '',
  body: 'body',
  createdAt: '2026-11-01T00:00:00Z',
  url: 'https://github.com/o/r/pull/1#discussion_r1',
  ...overrides
})

describe('getPRInlineCommentPlacement', () => {
  it('places a current review comment on its range', () => {
    expect(
      getPRInlineCommentPlacement(comment({ path: 'src/a.ts', line: 12, startLine: 10 }))
    ).toEqual({ path: 'src/a.ts', line: 12, startLine: 10 })
  })

  it('keeps outdated threads and conversation comments out of the diff', () => {
    expect(
      getPRInlineCommentPlacement(comment({ path: 'src/a.ts', line: 12, isOutdated: true }))
    ).toBeNull()
    expect(getPRInlineCommentPlacement(comment({ path: 'src/a.ts' }))).toBeNull()
    expect(getPRInlineCommentPlacement(comment({}))).toBeNull()
  })
})
