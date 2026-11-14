import { describe, expect, it } from 'vitest'
import { WorktreeSet } from './worktree-params'

describe('optional review metadata wire compatibility', () => {
  it.each([
    { diffComments: [{ id: 'legacy', body: 'older comment shape' }] },
    { mobileDiffReview: { version: 0, files: [] } },
    { mobileDiffReview: null }
  ])('preserves other edits when older review metadata is unsupported: %j', (review) => {
    const parsed = WorktreeSet.parse({ worktree: 'wt', comment: 'Keep this change', ...review })
    expect(parsed.comment).toBe('Keep this change')
    expect(parsed.diffComments).toBeUndefined()
    expect(parsed.mobileDiffReview).toBeUndefined()
  })
})
