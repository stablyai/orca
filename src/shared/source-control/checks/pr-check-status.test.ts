import { describe, expect, it } from 'vitest'
import {
  derivePRCheckStatus,
  derivePRCheckStatusFromRollup,
  summarizePRCheckRollup
} from './pr-check-status'
import { getProviderChecksOutcome } from './provider-check-summary'
import type { PRCheckDetail } from '../../github/check-types'

const check = (
  status: PRCheckDetail['status'],
  conclusion: PRCheckDetail['conclusion']
): PRCheckDetail => ({ name: 'ci', status, conclusion, url: null })

describe('provider-neutral check status', () => {
  it('keeps explicit nonterminal and missing-conclusion checks pending', () => {
    expect(derivePRCheckStatus([check('queued', null)])).toBe('pending')
    expect(derivePRCheckStatus([check('in_progress', null)])).toBe('pending')
    expect(derivePRCheckStatus([check('completed', 'pending')])).toBe('pending')
  })

  it('keeps completed unknown conclusions neutral while preserving attention states', () => {
    expect(derivePRCheckStatus([check('completed', null)])).toBe('neutral')
    expect(
      derivePRCheckStatus([check('completed', 'future_state' as PRCheckDetail['conclusion'])])
    ).toBe('neutral')
    expect(derivePRCheckStatus([check('completed', 'action_required')])).toBe('failure')
  })

  it('normalizes GitHub-style rollups without turning malformed data into success', () => {
    expect(derivePRCheckStatusFromRollup([{ status: 'IN_PROGRESS', conclusion: null }])).toBe(
      'pending'
    )
    expect(
      derivePRCheckStatusFromRollup([{ status: 'COMPLETED', conclusion: 'future_state' }])
    ).toBe('neutral')
    expect(derivePRCheckStatusFromRollup([{}])).toBe('neutral')
    expect(derivePRCheckStatusFromRollup([{ state: 'PENDING' }])).toBe('pending')
    expect(derivePRCheckStatusFromRollup([{ state: 'ERROR' }])).toBe('failure')
  })

  it.each(['ERROR', 'STARTUP_FAILURE'])('treats raw %s conclusions as failures', (conclusion) => {
    expect(derivePRCheckStatusFromRollup([{ status: 'COMPLETED', conclusion }])).toBe('failure')
  })
})

it.each([
  [['CANCELLED'], 'cancelled'],
  [['SUCCESS', 'CANCELLED'], 'cancelled'],
  [['CANCELLED', 'PENDING'], 'pending'],
  [['CANCELLED', 'FAILURE', 'PENDING'], 'failure']
] as const)('preserves legacy counts while presenting %j as %s', (conclusions, outcome) => {
  const raw = conclusions.map((conclusion) => ({ status: 'COMPLETED', conclusion }))
  const summary = summarizePRCheckRollup(raw)
  expect(summary.state).toBe('failure')
  expect(summary.cancelled).toBe(1)
  expect(summary.total).toBe(summary.passed + summary.failed + summary.pending + summary.neutral)
  expect(getProviderChecksOutcome(summary)).toBe(outcome)
  expect(getProviderChecksOutcome({ ...summary, cancelled: undefined })).toBe('failure')
  expect(getProviderChecksOutcome({ ...summary, cancelled: summary.failed + 1 })).toBe('failure')
  expect(getProviderChecksOutcome({ ...summary, total: 999 })).toBe('failure')
})

it('does not downgrade a coarse failure from contradictory cancellation metadata', () => {
  const summary = {
    state: 'failure' as const,
    total: 1,
    passed: 0,
    failed: 0,
    pending: 1,
    neutral: 0,
    cancelled: 0
  }
  expect(getProviderChecksOutcome(summary, 'failure')).toBe('failure')
})
