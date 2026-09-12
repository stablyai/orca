import { describe, expect, it } from 'vitest'
import {
  derivePRCheckStatuses,
  derivePRCheckStatusesFromRollup,
  derivePRCheckStatus,
  derivePRCheckStatusFromRollup
} from './pr-check-status'
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

  it('keeps real failures ahead of action-required checks and leaves success unchanged', () => {
    expect(
      derivePRCheckStatuses([check('completed', 'action_required'), check('completed', 'failure')])
    ).toEqual({ status: 'failure', presentationStatus: 'failure' })
    expect(derivePRCheckStatuses([check('completed', 'success')])).toEqual({
      status: 'success',
      presentationStatus: 'success'
    })
  })

  it('keeps completed unknown conclusions neutral while preserving attention states', () => {
    expect(derivePRCheckStatus([check('completed', null)])).toBe('neutral')
    expect(
      derivePRCheckStatus([check('completed', 'future_state' as PRCheckDetail['conclusion'])])
    ).toBe('neutral')
    expect(derivePRCheckStatus([check('completed', 'action_required')])).toBe('failure')
    expect(derivePRCheckStatuses([check('completed', 'action_required')])).toEqual({
      status: 'failure',
      presentationStatus: 'action_required'
    })
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
    expect(derivePRCheckStatusesFromRollup([{ state: 'ACTION_REQUIRED' }])).toEqual({
      status: 'failure',
      presentationStatus: 'action_required'
    })
  })

  it.each(['ERROR', 'STARTUP_FAILURE'])('treats raw %s conclusions as failures', (conclusion) => {
    expect(derivePRCheckStatusFromRollup([{ status: 'COMPLETED', conclusion }])).toBe('failure')
  })
})
