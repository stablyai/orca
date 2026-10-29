import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { ChecksDetailPollingPolicy, detailedChecksStatus } from './checks-detail-polling-policy'

describe('detailed checks refresh policy', () => {
  it.each([
    { status: 'queued', conclusion: null },
    { status: 'in_progress', conclusion: null },
    { status: 'completed', conclusion: 'pending' },
    { status: 'completed', conclusion: 'action_required' },
    { status: 'completed', conclusion: null }
  ] satisfies Pick<PRCheckDetail, 'status' | 'conclusion'>[])(
    'continues merged checks for $status / $conclusion',
    (check) => {
      const policy = new ChecksDetailPollingPolicy()
      policy.accept([{ name: 'Build', url: null, ...check }])
      expect(policy.delayMs('merged', 'success', 60_000)).toBe(60_000)
    }
  )

  it.each(['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'skipped'] as const)(
    'stops merged details after %s even if the aggregate remains pending',
    (conclusion) => {
      const policy = new ChecksDetailPollingPolicy()
      policy.accept([{ name: 'Build', url: null, status: 'completed', conclusion }])
      expect(policy.delayMs('merged', 'pending', 60_000)).toBeNull()
    }
  )

  it.each(['success', 'failure', 'neutral'] as const)(
    'stops successful empty details with a settled %s aggregate',
    (aggregate) => {
      const policy = new ChecksDetailPollingPolicy()
      policy.accept([])
      expect(policy.delayMs('merged', aggregate, 120_000)).toBeNull()
    }
  )

  it('retries empty details when the aggregate is pending or unknown and backs off errors', () => {
    const policy = new ChecksDetailPollingPolicy()
    expect(detailedChecksStatus([])).toBeUndefined()
    policy.accept([])
    expect(policy.delayMs('merged', 'pending', 120_000)).toBe(120_000)
    expect(policy.delayMs('merged', undefined, 120_000)).toBe(120_000)
    policy.fail()
    expect(policy.delayMs('merged', 'success', 240_000)).toBe(240_000)
  })
})
