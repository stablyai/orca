import { describe, expect, it } from 'vitest'
import type { PRRefreshOutcome } from './pull-request-refresh-types'
import type { PRInfo } from './pull-request-types'
import { normalizeGitHubPRForBranchOutcome } from './pull-request-for-branch-outcome'

const PR = {
  number: 42,
  title: 'Feature',
  state: 'merged',
  url: 'https://github.com/acme/orca/pull/42',
  checksStatus: 'success',
  updatedAt: '2026-08-04T22:46:08Z',
  mergeable: 'UNKNOWN'
} as PRInfo

describe('normalizeGitHubPRForBranchOutcome', () => {
  it('preserves current classified outcomes', () => {
    const outcome: PRRefreshOutcome = { kind: 'found', pr: PR, fetchedAt: 10 }
    expect(normalizeGitHubPRForBranchOutcome(outcome, 20)).toBe(outcome)
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

  it('preserves classified upstream errors', () => {
    const outcome: PRRefreshOutcome = {
      kind: 'upstream-error',
      errorType: 'network',
      message: 'network unavailable',
      fetchedAt: 10
    }
    expect(normalizeGitHubPRForBranchOutcome(outcome, 20)).toBe(outcome)
  })
})
