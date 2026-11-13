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

  it('leaves a different checkout head unverified without assuming its commits are absent', () => {
    expect(
      resolveMergedReviewWorkspaceReadiness({
        review: merged,
        headOid: 'def456',
        uncommittedCount: 0
      })
    ).toEqual({ kind: 'head-unverified' })
  })

  it('leaves missing checkout heads and missing review proof unverified', () => {
    expect(
      resolveMergedReviewWorkspaceReadiness({
        review: merged,
        headOid: null,
        uncommittedCount: 0
      })
    ).toEqual({ kind: 'head-unverified' })
    expect(
      resolveMergedReviewWorkspaceReadiness({
        review: { state: 'merged' },
        headOid: 'abc123',
        uncommittedCount: 0
      })
    ).toEqual({ kind: 'head-unverified' })
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
