import { describe, expect, it } from 'vitest'
import { getCheckSeverityRank, sortChecksBySeverity } from './pr-check-severity-order'

const check = (name: string, conclusion: string | null) =>
  ({ name, conclusion }) as { name: string; conclusion: never }

describe('PR check severity order', () => {
  it('keeps passing checks above the skipped and neutral noise', () => {
    const sorted = sortChecksBySeverity([
      check('daily-cleanup', 'skipped'),
      check('Test Results', 'success'),
      check('build-admin', 'skipped'),
      check('advisory', 'neutral'),
      check('Validate Configs', 'success')
    ])

    expect(sorted.map((c) => c.name)).toEqual([
      'Test Results',
      'Validate Configs',
      'advisory',
      'daily-cleanup',
      'build-admin'
    ])
  })

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

  it('sinks unknown conclusions below every known state', () => {
    expect(getCheckSeverityRank('stale_from_a_future_github')).toBeGreaterThan(
      getCheckSeverityRank('skipped')
    )
  })

  // Why: an object-literal rank table would resolve these off Object.prototype and
  // return a function, turning the comparator into NaN and scrambling the list.
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
})
