import { describe, expect, it } from 'vitest'
import { getCheckCounts, getChecksSummaryLabel } from './pr-check-counts'
import {
  getProviderChecksLabel,
  summarizeProviderChecks
} from '../../../shared/provider-check-summary'
import type { PRCheckDetail } from '../../../shared/github/check-types'

function check(conclusion: PRCheckDetail['conclusion'], name = String(conclusion)): PRCheckDetail {
  return { name, status: 'completed', conclusion, url: null }
}

describe('getCheckCounts', () => {
  // PR page/dialog/sidebar must count skipped successes consistently.
  it('counts skipped checks as passing, matching the sidebar header and the checks pill', () => {
    const checks = [
      check('success', 'build'),
      check('success', 'test'),
      check('skipped', 'deploy'),
      check('skipped', 'docs'),
      check('skipped', 'e2e')
    ]

    expect(getCheckCounts(checks)).toEqual({
      passing: 5,
      failing: 0,
      needsAction: 0,
      pending: 0,
      neutral: 0
    })
    expect(getChecksSummaryLabel(checks)).toBe('All checks passing')
    expect(summarizeProviderChecks(checks).passed).toBe(5)
    expect(getProviderChecksLabel(summarizeProviderChecks(checks))).toBe('5/5 passed')
  })

  // action_required blocks merge but needs its own amber bucket rather than red failure styling.
  it('keeps action_required separate from failures', () => {
    expect(getCheckCounts([check('action_required'), check('failure')])).toEqual({
      passing: 0,
      failing: 1,
      needsAction: 1,
      pending: 0,
      neutral: 0
    })
    expect(getChecksSummaryLabel([check('action_required')])).toBe('1 check needs action')
  })

  it('keeps a completed check without a conclusion unresolved', () => {
    const checks: PRCheckDetail[] = [
      { name: 'external', status: 'completed', conclusion: null, url: null }
    ]

    expect(getCheckCounts(checks)).toEqual({
      passing: 0,
      failing: 0,
      needsAction: 0,
      pending: 0,
      neutral: 1
    })
    expect(getChecksSummaryLabel(checks)).toBe('0 of 1 check passing')
  })
})
