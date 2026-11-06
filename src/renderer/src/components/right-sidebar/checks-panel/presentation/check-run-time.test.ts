import { describe, expect, it } from 'vitest'
import { formatCheckRunAge, getCheckRunTimeFacts } from './check-run-time'
import type { PRCheckDetail } from '../../../../../../shared/github/check-types'

const NOW = Date.parse('2026-11-05T12:00:00Z')

function facts(overrides: Partial<PRCheckDetail>) {
  return getCheckRunTimeFacts({ status: 'completed', ...overrides })
}

function age(overrides: Partial<PRCheckDetail>): string | null {
  const result = facts(overrides)
  return result ? formatCheckRunAge(result, NOW) : null
}

describe('check run time facts', () => {
  it('dates a finished check by its finish and shows how long it took', () => {
    const finished = facts({
      startedAt: '2026-11-05T09:57:00Z',
      completedAt: '2026-11-05T10:00:12Z'
    })
    expect(finished?.whenMs).toBe(Date.parse('2026-11-05T10:00:12Z'))
    expect(finished?.fixedText).not.toBe('')
  })

  it('dates a running check by its start, with no duration yet', () => {
    const running = facts({ status: 'in_progress', startedAt: '2026-11-05T11:55:00Z' })
    expect(running?.whenMs).toBe(Date.parse('2026-11-05T11:55:00Z'))
    expect(running?.running).toBe(true)
    expect(running?.fixedText).toBe('')
  })

  it('reads a provider clock ahead of ours as now and drops sub-second runs', () => {
    const ahead = facts({ startedAt: '2026-11-05T12:00:20Z', completedAt: '2026-11-05T12:00:20Z' })
    expect(ahead?.fixedText).toBe('')
    expect(age({ completedAt: '2026-11-05T12:00:20Z' })).toBe(
      age({ completedAt: '2026-11-05T12:00:00Z' })
    )
  })

  it('shows nothing for a finished check without a finish time', () => {
    expect(facts({ startedAt: '2026-11-05T09:57:00Z' })).toBeNull()
    expect(facts({})).toBeNull()
  })

  it('keeps an earlier-commit note even when the run has no time', () => {
    const note = facts({ notLatestCommitSha: 'a'.repeat(40) })
    expect(note?.fixedText).not.toBe('')
    expect(age({ notLatestCommitSha: 'a'.repeat(40) })).toBeNull()
  })
})
