import { describe, expect, it } from 'vitest'
import { getPRGroupKeyForState } from './workspace-pr-groups'

describe('getPRGroupKeyForState', () => {
  it.each([
    [undefined, 'in-progress'],
    [null, 'in-progress'],
    ['draft', 'in-progress'],
    ['open', 'in-review'],
    ['OPEN', 'in-review'],
    ['merged', 'done'],
    ['closed', 'closed']
  ] as const)('puts a %s PR in the %s lane', (state, lane) => {
    expect(getPRGroupKeyForState(state)).toBe(lane)
  })
})
