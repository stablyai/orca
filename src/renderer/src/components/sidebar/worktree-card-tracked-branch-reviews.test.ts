import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { getTrackedBranchReviewRows } from './worktree-card-tracked-branch-reviews'

const review = (over: Partial<HostedReviewInfo> = {}): HostedReviewInfo => ({
  provider: 'github',
  number: 334,
  title: 'feat: limitar transactionDate [v1.15.0]',
  state: 'open',
  url: 'https://github.com/acme/app/pull/334',
  status: 'success',
  updatedAt: '2026-08-09T00:00:00Z',
  mergeable: 'MERGEABLE',
  baseRefName: 'RELEASE/v1.15.0',
  ...over
})

describe('getTrackedBranchReviewRows', () => {
  it('returns [] without tracked branches', () => {
    expect(getTrackedBranchReviewRows(undefined, 'task/x', [])).toEqual([])
    expect(getTrackedBranchReviewRows([], 'task/x', [])).toEqual([])
  })

  it('maps resolved reviews to rows keyed by head branch', () => {
    expect(getTrackedBranchReviewRows(['task/x-v1.15.0'], 'task/x', [review()])).toEqual([
      {
        provider: 'github',
        number: 334,
        url: 'https://github.com/acme/app/pull/334',
        headRef: 'task/x-v1.15.0',
        baseRef: 'RELEASE/v1.15.0',
        title: 'feat: limitar transactionDate [v1.15.0]',
        state: 'open',
        status: 'success'
      }
    ])
  })

  it('skips branches whose review is unresolved, URL-less, or unsupported', () => {
    expect(
      getTrackedBranchReviewRows(['a', 'b', 'c', 'd'], 'task/x', [
        null,
        undefined,
        review({ url: '' }),
        review({ provider: 'unsupported' })
      ])
    ).toEqual([])
  })

  it('skips the worktree own branch — its review is already the primary', () => {
    expect(getTrackedBranchReviewRows(['task/x'], 'task/x', [review()])).toEqual([])
  })

  it('keeps rows aligned when earlier branches are skipped', () => {
    const rows = getTrackedBranchReviewRows(['task/x', 'task/x-stage'], 'task/x', [
      review(),
      review({ number: 335, url: 'https://github.com/acme/app/pull/335' })
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.number).toBe(335)
    expect(rows[0]?.headRef).toBe('task/x-stage')
  })
})
