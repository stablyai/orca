import { describe, expect, it } from 'vitest'
import { derivePRCheckStatus, derivePRCheckStatusFromRollup } from './pr-check-status'
import type { PRCheckDetail } from './github/check-types'

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

describe('cancelled aggregates', () => {
  // Why: a deliberate cancellation blocks merging exactly like a failure, but presenting it as
  // one made the sidebar call a stopped run "Failed" (#15847). The aggregate must carry its own
  // verdict down to PR metadata instead of collapsing into `failure`.
  it('derives a cancelled-only set as cancelled, not failure', () => {
    expect(derivePRCheckStatus([check('completed', 'cancelled')])).toBe('cancelled')
    expect(derivePRCheckStatusFromRollup([{ status: 'COMPLETED', conclusion: 'CANCELLED' }])).toBe(
      'cancelled'
    )
  })

  it('lets a real failure win over cancellations in a mixed set', () => {
    const status = derivePRCheckStatus([check('completed', 'cancelled'), check('completed', 'failure')])
    expect(status).toBe('failure')
  })

  it('keeps a set with a still-running check pending until it settles', () => {
    const status = derivePRCheckStatus([check('completed', 'cancelled'), check('in_progress', null)])
    expect(status).toBe('pending')
  })

  it('does not let a cancelled check turn the rollup green', () => {
    const status = derivePRCheckStatus([check('completed', 'success'), check('completed', 'cancelled')])
    expect(status).toBe('cancelled')
  })
})
