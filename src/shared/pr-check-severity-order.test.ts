import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from './github/check-types'
import { getCheckSeverityRank, sortChecksBySeverity } from './pr-check-severity-order'
import { mapGitLabPipelineJobStatusToConclusion } from './gitlab-pipeline-checks'

const check = (name: string, conclusion: string | null) =>
  ({ name, conclusion }) as Pick<PRCheckDetail, 'name' | 'conclusion'>

describe('PR check severity order', () => {
  it('orders failures, then in-flight work, then successes', () => {
    const sorted = sortChecksBySeverity([
      check('success', 'success'),
      check('skipped', 'skipped'),
      check('pending', null),
      check('cancelled', 'cancelled'),
      check('failure', 'failure')
    ])

    expect(sorted.map((c) => c.name)).toEqual([
      'failure',
      'cancelled',
      'pending',
      'success',
      'skipped'
    ])
  })

  it('covers every known conclusion and preserves input order within equal ranks', () => {
    const sorted = sortChecksBySeverity([
      check('success-a', 'success'),
      check('unknown', 'future_state'),
      check('skipped', 'skipped'),
      check('action-required', 'action_required'),
      check('pending', 'pending'),
      check('timed-out', 'timed_out'),
      check('neutral', 'neutral'),
      check('cancelled', 'cancelled'),
      check('failure', 'failure'),
      check('success-b', 'success'),
      check('failure-b', 'failure-b')
    ])

    expect(sorted.map((c) => c.name)).toEqual([
      'action-required',
      'timed-out',
      'failure',
      'cancelled',
      'pending',
      'success-a',
      'success-b',
      'neutral',
      'skipped',
      'unknown',
      'failure-b'
    ])
  })

  // Object rank tables expose prototype names as functions, producing NaN comparisons and unstable ordering.
  it('treats prototype property names as unknown conclusions', () => {
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(getCheckSeverityRank(inherited)).toBe(
        getCheckSeverityRank('stale_from_a_future_github')
      )
    }

    const sorted = sortChecksBySeverity([
      check('inherited', 'constructor'),
      check('failure', 'failure'),
      check('success', 'success')
    ])
    expect(sorted.map((c) => c.name)).toEqual(['failure', 'success', 'inherited'])
  })

  it('treats a missing conclusion as pending', () => {
    expect(getCheckSeverityRank(null)).toBe(getCheckSeverityRank('pending'))
    expect(getCheckSeverityRank(undefined)).toBe(getCheckSeverityRank('pending'))
  })

  it('leaves the input array untouched', () => {
    const checks = [check('success', 'success'), check('failure', 'failure')]
    sortChecksBySeverity(checks)
    expect(checks.map((c) => c.name)).toEqual(['success', 'failure'])
  })

  it('orders normalized provider states with stable ties', () => {
    const checks = [
      // Preserve an unrecognized provider value so it remains visibly unknown.
      check('future', 'future_state'),
      check('manual', mapGitLabPipelineJobStatusToConclusion('manual')),
      check('pass-a', 'success'),
      check('pass-b', 'success')
    ]

    // A manual GitLab gate is neutral, so it sinks below the passing checks a reviewer reads first.
    expect(sortChecksBySeverity(checks).map((item) => item.name)).toEqual([
      'pass-a',
      'pass-b',
      'manual',
      'future'
    ])
  })
})
