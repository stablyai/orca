import { describe, expect, it } from 'vitest'

import type { PRInfo } from './pull-request-types'
import { normalizeGitHubPRForBranchOutcome } from './pull-request-for-branch-outcome'

const PR: PRInfo = {
  number: 42,
  title: 'Feature',
  state: 'merged',
  url: 'https://github.com/acme/orca/pull/42',
  checksStatus: 'success',
  updatedAt: '2026-08-04T22:46:08Z',
  mergeable: 'UNKNOWN'
}

describe('normalizeGitHubPRForBranchOutcome', () => {
  it.each([
    { kind: 'no-pr' as const, fetchedAt: 10 },
    { kind: 'no-pr' as const, fetchedAt: 10, rejectedPRUrls: [PR.url] }
  ])('preserves no-PR responses from older and newer hosts', (outcome) => {
    expect(normalizeGitHubPRForBranchOutcome(outcome, 20)).toEqual(outcome)
  })

  it('normalizes legacy PRInfo and null responses', () => {
    expect(normalizeGitHubPRForBranchOutcome(PR, 20)).toEqual({
      kind: 'found',
      pr: PR,
      fetchedAt: 20
    })
    expect(normalizeGitHubPRForBranchOutcome(null, 20)).toEqual({
      kind: 'no-pr',
      fetchedAt: 20
    })
  })
})
