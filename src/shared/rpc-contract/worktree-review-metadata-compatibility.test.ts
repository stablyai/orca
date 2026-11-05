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

  it('preserves supported review metadata and explicit empty clears', () => {
    const diffComments = [
      {
        id: 'note',
        worktreeId: 'wt',
        filePath: 'app.ts',
        lineNumber: 1,
        body: 'Review this',
        createdAt: 1,
        side: 'modified'
      }
    ]
    const mobileDiffReview = { version: 1, files: {} }
    expect(WorktreeSet.parse({ worktree: 'wt', diffComments, mobileDiffReview })).toMatchObject({
      diffComments,
      mobileDiffReview
    })
    expect(WorktreeSet.parse({ worktree: 'wt', diffComments: [] }).diffComments).toEqual([])
  })

  it('continues rejecting malformed attachment writes rather than silently dropping them', () => {
    expect(
      WorktreeSet.safeParse({ worktree: 'wt', comment: 'Keep', linkedItems: [{}] }).success
    ).toBe(false)
  })
})
