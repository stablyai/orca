import { describe, expect, it } from 'vitest'
import { deriveWorkerPrBadge } from './orchestrator-worker-pr-badge'
import type { HostedReviewInfo } from '../../../shared/hosted-review'

const noLinks = {
  linkedPR: null,
  linkedGitLabMR: null,
  linkedBitbucketPR: null,
  linkedAzureDevOpsPR: null,
  linkedGiteaPR: null
}

function githubReview(over: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 142,
    title: 'Add login redirect',
    state: 'open',
    url: 'https://github.com/acme/app/pull/142',
    status: 'pending',
    updatedAt: '2026-06-20T00:00:00Z',
    mergeable: 'unknown',
    ...over
  } as HostedReviewInfo
}

describe('deriveWorkerPrBadge', () => {
  it('returns the PR number, state, and url from a cached GitHub review', () => {
    expect(deriveWorkerPrBadge({ ...noLinks, linkedPR: 142 }, githubReview())).toEqual({
      label: 'PR',
      number: 142,
      state: 'open',
      url: 'https://github.com/acme/app/pull/142'
    })
  })

  it('carries the merged state through', () => {
    const badge = deriveWorkerPrBadge(
      { ...noLinks, linkedPR: 142 },
      githubReview({ state: 'merged' })
    )
    expect(badge?.state).toBe('merged')
  })

  it('shows a linked PR number even before the review is cached (no state/url yet)', () => {
    const badge = deriveWorkerPrBadge({ ...noLinks, linkedPR: 7 }, undefined)
    expect(badge?.label).toBe('PR')
    expect(badge?.number).toBe(7)
    expect(badge?.state).toBeUndefined()
  })

  it('labels GitLab links as MR', () => {
    const badge = deriveWorkerPrBadge({ ...noLinks, linkedGitLabMR: 9 }, undefined)
    expect(badge?.label).toBe('MR')
    expect(badge?.number).toBe(9)
  })

  it('returns null when the worktree has no linked review', () => {
    expect(deriveWorkerPrBadge(noLinks, undefined)).toBeNull()
  })
})
