import { describe, expect, it } from 'vitest'

import { deriveTaskPagePRCheckSummary } from './task-page-pr-check-summary'
import type { PRCheckDetail } from '../../../shared/github/check-types'

function check(patch: Partial<PRCheckDetail>): PRCheckDetail {
  return {
    name: 'ci',
    status: 'completed',
    conclusion: 'success',
    url: null,
    ...patch
  }
}

describe('deriveTaskPagePRCheckSummary', () => {
  it('returns a none summary for PRs with no checks', () => {
    expect(deriveTaskPagePRCheckSummary([])).toEqual({
      state: 'none',
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      neutral: 0
    })
  })

  it('counts failing checks before pending and passing checks', () => {
    expect(
      deriveTaskPagePRCheckSummary([
        check({ conclusion: 'success' }),
        check({ conclusion: 'failure' }),
        check({ status: 'in_progress', conclusion: null })
      ])
    ).toEqual({
      state: 'failure',
      total: 3,
      passed: 1,
      failed: 1,
      pending: 1,
      neutral: 0
    })
  })

  it('keeps neutral checks out of passed while skipped checks pass', () => {
    expect(
      deriveTaskPagePRCheckSummary([
        check({ conclusion: 'success' }),
        check({ conclusion: 'neutral' }),
        check({ conclusion: 'skipped' })
      ])
    ).toEqual({
      state: 'success',
      total: 3,
      passed: 2,
      failed: 0,
      pending: 0,
      neutral: 1
    })
  })

  it('counts action_required as failed so a blocked PR never reads as passing', () => {
    expect(
      deriveTaskPagePRCheckSummary([
        check({ conclusion: 'success' }),
        check({ conclusion: 'action_required' })
      ])
    ).toEqual({
      state: 'failure',
      total: 2,
      passed: 1,
      failed: 1,
      pending: 0,
      neutral: 0
    })
  })

  it('keeps unknown completed outcomes neutral', () => {
    expect(
      deriveTaskPagePRCheckSummary([
        check({ conclusion: 'future_state' as PRCheckDetail['conclusion'] })
      ])
    ).toEqual({
      state: 'neutral',
      total: 1,
      passed: 0,
      failed: 0,
      pending: 0,
      neutral: 1
    })
  })
})
