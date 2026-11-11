import { describe, expect, it } from 'vitest'
import { resolveMergedReviewWorkspaceReadiness } from './merged-review-workspace-readiness'

const merged = { state: 'merged' as const, headSha: 'abc123' }

describe('resolveMergedReviewWorkspaceReadiness', () => {
  it('is safe to delete when HEAD is the merged head and the tree is clean', () => {
    expect(
      resolveMergedReviewWorkspaceReadiness({
        review: merged,
        headOid: 'ABC123',
        uncommittedCount: 0
      })
    ).toEqual({ kind: 'safe-to-delete' })
  })

  it('is safe to delete when the provider confirmed HEAD is in the merged review', () => {
    expect(
      resolveMergedReviewWorkspaceReadiness({
        review: { ...merged, headSha: 'updated-on-github', confirmedContainedHeadOid: 'local' },
        headOid: 'local',
        uncommittedCount: 0
      })
    ).toEqual({ kind: 'safe-to-delete' })
  })

  it('reports uncommitted changes before HEAD identity', () => {
    expect(
      resolveMergedReviewWorkspaceReadiness({
        review: merged,
        headOid: 'abc123',
        uncommittedCount: 3
      })
    ).toEqual({ kind: 'uncommitted-changes', count: 3 })
  })

  it('does not claim safety when HEAD moved past the review or is unknown', () => {
    for (const headOid of ['def456', null]) {
      expect(
        resolveMergedReviewWorkspaceReadiness({ review: merged, headOid, uncommittedCount: 0 })
      ).toEqual({ kind: 'head-not-in-review' })
    }
    expect(
      resolveMergedReviewWorkspaceReadiness({
        review: { state: 'merged' },
        headOid: 'abc123',
        uncommittedCount: 0
      })
    ).toEqual({ kind: 'head-not-in-review' })
  })

  it('says nothing for reviews that are not merged', () => {
    expect(
      resolveMergedReviewWorkspaceReadiness({
        review: { ...merged, state: 'open' },
        headOid: 'abc123',
        uncommittedCount: 0
      })
    ).toBeNull()
  })
})
