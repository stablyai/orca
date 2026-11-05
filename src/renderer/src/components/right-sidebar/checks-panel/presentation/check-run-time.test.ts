import { describe, expect, it } from 'vitest'
import { getCheckRunTimeLabel } from './check-run-time'
import type { PRCheckDetail } from '../../../../../../shared/github/check-types'

const NOW = Date.parse('2026-11-05T12:00:00Z')

function check(overrides: Partial<PRCheckDetail>): PRCheckDetail {
  return { name: 'build', status: 'completed', conclusion: 'failure', url: null, ...overrides }
}

describe('getCheckRunTimeLabel', () => {
  it('dates a finished check by its finish and says how long it took', () => {
    const label = getCheckRunTimeLabel(
      check({ startedAt: '2026-11-05T09:57:00Z', completedAt: '2026-11-05T10:00:12Z' }),
      NOW
    )
    expect(label?.when).toBe('2h ago')
    expect(label?.duration).toBe('3m 12s')
  })

  it('dates a running check by its start, with no duration yet', () => {
    const label = getCheckRunTimeLabel(
      check({ status: 'in_progress', conclusion: 'pending', startedAt: '2026-11-05T11:55:00Z' }),
      NOW
    )
    expect(label?.when).toBe('5m ago')
    expect(label?.duration).toBeNull()
  })

  it('reads a provider clock ahead of ours as just now and drops sub-second runs', () => {
    const label = getCheckRunTimeLabel(
      check({ startedAt: '2026-11-05T12:00:20Z', completedAt: '2026-11-05T12:00:20Z' }),
      NOW
    )
    expect(label?.when).toBe('just now')
    expect(label?.duration).toBeNull()
  })

  it('shows nothing for a finished check without a finish time', () => {
    expect(getCheckRunTimeLabel(check({ startedAt: '2026-11-05T09:57:00Z' }), NOW)).toBeNull()
    expect(getCheckRunTimeLabel(check({}), NOW)).toBeNull()
  })
})
