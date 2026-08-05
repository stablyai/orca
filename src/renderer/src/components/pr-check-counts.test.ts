import { describe, expect, it } from 'vitest'
import { getCheckCounts, getChecksSummaryLabel } from './pr-check-counts'
import {
  getProviderChecksLabel,
  summarizeProviderChecks
} from '../../../shared/provider-check-summary'
import type { PRCheckDetail } from '../../../shared/types'

function check(conclusion: PRCheckDetail['conclusion'], name = String(conclusion)): PRCheckDetail {
  return { name, status: 'completed', conclusion, url: null }
}

describe('getCheckCounts', () => {
  // Why: the PR page, the work-item dialog and the sidebar Checks panel all count this same list;
  // a 2-success/3-skipped PR used to read "2 passing · 3 skipped" here and "5 passing" there.
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

  // Why: action_required blocks merge but is not a red failure, so it keeps its own amber bucket
  // even though the shared rollup treats it as failing.
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

  it('buckets neutral and still-running checks apart', () => {
    const checks: PRCheckDetail[] = [
      check('neutral'),
      { name: 'ci', status: 'in_progress', conclusion: null, url: null }
    ]

    expect(getCheckCounts(checks)).toEqual({
      passing: 0,
      failing: 0,
      needsAction: 0,
      pending: 1,
      neutral: 1
    })
    expect(getChecksSummaryLabel(checks)).toBe('1 check pending')
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
    expect(getChecksSummaryLabel(checks)).toBe('0 of 1 checks passing')
  })

  it('reports no checks for an empty list', () => {
    expect(getChecksSummaryLabel([])).toBe('No checks found')
  })
})
