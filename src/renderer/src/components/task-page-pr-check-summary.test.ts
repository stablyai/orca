import { describe, expect, it } from 'vitest'

import { deriveTaskPagePRCheckSummary } from './task-page-pr-check-summary'
import type { PRCheckDetail } from '../../../shared/types'

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
      pending: 0
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
      pending: 1
    })
  })

  it('treats neutral and skipped checks as passed for the compact PR table label', () => {
    expect(
      deriveTaskPagePRCheckSummary([
        check({ conclusion: 'success' }),
        check({ conclusion: 'neutral' }),
        check({ conclusion: 'skipped' })
      ])
    ).toEqual({
      state: 'success',
      total: 3,
      passed: 3,
      failed: 0,
      pending: 0
    })
  })
})
