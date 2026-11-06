import { describe, expect, it } from 'vitest'
import { formatCheckRunAge, getCheckRunTimeFacts } from './check-run-time'
import type { PRCheckDetail } from '../../../../../../shared/github/check-types'

const NOW = Date.parse('2026-11-05T12:00:00Z')

function label(overrides: Partial<PRCheckDetail>): { fixed: string; age: string | null } | null {
  const facts = getCheckRunTimeFacts({ status: 'completed', ...overrides })
  return facts ? { fixed: facts.fixedText, age: formatCheckRunAge(facts, NOW) } : null
}

describe('check run time label', () => {
  it('dates a finished check by its finish and says how long it took', () => {
    expect(
      label({ startedAt: '2026-11-05T09:57:00Z', completedAt: '2026-11-05T10:00:12Z' })
    ).toEqual({ fixed: '3m 12s', age: '2h ago' })
  })

  it('dates a running check by its start, with no duration yet', () => {
    expect(label({ status: 'in_progress', startedAt: '2026-11-05T11:55:00Z' })).toEqual({
      fixed: '',
      age: '5m ago'
    })
  })

  it('reads a provider clock ahead of ours as just now and drops sub-second runs', () => {
    expect(
      label({ startedAt: '2026-11-05T12:00:20Z', completedAt: '2026-11-05T12:00:20Z' })
    ).toEqual({ fixed: '', age: 'just now' })
  })

  it('shows nothing for a finished check without a finish time', () => {
    expect(label({ startedAt: '2026-11-05T09:57:00Z' })).toBeNull()
    expect(label({})).toBeNull()
  })

  it('names an earlier commit even when the run has no time', () => {
    expect(label({ notLatestCommitSha: 'a'.repeat(40) })).toEqual({
      fixed: 'Earlier commit',
      age: null
    })
  })
})
