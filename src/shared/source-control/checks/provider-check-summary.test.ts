import { expect, it } from 'vitest'
import { summarizeProviderChecks } from './provider-check-summary'

it('keeps approval checks pending and preserves real failures in mixed results', () => {
  const approval = { status: 'completed', conclusion: 'action_required' }
  expect(
    summarizeProviderChecks([
      { status: 'completed', conclusion: 'success' },
      approval,
      { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }
    ])
  ).toEqual({
    state: 'pending',
    total: 3,
    passed: 1,
    failed: 0,
    cancelled: 0,
    pending: 2,
    neutral: 0
  })
  expect(
    summarizeProviderChecks([approval, { status: 'completed', conclusion: 'failure' }])
  ).toEqual({
    state: 'failure',
    total: 2,
    passed: 0,
    failed: 1,
    cancelled: 0,
    pending: 1,
    neutral: 0
  })
})
